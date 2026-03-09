"""Notion Review Worker – SQS-triggered Lambda.

Consumes review jobs from SQS, fetches the Notion topic content, generates 10
review questions using OpenAI, and stores the result in DynamoDB.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import boto3

try:
    from notion_client import Client
    from notion_client.errors import APIResponseError
except Exception:  # pragma: no cover
    Client = None  # type: ignore[assignment]
    APIResponseError = Exception  # type: ignore[misc,assignment]

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _get_jobs_table():
    table_name = _require_env("REVIEW_JOBS_TABLE_NAME")
    return boto3.resource("dynamodb").Table(table_name)


def _get_notion_client() -> Any:  # noqa: ANN401
    if Client is None:
        raise RuntimeError("Notion client library is not installed")

    token = (os.environ.get("NOTION_INTEGRATION_TOKEN") or "").strip() or (
        os.environ.get("NOTION_TOKEN") or ""
    ).strip()
    if not token:
        raise RuntimeError("Missing required environment variable: NOTION_INTEGRATION_TOKEN")

    return Client(auth=token)


def _get_openai_client() -> Any:  # noqa: ANN401
    if OpenAI is None:
        raise RuntimeError("OpenAI client library is not installed")

    api_key = _require_env("OPENAI_API_KEY")
    return OpenAI(api_key=api_key)


def _plain_text(rich_text: list[dict[str, Any]] | None) -> str:
    if not rich_text:
        return ""
    return "".join((t.get("plain_text") or "") for t in rich_text)


def _get_topics_data_source_id(notion: Any, database_id: str) -> str:  # noqa: ANN401
    """Return the data_source_id for a Notion database, or database_id if unsupported."""
    try:
        db_info = notion.databases.retrieve(database_id)
        data_sources = db_info.get("data_sources") or []
        if data_sources and data_sources[0].get("id"):
            return data_sources[0]["id"]
    except Exception:
        # Fall back to using databases.query
        pass
    return database_id


def _parse_unique_id_number(topic_id: str) -> int | None:
    """Extract the numeric part from a unique_id string like 'TOP2' or '2'."""
    import re
    m = re.search(r"(\d+)$", str(topic_id))
    return int(m.group(1)) if m else None


def _find_topic_page(
    notion: Any,  # noqa: ANN401
    database_id: str,
    topic_id: str,
) -> dict[str, Any] | None:
    """Find a topic page in the Topics database by Topic ID.

    Topic ID is a Notion unique_id property (prefix + number), so the correct
    filter type is 'unique_id', not 'rich_text'.
    """
    data_source_id = _get_topics_data_source_id(notion, database_id)

    uid_number = _parse_unique_id_number(topic_id)
    if uid_number is None:
        logger.warning("Could not parse numeric part from topicId=%r — cannot query", topic_id)
        return None

    notion_filter = {"property": "Topic ID", "unique_id": {"equals": uid_number}}

    # Prefer data_sources.query (new Notion API), fall back to databases.query.
    try:
        if hasattr(notion, "data_sources") and data_source_id != database_id:
            resp = notion.data_sources.query(
                data_source_id=data_source_id,
                filter=notion_filter,
                page_size=1,
            )
        else:
            resp = notion.databases.query(
                database_id=database_id,
                filter=notion_filter,
                page_size=1,
            )
    except APIResponseError as exc:
        logger.warning("Notion query by Topic ID failed: %s", exc)
        return None

    results = resp.get("results") or []
    return results[0] if results else None


def _extract_block_text(block: dict[str, Any]) -> str:
    block_type = block.get("type")
    if not block_type:
        return ""

    payload = block.get(block_type) or {}

    # Most text-based blocks store rich_text.
    if isinstance(payload, dict) and "rich_text" in payload:
        return _plain_text(payload.get("rich_text"))

    # Code block uses rich_text too, but keep as-is.
    return ""


def _fetch_page_text(
    notion: Any,  # noqa: ANN401
    page_id: str,
    *,
    max_blocks: int = 200,
    depth: int = 1,
) -> str:
    """Fetch readable text content for a Notion page.

    Keeps it intentionally simple (enough context for question generation).
    """

    lines: list[str] = []

    def walk_children(block_id: str, current_depth: int) -> None:
        fetched = 0
        cursor: str | None = None
        while True:
            resp = notion.blocks.children.list(block_id=block_id, start_cursor=cursor, page_size=100)
            for block in resp.get("results") or []:
                if fetched >= max_blocks:
                    return

                text = _extract_block_text(block).strip()
                if text:
                    lines.append(text)

                fetched += 1

                if current_depth < depth and block.get("has_children"):
                    child_id = block.get("id")
                    if child_id:
                        walk_children(child_id, current_depth + 1)

            if not resp.get("has_more"):
                break
            cursor = resp.get("next_cursor")

    walk_children(page_id, 0)
    return "\n".join(lines).strip()


def _generate_questions(openai_client: Any, *, model: str, topic_name: str, content: str) -> list[str]:  # noqa: ANN401
    prompt = (
        "Generate exactly 10 concise review questions for the topic below. "
        "Return ONLY valid JSON: an array of 10 strings.\n\n"
        f"Topic: {topic_name}\n\n"
        "Content:\n"
        f"{content[:12000]}"
    )

    resp = openai_client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "You are a helpful AI tutor."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
    )

    text = (resp.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [str(q).strip() for q in parsed if str(q).strip()][:10]
    except json.JSONDecodeError:
        pass

    # Fallback: split lines.
    lines = [ln.strip(" -\t") for ln in text.splitlines() if ln.strip()]
    return lines[:10]


def _update_job(request_id: str, updates: dict[str, Any]) -> None:
    table = _get_jobs_table()
    now = _now_iso()
    updates = {**updates, "updatedAt": now}

    expr_parts: list[str] = []
    expr_values: dict[str, Any] = {}
    expr_names: dict[str, str] = {}

    for key, val in updates.items():
        name_key = f"#{key}"
        value_key = f":{key}"
        expr_names[name_key] = key
        expr_values[value_key] = val
        expr_parts.append(f"{name_key} = {value_key}")

    table.update_item(
        Key={"requestId": request_id},
        UpdateExpression="SET " + ", ".join(expr_parts),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


def _process_job(message: dict[str, Any]) -> None:
    request_id = str(message.get("requestId") or "").strip()
    topic_id = str(message.get("topicId") or "").strip()
    notion_page_id = (message.get("notionPageId") or "").strip() if isinstance(message.get("notionPageId"), str) else ""

    if not request_id or not topic_id:
        raise ValueError("Job message must include requestId and topicId")

    _update_job(request_id, {"status": "processing"})

    notion = _get_notion_client()
    database_id = _require_env("NOTION_TOPICS_DATABASE_ID")

    page: dict[str, Any] | None = None
    if notion_page_id:
        page = {"id": notion_page_id}
    else:
        page = _find_topic_page(notion, database_id, topic_id)

    if not page or not page.get("id"):
        raise RuntimeError(f"Topic page not found for topicId={topic_id}")

    page_id = page["id"]
    try:
        page_full = notion.pages.retrieve(page_id=page_id)
    except Exception:
        page_full = page

    props = (page_full.get("properties") or {}) if isinstance(page_full, dict) else {}
    topic_name = ""
    if isinstance(props.get("Topic Name"), dict):
        title = props.get("Topic Name", {}).get("title")
        topic_name = _plain_text(title)

    content = _fetch_page_text(notion, page_id, depth=2)
    if not content:
        raise RuntimeError("No readable content found on the Notion page")

    openai_client = _get_openai_client()
    model = (os.environ.get("OPENAI_MODEL") or "gpt-4o-mini").strip() or "gpt-4o-mini"
    questions = _generate_questions(openai_client, model=model, topic_name=topic_name or topic_id, content=content)

    _update_job(
        request_id,
        {
            "status": "completed",
            "topicId": topic_id,
            "notionPageId": page_id,
            "topicName": topic_name,
            "questions": questions,
        },
    )


def lambda_handler(event: dict[str, Any], context) -> dict[str, Any]:  # noqa: ANN001
    logger.info("Received %d SQS record(s)", len(event.get("Records") or []))

    for record in event.get("Records") or []:
        body = record.get("body") or "{}"
        try:
            message = json.loads(body)
        except json.JSONDecodeError:
            logger.error("Invalid JSON in SQS message body")
            continue

        request_id = str(message.get("requestId") or "").strip()
        try:
            _process_job(message)
        except Exception as exc:
            logger.exception("Failed processing job")
            if request_id:
                try:
                    _update_job(request_id, {"status": "failed", "error": str(exc)})
                except Exception:
                    logger.exception("Failed updating job status to failed")

            # Re-raise so SQS will retry / eventually DLQ.
            raise

    return {"ok": True, "processed": len(event.get("Records") or [])}

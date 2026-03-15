"""
Notion Review Trigger – Lambda Handler
Fetches review topics from Notion and (optionally) triggers an LLM summary.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from decimal import Decimal
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

try:
    from notion_client import Client
    from notion_client.errors import APIResponseError
except Exception:  # pragma: no cover
    Client = None  # type: ignore[assignment]
    APIResponseError = Exception  # type: ignore[misc,assignment]

from dsa_review_handler import (
    fetch_dsa_review_table,
    get_selected_dsa_problem_numbers,
    get_dsa_problem_review_markdown,
    update_dsa_review_table,
    get_dsa_tracker,
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Content-Type": "application/json",
    }


def _respond(status_code: int, body: dict) -> dict:
    def _default(o: Any) -> Any:
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")

    return {
        "statusCode": status_code,
        "headers": _cors_headers(),
        "body": json.dumps(body, default=_default),
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ttl_epoch_seconds(hours: int = 24) -> int:
    return int(datetime.now(timezone.utc).timestamp()) + (hours * 60 * 60)


def _get_jobs_table_name() -> str:
    return _require_env("REVIEW_JOBS_TABLE_NAME")


def _get_jobs_table():
    return boto3.resource("dynamodb").Table(_get_jobs_table_name())


def _get_review_queue_url() -> str:
    return _require_env("REVIEW_QUEUE_URL")


def _require_env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _get_notion_client() -> Any:  # noqa: ANN401
    if Client is None:
        raise RuntimeError(
            "Notion client library is not installed. Add 'notion-client' to requirements.txt."
        )
    token = (os.environ.get("NOTION_INTEGRATION_TOKEN") or "").strip() or (
        os.environ.get("NOTION_TOKEN") or ""
    ).strip()
    if not token:
        raise RuntimeError(
            "Missing required environment variable: NOTION_INTEGRATION_TOKEN"
        )
    return Client(auth=token)


def _plain_text(rich_text: list[dict[str, Any]] | None) -> str:
    if not rich_text:
        return ""
    return "".join((t.get("plain_text") or "") for t in rich_text)


# ---------------------------------------------------------------------------
# S3 tracking helpers
# ---------------------------------------------------------------------------

def _get_tracking_bucket_name() -> str:
    return _require_env("REVIEW_TRACKING_BUCKET_NAME")


def _tracking_s3_key(year: int, month: int) -> str:
    return f"reviews/{year:04d}/{month:02d}.json"


def _read_tracking_file(s3_client: Any, bucket: str, key: str) -> dict:  # noqa: ANN401
    """Read the monthly tracking JSON from S3. Returns empty structure on miss."""
    try:
        resp = s3_client.get_object(Bucket=bucket, Key=key)
        return json.loads(resp["Body"].read())
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "NoSuchKey":
            return {"version": 1, "days": {}}
        logger.warning("Could not read tracking file s3://%s/%s: %s", bucket, key, exc)
        return {"version": 1, "days": {}}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read tracking file s3://%s/%s: %s", bucket, key, exc)
        return {"version": 1, "days": {}}


def _write_tracking_file(s3_client: Any, bucket: str, key: str, data: dict) -> None:  # noqa: ANN401
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, ensure_ascii=False).encode(),
        ContentType="application/json",
    )


def _notion_property_value(prop: dict[str, Any] | None) -> Any:  # noqa: ANN401
    if not prop:
        return None

    prop_type = prop.get("type")
    if not prop_type:
        return prop

    if prop_type == "title":
        return _plain_text(prop.get("title"))
    if prop_type == "rich_text":
        return _plain_text(prop.get("rich_text"))
    if prop_type == "number":
        return prop.get("number")
    if prop_type == "url":
        return prop.get("url")
    if prop_type == "date":
        date_val = prop.get("date")
        if not date_val:
            return None
        return {
            "start": date_val.get("start"),
            "end": date_val.get("end"),
            "time_zone": date_val.get("time_zone"),
        }
    if prop_type == "select":
        select_val = prop.get("select")
        return (select_val or {}).get("name")
    if prop_type == "multi_select":
        return [v.get("name") for v in (prop.get("multi_select") or []) if v.get("name")]
    if prop_type == "checkbox":
        return prop.get("checkbox")
    if prop_type == "unique_id":
        uid = prop.get("unique_id") or {}
        prefix = uid.get("prefix") or ""
        number = uid.get("number")
        if number is None:
            return None
        return f"{prefix}{number}" if prefix else str(number)

    # Fall back to returning the underlying typed payload.
    return prop.get(prop_type)


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

def _get_topics(event: dict) -> dict:
    """Return the 5 least-recently-reviewed topics from Notion."""
    try:
        notion = _get_notion_client()
        database_id = _require_env("NOTION_TOPICS_DATABASE_ID")
    except RuntimeError as exc:
        logger.error("Notion configuration error: %s", exc)
        return _respond(500, {"error": str(exc)})

    try:
        # Step 1: Retrieve the database to extract its primary Data Source ID
        db_info = notion.databases.retrieve(database_id)
        data_source_id = db_info["data_sources"][0]["id"]

        # Step 2: Query the Data Source instead of the Database
        never_reviewed = notion.data_sources.query(
            data_source_id=data_source_id,
            filter={"property": "Last Reviewed", "date": {"is_empty": True}},
            sorts=[{"property": "Date Added", "direction": "ascending"}],
            page_size=5,
        )

        reviewed = notion.data_sources.query(
            data_source_id=data_source_id,
            filter={"property": "Last Reviewed", "date": {"is_not_empty": True}},
            sorts=[{"property": "Last Reviewed", "direction": "ascending"}],
            page_size=5,
        )
    except APIResponseError as exc:
        logger.exception("Notion API error querying database")
        return _respond(502, {"error": "Notion API error", "details": str(exc)})

    pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in (never_reviewed.get("results") or []) + (reviewed.get("results") or []):
        page_id = page.get("id")
        if not page_id or page_id in seen:
            continue
        seen.add(page_id)
        pages.append(page)
        if len(pages) >= 5:
            break

    topics: list[dict[str, Any]] = []
    for page in pages:
        props = page.get("properties") or {}

        topic_name = _notion_property_value(props.get("Topic Name"))
        date_added = _notion_property_value(props.get("Date Added"))
        last_reviewed = _notion_property_value(props.get("Last Reviewed"))
        topic_id = _notion_property_value(props.get("Topic ID"))
        subject = _notion_property_value(props.get("Subject"))
        notion_page_url_prop = _notion_property_value(props.get("Notion Page URL"))
        last_questions_raw = _notion_property_value(props.get("Last Questions JSON"))

        last_questions: Any = last_questions_raw
        if isinstance(last_questions_raw, str) and last_questions_raw.strip():
            try:
                last_questions = json.loads(last_questions_raw)
            except json.JSONDecodeError:
                last_questions = last_questions_raw

        topics.append(
            {
                "notionPageId": page.get("id"),
                "notionPageUrl": notion_page_url_prop or page.get("url"),
                "topicName": topic_name,
                "dateAdded": date_added,
                "lastReviewed": last_reviewed,
                "subject": subject,
                "topicId": topic_id,
                "lastQuestionsJson": last_questions,
                "fields": {
                    "Topic Name": topic_name,
                    "Date Added": date_added,
                    "Last Questions JSON": last_questions,
                    "Last Reviewed": last_reviewed,
                    "Notion Page URL": notion_page_url_prop,
                    "Subject": subject,
                    "Topic ID": topic_id,
                },
                "notionProperties": props,
            }
        )

    return _respond(200, {"topics": topics, "count": len(topics)})


def _get_all_topics(event: dict) -> dict:
    """Return all topics from Notion, paginating through the full data source."""
    try:
        notion = _get_notion_client()
        database_id = _require_env("NOTION_TOPICS_DATABASE_ID")
    except RuntimeError as exc:
        logger.error("Notion configuration error: %s", exc)
        return _respond(500, {"error": str(exc)})

    try:
        db_info = notion.databases.retrieve(database_id)
        data_source_id = db_info["data_sources"][0]["id"]

        all_results: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            kwargs: dict[str, Any] = {
                "data_source_id": data_source_id,
                "sorts": [{"property": "Topic Name", "direction": "ascending"}],
                "page_size": 100,
            }
            if cursor:
                kwargs["start_cursor"] = cursor
            response = notion.data_sources.query(**kwargs)
            all_results.extend(response.get("results") or [])
            if not response.get("has_more"):
                break
            cursor = response.get("next_cursor")
    except APIResponseError as exc:
        logger.exception("Notion API error querying all topics")
        return _respond(502, {"error": "Notion API error", "details": str(exc)})

    topics: list[dict[str, Any]] = []
    for page in all_results:
        props = page.get("properties") or {}

        topic_name = _notion_property_value(props.get("Topic Name"))
        date_added = _notion_property_value(props.get("Date Added"))
        last_reviewed = _notion_property_value(props.get("Last Reviewed"))
        topic_id = _notion_property_value(props.get("Topic ID"))
        subject = _notion_property_value(props.get("Subject"))
        notion_page_url_prop = _notion_property_value(props.get("Notion Page URL"))
        last_questions_raw = _notion_property_value(props.get("Last Questions JSON"))

        last_questions: Any = last_questions_raw
        if isinstance(last_questions_raw, str) and last_questions_raw.strip():
            try:
                last_questions = json.loads(last_questions_raw)
            except json.JSONDecodeError:
                last_questions = last_questions_raw

        topics.append(
            {
                "notionPageId": page.get("id"),
                "notionPageUrl": notion_page_url_prop or page.get("url"),
                "topicName": topic_name,
                "dateAdded": date_added,
                "lastReviewed": last_reviewed,
                "subject": subject,
                "topicId": topic_id,
                "lastQuestionsJson": last_questions,
                "fields": {
                    "Topic Name": topic_name,
                    "Date Added": date_added,
                    "Last Questions JSON": last_questions,
                    "Last Reviewed": last_reviewed,
                    "Notion Page URL": notion_page_url_prop,
                    "Subject": subject,
                    "Topic ID": topic_id,
                },
                "notionProperties": props,
            }
        )

    return _respond(200, {"topics": topics, "count": len(topics)})


def _trigger_review(event: dict) -> dict:
    """Enqueue an async review job for the requested topic."""
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _respond(400, {"error": "Invalid JSON body"})

    topic_id = body.get("topicId")
    if not topic_id:
        return _respond(400, {"error": "topicId is required"})

    notion_page_id = body.get("notionPageId")

    request_id = str(uuid.uuid4())
    created_at = _now_iso()
    expires_at = _ttl_epoch_seconds(24)

    try:
        table = _get_jobs_table()
        item: dict[str, Any] = {
            "requestId": request_id,
            "topicId": str(topic_id),
            "status": "queued",
            "createdAt": created_at,
            "updatedAt": created_at,
            "expiresAt": expires_at,
        }
        if notion_page_id:
            item["notionPageId"] = str(notion_page_id)

        table.put_item(Item=item)

        sqs = boto3.client("sqs")
        sqs.send_message(
            QueueUrl=_get_review_queue_url(),
            MessageBody=json.dumps(
                {
                    "requestId": request_id,
                    "topicId": str(topic_id),
                    "notionPageId": str(notion_page_id) if notion_page_id else "",
                }
            ),
        )
    except Exception as exc:
        logger.exception("Failed to enqueue review job")
        return _respond(500, {"error": "Failed to enqueue review job", "details": str(exc)})

    logger.info("Review job queued for topic %s (requestId=%s)", topic_id, request_id)
    return _respond(
        202,
        {
            "message": "Review queued",
            "topicId": str(topic_id),
            "requestId": request_id,
            "status": "queued",
        },
    )


def _get_review_result(event: dict) -> dict:
    request_id = None
    path_params = event.get("pathParameters") or {}
    if isinstance(path_params, dict):
        request_id = path_params.get("requestId")

    if not request_id:
        # Fallback for local/invoke payloads without pathParameters
        path = event.get("path") or ""
        marker = "/notion-review/results/"
        if marker in path:
            request_id = path.split(marker, 1)[1].split("/", 1)[0]

    if not request_id:
        return _respond(400, {"error": "requestId is required"})

    try:
        table = _get_jobs_table()
        resp = table.get_item(Key={"requestId": str(request_id)})
        item = resp.get("Item")
    except Exception as exc:
        logger.exception("Failed to read review job")
        return _respond(500, {"error": "Failed to read review job", "details": str(exc)})

    if not item:
        return _respond(404, {"error": "Not found", "requestId": str(request_id)})

    return _respond(200, {"job": item})


def _log_review(event: dict) -> dict:
    """Mark a set of reviewed topics as completed.

    Performs two writes in parallel intent:
      a) Updates each topic's Notion page (Last Reviewed + Last Questions JSON).
      b) Appends the session to a monthly S3 tracker file keyed by date.

    Request body:
      {
        "reviewedAt": "YYYY-MM-DD",   // optional, defaults to today UTC
        "topics": [
          {
            "notionPageId": "...",     // required for Notion update
            "topicId": "TOP2",
            "topicName": "Neural Networks",
            "subject": "AI",
            "questions": ["Q1?", "Q2?", ...]
          }
        ]
      }
    """
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _respond(400, {"error": "Invalid JSON body"})

    topics_input = body.get("topics")
    if not isinstance(topics_input, list) or not topics_input:
        return _respond(400, {"error": "'topics' must be a non-empty list"})

    reviewed_at = (body.get("reviewedAt") or "").strip()
    if not reviewed_at:
        reviewed_at = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    try:
        review_date = datetime.strptime(reviewed_at, "%Y-%m-%d")
    except ValueError:
        return _respond(400, {"error": "reviewedAt must be in YYYY-MM-DD format"})

    review_year = review_date.year
    review_month = review_date.month

    # --- Update Notion pages ---
    notion_warnings: list[str] = []
    try:
        notion = _get_notion_client()
    except RuntimeError as exc:
        notion = None
        notion_warnings.append(str(exc))

    tracker_entries: list[dict[str, Any]] = []
    for raw_topic in topics_input:
        if not isinstance(raw_topic, dict):
            continue

        notion_page_id = (raw_topic.get("notionPageId") or "").strip()
        topic_id = str(raw_topic.get("topicId") or "").strip()
        topic_name = str(raw_topic.get("topicName") or "").strip()
        subject = str(raw_topic.get("subject") or "").strip()
        questions = raw_topic.get("questions") or []
        if not isinstance(questions, list):
            questions = []

        if notion and notion_page_id:
            questions_json = json.dumps(questions)[:1990]
            try:
                notion.pages.update(
                    page_id=notion_page_id,
                    properties={
                        "Last Reviewed": {"date": {"start": reviewed_at}},
                        "Last Questions JSON": {
                            "rich_text": [{"text": {"content": questions_json}}]
                        },
                    },
                )
            except APIResponseError as exc:
                logger.warning(
                    "Notion update failed for page %s: %s", notion_page_id, exc
                )
                notion_warnings.append(f"{notion_page_id}: {exc}")

        tracker_entries.append(
            {
                "topicId": topic_id,
                "topicName": topic_name,
                "subject": subject,
                "notionPageId": notion_page_id,
                "questionsCount": len(questions),
            }
        )

    # --- Update S3 monthly tracker file ---
    tracker_errors: list[str] = []
    try:
        bucket = _get_tracking_bucket_name()
        s3 = boto3.client("s3")
        key = _tracking_s3_key(review_year, review_month)
        tracking_data = _read_tracking_file(s3, bucket, key)
        days: dict = tracking_data.setdefault("days", {})
        day_entries: list = days.setdefault(reviewed_at, [])
        existing_ids = {e.get("topicId") for e in day_entries}
        for entry in tracker_entries:
            if entry["topicId"] not in existing_ids:
                day_entries.append(entry)
        tracking_data["version"] = 1
        tracking_data["year"] = review_year
        tracking_data["month"] = review_month
        _write_tracking_file(s3, bucket, key, tracking_data)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to update S3 tracker")
        tracker_errors.append(str(exc))

    response_body: dict[str, Any] = {
        "message": "Review logged",
        "reviewedAt": reviewed_at,
        "topicsLogged": len(tracker_entries),
    }
    if notion_warnings:
        response_body["notionWarnings"] = notion_warnings
    if tracker_errors:
        response_body["trackerErrors"] = tracker_errors
        return _respond(207, response_body)

    return _respond(200, response_body)


def _get_tracker(event: dict) -> dict:
    """Return monthly review tracking data for the calendar UI.

    Query params:
      year  – 4-digit integer (default: current UTC year)
      month – 1–12            (default: current UTC month)

    Response shape:
      {
        "year": 2026,
        "month": 3,
        "days": {
          "2026-03-09": [
            { "topicId": "TOP2", "topicName": "...", "subject": "...",
              "notionPageId": "...", "questionsCount": 5 }
          ]
        },
        "reviewedDates": ["2026-03-09"],
        "totalTopicsReviewed": 1
      }
    """
    params = event.get("queryStringParameters") or {}
    now = datetime.now(timezone.utc)
    try:
        year = int(params.get("year") or now.year)
        month = int(params.get("month") or now.month)
    except (TypeError, ValueError):
        return _respond(400, {"error": "year and month must be integers"})

    if year < 2000 or year > 9999:
        return _respond(400, {"error": "year out of range"})
    if month < 1 or month > 12:
        return _respond(400, {"error": "month must be between 1 and 12"})

    try:
        bucket = _get_tracking_bucket_name()
        s3 = boto3.client("s3")
        key = _tracking_s3_key(year, month)
        tracking_data = _read_tracking_file(s3, bucket, key)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to read tracker data")
        return _respond(500, {"error": "Failed to read tracker", "details": str(exc)})

    days: dict = tracking_data.get("days") or {}
    reviewed_dates = sorted(days.keys())
    total_topics = sum(len(v) for v in days.values())

    return _respond(
        200,
        {
            "year": year,
            "month": month,
            "days": days,
            "reviewedDates": reviewed_dates,
            "totalTopicsReviewed": total_topics,
        },
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def lambda_handler(event: dict, context) -> dict:  # noqa: ANN001
    logger.info("Event: %s", json.dumps(event))

    http_method = event.get("httpMethod", "")
    path = event.get("path", "")

    if http_method == "OPTIONS":
        return _respond(200, {})

    if http_method == "GET" and path.endswith("/topics"):
        return _get_topics(event)

    if http_method == "GET" and path.endswith("/all-topics"):
        return _get_all_topics(event)

    if http_method == "POST" and path.endswith("/trigger"):
        return _trigger_review(event)

    if http_method == "GET" and "/notion-review/results/" in path:
        return _get_review_result(event)

    if http_method == "POST" and path.endswith("/log-review"):
        return _log_review(event)

    if http_method == "GET" and path.endswith("/notion-review/tracker"):
        return _get_tracker(event)

    # --- DSA Review sub-app ---
    if http_method == "GET" and path.endswith("/fetch_dsa_review_table"):
        return fetch_dsa_review_table(event)

    if http_method == "GET" and path.endswith("/get_selected_dsa_problem_numbers"):
        return get_selected_dsa_problem_numbers(event)

    if http_method == "GET" and path.endswith("/get_dsa_problem_review_markdown"):
        return get_dsa_problem_review_markdown(event)

    if http_method == "POST" and path.endswith("/update_dsa_review_table"):
        return update_dsa_review_table(event)

    if http_method == "GET" and path.endswith("/dsa-review/tracker"):
        return get_dsa_tracker(event)

    return _respond(404, {"error": "Route not found"})

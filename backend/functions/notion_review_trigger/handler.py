"""
Notion Review Trigger – Lambda Handler
Fetches review topics from Notion and (optionally) triggers an LLM summary.
"""
from __future__ import annotations

import json
import logging
import os

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
    return {
        "statusCode": status_code,
        "headers": _cors_headers(),
        "body": json.dumps(body),
    }


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

def _get_topics(event: dict) -> dict:
    """Return the 5 most recent review topics."""
    # TODO: replace with real Notion API integration
    topics = [
        {"id": "1", "title": "AWS Lambda Best Practices", "status": "pending"},
        {"id": "2", "title": "CloudFront Cache Strategies", "status": "pending"},
        {"id": "3", "title": "React Server Components", "status": "in_progress"},
        {"id": "4", "title": "Cognito JWT Verification", "status": "completed"},
        {"id": "5", "title": "SAM Template Deep Dive", "status": "pending"},
    ]
    return _respond(200, {"topics": topics})


def _trigger_review(event: dict) -> dict:
    """Trigger an LLM-based review for the requested topic."""
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _respond(400, {"error": "Invalid JSON body"})

    topic_id = body.get("topicId")
    if not topic_id:
        return _respond(400, {"error": "topicId is required"})

    # TODO: invoke Bedrock / OpenAI and update Notion
    logger.info("LLM review triggered for topic %s", topic_id)
    return _respond(202, {"message": "Review triggered", "topicId": topic_id})


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

    if http_method == "POST" and path.endswith("/trigger"):
        return _trigger_review(event)

    return _respond(404, {"error": "Route not found"})

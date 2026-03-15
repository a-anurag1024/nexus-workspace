"""
DSA Review sub-app for the notion_review_trigger Lambda.

Handles four endpoints that bridge the frontend with DSA review data stored in S3:
  - GET  /dsa-review/fetch_dsa_review_table
  - GET  /dsa-review/get_selected_dsa_problem_numbers
  - GET  /dsa-review/get_dsa_problem_review_markdown
  - POST /dsa-review/update_dsa_review_table

CSV schema (dsa_review/problems_table.csv):
  problem_number, problem_tag, leetcode_url, summary_file,
  number_of_times_unanswered, last_reviewed, number_of_times_reviewed
"""
from __future__ import annotations

import csv
import io
import json
import logging
import math
import os
import random
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

_PROBLEMS_TABLE_KEY = "dsa_review/problems_table.csv"
_SUMMARIES_PREFIX = "dsa_review/summaries"
_DSA_REVIEWS_PREFIX = "dsa_review/reviews"
_CSV_COLUMNS = [
    "problem_number",
    "problem_tag",
    "leetcode_url",
    "summary_file",
    "number_of_times_unanswered",
    "last_reviewed",
    "number_of_times_reviewed",
]

# ---------------------------------------------------------------------------
# Shared response helpers (intentionally self-contained to avoid circular imports)
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


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------

def _get_bucket() -> str:
    value = (os.environ.get("REVIEW_TRACKING_BUCKET_NAME") or "").strip()
    if not value:
        raise RuntimeError(
            "Missing required environment variable: REVIEW_TRACKING_BUCKET_NAME"
        )
    return value


def _dsa_tracking_s3_key(year: int, month: int) -> str:
    return f"{_DSA_REVIEWS_PREFIX}/{year:04d}/{month:02d}.json"


def _read_dsa_tracking_file(s3: Any, bucket: str, key: str) -> dict:
    """Read a monthly DSA tracking JSON from S3. Returns empty structure on miss."""
    try:
        resp = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(resp["Body"].read())
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "NoSuchKey":
            return {"version": 1, "days": {}}
        logger.warning("Could not read DSA tracking file s3://%s/%s: %s", bucket, key, exc)
        return {"version": 1, "days": {}}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read DSA tracking file s3://%s/%s: %s", bucket, key, exc)
        return {"version": 1, "days": {}}


def _write_dsa_tracking_file(s3: Any, bucket: str, key: str, data: dict) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, ensure_ascii=False).encode(),
        ContentType="application/json",
    )


def _read_problems_table(s3: Any, bucket: str) -> list[dict]:
    """Read problems_table.csv from S3 and return as a list of typed dicts."""
    try:
        resp = s3.get_object(Bucket=bucket, Key=_PROBLEMS_TABLE_KEY)
        csv_text = resp["Body"].read().decode("utf-8-sig")
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "NoSuchKey":
            return []
        raise

    rows: list[dict] = []
    reader = csv.DictReader(io.StringIO(csv_text))
    for row in reader:
        rows.append(
            {
                "problem_number": int(row.get("problem_number") or 0),
                "problem_tag": row.get("problem_tag") or "",
                "leetcode_url": row.get("leetcode_url") or "",
                "summary_file": row.get("summary_file") or "",
                "number_of_times_unanswered": int(
                    row.get("number_of_times_unanswered") or 0
                ),
                "last_reviewed": row.get("last_reviewed") or "",
                "number_of_times_reviewed": int(
                    row.get("number_of_times_reviewed") or 0
                ),
            }
        )
    return rows


def _write_problems_table(s3: Any, bucket: str, rows: list[dict]) -> None:
    """Serialize rows back to CSV and upload to S3."""
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=_CSV_COLUMNS)
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {
                "problem_number": row["problem_number"],
                "problem_tag": row["problem_tag"],
                "leetcode_url": row["leetcode_url"],
                "summary_file": row["summary_file"],
                "number_of_times_unanswered": row["number_of_times_unanswered"],
                "last_reviewed": row["last_reviewed"],
                "number_of_times_reviewed": row["number_of_times_reviewed"],
            }
        )
    s3.put_object(
        Bucket=bucket,
        Key=_PROBLEMS_TABLE_KEY,
        Body=output.getvalue().encode("utf-8"),
        ContentType="text/csv",
    )


# ---------------------------------------------------------------------------
# Selection algorithm
# ---------------------------------------------------------------------------

def _select_problems(
    rows: list[dict], min_count: int = 5, max_count: int = 8
) -> list[dict]:
    """Three-phase weighted random selection.

    Phase 1 – Staleness Filter (Bottom 33%):
      Sort all problems by last_reviewed ascending; treat empty/null as oldest.
      Slice the stale 33% as the Candidate Pool.

    Phase 2 – Difficulty Weighting:
      weight = 1 + number_of_times_unanswered  (baseline of 1 for all).

    Phase 3 – Weighted Random Sample:
      Draw 5–8 unique problems from the Candidate Pool using the weights.
    """
    if not rows:
        return []

    # Phase 1
    def _sort_key(r: dict) -> str:
        val = (r.get("last_reviewed") or "").strip()
        return val if val else "0000-00-00"

    sorted_rows = sorted(rows, key=_sort_key)
    candidate_count = max(1, math.ceil(len(sorted_rows) * 0.33))
    candidates = sorted_rows[:candidate_count]

    # Phase 2
    weights = [1 + r["number_of_times_unanswered"] for r in candidates]

    # Phase 3 – weighted sample with replacement, then deduplicate
    k = min(max_count, len(candidates))
    # random.choices allows duplicates; we draw a slightly larger pool to fill gaps
    draw_size = min(k * 3, len(candidates) * 3)
    drawn = random.choices(candidates, weights=weights, k=draw_size)

    seen: set[int] = set()
    unique: list[dict] = []
    for item in drawn:
        pn = item["problem_number"]
        if pn not in seen:
            seen.add(pn)
            unique.append(item)
            if len(unique) == k:
                break

    # If we still came up short (very small pool), fill from remaining candidates
    if len(unique) < min(min_count, len(candidates)):
        remaining = [c for c in candidates if c["problem_number"] not in seen]
        for c in remaining:
            unique.append(c)
            if len(unique) >= min(min_count, len(candidates)):
                break

    return unique


# ---------------------------------------------------------------------------
# Endpoint handlers
# ---------------------------------------------------------------------------

def fetch_dsa_review_table(event: dict) -> dict:
    """GET /dsa-review/fetch_dsa_review_table

    Returns the full problems table as a JSON array.
    """
    try:
        bucket = _get_bucket()
        s3 = boto3.client("s3")
        rows = _read_problems_table(s3, bucket)
    except RuntimeError as exc:
        return _respond(500, {"error": str(exc)})
    except ClientError as exc:
        logger.exception("S3 error reading DSA review table")
        return _respond(502, {"error": "S3 error", "details": str(exc)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error reading DSA review table")
        return _respond(500, {"error": "Internal error", "details": str(exc)})

    return _respond(200, {"problems": rows, "count": len(rows)})


def get_selected_dsa_problem_numbers(event: dict) -> dict:
    """GET /dsa-review/get_selected_dsa_problem_numbers

    Runs the three-phase selection algorithm and returns 5–8 problems
    with their leetcode links and review stats.
    """
    try:
        bucket = _get_bucket()
        s3 = boto3.client("s3")
        rows = _read_problems_table(s3, bucket)
    except RuntimeError as exc:
        return _respond(500, {"error": str(exc)})
    except ClientError as exc:
        logger.exception("S3 error reading DSA review table for selection")
        return _respond(502, {"error": "S3 error", "details": str(exc)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error selecting DSA problems")
        return _respond(500, {"error": "Internal error", "details": str(exc)})

    selected = _select_problems(rows)
    payload = [
        {
            "problem_number": r["problem_number"],
            "problem_tag": r["problem_tag"],
            "leetcode_url": r["leetcode_url"],
            "number_of_times_unanswered": r["number_of_times_unanswered"],
            "last_reviewed": r["last_reviewed"],
            "number_of_times_reviewed": r["number_of_times_reviewed"],
        }
        for r in selected
    ]
    return _respond(200, {"selected_problems": payload, "count": len(payload)})


def get_dsa_problem_review_markdown(event: dict) -> dict:
    """GET /dsa-review/get_dsa_problem_review_markdown?problem_number=X&problem_tag=Y

    Returns the raw markdown content for the requested problem's summary file
    from s3://<bucket>/dsa_review/summaries/<problem_number>.<problem_tag>.md
    """
    params = event.get("queryStringParameters") or {}
    problem_number = (params.get("problem_number") or "").strip()
    problem_tag = (params.get("problem_tag") or "").strip()

    if not problem_number:
        return _respond(400, {"error": "problem_number query parameter is required"})
    if not problem_tag:
        return _respond(400, {"error": "problem_tag query parameter is required"})

    # Sanitize inputs to prevent path traversal
    for val, label in ((problem_number, "problem_number"), (problem_tag, "problem_tag")):
        if any(c in val for c in ("/", "\\", "..")):
            return _respond(400, {"error": f"Invalid characters in {label}"})

    md_key = f"{_SUMMARIES_PREFIX}/{problem_number}.{problem_tag}.md"

    try:
        bucket = _get_bucket()
        s3 = boto3.client("s3")
        resp = s3.get_object(Bucket=bucket, Key=md_key)
        markdown_content = resp["Body"].read().decode("utf-8")
    except RuntimeError as exc:
        return _respond(500, {"error": str(exc)})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "NoSuchKey":
            return _respond(
                404,
                {
                    "error": "Markdown file not found",
                    "problem_number": problem_number,
                    "problem_tag": problem_tag,
                },
            )
        logger.exception(
            "S3 error reading markdown for problem %s (%s)", problem_number, problem_tag
        )
        return _respond(502, {"error": "S3 error", "details": str(exc)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error reading DSA markdown")
        return _respond(500, {"error": "Internal error", "details": str(exc)})

    return _respond(
        200,
        {
            "problem_number": int(problem_number),
            "problem_tag": problem_tag,
            "markdown": markdown_content,
        },
    )


def update_dsa_review_table(event: dict) -> dict:
    """POST /dsa-review/update_dsa_review_table

    Request body:
      {
        "reviewed_at": "YYYY-MM-DD",   // optional; defaults to today UTC
        "results": [
          { "problem_number": 42, "answered": true },
          { "problem_number": 17, "answered": false }
        ]
      }

    For each problem:
      - last_reviewed  → set to reviewed_at
      - number_of_times_reviewed  → incremented by 1
      - number_of_times_unanswered → incremented by 1 when answered is false
    """
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _respond(400, {"error": "Invalid JSON body"})

    results_input = body.get("results")
    if not isinstance(results_input, list) or not results_input:
        return _respond(400, {"error": "'results' must be a non-empty list"})

    reviewed_at = (body.get("reviewed_at") or "").strip()
    if not reviewed_at:
        reviewed_at = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    else:
        try:
            datetime.strptime(reviewed_at, "%Y-%m-%d")
        except ValueError:
            return _respond(400, {"error": "reviewed_at must be in YYYY-MM-DD format"})

    # Build {problem_number: answered} lookup
    updates: dict[int, bool] = {}
    for entry in results_input:
        if not isinstance(entry, dict):
            return _respond(
                400, {"error": "Each entry in 'results' must be an object"}
            )
        try:
            pn = int(entry["problem_number"])
        except (KeyError, TypeError, ValueError):
            return _respond(
                400,
                {"error": "Each result must have an integer 'problem_number'"},
            )
        updates[pn] = bool(entry.get("answered", True))

    try:
        bucket = _get_bucket()
        s3 = boto3.client("s3")
        rows = _read_problems_table(s3, bucket)
    except RuntimeError as exc:
        return _respond(500, {"error": str(exc)})
    except ClientError as exc:
        logger.exception("S3 error reading DSA review table for update")
        return _respond(502, {"error": "S3 error", "details": str(exc)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error reading DSA review table for update")
        return _respond(500, {"error": "Internal error", "details": str(exc)})

    matched_pns: set[int] = set()
    for row in rows:
        pn = row["problem_number"]
        if pn in updates:
            row["last_reviewed"] = reviewed_at
            row["number_of_times_reviewed"] += 1
            if not updates[pn]:  # answered == False → it was unanswered
                row["number_of_times_unanswered"] += 1
            matched_pns.add(pn)

    not_found = [pn for pn in updates if pn not in matched_pns]

    # Build tracker entries for matched problems
    matched_rows = [r for r in rows if r["problem_number"] in matched_pns]
    tracker_entries = [
        {
            "problem_number": r["problem_number"],
            "problem_tag": r["problem_tag"],
            "answered": updates[r["problem_number"]],
        }
        for r in matched_rows
    ]

    try:
        _write_problems_table(s3, bucket, rows)
    except ClientError as exc:
        logger.exception("S3 error writing DSA review table")
        return _respond(502, {"error": "S3 write error", "details": str(exc)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error writing DSA review table")
        return _respond(500, {"error": "Internal error", "details": str(exc)})

    # Write monthly tracking file
    tracker_errors: list[str] = []
    try:
        review_date = datetime.strptime(reviewed_at, "%Y-%m-%d")
        tracking_key = _dsa_tracking_s3_key(review_date.year, review_date.month)
        tracking_data = _read_dsa_tracking_file(s3, bucket, tracking_key)
        days: dict = tracking_data.setdefault("days", {})
        day_entries: list = days.setdefault(reviewed_at, [])
        existing_pns = {e.get("problem_number") for e in day_entries}
        for entry in tracker_entries:
            if entry["problem_number"] not in existing_pns:
                day_entries.append(entry)
        tracking_data["version"] = 1
        tracking_data["year"] = review_date.year
        tracking_data["month"] = review_date.month
        _write_dsa_tracking_file(s3, bucket, tracking_key, tracking_data)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to update DSA S3 tracker")
        tracker_errors.append(str(exc))

    response_body: dict[str, Any] = {
        "message": "Review table updated",
        "reviewed_at": reviewed_at,
        "updated_count": len(matched_pns),
    }
    if not_found:
        response_body["not_found"] = not_found
    if tracker_errors:
        response_body["tracker_errors"] = tracker_errors
        return _respond(207, response_body)

    return _respond(200, response_body)


def get_dsa_tracker(event: dict) -> dict:
    """GET /dsa-review/tracker

    Returns monthly DSA review tracking data for the calendar UI.

    Query params:
      year  – 4-digit integer (default: current UTC year)
      month – 1–12            (default: current UTC month)

    Response shape:
      {
        "year": 2026,
        "month": 3,
        "days": {
          "2026-03-15": [
            { "problem_number": 1, "problem_tag": "merge_sorted_array", "answered": true }
          ]
        },
        "reviewedDates": ["2026-03-15"],
        "totalProblemsReviewed": 1
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
        bucket = _get_bucket()
        s3 = boto3.client("s3")
        key = _dsa_tracking_s3_key(year, month)
        tracking_data = _read_dsa_tracking_file(s3, bucket, key)
    except RuntimeError as exc:
        return _respond(500, {"error": str(exc)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to read DSA tracker data")
        return _respond(500, {"error": "Failed to read DSA tracker", "details": str(exc)})

    days: dict = tracking_data.get("days") or {}
    reviewed_dates = sorted(days.keys())
    total_problems = sum(len(v) for v in days.values())

    return _respond(
        200,
        {
            "year": year,
            "month": month,
            "days": days,
            "reviewedDates": reviewed_dates,
            "totalProblemsReviewed": total_problems,
        },
    )

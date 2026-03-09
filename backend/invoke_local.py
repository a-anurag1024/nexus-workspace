#!/usr/bin/env python3
"""
invoke_local.py — Run any Lambda handler directly for quick dev testing.

Usage:
  python invoke_local.py <FunctionName> [event-file.json] [--mock-aws]

FunctionName must match a key in env.json.

Examples:
  python invoke_local.py NotionReviewFunctionLocal events/trigger_get_topics.json --mock-aws
  python invoke_local.py NotionReviewFunctionLocal events/trigger_post_trigger.json --mock-aws
  python invoke_local.py NotionReviewFunctionLocal events/trigger_log_review.json --mock-aws
  python invoke_local.py NotionReviewFunctionLocal events/trigger_get_tracker.json --mock-aws
  python invoke_local.py NotionReviewWorkerFunction events/worker_process_job.json --mock-aws
  python invoke_local.py TokenAuthorizerFunction events/authorizer_valid_token.json --mock-aws

Without --mock-aws, boto3 calls go to real AWS (or LocalStack if AWS_ENDPOINT_URL is set in env.json).
With --mock-aws, DynamoDB / SQS / SSM are replaced by in-memory stubs — no AWS needed at all.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

BASE_DIR = Path(__file__).parent

# Map env.json function keys → source directories (relative to BASE_DIR).
FUNCTION_DIRS: dict[str, str] = {
    "NotionReviewFunction":       "functions/notion_review_trigger",
    "NotionReviewFunctionLocal":  "functions/notion_review_trigger",
    "NotionReviewWorkerFunction": "functions/notion_review_worker",
    "TokenAuthorizerFunction":    "functions/token_authorizer",
}


# ---------------------------------------------------------------------------
# Environment setup
# ---------------------------------------------------------------------------

def _load_env(function_name: str) -> None:
    env_file = BASE_DIR / "env.json"
    if not env_file.exists():
        print(f"[warn] env.json not found at {env_file}")
        return

    with env_file.open() as f:
        all_env = json.load(f)

    env_vars = all_env.get(function_name)
    if env_vars is None:
        available = ", ".join(all_env.keys())
        print(f"[warn] '{function_name}' not in env.json. Available: {available}")
        return

    for k, v in env_vars.items():
        os.environ.setdefault(k, str(v))

    print(f"[info] Loaded {len(env_vars)} env vars for '{function_name}'")


# ---------------------------------------------------------------------------
# In-memory AWS mocks (--mock-aws)
# ---------------------------------------------------------------------------

class _MockDynamoTable:
    def __init__(self, name: str) -> None:
        self._name = name

    def put_item(self, *, Item: dict, **_: Any) -> dict:
        print(f"[mock dynamo:{self._name}] put_item\n{json.dumps(Item, indent=2, default=str)}")
        return {}

    def get_item(self, *, Key: dict, **_: Any) -> dict:
        print(f"[mock dynamo:{self._name}] get_item Key={Key}  → returning empty Item")
        return {"Item": {}}

    def update_item(self, *, Key: dict, UpdateExpression: str = "", **kwargs: Any) -> dict:
        print(f"[mock dynamo:{self._name}] update_item Key={Key}  expr='{UpdateExpression}'")
        if kwargs.get("ExpressionAttributeValues"):
            print(f"  values: {json.dumps(kwargs['ExpressionAttributeValues'], indent=2, default=str)}")
        return {}


class _MockDynamoResource:
    def Table(self, name: str) -> _MockDynamoTable:  # noqa: N802
        return _MockDynamoTable(name)


class _MockSQSClient:
    def send_message(self, **kwargs: Any) -> dict:
        print(f"[mock sqs] send_message\n{json.dumps(kwargs, indent=2, default=str)}")
        return {"MessageId": "mock-msg-00000000-0000-0000-0000-000000000000"}

    def create_queue(self, **kwargs: Any) -> dict:
        return {"QueueUrl": "http://mock-sqs/queue"}


class _MockSSMClient:
    def get_parameter(self, *, Name: str, WithDecryption: bool = False, **_: Any) -> dict:
        # Falls back to LOCAL_EXPECTED_TOKEN env var, which can be set in env.json.
        value = os.environ.get("LOCAL_EXPECTED_TOKEN", "local-test-token")
        print(f"[mock ssm] get_parameter Name={Name!r} → {value!r}")
        return {"Parameter": {"Value": value}}


class _MockS3Client:
    """In-memory stub for the S3 client used by the review tracker."""

    def __init__(self) -> None:
        self._store: dict[str, bytes] = {}  # key → raw bytes

    def get_object(self, *, Bucket: str, Key: str, **_: Any) -> dict:
        full_key = f"{Bucket}/{Key}"
        if full_key not in self._store:
            from botocore.exceptions import ClientError  # noqa: PLC0415
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "The specified key does not exist."}},
                "GetObject",
            )
        data = self._store[full_key]
        print(f"[mock s3] get_object s3://{Bucket}/{Key} ({len(data)} bytes)")
        import io  # noqa: PLC0415
        return {"Body": io.BytesIO(data)}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **_: Any) -> dict:
        full_key = f"{Bucket}/{Key}"
        self._store[full_key] = Body if isinstance(Body, bytes) else Body.encode()
        try:
            parsed = json.loads(self._store[full_key])
            print(f"[mock s3] put_object s3://{Bucket}/{Key}\n{json.dumps(parsed, indent=2)}")
        except Exception:  # noqa: BLE001
            print(f"[mock s3] put_object s3://{Bucket}/{Key} ({len(self._store[full_key])} bytes)")
        return {}


# Shared S3 mock instance so get → put round-trips work within one invocation.
_mock_s3 = _MockS3Client()


def _apply_boto3_mocks() -> None:
    import unittest.mock as mock
    import boto3 as _boto3

    _resource_map: dict[str, Any] = {"dynamodb": _MockDynamoResource()}
    _client_map: dict[str, Any] = {"sqs": _MockSQSClient(), "ssm": _MockSSMClient(), "s3": _mock_s3}

    def mock_resource(service: str, **_: Any) -> Any:
        if service not in _resource_map:
            print(f"[mock boto3] resource({service!r}) — no dedicated mock, using MagicMock")
            return mock.MagicMock()
        return _resource_map[service]

    def mock_client(service: str, **_: Any) -> Any:
        if service not in _client_map:
            print(f"[mock boto3] client({service!r}) — no dedicated mock, using MagicMock")
            return mock.MagicMock()
        return _client_map[service]

    _boto3.resource = mock_resource  # type: ignore[method-assign]
    _boto3.client = mock_client  # type: ignore[method-assign]
    print("[info] boto3 mocks applied (DynamoDB resource, SQS client, SSM client, S3 client)")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Invoke a Lambda handler locally without containers.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("function", help="Function name — must match a key in env.json")
    parser.add_argument("event", nargs="?", default=None, help="Path to event JSON file (relative to backend/)")
    parser.add_argument(
        "--mock-aws",
        action="store_true",
        help="Replace DynamoDB/SQS/SSM boto3 calls with in-memory stubs (no AWS required)",
    )
    args = parser.parse_args()

    # Resolve function source directory.
    func_dir_rel = FUNCTION_DIRS.get(args.function)
    if func_dir_rel is None:
        available = "\n  ".join(FUNCTION_DIRS.keys())
        print(f"[error] Unknown function '{args.function}'.\nAvailable:\n  {available}")
        sys.exit(1)

    func_dir = BASE_DIR / func_dir_rel
    layer_dir = BASE_DIR / "layers" / "common" / "python"

    # Prepend to sys.path so local source overrides any installed versions.
    for p in (str(func_dir), str(layer_dir)):
        if p not in sys.path:
            sys.path.insert(0, p)

    # Load env vars from env.json.
    _load_env(args.function)

    # Patch boto3 before importing the handler so all calls go to mocks.
    if args.mock_aws:
        _apply_boto3_mocks()

    # Load event JSON.
    if args.event:
        event_path = Path(args.event) if Path(args.event).is_absolute() else BASE_DIR / args.event
        with event_path.open() as f:
            event = json.load(f)
        print(f"[info] Event loaded from '{event_path.name}'")
    else:
        event = {}
        print("[info] No event file — using empty event {}")

    # Minimal Lambda context stub.
    context = SimpleNamespace(
        function_name=args.function,
        function_version="$LATEST",
        invoked_function_arn=f"arn:aws:lambda:local:000000000000:function:{args.function}",
        memory_limit_in_mb=256,
        aws_request_id="local-invoke-00000000-0000-0000-0000-000000000000",
        log_group_name=f"/aws/lambda/{args.function}",
        log_stream_name="local",
        get_remaining_time_in_millis=lambda: 30_000,
    )

    # Route Lambda logger output to stdout.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s", stream=sys.stdout)

    # Import handler fresh from the source file (avoids stale module caches).
    handler_file = func_dir / "handler.py"
    spec = importlib.util.spec_from_file_location("handler", handler_file)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]

    divider = "=" * 60
    print(f"\n{divider}")
    print(f"  Invoking {args.function}::lambda_handler")
    print(f"{divider}\n")

    result = module.lambda_handler(event, context)

    print(f"\n{divider}")
    print("  Result:")
    print(json.dumps(result, indent=2, default=str))
    print(divider)


if __name__ == "__main__":
    main()

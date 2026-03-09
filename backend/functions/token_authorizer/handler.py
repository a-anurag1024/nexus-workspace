"""
Personal token authorizer – Lambda handler.

Validates the Bearer token in the Authorization header against the value
stored in AWS SSM Parameter Store (SecureString).  The SSM value is cached
in-process for the Lambda container lifetime, so SSM is hit at most once per
cold start (API Gateway also caches the Allow policy for ReauthorizeEvery
seconds, further reducing calls).
"""
from __future__ import annotations

import hmac
import logging
import os

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_cached_token: str | None = None


def _get_expected_token() -> str:
    global _cached_token  # noqa: PLW0603
    if _cached_token is not None:
        return _cached_token
    ssm = boto3.client("ssm")
    path = os.environ["SSM_TOKEN_PATH"]
    resp = ssm.get_parameter(Name=path, WithDecryption=True)
    _cached_token = resp["Parameter"]["Value"]
    return _cached_token


def _build_policy(effect: str, method_arn: str) -> dict:
    # Wildcard stage + method so one cached policy covers all endpoints.
    # method_arn: arn:aws:execute-api:<region>:<acct>:<api-id>/<stage>/<method>/<path>
    parts = method_arn.split(":")
    api_part = parts[5].split("/")  # ['api-id', 'stage', 'method', ...]
    wildcard_arn = ":".join(parts[:5]) + ":" + api_part[0] + "/" + api_part[1] + "/*/*"
    return {
        "principalId": "owner",
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Action": "execute-api:Invoke",
                    "Effect": effect,
                    "Resource": wildcard_arn,
                }
            ],
        },
    }


def lambda_handler(event: dict, context) -> dict:  # noqa: ANN001
    raw: str = event.get("authorizationToken", "")
    # Strip "Bearer " prefix (case-insensitive).
    if raw.lower().startswith("bearer "):
        incoming = raw[7:].strip()
    else:
        incoming = raw.strip()

    method_arn: str = event.get("methodArn", "")

    try:
        expected = _get_expected_token()
    except Exception:
        logger.exception("Failed to retrieve token from SSM")
        raise Exception("Unauthorized")  # noqa: TRY301

    # hmac.compare_digest prevents timing-based token enumeration.
    if hmac.compare_digest(incoming.encode(), expected.encode()):
        return _build_policy("Allow", method_arn)

    logger.warning("Authorizer: invalid token presented")
    return _build_policy("Deny", method_arn)

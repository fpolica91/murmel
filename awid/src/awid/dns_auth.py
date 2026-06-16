"""Shared auth and validation helpers for DNS-backed awid routes."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from fastapi import HTTPException, Request

from awid.did import validate_did
from awid.signing import canonical_json_bytes, verify_did_key_signature

logger = logging.getLogger(__name__)

_REPLAY_TTL_SECONDS = 300


def parse_didkey_auth(authorization: str | None) -> tuple[str, str]:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    parts = authorization.split(" ")
    if len(parts) != 3 or parts[0] != "DIDKey":
        raise HTTPException(
            status_code=401,
            detail="Authorization must be: DIDKey <did:key> <signature>",
        )
    return parts[1], parts[2]


def require_timestamp(request: Request, *, header_name: str = "X-AWEB-Timestamp") -> str:
    value = request.headers.get(header_name)
    if not value:
        raise HTTPException(status_code=401, detail=f"Missing {header_name} header")
    return value


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def enforce_timestamp_skew(ts: str, *, max_delta_seconds: int = 300) -> None:
    try:
        normalized = ts.strip()
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            raise HTTPException(status_code=401, detail="Timestamp must include timezone")
        dt = dt.astimezone(timezone.utc)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Malformed timestamp")
    delta = abs((_utc_now() - dt).total_seconds())
    if delta > max_delta_seconds:
        raise HTTPException(status_code=401, detail="Timestamp outside allowed skew window")


async def _enforce_single_use(request: Request, *, did_key: str, signature: str) -> None:
    """Reject a signature already seen inside the skew window (replay).

    Uses the app's Redis as a single-use cache keyed on (did_key, signature)
    with TTL == skew window. No Redis configured (e.g. tests) → no-op.
    """
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return
    digest = hashlib.sha256(f"{did_key}:{signature}".encode("utf-8")).hexdigest()
    key = f"awid:replay:{digest}"
    try:
        was_set = await redis.set(key, "1", nx=True, ex=_REPLAY_TTL_SECONDS)
    except Exception:  # pragma: no cover - replay cache must not block on Redis hiccups
        logger.warning("Replay cache unavailable; allowing request", exc_info=True)
        return
    if not was_set:
        raise HTTPException(status_code=401, detail="Replayed signature")


async def verify_signed_json_request(
    request: Request,
    *,
    payload_dict: dict[str, str],
    authorization_header: str = "Authorization",
    timestamp_header: str = "X-AWEB-Timestamp",
) -> str:
    did_key, sig = parse_didkey_auth(request.headers.get(authorization_header))
    timestamp = require_timestamp(request, header_name=timestamp_header)
    enforce_timestamp_skew(timestamp)

    payload = canonical_json_bytes(payload_dict | {"timestamp": timestamp})
    try:
        verify_did_key_signature(did_key=did_key, payload=payload, signature_b64=sig)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid signature")
    await _enforce_single_use(request, did_key=did_key, signature=sig)
    return did_key


def validate_did_key(value: str) -> str:
    normalized = (value or "").strip()
    if not validate_did(normalized):
        raise ValueError("must be a valid did:key Ed25519 identifier")
    return normalized

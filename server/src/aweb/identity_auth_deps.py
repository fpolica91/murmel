from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from awid.dns_auth import enforce_timestamp_skew, parse_didkey_auth, require_timestamp
from awid.signing import canonical_json_bytes, verify_did_key_signature
from aweb.deps import get_db
from aweb.messaging.alias_targets import derive_team_address
from aweb.team_auth_deps import TeamIdentity, _aweb_db, get_team_identity

logger = logging.getLogger(__name__)

IDENTITY_DID_AW_HEADER = "X-AWEB-DID-AW"


@dataclass(frozen=True)
class IdentityAuth:
    did_key: str
    did_aw: str | None
    address: str | None


@dataclass(frozen=True)
class MessagingAuth:
    did_key: str
    did_aw: str | None
    address: str | None
    team_id: str | None = None
    alias: str | None = None
    agent_id: str | None = None
    identity_scope: str | None = None
    certificate_id: str | None = None
    verified_team_id: str | None = None


def auth_dids(identity: IdentityAuth | MessagingAuth) -> list[str]:
    dids: list[str] = []
    for value in ((getattr(identity, "did_aw", None) or "").strip(), (getattr(identity, "did_key", None) or "").strip()):
        if value and value not in dids:
            dids.append(value)
    return dids


def _get_body_sha256(request: Request) -> str:
    body_sha256 = getattr(request.state, "body_sha256", None)
    if body_sha256 is not None:
        return body_sha256
    return hashlib.sha256(b"").hexdigest()


async def resolve_identity_auth(request: Request) -> IdentityAuth:
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    did_key, signature_b64 = parse_didkey_auth(auth_header)
    timestamp = require_timestamp(request)
    enforce_timestamp_skew(timestamp)

    did_aw = (request.headers.get(IDENTITY_DID_AW_HEADER) or "").strip()
    payload = canonical_json_bytes(
        {
            "body_sha256": _get_body_sha256(request),
            "did_aw": did_aw,
            "timestamp": timestamp,
        }
    )
    try:
        verify_did_key_signature(did_key=did_key, payload=payload, signature_b64=signature_b64)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid DIDKey signature") from exc

    if not did_aw:
        return IdentityAuth(did_key=did_key, did_aw=None, address=None)

    registry_client = getattr(request.app.state, "awid_registry_client", None)
    if registry_client is None:
        raise HTTPException(status_code=503, detail="AWID registry client not configured")

    try:
        resolution = await registry_client.resolve_key(did_aw)
    except Exception as exc:
        logger.warning("AWID registry unavailable for did:aw resolution: %s", did_aw, exc_info=True)
        raise HTTPException(status_code=503, detail="AWID registry unavailable") from exc

    if resolution and resolution.current_did_key != did_key and hasattr(registry_client, "resolve_key_fresh"):
        try:
            resolution = await registry_client.resolve_key_fresh(did_aw)
        except Exception:
            logger.warning("AWID fresh did:aw resolution failed for %s", did_aw, exc_info=True)

    if not resolution or resolution.current_did_key != did_key:
        raise HTTPException(status_code=401, detail="did:aw does not match Authorization did:key")

    address = None
    try:
        addresses = await registry_client.list_did_addresses(did_aw)
    except Exception:
        addresses = []
    if addresses:
        first = addresses[0]
        address = f"{first.domain}/{first.name}"

    return IdentityAuth(did_key=did_key, did_aw=did_aw, address=address)


async def get_identity_auth(request: Request, db=Depends(get_db)) -> IdentityAuth:
    del db
    return await resolve_identity_auth(request)


async def lookup_identity_agent_context(
    db,
    *,
    did_key: str,
    did_aw: str | None = None,
    allow_ambiguous_global_identity: bool = False,
) -> dict | None:
    did_aw_value = (did_aw or "").strip()
    aweb_db = _aweb_db(db)
    rows = await aweb_db.fetch_all(
        """
        SELECT agent_id, team_id, alias, did_aw, address, identity_scope
        FROM {{tables.agents}}
        WHERE deleted_at IS NULL
          AND (did_key = $1 OR ($2 <> '' AND did_aw = $2))
        ORDER BY created_at DESC
        LIMIT 2
        """,
        did_key,
        did_aw_value,
    )
    if not rows:
        return None
    if len(rows) > 1:
        if allow_ambiguous_global_identity and did_aw_value:
            return None
        raise HTTPException(status_code=409, detail="Authenticated DID matches multiple active local agents")
    return dict(rows[0])


def _jwt_synthetic_did_key(subject: str) -> str:
    """Deterministic synthetic ``did:key`` for a Better-Auth JWT subject.

    The chat/messaging subsystem routes everything by DID. Token (Better Auth
    JWT) callers have no certificate DID, so we mint a stable per-subject
    synthetic DID. It is purely a local routing key — it is never published to
    AWID and never used for signature verification — so a plain, deterministic
    encoding keyed by the subject is sufficient and idempotent.
    """
    return f"did:key:jwt-{subject}"


async def provision_human_participant(
    db,
    *,
    team_id: str,
    subject: str,
    name: str | None = None,
    agent_name: str | None = None,
) -> dict | None:
    """Idempotently provision/refresh a human ``agents`` row for a JWT subject.

    A human becomes a first-class chat/comment/assignee participant simply by
    having a row in the ``agents`` (participant directory) table with
    ``agent_type='human'``. This is the single funnel every token-authenticated
    request goes through (chat, issues, comments, roster), so the human row
    exists before the first call and the human is immediately reachable and
    selectable.

    The row is keyed by a deterministic synthetic ``did_key``
    (``did:key:jwt-<subject>``), a local-only routing key that is never
    published to AWID. The upsert is idempotent on ``(team_id, did_key)`` and
    keeps ``alias``, ``human_name``, and ``address`` in sync with the caller's
    verified claims on every request.

    - ``alias`` = name claim || agent_name || subject (the team-unique selector
      used as chat ``to_aliases`` and issue ``assignee_id``).
    - ``human_name`` = name claim (falls back to alias when no name claim), so
      the roster shows a real display name rather than the raw auth subject.
    """
    aweb_db = _aweb_db(db)
    subject = (subject or "").strip()
    name = (name or "").strip()
    agent_name = (agent_name or "").strip()
    alias = name or agent_name or subject
    human_name = name or alias
    did_key = _jwt_synthetic_did_key(subject)
    # Advertise the DOMAIN form (``<domain>/<alias>``) that the recipient and
    # namespace resolvers expect, NOT the raw team_id form
    # (``<name>:<domain>/<alias>``). team_id "default:local" parses to
    # domain "local" + name "default", so a token human "Mia" is reachable at
    # "local/Mia" — which ``get_agent_by_namespace_alias`` resolves by joining
    # ``teams.namespace`` to the alias. The old ``f"{team_id}/{alias}"`` produced
    # "default:local/Mia", which no resolver could match.
    address = (derive_team_address(team_id, alias) or None) if alias else None
    row = await aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, alias, human_name, agent_type, identity_scope, address)
        VALUES ($1, $2, $3, $4, 'human', 'local', $5)
        ON CONFLICT (team_id, did_key) WHERE deleted_at IS NULL
        DO UPDATE SET alias = EXCLUDED.alias,
                      human_name = EXCLUDED.human_name,
                      address = EXCLUDED.address
        RETURNING agent_id, team_id, alias, human_name, did_key, address, identity_scope
        """,
        team_id,
        did_key,
        alias or subject,
        human_name,
        address,
    )
    return dict(row) if row else None


async def _ensure_token_agent(
    db,
    *,
    team_id: str,
    subject: str,
    alias: str,
    did_key: str,
) -> dict | None:
    """Backward-compatible shim over :func:`provision_human_participant`.

    Retained for the messaging path's existing call shape. ``alias`` here is
    already resolved to ``name || agent_name || subject`` by the caller, so we
    pass it through as the name claim to keep ``human_name`` populated.
    """
    del did_key  # derived deterministically from the subject inside the helper
    return await provision_human_participant(
        db,
        team_id=team_id,
        subject=subject,
        name=alias,
    )


async def get_messaging_auth(request: Request, db=Depends(get_db)) -> MessagingAuth:
    # Better Auth JWT (token) path: the rest of the server treats a bearer JWT
    # as the primary auth, so messaging must too. Token callers have no cert
    # DID, so we resolve them through the membership-scoped token identity and
    # back them with an idempotently-provisioned local agent row.
    from aweb.token_team_scope import resolve_token_team_identity

    if not request.headers.get("X-AWID-Team-Certificate"):
        token_identity = await resolve_token_team_identity(request, db)
        if token_identity is not None:
            subject = (token_identity.agent_id or "").strip()
            alias = (token_identity.alias or "").strip() or subject
            did_key = _jwt_synthetic_did_key(subject)
            agent_row = await _ensure_token_agent(
                db,
                team_id=token_identity.team_id,
                subject=subject,
                alias=alias,
                did_key=did_key,
            )
            return MessagingAuth(
                did_key=did_key,
                did_aw=None,
                address=(agent_row or {}).get("address"),
                team_id=token_identity.team_id,
                alias=alias,
                agent_id=str((agent_row or {}).get("agent_id")) if (agent_row or {}).get("agent_id") else None,
                identity_scope="token",
                verified_team_id=token_identity.team_id,
            )

    if request.headers.get("X-AWID-Team-Certificate"):
        team_identity: TeamIdentity = await get_team_identity(request, db)
        aweb_db = _aweb_db(db)
        row = await aweb_db.fetch_one(
            """
            SELECT did_aw, address
            FROM {{tables.agents}}
            WHERE agent_id = $1 AND deleted_at IS NULL
            """,
            team_identity.agent_id,
        )
        row_did_aw = (row.get("did_aw") if row else None) or None
        row_address = (row.get("address") if row else None) or None
        return MessagingAuth(
            did_key=team_identity.did_key,
            did_aw=team_identity.did_aw or row_did_aw,
            address=team_identity.address or row_address,
            team_id=team_identity.team_id,
            alias=team_identity.alias,
            agent_id=team_identity.agent_id,
            identity_scope=team_identity.identity_scope,
            certificate_id=team_identity.certificate_id,
            verified_team_id=team_identity.team_id,
        )

    identity = await resolve_identity_auth(request)
    # Identity-scoped messaging routes by DID/address; a global identity may
    # have multiple local team rows, so ambiguity must not force a team choice.
    row = await lookup_identity_agent_context(
        db,
        did_key=identity.did_key,
        did_aw=identity.did_aw,
        allow_ambiguous_global_identity=True,
    )
    return MessagingAuth(
        did_key=identity.did_key,
        did_aw=identity.did_aw or ((row or {}).get("did_aw") or None),
        address=identity.address or ((row or {}).get("address") or None),
        team_id=(row or {}).get("team_id") or None,
        alias=(row or {}).get("alias") or None,
        agent_id=(str((row or {}).get("agent_id")) if (row or {}).get("agent_id") else None),
        identity_scope=(row or {}).get("identity_scope") or None,
    )

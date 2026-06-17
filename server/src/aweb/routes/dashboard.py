"""Dashboard read endpoints for hosted dashboard clients.

Authenticated with X-Dashboard-Token (JWT containing team_ids).
All endpoints are read-only.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from uuid import UUID
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from awid.team_ids import parse_team_id
from aweb.claims import list_active_claims
from aweb.config import get_settings
from aweb.deps import get_db, get_redis
from aweb.events import (
    TeamAgentOfflineEvent,
    TeamAgentOnlineEvent,
    publish_team_event,
    team_events_channel_name,
)
from aweb.presence import get_workspace_ids_by_team_id, list_agent_presences_by_workspace_ids
from aweb.team_auth import verify_dashboard_token

router = APIRouter(tags=["dashboard"])
logger = logging.getLogger(__name__)

DASHBOARD_KEEPALIVE_SECONDS = 30.0
DASHBOARD_PRESENCE_POLL_SECONDS = 5.0
DASHBOARD_PUBSUB_POLL_SECONDS = 1.0


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


def _get_dashboard_secret(request: Request) -> str:
    secret = getattr(request.app.state, "dashboard_jwt_secret", None)
    if not secret:
        settings = get_settings()
        secret = settings.dashboard_jwt_secret
    return secret or ""


async def _require_dashboard_auth(request: Request, team_id: str) -> dict[str, Any]:
    """Resolve dashboard access. A valid X-Dashboard-Token grants authenticated
    (full) access on any team; otherwise a *public* team allows an anonymous
    read, flagged ``authenticated: False`` so content-bearing endpoints redact
    message bodies/subjects. Private teams require a valid token.
    """
    token = request.headers.get("X-Dashboard-Token")

    # A present token is authoritative — verify it first so an authenticated
    # member sees full content even on a public team.
    token_error: ValueError | None = None
    if token:
        secret = _get_dashboard_secret(request)
        try:
            claims = verify_dashboard_token(token, secret, required_team=team_id)
            claims["authenticated"] = True
            return claims
        except ValueError as e:
            if "not configured" in str(e):
                raise HTTPException(status_code=500, detail="Dashboard auth misconfigured")
            token_error = e  # may still fall through to a public anonymous read

    # No valid token — only public teams allow an anonymous (redacted) read.
    try:
        visibility = await _get_team_visibility(request, team_id)
    except HTTPException:
        if not token:
            raise
        visibility = "private"

    if visibility == "public":
        return {"user_id": "", "team_ids": [team_id], "authenticated": False}

    if token_error is not None:
        if "not authorized" in str(token_error):
            raise HTTPException(status_code=403, detail=str(token_error))
        raise HTTPException(status_code=401, detail=str(token_error))
    raise HTTPException(status_code=401, detail="Missing X-Dashboard-Token header")


async def _get_team_visibility(request: Request, team_id: str) -> str:
    try:
        domain, team_name = parse_team_id(team_id)
    except ValueError:
        return "private"

    registry_client = getattr(request.app.state, "awid_registry_client", None)
    if registry_client is None:
        raise HTTPException(status_code=503, detail="AWID registry unavailable")

    try:
        team = await registry_client.get_team(domain, team_name)
    except Exception:
        raise HTTPException(status_code=503, detail="AWID registry unavailable")

    if team is None:
        return "private"
    return getattr(team, "visibility", "private")


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class AgentSummary(BaseModel):
    agent_id: str
    alias: str
    did_key: str
    human_name: str
    address: Optional[str]
    agent_type: str
    role: str
    status: str
    identity_scope: str
    last_seen: Optional[str]
    workspace_path: Optional[str]
    created_at: str


class AgentDetail(BaseModel):
    agent_id: str
    alias: str
    did_key: str
    did_aw: Optional[str]
    address: Optional[str]
    role: str
    status: str
    identity_scope: str
    human_name: str
    agent_type: str
    created_at: str


class MessageSummary(BaseModel):
    message_id: str
    from_alias: str
    to_alias: str
    subject: str
    body: str
    priority: str
    created_at: str
    read_at: Optional[str]


class TeamStatus(BaseModel):
    team_id: str
    agent_count: int
    online_agents: list[str]
    active_claims: list[dict[str, Any]]
    active_locks: list[dict[str, Any]]


class UsageMetrics(BaseModel):
    team_id: str
    messages_sent: int
    active_agents: int
    since: Optional[str]
    until: Optional[str]


class DashboardClaimSummary(BaseModel):
    task_ref: str
    workspace_id: str
    alias: str
    claimed_at: str


class DashboardEventSnapshot(BaseModel):
    team_id: str
    online_aliases: list[str]
    active_claims: list[DashboardClaimSummary]
    timestamp: str


# ---------------------------------------------------------------------------
# Dashboard SSE helpers
# ---------------------------------------------------------------------------


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _format_sse(event_name: str, payload: dict[str, Any]) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload)}\n\n"


async def _list_online_aliases(redis, *, team_id: str) -> list[str]:
    workspace_ids = await get_workspace_ids_by_team_id(redis, team_id)
    if not workspace_ids:
        return []
    presences = await list_agent_presences_by_workspace_ids(redis, workspace_ids)
    aliases = {
        str(p.get("alias", "")).strip()
        for p in presences
        if str(p.get("alias", "")).strip() and str(p.get("team_id", "")).strip() == team_id
    }
    return sorted(aliases)


async def _build_dashboard_snapshot(db, redis, *, team_id: str) -> dict[str, Any]:
    online_aliases = await _list_online_aliases(redis, team_id=team_id)
    claim_rows = await list_active_claims(db, team_id=team_id, limit=200)
    snapshot = DashboardEventSnapshot(
        team_id=team_id,
        online_aliases=online_aliases,
        active_claims=[
            DashboardClaimSummary(
                task_ref=row["task_ref"],
                workspace_id=str(row["workspace_id"]),
                alias=row["alias"],
                claimed_at=row["claimed_at"].isoformat(),
            )
            for row in claim_rows
        ],
        timestamp=_utc_now_iso(),
    )
    return snapshot.model_dump()


async def _sse_dashboard_events(*, request: Request, db, redis, team_id: str):
    channel = team_events_channel_name(team_id)
    async with redis.pubsub() as pubsub:
        await pubsub.subscribe(channel)

        yield ": keepalive\n\n"
        yield _format_sse("connected", {"type": "connected", "team_id": team_id, "timestamp": _utc_now_iso()})

        snapshot = await _build_dashboard_snapshot(db, redis, team_id=team_id)
        yield _format_sse("snapshot", {"type": "snapshot", **snapshot})

        previous_online_aliases = set(snapshot["online_aliases"])
        loop = asyncio.get_running_loop()
        last_keepalive = loop.time()
        last_presence_poll = loop.time()

        while True:
            if await request.is_disconnected():
                return

            try:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=DASHBOARD_PUBSUB_POLL_SECONDS,
                )
            except Exception:
                logger.warning("Dashboard team-events pubsub read failed", exc_info=True)
                return

            now = loop.time()

            if message and message.get("type") == "message":
                raw_payload = message.get("data")
                if isinstance(raw_payload, bytes):
                    raw_payload = raw_payload.decode("utf-8")
                payload = json.loads(raw_payload)
                yield _format_sse(str(payload.get("type", "message")), payload)

            if now - last_presence_poll >= DASHBOARD_PRESENCE_POLL_SECONDS:
                current_online_aliases = set(await _list_online_aliases(redis, team_id=team_id))
                for alias in sorted(current_online_aliases - previous_online_aliases):
                    await publish_team_event(
                        redis,
                        TeamAgentOnlineEvent(
                            team_id=team_id,
                            alias=alias,
                        ),
                    )
                for alias in sorted(previous_online_aliases - current_online_aliases):
                    await publish_team_event(
                        redis,
                        TeamAgentOfflineEvent(
                            team_id=team_id,
                            alias=alias,
                        ),
                    )
                previous_online_aliases = current_online_aliases
                last_presence_poll = now

            if now - last_keepalive >= DASHBOARD_KEEPALIVE_SECONDS:
                yield ": keepalive\n\n"
                last_keepalive = now


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/v1/teams/{team_id:path}/agents")
async def list_team_agents(
    request: Request, team_id: str, db=Depends(get_db)
) -> dict:
    await _require_dashboard_auth(request, team_id)
    aweb_db = db.get_manager("aweb")

    rows = await aweb_db.fetch_all(
        """
        SELECT a.agent_id, a.alias, a.did_key, a.human_name, a.address, a.agent_type,
               a.role, a.status, a.identity_scope, a.created_at,
               w.last_seen_at, w.workspace_path
        FROM {{tables.agents}} a
        LEFT JOIN LATERAL (
            SELECT last_seen_at, workspace_path
            FROM {{tables.workspaces}}
            WHERE agent_id = a.agent_id AND team_id = a.team_id AND deleted_at IS NULL
            ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
            LIMIT 1
        ) w ON TRUE
        WHERE a.team_id = $1 AND a.deleted_at IS NULL
          AND COALESCE(a.agent_type, 'agent') != 'human'
        ORDER BY a.alias
        """,
        team_id,
    )

    return {
        "agents": [
            AgentSummary(
                agent_id=str(r["agent_id"]),
                alias=r["alias"],
                did_key=r["did_key"],
                human_name=r["human_name"],
                address=r.get("address"),
                agent_type=r["agent_type"],
                role=r["role"],
                status=r["status"],
                identity_scope=r["identity_scope"],
                last_seen=(r["last_seen_at"].isoformat() if r["last_seen_at"] else None),
                workspace_path=r["workspace_path"],
                created_at=r["created_at"].isoformat(),
            ).model_dump()
            for r in rows
        ]
    }


@router.get("/v1/teams/{team_id:path}/claims")
async def list_team_claims(
    request: Request,
    team_id: str,
    limit: int = Query(default=200, ge=1, le=200),
    db=Depends(get_db),
) -> dict:
    await _require_dashboard_auth(request, team_id)
    rows = await list_active_claims(db, team_id=team_id, limit=limit)
    return {
        "claims": [
            DashboardClaimSummary(
                task_ref=row["task_ref"],
                workspace_id=str(row["workspace_id"]),
                alias=row["alias"],
                claimed_at=row["claimed_at"].isoformat(),
            ).model_dump()
            for row in rows
        ]
    }


@router.get("/v1/teams/{team_id:path}/agents/{alias}")
async def get_team_agent(
    request: Request, team_id: str, alias: str, db=Depends(get_db)
) -> dict:
    await _require_dashboard_auth(request, team_id)
    aweb_db = db.get_manager("aweb")

    row = await aweb_db.fetch_one(
        """
        SELECT agent_id, alias, did_key, did_aw, address, role, status, identity_scope,
               human_name, agent_type, created_at
        FROM {{tables.agents}}
        WHERE team_id = $1 AND alias = $2 AND deleted_at IS NULL
          AND COALESCE(agent_type, 'agent') != 'human'
        """,
        team_id,
        alias,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")

    return AgentDetail(
        agent_id=str(row["agent_id"]),
        alias=row["alias"],
        did_key=row["did_key"],
        did_aw=row.get("did_aw"),
        address=row.get("address"),
        role=row["role"],
        status=row["status"],
        identity_scope=row["identity_scope"],
        human_name=row["human_name"],
        agent_type=row["agent_type"],
        created_at=row["created_at"].isoformat(),
    ).model_dump()


@router.get("/v1/teams/{team_id:path}/messages")
async def list_team_messages(
    request: Request,
    team_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    db=Depends(get_db),
) -> dict:
    auth = await _require_dashboard_auth(request, team_id)
    aweb_db = db.get_manager("aweb")

    rows = await aweb_db.fetch_all(
        """
        SELECT message_id, from_alias, to_alias, subject, body, priority, created_at, read_at
        FROM {{tables.messages}}
        WHERE team_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        """,
        team_id,
        limit,
    )

    # Unauthenticated public-team callers see message metadata only — never the
    # subject or body. Authenticated dashboard tokens see full content.
    redact = not auth.get("authenticated", False)
    return {
        "messages": [
            MessageSummary(
                message_id=str(r["message_id"]),
                from_alias=r["from_alias"],
                to_alias=r["to_alias"],
                subject="" if redact else r["subject"],
                body="" if redact else r["body"],
                priority=r["priority"],
                created_at=r["created_at"].isoformat(),
                read_at=r["read_at"].isoformat() if r.get("read_at") else None,
            ).model_dump()
            for r in rows
        ]
    }


@router.get("/v1/teams/{team_id:path}/events/stream")
async def stream_team_events(
    request: Request,
    team_id: str,
    db=Depends(get_db),
    redis=Depends(get_redis),
):
    await _require_dashboard_auth(request, team_id)
    if redis is None:
        raise HTTPException(status_code=503, detail="Redis unavailable")

    return StreamingResponse(
        _sse_dashboard_events(request=request, db=db, redis=redis, team_id=team_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/v1/teams/{team_id:path}/roles/active")
async def get_active_roles(
    request: Request, team_id: str, db=Depends(get_db)
) -> dict:
    await _require_dashboard_auth(request, team_id)
    aweb_db = db.get_manager("aweb")

    row = await aweb_db.fetch_one(
        """
        SELECT id, version, bundle_json, updated_at
        FROM {{tables.team_roles}}
        WHERE team_id = $1 AND is_active = true
        """,
        team_id,
    )

    if not row:
        return {"roles": None}

    return {
        "roles": {
            "id": str(row["id"]),
            "version": row["version"],
            "bundle": row["bundle_json"],
            "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }
    }


@router.get("/v1/teams/{team_id:path}/instructions/active")
async def get_active_instructions(
    request: Request, team_id: str, db=Depends(get_db)
) -> dict:
    await _require_dashboard_auth(request, team_id)
    aweb_db = db.get_manager("aweb")

    row = await aweb_db.fetch_one(
        """
        SELECT id, version, document_json, updated_at
        FROM {{tables.team_instructions}}
        WHERE team_id = $1 AND is_active = true
        """,
        team_id,
    )

    if not row:
        return {"instructions": None}

    return {
        "instructions": {
            "id": str(row["id"]),
            "version": row["version"],
            "document": row["document_json"],
            "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }
    }


@router.get("/v1/teams/{team_id:path}/status")
async def get_team_status(
    request: Request, team_id: str, db=Depends(get_db)
) -> dict:
    await _require_dashboard_auth(request, team_id)
    aweb_db = db.get_manager("aweb")

    agent_count_row = await aweb_db.fetch_one(
        "SELECT COUNT(*)::int AS cnt FROM {{tables.agents}} WHERE team_id = $1 AND deleted_at IS NULL",
        team_id,
    )
    agent_count = agent_count_row["cnt"] if agent_count_row else 0

    # Online = workspaces with recent last_seen_at
    online_rows = await aweb_db.fetch_all(
        """
        SELECT DISTINCT alias FROM {{tables.workspaces}}
        WHERE team_id = $1 AND deleted_at IS NULL
          AND last_seen_at > NOW() - INTERVAL '30 minutes'
        """,
        team_id,
    )
    online_agents = [r["alias"] for r in online_rows]

    claim_rows = await list_active_claims(db, team_id=team_id)

    lock_rows = await aweb_db.fetch_all(
        """
        SELECT resource_key, holder_alias, acquired_at, expires_at
        FROM {{tables.reservations}}
        WHERE team_id = $1
          AND (expires_at IS NULL OR expires_at > NOW())
        """,
        team_id,
    )

    return TeamStatus(
        team_id=team_id,
        agent_count=agent_count,
        online_agents=online_agents,
        active_claims=[
            {"task_ref": r["task_ref"], "alias": r["alias"], "claimed_at": r["claimed_at"].isoformat()}
            for r in claim_rows
        ],
        active_locks=[
            {
                "resource_key": r["resource_key"],
                "holder_alias": r["holder_alias"],
                "acquired_at": r["acquired_at"].isoformat(),
                "expires_at": r["expires_at"].isoformat() if r.get("expires_at") else None,
            }
            for r in lock_rows
        ],
    ).model_dump()


@router.get("/v1/usage")
async def get_usage(
    request: Request,
    team_id: str = Query(...),
    since: Optional[str] = Query(default=None),
    until: Optional[str] = Query(default=None),
    db=Depends(get_db),
) -> dict:
    await _require_dashboard_auth(request, team_id)
    aweb_db = db.get_manager("aweb")

    since_dt = _parse_optional_datetime(since)
    until_dt = _parse_optional_datetime(until)

    # Count messages
    msg_query = "SELECT COUNT(*)::int AS cnt FROM {{tables.messages}} WHERE team_id = $1"
    msg_params: list = [team_id]
    idx = 2
    if since_dt:
        msg_query += f" AND created_at >= ${idx}"
        msg_params.append(since_dt)
        idx += 1
    if until_dt:
        msg_query += f" AND created_at <= ${idx}"
        msg_params.append(until_dt)

    msg_row = await aweb_db.fetch_one(msg_query, *msg_params)
    messages_sent = msg_row["cnt"] if msg_row else 0

    # Count active agents
    agent_row = await aweb_db.fetch_one(
        "SELECT COUNT(*)::int AS cnt FROM {{tables.agents}} WHERE team_id = $1 AND deleted_at IS NULL",
        team_id,
    )
    active_agents = agent_row["cnt"] if agent_row else 0

    return UsageMetrics(
        team_id=team_id,
        messages_sent=messages_sent,
        active_agents=active_agents,
        since=since,
        until=until,
    ).model_dump()


def _parse_optional_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        raise HTTPException(status_code=422, detail=f"Invalid datetime: {value}")

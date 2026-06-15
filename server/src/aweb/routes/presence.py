"""Presence heartbeat for token (human) identities: ``POST /v1/presence/heartbeat``.

A logged-in human authenticates with a Better Auth bearer JWT. Their
``token_identity`` sets ``identity.agent_id`` to the Better Auth subject STRING
(not a UUID), and a human has no ``workspaces`` row, so the agent heartbeat
(``POST /v1/agents/heartbeat`` — which casts ``identity.agent_id::UUID`` and
updates ``workspaces``) cannot mark a human online.

This endpoint resolves the human's REAL ``agent_id`` UUID via
``provision_human_participant`` (idempotent) and writes Redis presence keyed by
that UUID, exactly like agents. Online is then computed authoritatively from the
presence record's TTL window by ``GET /v1/participants`` and ``GET /v1/agents``.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from aweb.deps import get_db, get_redis
from aweb.identity_auth_deps import provision_human_participant
from aweb.team_auth_deps import TeamIdentity, get_team_identity

from ..presence import update_agent_presence

router = APIRouter(prefix="/v1/presence", tags=["presence"])

# The presence key TTL IS the online window. The UI re-pings well inside this
# (45s ping < 120s TTL) so a live tab stays online with one-missed-ping margin;
# closing the tab lets the key expire -> offline.
PRESENCE_TTL_SECONDS = 120


class PresenceHeartbeatResponse(BaseModel):
    agent_id: str
    alias: str
    online: bool = True
    last_seen: Optional[str] = None


@router.post("/heartbeat", response_model=PresenceHeartbeatResponse)
async def presence_heartbeat(
    request: Request,
    db=Depends(get_db),
    redis=Depends(get_redis),
    identity: TeamIdentity = Depends(get_team_identity),
) -> PresenceHeartbeatResponse:
    """Mark the authenticated (human/token) participant online.

    Resolves the caller's real ``agent_id`` UUID (provisioning the human
    participant row idempotently), then writes a fresh Redis presence record
    keyed by that UUID with a ``PRESENCE_TTL_SECONDS`` TTL.
    """
    row = await provision_human_participant(
        db,
        team_id=identity.team_id,
        subject=identity.agent_id,
        name=identity.alias,
    )
    if not row:
        raise HTTPException(status_code=500, detail="Failed to provision participant")

    agent_id = str(row["agent_id"])
    last_seen = await update_agent_presence(
        redis,
        agent_id=agent_id,
        alias=identity.alias,
        team_id=identity.team_id,
        human_name=row.get("human_name") or "",
        status="active",
        ttl_seconds=PRESENCE_TTL_SECONDS,
    )

    return PresenceHeartbeatResponse(
        agent_id=agent_id,
        alias=identity.alias,
        online=True,
        last_seen=last_seen,
    )

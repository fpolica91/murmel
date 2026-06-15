"""Unified participant directory: ``GET /v1/participants``.

The ``agents`` table is the participant/identity directory, not an agent-only
table. A human becomes a first-class chat/comment/assignee participant by having
a row here with ``agent_type='human'``. This endpoint exposes BOTH humans and
agents to ANY team member (it is NOT admin-gated), each with an authoritative
``kind`` ("human" | "agent") derived from ``agents.agent_type``.

The UI uses this endpoint for the team roster, the chat recipient picker, and
the issue assignee picker. ``GET /v1/agents`` stays unchanged (agents-only, with
presence) for back-compat.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from aweb.deps import get_db, get_redis
from aweb.team_auth_deps import TeamIdentity, get_team_identity

from ..presence import list_agent_presences_by_workspace_ids

router = APIRouter(prefix="/v1/participants", tags=["participants"])


class ParticipantView(BaseModel):
    kind: str  # "human" | "agent" — AUTHORITATIVE; UI keys on this, never guesses
    alias: str  # team-unique selector (chat to_aliases + issue assignee_id)
    display_name: str  # human_name for humans; alias for agents (or blank human_name)
    agent_id: Optional[str] = None
    did_key: Optional[str] = None
    did_aw: Optional[str] = None
    address: Optional[str] = None
    role: Optional[str] = None
    agent_type: str = "agent"  # raw passthrough of agents.agent_type
    online: bool = False
    status: str = "offline"
    last_seen: Optional[str] = None


class ListParticipantsResponse(BaseModel):
    team_id: str
    participants: list[ParticipantView]


def _participant_kind(agent_type: Optional[str]) -> str:
    return "human" if (agent_type or "agent") == "human" else "agent"


@router.get("", response_model=ListParticipantsResponse)
async def list_participants(
    request: Request,
    db=Depends(get_db),
    redis=Depends(get_redis),
    identity: TeamIdentity = Depends(get_team_identity),
) -> ListParticipantsResponse:
    """List ALL participants (humans + agents) in the current team.

    Non-admin: any active team member may call this. Humans report
    ``online=False``, ``status="offline"``, ``last_seen=None`` (no presence by
    design); agents carry live presence exactly as ``GET /v1/agents`` does.
    """
    aweb_db = db.get_manager("aweb")

    rows = await aweb_db.fetch_all(
        """
        SELECT a.agent_id, a.alias, a.did_key, a.did_aw, a.address,
               a.human_name, a.agent_type, a.role
        FROM {{tables.agents}} a
        WHERE a.team_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.alias
        """,
        identity.team_id,
    )

    # Presence from Redis (agents only; humans have no live presence).
    agent_ids = [str(r["agent_id"]) for r in rows]
    presences = (
        await list_agent_presences_by_workspace_ids(redis, agent_ids)
        if redis and agent_ids
        else []
    )
    presence_by_id = {str(p.get("workspace_id")): p for p in presences if p.get("workspace_id")}

    participants: list[ParticipantView] = []
    for r in rows:
        agent_id = str(r["agent_id"])
        kind = _participant_kind(r.get("agent_type"))
        alias = r.get("alias") or ""
        human_name = (r.get("human_name") or "").strip()
        display_name = human_name if (kind == "human" and human_name) else (human_name or alias)

        online = False
        status = "offline"
        last_seen = None
        role = r.get("role") or None
        # Humans never have presence; only join presence for agents.
        presence = presence_by_id.get(agent_id) if kind == "agent" else None
        if presence:
            online = True
            status = presence.get("status") or "active"
            last_seen = presence.get("last_seen") or None
            role = presence.get("role") or role

        participants.append(
            ParticipantView(
                kind=kind,
                alias=alias,
                display_name=display_name or alias,
                agent_id=agent_id,
                did_key=r.get("did_key") or None,
                did_aw=r.get("did_aw") or None,
                address=r.get("address") or None,
                role=role,
                agent_type=r.get("agent_type") or "agent",
                online=online,
                status=status,
                last_seen=last_seen,
            )
        )

    return ListParticipantsResponse(team_id=identity.team_id, participants=participants)

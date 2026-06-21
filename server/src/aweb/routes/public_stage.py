"""Public, read-only spectator stage for ONE server-configured showcase team.

SECURITY MODEL (this is the single place team data is exposed without a token):

  * NO client-supplied team id. The team is read ONLY from the
    ``AWEB_PUBLIC_STAGE_TEAM`` env var. There is no path/query/body parameter to
    tamper with, so the cross-team IDOR vector does not exist by construction.
  * Disabled by default. If the env is unset/blank, every request 404s — prod
    stays closed until it is deliberately pointed at a DEDICATED throwaway
    showcase team (never a real customer team).
  * Read-only. GET only; no mutation is reachable here.
  * Field whitelist. Only what the scene renders is returned — display names,
    issue titles/status, claim aliases, and chat bodies. No emails, tokens,
    DIDs, addresses, or internal secrets leave this endpoint.

Because the showcase team is explicitly opted-in by an operator, exposing its
team-wide chat (across sessions) is intentional and confined to that one team.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Response

from ..db import DatabaseInfra, get_db_infra
from ..deps import get_redis
from ..claims import list_active_claims
from ..coordination.hierarchy import list_issues
from ..presence import list_agent_presences_by_workspace_ids

router = APIRouter(prefix="/v1/public", tags=["public-stage"])


def _stage_team() -> Optional[str]:
    """The single showcase team, or None when the feature is disabled."""
    value = (os.getenv("AWEB_PUBLIC_STAGE_TEAM") or "").strip()
    return value or None


def _participant_kind(agent_type: Optional[str]) -> str:
    return "human" if (agent_type or "").strip().lower() == "human" else "agent"


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


@router.get("/stage")
async def public_stage(
    response: Response,
    db_infra: DatabaseInfra = Depends(get_db_infra),
    redis=Depends(get_redis),
) -> dict[str, Any]:
    """Aggregated, read-only snapshot of the configured showcase team.

    Returns ``{team, participants, issues, claims, chat}`` — exactly enough to
    render the live office scene. 404 when no showcase team is configured.
    """
    team_id = _stage_team()
    if not team_id:
        raise HTTPException(status_code=404, detail="No public stage configured")

    aweb_db = db_infra.get_manager("aweb")

    # ── participants (whitelist: identity-for-display only) ──────────────
    agent_rows = await aweb_db.fetch_all(
        """
        SELECT a.agent_id, a.alias, a.human_name, a.agent_type, a.role
        FROM {{tables.agents}} a
        WHERE a.team_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.alias
        """,
        team_id,
    )
    agent_ids = [str(r["agent_id"]) for r in agent_rows]
    presences = (
        await list_agent_presences_by_workspace_ids(redis, agent_ids)
        if redis and agent_ids
        else []
    )
    online_ids = {
        str(p.get("workspace_id")) for p in presences if p.get("workspace_id")
    }
    participants = []
    for r in agent_rows:
        kind = _participant_kind(r.get("agent_type"))
        alias = r.get("alias") or ""
        human_name = (r.get("human_name") or "").strip()
        display = human_name if (kind == "human" and human_name) else (human_name or alias)
        participants.append(
            {
                "kind": kind,
                "alias": alias,
                "display_name": display or alias,
                "agent_id": str(r["agent_id"]),
                "role": r.get("role") or None,
                "agent_type": r.get("agent_type") or "agent",
                "online": str(r["agent_id"]) in online_ids,
            }
        )

    # ── issues (whitelist: board fields only) ────────────────────────────
    issue_rows = await list_issues(db_infra, team_id=team_id)
    issues = [
        {
            "issue_id": str(i.get("issue_id")),
            "title": i.get("title") or "",
            "status": i.get("status") or "todo",
            "assignee_type": i.get("assignee_type"),
            "assignee_id": i.get("assignee_id"),
            "created_at": _iso(i.get("created_at")),
            "updated_at": _iso(i.get("updated_at")),
        }
        for i in issue_rows
    ]

    # ── claims (who is heads-down) ───────────────────────────────────────
    claim_rows = await list_active_claims(db_infra, team_id=team_id, limit=100)
    claims = [
        {
            "task_ref": c.get("task_ref"),
            "alias": c.get("alias"),
            "claimed_at": _iso(c.get("claimed_at")),
        }
        for c in claim_rows
    ]

    # ── chat: TEAM-WIDE recent messages (the spectator unlock) ───────────
    # Safe only because team_id is the operator-configured showcase team — not
    # client input. Whitelist: sender alias + body + time, nothing else.
    chat_rows = await aweb_db.fetch_all(
        """
        SELECT m.from_alias, m.body, m.created_at
        FROM {{tables.chat_messages}} m
        JOIN {{tables.chat_sessions}} s ON m.session_id = s.session_id
        WHERE s.team_id = $1 AND m.body <> ''
        ORDER BY m.created_at DESC
        LIMIT 60
        """,
        team_id,
    )
    chat = [
        {
            "from": r.get("from_alias"),
            "body": r.get("body"),
            "ts": _iso(r.get("created_at")),
        }
        for r in chat_rows
    ]

    # short cache: cheap read, blunts public hammering without going stale
    response.headers["Cache-Control"] = "public, max-age=2"
    return {
        "team": team_id.split(":")[0],
        "participants": participants,
        "issues": issues,
        "claims": claims,
        "chat": chat,
    }

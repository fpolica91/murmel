"""External tracker integration routes (pull-only).

Auth is the normal team bearer token, so a pull imports into the CALLER's team.
The Linear API key is read from the ``LINEAR_API_KEY`` env (the same optional-
integration pattern as ANTHROPIC_API_KEY / AWEB_PUBLIC_STAGE_TEAM); per-team
encrypted key storage is a deliberate multi-tenant follow-up. 503 when no key is
configured.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from aweb.deps import get_db
from aweb.integrations.linear_pull import LinearError, pull_linear
from aweb.team_auth_deps import TeamIdentity, get_team_identity

router = APIRouter(prefix="/v1/integrations", tags=["integrations"])


class LinearPullRequest(BaseModel):
    model_config = {"extra": "forbid"}

    # Optional: restrict the import to one Linear team by its key (e.g. "ENG").
    linear_team_key: Optional[str] = None


def _linear_api_key() -> Optional[str]:
    return (os.getenv("LINEAR_API_KEY") or "").strip() or None


@router.post("/linear/pull")
async def linear_pull(
    request: Request,
    payload: LinearPullRequest | None = None,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> dict:
    """Pull Linear issues into the authenticated team (one-way, idempotent)."""
    api_key = _linear_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="LINEAR_API_KEY is not configured; Linear pull is disabled.",
        )
    team_key = payload.linear_team_key if payload else None
    try:
        result = await pull_linear(
            db,
            team_id=identity.team_id,
            api_key=api_key,
            linear_team_key=team_key,
        )
    except LinearError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return result

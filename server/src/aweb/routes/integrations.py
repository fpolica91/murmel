"""External-tracker import routes — RECEIVE-ONLY.

Murmel never fetches from or holds credentials for any external tracker. The
agent fetches + maps issues with its OWN access and POSTs them here; this
endpoint just upserts them idempotently into the authenticated team.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from aweb.deps import get_db
from aweb.integrations.issue_import import ImportError_, import_issues
from aweb.team_auth_deps import TeamIdentity, get_team_identity

router = APIRouter(prefix="/v1/integrations", tags=["integrations"])


class ImportIssue(BaseModel):
    model_config = {"extra": "forbid"}

    external_ref: str = Field(..., min_length=1, max_length=256)
    title: str = Field(..., min_length=1, max_length=500)
    status: Optional[str] = None  # a Murmel status; caller maps from the source
    description: Optional[str] = Field(None, max_length=16384)


class ImportRequest(BaseModel):
    model_config = {"extra": "forbid"}

    external_system: str = Field(..., min_length=1, max_length=64)
    issues: List[ImportIssue] = Field(..., max_length=2000)


@router.post("/issues/import")
async def import_external_issues(
    request: Request,
    payload: ImportRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> dict:
    """Upsert externally-sourced issues into the authenticated team (idempotent
    on external_ref). The caller (agent/client) supplies already-fetched issues —
    Murmel makes no external API calls and holds no keys."""
    try:
        result = await import_issues(
            db,
            team_id=identity.team_id,
            external_system=payload.external_system,
            issues=[i.model_dump() for i in payload.issues],
        )
    except ImportError_ as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return result

"""FastAPI dependencies for team (token) authentication.

Provides TeamIdentity — the authenticated context for all routes in the
team-based architecture. Every authenticated endpoint resolves a TeamIdentity
from the request's Better Auth bearer JWT (see ``aweb.token_team_scope`` /
``aweb.token_auth``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from aweb.deps import get_db

logger = logging.getLogger(__name__)


def _aweb_db(db_or_manager):
    return db_or_manager.get_manager("aweb") if hasattr(db_or_manager, "get_manager") else db_or_manager


@dataclass(frozen=True)
class TeamIdentity:
    """Authenticated participant identity within a team.

    Resolved from the verified Better Auth bearer JWT and the agents table.
    """

    team_id: str
    alias: str
    did_key: str
    did_aw: str
    address: str
    agent_id: str
    identity_scope: str
    certificate_id: str


async def get_team_identity(request: Request, db=Depends(get_db)) -> TeamIdentity:
    """FastAPI dependency: authenticate the request via the Better Auth JWT.

    Token auth is the only accepted auth path. The request must present a valid
    bearer JWT whose subject has an active membership for the requested team
    (selected via the ``X-AWEB-Team-Id`` header or the subject's sole active
    team). Raises HTTPException(401) when no valid token is present.

    IMPORTANT: this must be used as Depends(get_team_identity) so FastAPI
    evaluates it before body parameter injection.

    See ``aweb.token_team_scope`` / ``aweb.token_auth``.
    """
    # Imported lazily to avoid an import cycle through the integration glue.
    from aweb.token_team_scope import resolve_token_team_identity

    token_identity = await resolve_token_team_identity(request, db)
    if token_identity is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required: present a valid bearer token.",
        )
    return token_identity

"""Integration glue: resolve a token-authenticated request into a TeamIdentity.

This module bridges the self-contained token-auth pipeline in
:mod:`aweb.token_auth` (Better Auth JWT + ``memberships`` table) onto the
existing :class:`~aweb.team_auth_deps.TeamIdentity` shape that team-scoped
routes already consume via ``Depends(get_team_identity)``.

It is ADDITIVE: it never runs for a team-certificate request. The
certificate path stays the single source of truth for cert-authenticated
callers; this path only engages when a request presents a bearer JWT and no
team certificate, and only when ``AWEB_ENABLE_TOKEN_AUTH`` is on.

Team selection for a multi-team subject
---------------------------------------
A JWT subject may belong to several teams. A request selects its team with the
``X-AWEB-Team-Id`` header. The selected team must appear in the subject's
*active* memberships (the authoritative set loaded from the ``memberships``
table). If the header is omitted and the subject has exactly one active
membership, that team is used; otherwise the request is rejected so a
token-authenticated caller is always scoped to exactly one of their own active
teams.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import HTTPException, Request

from aweb.config import get_settings
from aweb.deps import get_db
from aweb.identity_auth_deps import provision_human_participant
from aweb.team_auth_deps import TeamIdentity
from aweb.token_auth import (
    TokenAuthContext,
    TokenAuthError,
    resolve_token_auth,
)

logger = logging.getLogger(__name__)

# Header a token-authenticated caller uses to pick which of their active teams
# this request acts in. Mirrors the cert path, where the team is bound by the
# certificate rather than chosen per-request.
TEAM_ID_HEADER = "X-AWEB-Team-Id"


def request_has_bearer_token(request: Request) -> bool:
    """True if the request carries an ``Authorization: Bearer <token>`` header.

    Used to decide whether to engage the token path. A team-certificate request
    uses ``Authorization: DIDKey ...`` instead, so this is False for it and the
    certificate path remains untouched.
    """
    auth = request.headers.get("Authorization") or ""
    parts = auth.split(None, 1)
    return len(parts) == 2 and parts[0].lower() == "bearer"


def request_has_team_certificate(request: Request) -> bool:
    """True if the request carries a team certificate header."""
    return bool(request.headers.get("X-AWID-Team-Certificate"))


def token_auth_enabled() -> bool:
    """Whether the simple-auth (bearer JWT) path is enabled."""
    return get_settings().enable_token_auth


def _select_team(auth: TokenAuthContext, requested: Optional[str]) -> str:
    """Pick the active team this token request is scoped to.

    ``auth.team_ids`` is the authoritative active set loaded from the
    ``memberships`` table (NOT the JWT hint). The selected team must be a member
    of that set, which enforces requirement (4): token requests are limited to
    the subject's active memberships.
    """
    requested = (requested or "").strip()
    if requested:
        if requested not in auth.team_ids:
            raise HTTPException(
                status_code=403,
                detail=f"Subject not authorized for team {requested}",
            )
        return requested
    if len(auth.team_ids) == 1:
        return auth.team_ids[0]
    if not auth.team_ids:
        raise HTTPException(
            status_code=403,
            detail="Subject has no active team memberships",
        )
    raise HTTPException(
        status_code=400,
        detail=(
            f"Subject belongs to multiple teams; specify one with the "
            f"'{TEAM_ID_HEADER}' header"
        ),
    )


def token_identity(auth: TokenAuthContext, team_id: str) -> TeamIdentity:
    """Project a verified token context onto a :class:`TeamIdentity`.

    Token subjects are not team-certificate agents, so the cert-specific fields
    (``did_key``, ``did_aw``, ``certificate_id``, ...) are empty. ``alias`` and
    ``agent_id`` carry the subject (or ``agent_name`` claim when present) so
    downstream code that records an actor still has a stable identifier.
    """
    # Display name for attribution (comment authors, etc.): prefer the `name`
    # claim (a human's display name), then the agent_name, then the subject id.
    # agent_id below keeps the stable subject; alias is display-only here, so a
    # friendly name is safe (authz is by team membership, not alias).
    name = ""
    if isinstance(auth.claims, dict):
        name = (auth.claims.get("name") or "").strip()
    alias = (name or auth.agent_name or auth.subject or "").strip()
    return TeamIdentity(
        team_id=team_id,
        alias=alias,
        did_key="",
        did_aw="",
        address="",
        agent_id=auth.subject,
        identity_scope="token",
        certificate_id="",
    )


async def resolve_token_team_identity(
    request: Request,
    db: Any,
) -> Optional[TeamIdentity]:
    """Resolve a bearer-JWT request into a team-scoped :class:`TeamIdentity`.

    Returns ``None`` (caller should fall back to certificate auth) when the
    token path does not apply: feature disabled, no bearer token, or a team
    certificate is also present (cert wins to preserve existing behaviour).

    Raises ``HTTPException`` when a bearer token *is* present but fails
    verification, revocation, or team-scoping checks.
    """
    # Cheap header checks first: a certificate request (or any request without
    # a bearer token) must fall through to cert auth WITHOUT touching settings,
    # so the cert path never depends on token-auth configuration being present.
    if request_has_team_certificate(request):
        return None
    if not request_has_bearer_token(request):
        return None
    if not token_auth_enabled():
        return None

    authorization = request.headers.get("Authorization") or ""
    token = authorization.split(None, 1)[1].strip()
    try:
        auth = await resolve_token_auth(token, db)
    except TokenAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    team_id = _select_team(auth, request.headers.get(TEAM_ID_HEADER))
    identity = token_identity(auth, team_id)

    # Lift human-participant provisioning out of the messaging-only path: every
    # token-authenticated request (chat, issues, comments, roster, assignment)
    # funnels through here, so idempotently upsert the caller's human ``agents``
    # row now. This guarantees the human is a first-class participant (reachable
    # by alias, listable in the roster, assignable) before their first call —
    # not just after they happen to touch chat. Keyed on a deterministic
    # synthetic did:key, so re-auth never duplicates.
    name = ""
    if isinstance(auth.claims, dict):
        name = (auth.claims.get("name") or "").strip()
    try:
        await provision_human_participant(
            db,
            team_id=team_id,
            subject=auth.subject,
            name=name,
            agent_name=auth.agent_name,
        )
    except Exception:  # pragma: no cover - provisioning must never block auth
        logger.warning(
            "human participant provisioning failed for subject in team %s",
            team_id,
            exc_info=True,
        )
    return identity


__all__ = [
    "TEAM_ID_HEADER",
    "request_has_bearer_token",
    "request_has_team_certificate",
    "token_auth_enabled",
    "token_identity",
    "resolve_token_team_identity",
]

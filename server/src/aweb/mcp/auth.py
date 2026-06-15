"""MCP authentication middleware."""

from __future__ import annotations

import contextvars
import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from aweb.internal_auth import parse_internal_auth_context
from aweb.identity_auth_deps import lookup_identity_agent_context, resolve_identity_auth
from aweb.team_auth_deps import _aweb_db, verify_request_certificate
from aweb.token_auth import TokenAuthError, resolve_token_auth
from aweb.token_team_scope import (
    TEAM_ID_HEADER,
    _select_team,
    request_has_bearer_token,
    request_has_team_certificate,
    token_auth_enabled,
)

logger = logging.getLogger(__name__)


@dataclass
class AuthContext:
    """Resolved identity for the current MCP request."""

    team_id: str | None
    agent_id: str | None
    alias: str | None
    did_key: str
    did_aw: str | None = None
    address: str | None = None
    workspace_id: str | None = None
    trusted_proxy: bool = False


def auth_dids(auth: AuthContext) -> list[str]:
    """Return the authenticated routing DIDs in preference order."""
    dids: list[str] = []
    for value in ((auth.did_aw or "").strip(), (auth.did_key or "").strip()):
        if value and value not in dids:
            dids.append(value)
    return dids


def primary_auth_did(auth: AuthContext) -> str:
    """Return the preferred routing DID for the authenticated caller."""
    dids = auth_dids(auth)
    return dids[0] if dids else ""


_auth_context: contextvars.ContextVar[AuthContext | None] = contextvars.ContextVar(
    "aweb_mcp_auth", default=None
)


def get_auth() -> AuthContext:
    """Return the auth context for the current request.

    Raises RuntimeError if called outside an authenticated request.
    """
    ctx = _auth_context.get()
    if ctx is None:
        raise RuntimeError("No MCP auth context — request was not authenticated")
    return ctx


class MCPAuthMiddleware:
    """ASGI middleware that resolves identity for MCP requests."""

    def __init__(self, app: ASGIApp, db_infra: Any) -> None:
        self.app = app
        self.db_infra = db_infra

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)

        try:
            ctx = await self._resolve_auth(request)
        except HTTPException as exc:
            response = JSONResponse(
                {"error": exc.detail},
                status_code=exc.status_code,
                headers=exc.headers,
            )
            await response(scope, receive, send)
            return

        if ctx is None:
            response = JSONResponse(
                {"error": "Authentication required"},
                status_code=401,
            )
            await response(scope, receive, send)
            return

        cv_token = _auth_context.set(ctx)
        try:
            await self.app(scope, receive, send)
        finally:
            _auth_context.reset(cv_token)

    async def _resolve_auth(self, request: Request) -> AuthContext | None:
        internal = parse_internal_auth_context(request)
        if internal is not None:
            return await self._resolve_proxy_auth(internal)

        # Bearer-JWT (Better Auth) is the only client auth path for MCP.
        if request_has_bearer_token(request) and token_auth_enabled():
            return await self._resolve_token_auth(request)

        return None

    async def _resolve_token_auth(self, request: Request) -> AuthContext:
        """Resolve a Better Auth bearer JWT onto the MCP ``AuthContext`` shape.

        Reuses the REST token pipeline (:func:`resolve_token_auth` plus the
        ``token_team_scope`` team-selection helper) so authorization stays
        identical across transports: the JWT is verified against JWKS, checked
        for revocation, and scoped to one of the subject's *active* memberships
        (the authoritative set from the ``memberships`` table).

        Token subjects are not team-certificate agents, so the cert-specific
        fields (``did_key``, ``did_aw``, ``address``, ``workspace_id``) are left
        empty and ``alias``/``agent_id`` carry the subject (or ``agent_name``
        claim), mirroring :func:`aweb.token_team_scope.token_identity`.
        """
        authorization = request.headers.get("authorization") or ""
        token = authorization.split(None, 1)[1].strip()
        try:
            auth = await resolve_token_auth(token, self.db_infra)
        except TokenAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

        team_id = _select_team(auth, request.headers.get(TEAM_ID_HEADER))
        alias = (auth.agent_name or auth.subject or "").strip() or None

        return AuthContext(
            team_id=team_id,
            agent_id=auth.subject,
            workspace_id=None,
            alias=alias,
            did_key="",
            did_aw=None,
            address=None,
        )

    async def _resolve_proxy_auth(self, internal: dict[str, str]) -> AuthContext:
        aweb_db = _aweb_db(self.db_infra)
        team_id = internal["team_id"]
        row = await aweb_db.fetch_one(
            """
            SELECT agent_id, alias, did_key, did_aw, address
            FROM {{tables.agents}}
            WHERE agent_id = $1 AND team_id = $2 AND deleted_at IS NULL
            """,
            UUID(internal["actor_id"]),
            team_id,
        )
        if not row:
            raise HTTPException(status_code=403, detail="Agent not connected")

        workspace = await aweb_db.fetch_one(
            """
            SELECT workspace_id
            FROM {{tables.workspaces}}
            WHERE agent_id = $1 AND team_id = $2 AND deleted_at IS NULL
            ORDER BY updated_at DESC, workspace_id DESC
            LIMIT 1
            """,
            row["agent_id"],
            team_id,
        )

        return AuthContext(
            team_id=team_id,
            agent_id=str(row["agent_id"]),
            workspace_id=(str(workspace["workspace_id"]) if workspace else None),
            alias=row["alias"],
            did_key=str(row["did_key"]),
            did_aw=(str(row.get("did_aw") or "").strip() or None),
            address=(str(row.get("address") or "").strip() or None),
            trusted_proxy=True,
        )

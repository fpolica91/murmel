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
from aweb.team_auth_deps import _aweb_db
from aweb.token_auth import TokenAuthError, resolve_token_auth
from aweb.token_team_scope import (
    TEAM_ID_HEADER,
    _select_team,
    request_has_bearer_token,
    token_auth_enabled,
)

PROJECT_HEADER = "X-AWEB-Project"

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
    project: str | None = None
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


def is_keyless_token_identity(auth: AuthContext) -> bool:
    """True when the caller is a Better Auth token subject with no signing key.

    Token subjects are server-authenticated (JWT verified + membership checked
    by the MCP middleware) but hold no self-custodial key for the routing DID
    they are attributed under. The synthetic routing DID ``did:key:jwt-<sub>``
    has no key bytes, so any attempt to derive/verify a signature from it would
    crash. Messaging tools use this to take a *server-attributed plaintext*
    path: the message is routed/attributed to the authenticated participant but
    carries no client envelope signature.

    Trusted-proxy (hosted custodial) callers and real did:key / did:aw cert
    identities are explicitly NOT keyless and keep the signed/encrypted paths.
    """
    if getattr(auth, "trusted_proxy", False):
        return False
    did = (auth.did_key or "").strip()
    return not did or did.startswith("did:key:jwt-")


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
            return await self._resolve_proxy_auth(internal, request)

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

        Token subjects are not team-certificate agents, but they DO have a
        participant row keyed by the synthetic local routing DID
        ``did:key:jwt-<subject>`` (see
        :func:`aweb.identity_auth_deps.provision_human_participant`). We populate
        ``did_key`` with that synthetic routing DID so that
        :func:`primary_auth_did` resolves to the caller's participant — this is
        what messaging/contacts tools route and attribute against. The truly
        cert-specific fields (``did_aw``, ``address``, ``workspace_id``) stay
        empty: the synthetic DID holds no key bytes and must never be used to
        derive or verify a cryptographic signature.
        """
        authorization = request.headers.get("authorization") or ""
        token = authorization.split(None, 1)[1].strip()
        try:
            auth = await resolve_token_auth(token, self.db_infra)
        except TokenAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

        team_id = _select_team(auth, request.headers.get(TEAM_ID_HEADER))
        did_key = f"did:key:jwt-{auth.subject}"
        alias = await self._resolve_token_alias(auth, team_id, did_key)

        return AuthContext(
            team_id=team_id,
            agent_id=auth.subject,
            workspace_id=None,
            project=request.headers.get(PROJECT_HEADER),
            alias=alias,
            did_key=did_key,
            did_aw=None,
            address=None,
        )

    async def _resolve_token_alias(
        self, auth: Any, team_id: str, did_key: str
    ) -> str | None:
        """Resolve the caller's display alias for chat/mail attribution.

        Token (Better Auth JWT) callers have no team certificate, but the REST
        pipeline idempotently upserts a human ``agents`` row keyed by the
        synthetic routing DID ``did:key:jwt-<subject>`` (see
        :func:`aweb.identity_auth_deps.provision_human_participant`). That row's
        ``alias`` is the authoritative, team-unique display name (e.g.
        ``"Ada (agent)"``) used as chat ``from_alias`` and issue ``assignee_id``.

        Previously this fell straight back to ``auth.subject`` whenever the JWT
        carried no ``agent_name`` claim, so MCP-attributed chat/mail showed the
        raw Better Auth subject string instead of the participant's name. We now
        prefer the provisioned participant alias, then the verified ``name``
        claim, then ``agent_name``, and only use the opaque subject as a last
        resort.
        """
        try:
            aweb_db = _aweb_db(self.db_infra)
            row = await aweb_db.fetch_one(
                """
                SELECT alias
                FROM {{tables.agents}}
                WHERE did_key = $1 AND team_id = $2 AND deleted_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
                """,
                did_key,
                team_id,
            )
        except Exception:  # pragma: no cover - directory lookup must not block auth
            logger.warning(
                "token alias lookup failed for subject in team %s",
                team_id,
                exc_info=True,
            )
            row = None

        candidates: list[str | None] = []
        if row is not None:
            candidates.append(row["alias"])
        if isinstance(getattr(auth, "claims", None), dict):
            candidates.append(auth.claims.get("name"))
        candidates.append(auth.agent_name)
        candidates.append(auth.subject)
        for candidate in candidates:
            value = (candidate or "").strip()
            if value:
                return value
        return None

    async def _resolve_proxy_auth(self, internal: dict[str, str], request: Request) -> AuthContext:
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
            project=request.headers.get(PROJECT_HEADER),
            alias=row["alias"],
            did_key=str(row["did_key"]),
            did_aw=(str(row.get("did_aw") or "").strip() or None),
            address=(str(row.get("address") or "").strip() or None),
            trusted_proxy=True,
        )

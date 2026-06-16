"""Tests for the bearer-JWT path in the MCP auth middleware.

These cover the ``_resolve_token_auth`` branch in
:class:`aweb.mcp.auth.MCPAuthMiddleware`: a Better Auth bearer JWT is resolved
via the token pipeline and mapped onto the :class:`AuthContext` shape, gated by
the ``enable_token_auth`` settings flag. The bearer JWT is the only client auth
path for MCP; with the flag off the middleware resolves no identity.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from aweb.mcp import auth as mcp_auth
from aweb.mcp.auth import AuthContext, MCPAuthMiddleware
from aweb.token_auth import TokenAuthContext, TokenAuthError


class _DBInfra:
    """A sentinel db handle; the token path never touches it directly here."""


class _AliasDB:
    """A fake aweb db manager returning a single agents-row alias.

    ``_aweb_db`` returns the object unchanged when it has no ``get_manager``
    attribute, so this stands in directly for the aweb manager that
    ``_resolve_token_alias`` queries. ``alias=None`` simulates "no provisioned
    participant row yet" so the claim/agent_name/subject fallback chain runs.
    """

    def __init__(self, alias: str | None) -> None:
        self._alias = alias
        self.calls: list[tuple] = []

    async def fetch_one(self, query, *params):
        self.calls.append((query, params))
        if self._alias is None:
            return None
        return {"alias": self._alias}


def _request(headers: dict[str, str]) -> Request:
    raw = [
        (k.lower().encode("latin-1"), v.encode("latin-1"))
        for k, v in headers.items()
    ]
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/mcp",
        "headers": raw,
    }
    return Request(scope)


def _token_ctx(
    team_ids: list[str],
    *,
    agent_name: str | None = None,
    name: str | None = None,
) -> TokenAuthContext:
    claims: dict = {"sub": "user-123"}
    if name is not None:
        claims["name"] = name
    return TokenAuthContext(
        subject="user-123",
        team_ids=team_ids,
        roles=["member"],
        agent_name=agent_name,
        jti="jti-1",
        claims=claims,
    )


@pytest.fixture
def middleware() -> MCPAuthMiddleware:
    return MCPAuthMiddleware(app=lambda *a, **k: None, db_infra=_DBInfra())


@pytest.mark.asyncio
async def test_bearer_jwt_resolves_to_auth_context(monkeypatch, middleware):
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _fake_resolve(token, db, **kwargs):
        assert token == "the-jwt"
        return _token_ctx(["acme:team"], agent_name="alice-agent")

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _fake_resolve)

    ctx = await middleware._resolve_auth(
        _request({"authorization": "Bearer the-jwt"})
    )

    assert isinstance(ctx, AuthContext)
    assert ctx.team_id == "acme:team"
    assert ctx.agent_id == "user-123"
    assert ctx.alias == "alice-agent"
    # Token subjects route against their synthetic participant DID
    # (did:key:jwt-<subject>); the other cert-specific fields stay empty.
    assert ctx.did_key == "did:key:jwt-user-123"
    assert ctx.did_aw is None
    assert ctx.address is None
    assert ctx.workspace_id is None
    assert ctx.trusted_proxy is False


@pytest.mark.asyncio
async def test_bearer_jwt_team_header_selects_team(monkeypatch, middleware):
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _fake_resolve(token, db, **kwargs):
        return _token_ctx(["team-a", "team-b"])

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _fake_resolve)

    ctx = await middleware._resolve_auth(
        _request(
            {
                "authorization": "Bearer the-jwt",
                mcp_auth.TEAM_ID_HEADER: "team-b",
            }
        )
    )
    assert ctx.team_id == "team-b"
    # Subject falls back as alias when no agent_name claim is present.
    assert ctx.alias == "user-123"


@pytest.mark.asyncio
async def test_bearer_jwt_multi_team_requires_header(monkeypatch, middleware):
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _fake_resolve(token, db, **kwargs):
        return _token_ctx(["team-a", "team-b"])

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _fake_resolve)

    with pytest.raises(HTTPException) as exc:
        await middleware._resolve_auth(_request({"authorization": "Bearer the-jwt"}))
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_bearer_jwt_verification_failure_is_401(monkeypatch, middleware):
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _fake_resolve(token, db, **kwargs):
        raise TokenAuthError("bad token")

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _fake_resolve)

    with pytest.raises(HTTPException) as exc:
        await middleware._resolve_auth(_request({"authorization": "Bearer the-jwt"}))
    assert exc.value.status_code == 401
    assert exc.value.detail == "bad token"


@pytest.mark.asyncio
async def test_flag_off_yields_no_auth_context(monkeypatch, middleware):
    """When the flag is off, a bearer token is NOT treated as token auth.

    Token auth is the only client auth path for MCP, so with the flag off the
    middleware resolves no identity and the request is treated as
    unauthenticated.
    """
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: False)

    async def _must_not_run(*a, **k):  # pragma: no cover - guard
        raise AssertionError("token pipeline must not run when flag is off")

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _must_not_run)

    ctx = await middleware._resolve_auth(
        _request({"authorization": "Bearer the-jwt"})
    )
    assert ctx is None


@pytest.mark.asyncio
async def test_alias_resolves_from_participant_row(monkeypatch):
    """The provisioned agents-row alias wins over every JWT claim.

    Regression for "MCP chat: show token sender display name, not the JWT
    subject": chat/mail attributed the sender as the opaque Better Auth subject
    instead of the participant's display name. The display alias lives in the
    ``agents`` row keyed by ``did:key:jwt-<subject>``; resolve it there.
    """
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _fake_resolve(token, db, **kwargs):
        # No agent_name claim — pre-fix this would have fallen back to subject.
        return _token_ctx(["acme:team"], agent_name=None, name=None)

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _fake_resolve)

    alias_db = _AliasDB("Ada (agent)")
    mw = MCPAuthMiddleware(app=lambda *a, **k: None, db_infra=alias_db)

    ctx = await mw._resolve_auth(_request({"authorization": "Bearer the-jwt"}))

    assert ctx.alias == "Ada (agent)"
    # The directory was actually consulted, scoped to the synthetic DID + team.
    assert alias_db.calls, "expected an agents-row lookup"
    _query, params = alias_db.calls[0]
    assert params[0] == "did:key:jwt-user-123"
    assert params[1] == "acme:team"


@pytest.mark.asyncio
async def test_alias_falls_back_to_name_claim_when_no_row(monkeypatch):
    """With no participant row, prefer the verified ``name`` claim over subject."""
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _fake_resolve(token, db, **kwargs):
        return _token_ctx(["acme:team"], agent_name=None, name="Ada (agent)")

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _fake_resolve)

    mw = MCPAuthMiddleware(app=lambda *a, **k: None, db_infra=_AliasDB(None))

    ctx = await mw._resolve_auth(_request({"authorization": "Bearer the-jwt"}))

    # Not the opaque subject "user-123".
    assert ctx.alias == "Ada (agent)"


@pytest.mark.asyncio
async def test_alias_falls_back_to_subject_as_last_resort(monkeypatch):
    """No row, no name claim, no agent_name → the subject is the last resort."""
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _fake_resolve(token, db, **kwargs):
        return _token_ctx(["acme:team"], agent_name=None, name=None)

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _fake_resolve)

    mw = MCPAuthMiddleware(app=lambda *a, **k: None, db_infra=_AliasDB(None))

    ctx = await mw._resolve_auth(_request({"authorization": "Bearer the-jwt"}))

    assert ctx.alias == "user-123"

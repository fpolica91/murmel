"""Tests for the additive bearer-JWT path in the MCP auth middleware.

These cover the new ``_resolve_token_auth`` branch in
:class:`aweb.mcp.auth.MCPAuthMiddleware`: a Better Auth bearer JWT (no team
certificate) is resolved via the existing token pipeline and mapped onto the
same :class:`AuthContext` shape the certificate path produces, gated by the
``enable_token_auth`` settings flag. The certificate / DIDKey paths must remain
untouched.
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


def _token_ctx(team_ids: list[str], *, agent_name: str | None = None) -> TokenAuthContext:
    return TokenAuthContext(
        subject="user-123",
        team_ids=team_ids,
        roles=["member"],
        agent_name=agent_name,
        jti="jti-1",
        claims={"sub": "user-123"},
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
    # Cert-specific fields are empty for a token subject.
    assert ctx.did_key == ""
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
async def test_flag_off_falls_through_to_cert_path(monkeypatch, middleware):
    """When the flag is off, a bearer token is NOT treated as token auth.

    The request falls through to the existing DIDKey/cert gate, which returns
    None for a non-DIDKey Authorization header.
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
async def test_team_certificate_present_skips_token_path(monkeypatch, middleware):
    """A team certificate always wins, even if a bearer token is also present."""
    monkeypatch.setattr(mcp_auth, "token_auth_enabled", lambda: True)

    async def _must_not_run(*a, **k):  # pragma: no cover - guard
        raise AssertionError("token pipeline must not run when a cert is present")

    monkeypatch.setattr(mcp_auth, "resolve_token_auth", _must_not_run)

    cert_calls: list[object] = []

    async def _fake_verify_cert(request, db):
        cert_calls.append(request)
        raise HTTPException(status_code=403, detail="cert path reached")

    monkeypatch.setattr(mcp_auth, "verify_request_certificate", _fake_verify_cert)

    with pytest.raises(HTTPException) as exc:
        await middleware._resolve_auth(
            _request(
                {
                    "authorization": "DIDKey z6MkX",
                    "x-awid-team-certificate": "cert-blob",
                }
            )
        )
    # Reached the cert path, not the token path.
    assert exc.value.detail == "cert path reached"
    assert cert_calls

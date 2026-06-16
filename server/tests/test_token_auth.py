"""Tests for the self-contained token auth module (Epic1 Story1.3 + 1.1).

These exercise the pure logic paths without a real JWKS server or database:

- claim normalization
- bearer header parsing
- revocation check + membership loader against a fake manager
- end-to-end resolve_token_auth with a locally-generated RS256 key and a
  stubbed verifier signing key

They intentionally avoid network and Postgres so they run as fast syntax-level
checks of the module's behavior.
"""

from __future__ import annotations

import datetime as dt

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from aweb.token_auth import (
    JWKSVerifier,
    TokenAuthConfig,
    TokenAuthError,
    _as_str_list,
    _bearer_token_from_header,
    is_token_revoked,
    load_active_team_ids,
    resolve_token_auth,
)


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------


class FakeManager:
    """Minimal pgdbm-like manager backed by in-memory dicts."""

    def __init__(self, *, memberships=None, revoked=None):
        # memberships: list of (subject, team_id, role, status)
        self._memberships = memberships or []
        # revoked: set of jti
        self._revoked = set(revoked or [])

    async def fetch_value(self, _query, *args):
        jti = args[0]
        return 1 if jti in self._revoked else None

    async def fetch_all(self, _query, *args):
        subject = args[0]
        return [
            {"team_id": t}
            for (s, t, _role, status) in self._memberships
            if s == subject and status == "active"
        ]

    async def fetch_one(self, _query, *args):
        subject, team_id = args[0], args[1]
        for (s, t, role, status) in self._memberships:
            if s == subject and t == team_id and status == "active":
                return {"subject": s, "team_id": t, "role": role, "status": status}
        return None


class _StubKey:
    def __init__(self, key):
        self.key = key


class StubVerifier(JWKSVerifier):
    """JWKSVerifier that uses a fixed public key instead of fetching JWKS."""

    def __init__(self, config, public_key):
        self._config = config
        self._public_key = public_key

    def _signing_key(self, token):  # noqa: D401 - override
        return _StubKey(self._public_key)


# --------------------------------------------------------------------------
# Pure-logic tests
# --------------------------------------------------------------------------


def test_as_str_list_variants():
    assert _as_str_list(None) == []
    assert _as_str_list("") == []
    assert _as_str_list("admin") == ["admin"]
    assert _as_str_list(["a", "b"]) == ["a", "b"]
    assert _as_str_list(["a", None, ""]) == ["a"]
    assert _as_str_list(123) == ["123"]


def test_bearer_header_parsing():
    assert _bearer_token_from_header("Bearer abc.def.ghi") == "abc.def.ghi"
    assert _bearer_token_from_header("bearer xyz") == "xyz"
    with pytest.raises(TokenAuthError):
        _bearer_token_from_header(None)
    with pytest.raises(TokenAuthError):
        _bearer_token_from_header("Token abc")
    with pytest.raises(TokenAuthError):
        _bearer_token_from_header("Bearer ")


@pytest.mark.asyncio
async def test_is_token_revoked():
    db = FakeManager(revoked={"jti-bad"})
    assert await is_token_revoked(db, "jti-bad") is True
    assert await is_token_revoked(db, "jti-good") is False
    assert await is_token_revoked(db, None) is False


@pytest.mark.asyncio
async def test_load_active_team_ids_is_authoritative():
    db = FakeManager(
        memberships=[
            ("sub-1", "team-a", "member", "active"),
            ("sub-1", "team-b", "admin", "active"),
            ("sub-1", "team-c", "member", "suspended"),
            ("sub-2", "team-z", "member", "active"),
        ]
    )
    assert await load_active_team_ids(db, "sub-1") == ["team-a", "team-b"]
    assert await load_active_team_ids(db, "sub-2") == ["team-z"]
    assert await load_active_team_ids(db, "nobody") == []
    assert await load_active_team_ids(db, "") == []


# --------------------------------------------------------------------------
# End-to-end resolution with a real RS256 signature + stubbed JWKS key
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def rsa_keys():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


def _make_token(private_key, **overrides):
    now = dt.datetime.now(dt.timezone.utc)
    claims = {
        "sub": "sub-1",
        "team_ids": ["team-hint-only"],  # hint, should be ignored
        "roles": ["member"],
        "agent_name": "agent-007",
        "iat": now,
        "exp": now + dt.timedelta(minutes=5),
        "jti": "jti-1",
    }
    claims.update(overrides)
    return pyjwt.encode(claims, private_key, algorithm="RS256")


def _config():
    return TokenAuthConfig(jwks_url="https://example.test/jwks", algorithms=("RS256",))


@pytest.mark.asyncio
async def test_resolve_token_auth_happy_path(rsa_keys):
    private_key, public_key = rsa_keys
    verifier = StubVerifier(_config(), public_key)
    token = _make_token(private_key)
    db = FakeManager(
        memberships=[
            ("sub-1", "team-a", "member", "active"),
            ("sub-1", "team-b", "admin", "active"),
        ]
    )

    ctx = await resolve_token_auth(token, db, verifier=verifier)

    assert ctx.subject == "sub-1"
    # Authoritative from memberships, NOT the team_ids hint.
    assert ctx.team_ids == ["team-a", "team-b"]
    assert "team-hint-only" not in ctx.team_ids
    assert ctx.roles == ["member"]
    assert ctx.agent_name == "agent-007"
    assert ctx.jti == "jti-1"
    assert ctx.has_team("team-a") is True
    assert ctx.has_team("team-x") is False


@pytest.mark.asyncio
async def test_resolve_token_auth_required_team(rsa_keys):
    private_key, public_key = rsa_keys
    verifier = StubVerifier(_config(), public_key)
    token = _make_token(private_key)
    db = FakeManager(memberships=[("sub-1", "team-a", "member", "active")])

    ctx = await resolve_token_auth(token, db, verifier=verifier, required_team="team-a")
    assert ctx.has_team("team-a")

    with pytest.raises(TokenAuthError):
        await resolve_token_auth(token, db, verifier=verifier, required_team="team-x")


@pytest.mark.asyncio
async def test_resolve_token_auth_rejects_revoked(rsa_keys):
    private_key, public_key = rsa_keys
    verifier = StubVerifier(_config(), public_key)
    token = _make_token(private_key, jti="jti-bad")
    db = FakeManager(
        memberships=[("sub-1", "team-a", "member", "active")],
        revoked={"jti-bad"},
    )
    with pytest.raises(TokenAuthError, match="revoked"):
        await resolve_token_auth(token, db, verifier=verifier)


@pytest.mark.asyncio
async def test_resolve_token_auth_rejects_expired(rsa_keys):
    private_key, public_key = rsa_keys
    verifier = StubVerifier(_config(), public_key)
    past = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
    token = _make_token(private_key, exp=past, iat=past - dt.timedelta(minutes=5))
    db = FakeManager(memberships=[("sub-1", "team-a", "member", "active")])
    with pytest.raises(TokenAuthError, match="expired"):
        await resolve_token_auth(token, db, verifier=verifier)


@pytest.mark.asyncio
async def test_resolve_token_auth_rejects_wrong_key(rsa_keys):
    private_key, _public_key = rsa_keys
    other_public = rsa.generate_private_key(
        public_exponent=65537, key_size=2048
    ).public_key()
    verifier = StubVerifier(_config(), other_public)
    token = _make_token(private_key)
    db = FakeManager(memberships=[("sub-1", "team-a", "member", "active")])
    with pytest.raises(TokenAuthError, match="Invalid token"):
        await resolve_token_auth(token, db, verifier=verifier)


# --------------------------------------------------------------------------
# Startup config validation (audience/issuer fail-closed)
# --------------------------------------------------------------------------


def _force_token_auth(monkeypatch, enabled: bool) -> None:
    import aweb.token_team_scope as scope

    monkeypatch.setattr(scope, "token_auth_enabled", lambda: enabled)


def test_validate_token_auth_config_noop_when_disabled(monkeypatch):
    from aweb.token_auth import validate_token_auth_config

    _force_token_auth(monkeypatch, False)
    monkeypatch.delenv("AWEB_TOKEN_AUTH_AUDIENCE", raising=False)
    monkeypatch.delenv("AWEB_TOKEN_AUTH_ISSUER", raising=False)
    validate_token_auth_config()  # no raise


def test_validate_token_auth_config_prod_missing_aud_iss_raises(monkeypatch):
    from aweb.token_auth import validate_token_auth_config

    _force_token_auth(monkeypatch, True)
    monkeypatch.delenv("AWEB_TOKEN_AUTH_AUDIENCE", raising=False)
    monkeypatch.delenv("AWEB_TOKEN_AUTH_ISSUER", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="aud/iss"):
        validate_token_auth_config()


def test_validate_token_auth_config_dev_missing_only_warns(monkeypatch):
    from aweb.token_auth import validate_token_auth_config

    _force_token_auth(monkeypatch, True)
    monkeypatch.delenv("AWEB_TOKEN_AUTH_AUDIENCE", raising=False)
    monkeypatch.delenv("AWEB_TOKEN_AUTH_ISSUER", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "development")
    validate_token_auth_config()  # warns, no raise


def test_validate_token_auth_config_ok_when_aud_iss_set(monkeypatch):
    from aweb.token_auth import validate_token_auth_config

    _force_token_auth(monkeypatch, True)
    monkeypatch.setenv("AWEB_TOKEN_AUTH_AUDIENCE", "http://localhost:8088")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_ISSUER", "http://localhost:3030")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_JWKS_URL", "https://issuer.example/jwks")
    monkeypatch.setenv("ENVIRONMENT", "production")
    validate_token_auth_config()  # no raise


def test_validate_token_auth_config_rejects_symmetric_alg(monkeypatch):
    from aweb.token_auth import validate_token_auth_config

    _force_token_auth(monkeypatch, True)
    monkeypatch.setenv("AWEB_TOKEN_AUTH_AUDIENCE", "http://localhost:8088")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_ISSUER", "http://localhost:3030")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_JWKS_URL", "https://issuer.example/jwks")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_ALGORITHMS", "HS256")
    monkeypatch.setenv("ENVIRONMENT", "development")  # alg guard fails closed even in dev
    with pytest.raises(RuntimeError, match="asymmetric"):
        validate_token_auth_config()


def test_validate_token_auth_config_prod_requires_https_jwks(monkeypatch):
    from aweb.token_auth import validate_token_auth_config

    _force_token_auth(monkeypatch, True)
    monkeypatch.setenv("AWEB_TOKEN_AUTH_AUDIENCE", "http://localhost:8088")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_ISSUER", "http://localhost:3030")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_JWKS_URL", "http://issuer.example/jwks")
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(RuntimeError, match="https"):
        validate_token_auth_config()


def test_validate_token_auth_config_allows_loopback_http_jwks(monkeypatch):
    from aweb.token_auth import validate_token_auth_config

    _force_token_auth(monkeypatch, True)
    monkeypatch.setenv("AWEB_TOKEN_AUTH_AUDIENCE", "http://localhost:8088")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_ISSUER", "http://localhost:3030")
    monkeypatch.setenv("AWEB_TOKEN_AUTH_JWKS_URL", "http://localhost:3030/api/auth/jwks")
    monkeypatch.setenv("ENVIRONMENT", "production")
    validate_token_auth_config()  # loopback http allowed -> no raise

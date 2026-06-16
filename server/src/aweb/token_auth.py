"""Self-contained server-side token auth (Better Auth JWT + memberships).

This module implements the "simple auth" path described in the Epic 1 spec.
It is ADDITIVE and does not touch the existing team-certificate auth path
(see ``team_auth.py`` / ``team_auth_deps.py``).

Auth contract
-------------
A request presents a JWT (RS256 / ES256) issued by Better Auth. The server:

1. Validates the signature against the issuer's JWKS (keys cached with a TTL).
2. Checks ``exp`` (expiry).
3. Rejects the token if its ``jti`` exists in the ``revoked_tokens`` table.
4. Authorizes a request for team ``T`` iff the ``memberships`` table has a row
   ``(subject=sub, team_id=T, status='active')``.

The ``memberships`` table is the source of truth for authorization; the
``team_ids`` claim on the JWT is only a hint. The membership loader below
returns the authoritative active ``team_ids`` for a subject.

Claims: ``sub``, ``team_ids`` (string[] hint), ``roles``, ``agent_name``
(optional), ``exp``, ``iat``, ``jti``.

Configuration (read from the environment so this module stays self-contained):

- ``AWEB_TOKEN_AUTH_JWKS_URL``     — JWKS endpoint of the Better Auth issuer.
- ``AWEB_TOKEN_AUTH_ISSUER``       — expected ``iss`` claim (optional).
- ``AWEB_TOKEN_AUTH_AUDIENCE``     — expected ``aud`` claim (optional).
- ``AWEB_TOKEN_AUTH_ALGORITHMS``   — comma list, default ``RS256,ES256``.
- ``AWEB_TOKEN_AUTH_JWKS_TTL``     — JWKS cache TTL seconds, default ``300``.
- ``AWEB_TOKEN_AUTH_LEEWAY``       — clock-skew leeway seconds, default ``30``.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import jwt as pyjwt
from jwt import PyJWKClient

from fastapi import Depends, Header, HTTPException, Request

from aweb.deps import get_db

logger = logging.getLogger(__name__)

# Minimum seconds between JWKS-cache rebuilds forced by a key-resolution failure
# (bounds attacker-driven JWKS refetch from unknown-kid token floods).
_FORCED_JWKS_REBUILD_COOLDOWN = 30.0


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TokenAuthError(ValueError):
    """Raised when a token cannot be verified or is unauthorized.

    A plain ``ValueError`` subclass so callers that already catch ``ValueError``
    (matching the ``team_auth`` style) keep working. The FastAPI dependency
    translates this into a 401.
    """


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class TokenAuthConfig:
    """Verifier configuration, normally loaded from the environment."""

    jwks_url: str
    issuer: Optional[str] = None
    audience: Optional[str] = None
    # Better Auth's jwt plugin defaults to EdDSA (Ed25519); RS256/ES256 are also
    # valid per deploy. We accept all three by default and let the JWK's `kid`
    # select the actual key/alg, rather than hard-coding one on the verifier.
    algorithms: tuple[str, ...] = ("RS256", "ES256", "EdDSA")
    jwks_cache_ttl: int = 300
    leeway: int = 30

    @classmethod
    def from_env(cls) -> "TokenAuthConfig":
        algos_raw = os.getenv("AWEB_TOKEN_AUTH_ALGORITHMS", "RS256,ES256,EdDSA")
        algorithms = tuple(a.strip() for a in algos_raw.split(",") if a.strip())
        return cls(
            jwks_url=(os.getenv("AWEB_TOKEN_AUTH_JWKS_URL", "") or "").strip(),
            issuer=(os.getenv("AWEB_TOKEN_AUTH_ISSUER") or "").strip() or None,
            audience=(os.getenv("AWEB_TOKEN_AUTH_AUDIENCE") or "").strip() or None,
            algorithms=algorithms or ("RS256", "ES256", "EdDSA"),
            jwks_cache_ttl=_env_int("AWEB_TOKEN_AUTH_JWKS_TTL", 300),
            leeway=_env_int("AWEB_TOKEN_AUTH_LEEWAY", 30),
        )


# ---------------------------------------------------------------------------
# Auth context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TokenAuthContext:
    """Resolved identity for a token-authenticated request.

    ``team_ids`` is the authoritative set of active team ids loaded from the
    ``memberships`` table (NOT the JWT hint). ``claims`` keeps the raw verified
    payload for callers that need additional fields.
    """

    subject: str
    team_ids: list[str]
    roles: list[str]
    agent_name: Optional[str] = None
    jti: Optional[str] = None
    claims: dict[str, Any] = field(default_factory=dict)

    def has_team(self, team_id: str) -> bool:
        return team_id in self.team_ids


# ---------------------------------------------------------------------------
# JWKS verifier (with key caching)
# ---------------------------------------------------------------------------


class JWKSVerifier:
    """Verifies Better Auth JWTs against a JWKS endpoint with key caching.

    ``PyJWKClient`` already caches signing keys, but it has no global TTL: a
    rotated/withdrawn key would be served from cache indefinitely. We wrap it so
    the underlying client is rebuilt once ``jwks_cache_ttl`` elapses, which
    bounds how long a stale key set can be trusted while still avoiding a JWKS
    fetch on every request.
    """

    def __init__(self, config: TokenAuthConfig) -> None:
        if not config.jwks_url:
            raise TokenAuthError("Token auth JWKS URL is not configured")
        self._config = config
        self._lock = threading.Lock()
        self._client: Optional[PyJWKClient] = None
        self._client_built_at: float = 0.0
        self._last_forced_rebuild: float = 0.0

    @property
    def config(self) -> TokenAuthConfig:
        return self._config

    def _get_client(self) -> PyJWKClient:
        now = time.monotonic()
        with self._lock:
            expired = (now - self._client_built_at) >= self._config.jwks_cache_ttl
            if self._client is None or expired:
                # PyJWKClient keeps its own LRU of keys; lifecycle_cache lets it
                # cache fetched keys across calls within this TTL window.
                self._client = PyJWKClient(
                    self._config.jwks_url,
                    cache_keys=True,
                    lifespan=self._config.jwks_cache_ttl,
                )
                self._client_built_at = now
            return self._client

    def _signing_key(self, token: str):
        client = self._get_client()
        try:
            return client.get_signing_key_from_jwt(token)
        except Exception as exc:  # PyJWKClientError, network, decode, ...
            # Force at most ONE rebuild per cooldown window. Otherwise a flood of
            # tokens with unknown `kid`s would zero the cache on every request and
            # drive a JWKS refetch per request (cache-bust amplification against
            # the issuer). PyJWKClient already refreshes on a genuine key miss, so
            # this wrapper rebuild only needs to be an occasional safety net.
            now = time.monotonic()
            with self._lock:
                if (now - self._last_forced_rebuild) >= _FORCED_JWKS_REBUILD_COOLDOWN:
                    self._client_built_at = 0.0
                    self._last_forced_rebuild = now
            raise TokenAuthError(f"Unable to resolve signing key: {exc}") from exc

    def verify(self, token: str) -> dict[str, Any]:
        """Verify signature + standard claims and return the decoded payload.

        Performs steps 1 and 2 of the contract (signature + ``exp``). Revocation
        (step 3) and membership authorization (step 4) are handled separately by
        :func:`is_token_revoked` and :func:`load_active_team_ids`.
        """
        if not token or not token.strip():
            raise TokenAuthError("Missing bearer token")

        signing_key = self._signing_key(token)

        options = {
            "require": ["exp", "sub"],
            "verify_aud": self._config.audience is not None,
            # Reject (not just warn on) an undersized RSA signing key from the
            # JWKS — fail closed if a misconfigured issuer ever publishes one.
            "enforce_minimum_key_length": True,
        }
        decode_kwargs: dict[str, Any] = {
            "algorithms": list(self._config.algorithms),
            "options": options,
            "leeway": self._config.leeway,
        }
        if self._config.audience is not None:
            decode_kwargs["audience"] = self._config.audience
        if self._config.issuer is not None:
            decode_kwargs["issuer"] = self._config.issuer

        try:
            payload = pyjwt.decode(token, signing_key.key, **decode_kwargs)
        except pyjwt.ExpiredSignatureError as exc:
            raise TokenAuthError("Token expired") from exc
        except pyjwt.InvalidTokenError as exc:
            raise TokenAuthError(f"Invalid token: {exc}") from exc

        if not payload.get("sub"):
            raise TokenAuthError("Token missing subject (sub)")

        return payload


# Process-wide verifier singleton keyed by config, so the JWKS cache is shared
# across requests. Rebuilt automatically if the env config changes.
_verifier_lock = threading.Lock()
_verifier: Optional[JWKSVerifier] = None
_verifier_config: Optional[TokenAuthConfig] = None


def get_verifier(config: Optional[TokenAuthConfig] = None) -> JWKSVerifier:
    """Return a shared :class:`JWKSVerifier` for the given (or env) config."""
    global _verifier, _verifier_config
    cfg = config or TokenAuthConfig.from_env()
    with _verifier_lock:
        if _verifier is None or _verifier_config != cfg:
            _verifier = JWKSVerifier(cfg)
            _verifier_config = cfg
        return _verifier


def reset_verifier_cache() -> None:
    """Drop the cached verifier (test hook / config reload)."""
    global _verifier, _verifier_config
    with _verifier_lock:
        _verifier = None
        _verifier_config = None


_DEV_LIKE_ENVS = {"dev", "development", "local", "test", "testing"}
# The key source is a PUBLIC JWKS; only asymmetric algorithms are ever valid.
# A symmetric (HS*) alg would let an attacker forge tokens with the public key.
_ASYMMETRIC_ALGS = {
    "RS256", "RS384", "RS512",
    "ES256", "ES384", "ES512",
    "PS256", "PS384", "PS512",
    "EdDSA",
}


def _current_env() -> str:
    for name in ("ENVIRONMENT", "APP_ENV"):
        value = (os.getenv(name) or "").strip().lower()
        if value:
            return value
    return ""


def _jwks_url_is_safe(url: str) -> bool:
    """True if the JWKS URL is https or targets a loopback/internal host."""
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme == "https":
        return True
    return _jwks_host_is_local(url)


def _jwks_host_is_local(url: str) -> bool:
    """True only if the JWKS targets a loopback/internal host (not any https).

    Distinct from _jwks_url_is_safe: a public https JWKS is *safe* but not
    *local*. The dev downgrade of aud/iss + scheme checks keys on locality, so a
    dev-style ENVIRONMENT leaking onto a deploy with a PUBLIC JWKS still fails
    closed rather than silently skipping audience/issuer validation.
    """
    from urllib.parse import urlparse

    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return (
        host in ("localhost", "127.0.0.1", "::1")
        or host.endswith(".localhost")
        or host.endswith(".internal")
    )


def validate_token_auth_config() -> None:
    """Fail closed on insecure token-auth configuration. Enforced at startup in
    BOTH deployment modes. Dev/test environments downgrade the env-sensitive
    checks (aud/iss, JWKS scheme) to warnings so local setups still run; the
    symmetric-algorithm guard always fails closed.
    """
    from aweb.token_team_scope import token_auth_enabled  # avoid import cycle

    if not token_auth_enabled():
        return
    cfg = TokenAuthConfig.from_env()
    # Downgrade the env-sensitive checks to warnings ONLY for a genuinely local
    # setup: dev-like ENVIRONMENT *and* a loopback/internal JWKS. A public JWKS
    # always fails closed, so a dev env-string on a reachable deploy can't skip
    # aud/iss or https validation.
    is_dev = _current_env() in _DEV_LIKE_ENVS and _jwks_host_is_local(cfg.jwks_url)

    # 1) Symmetric algorithms against a public JWKS are never valid — always fail.
    bad_algs = [a for a in cfg.algorithms if a not in _ASYMMETRIC_ALGS]
    if bad_algs:
        raise RuntimeError(
            "Refusing to start: non-asymmetric JWT algorithm(s) configured "
            f"against a public JWKS: {', '.join(bad_algs)}"
        )

    # 2) aud/iss must be set, else verify() skips those claims and a token minted
    #    for another service sharing the issuer's JWKS would be accepted.
    missing = [
        name
        for name, value in (
            ("AWEB_TOKEN_AUTH_AUDIENCE", cfg.audience),
            ("AWEB_TOKEN_AUTH_ISSUER", cfg.issuer),
        )
        if not value
    ]
    if missing:
        detail = (
            f"token auth is enabled but {', '.join(missing)} not set; "
            "aud/iss claims will not be validated"
        )
        if is_dev:
            logger.warning("Token auth config: %s", detail)
        else:
            raise RuntimeError(f"Refusing to start: {detail}")

    # 3) JWKS must be fetched over https (except loopback/internal hosts).
    if not _jwks_url_is_safe(cfg.jwks_url):
        detail = f"AWEB_TOKEN_AUTH_JWKS_URL is not https: {cfg.jwks_url}"
        if is_dev:
            logger.warning("Token auth config: %s", detail)
        else:
            raise RuntimeError(f"Refusing to start: {detail}")


# ---------------------------------------------------------------------------
# Revocation check (revoked_tokens table)
# ---------------------------------------------------------------------------


def _aweb_db(db_or_manager: Any):
    """Normalize a DatabaseInfra or manager into a query manager.

    Mirrors ``team_auth_deps._aweb_db`` so this module composes with the same
    ``app.state.db`` handle.
    """
    return (
        db_or_manager.get_manager("aweb")
        if hasattr(db_or_manager, "get_manager")
        else db_or_manager
    )


async def is_token_revoked(db: Any, jti: Optional[str]) -> bool:
    """Return True if ``jti`` is present in the revoked_tokens denylist.

    A token without a ``jti`` cannot be individually revoked; we treat it as
    not-revoked (it still expires via ``exp``). The denylist only needs to hold
    a row until the token naturally expires.
    """
    if not jti:
        return False
    manager = _aweb_db(db)
    found = await manager.fetch_value(
        "SELECT 1 FROM {{tables.revoked_tokens}} WHERE jti = $1",
        jti,
    )
    return found is not None


async def revoke_token(
    db: Any,
    jti: str,
    *,
    subject: Optional[str],
    expires_at: Any,
) -> None:
    """Insert a JTI into the revocation denylist (idempotent).

    ``expires_at`` should be the token's ``exp`` (a timezone-aware datetime) so
    the row can be garbage-collected once the token would expire anyway.
    """
    if not jti:
        raise TokenAuthError("Cannot revoke a token without a jti")
    manager = _aweb_db(db)
    await manager.execute(
        """
        INSERT INTO {{tables.revoked_tokens}} (jti, subject, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (jti) DO NOTHING
        """,
        jti,
        subject,
        expires_at,
    )


# ---------------------------------------------------------------------------
# Membership loader (memberships table is the source of truth)
# ---------------------------------------------------------------------------


async def load_active_team_ids(db: Any, subject: str) -> list[str]:
    """Return the active team ids for ``subject`` from the memberships table.

    This is the authoritative authorization set. The JWT ``team_ids`` claim is
    only a hint and is intentionally ignored here.
    """
    if not subject:
        return []
    manager = _aweb_db(db)
    rows = await manager.fetch_all(
        """
        SELECT team_id FROM {{tables.memberships}}
        WHERE subject = $1 AND status = 'active'
        ORDER BY team_id
        """,
        subject,
    )
    return [str(row["team_id"]) for row in rows]


async def load_membership(db: Any, subject: str, team_id: str) -> Optional[dict[str, Any]]:
    """Return the active membership row for (subject, team_id), or None."""
    if not subject or not team_id:
        return None
    manager = _aweb_db(db)
    row = await manager.fetch_one(
        """
        SELECT subject, team_id, role, status
        FROM {{tables.memberships}}
        WHERE subject = $1 AND team_id = $2 AND status = 'active'
        """,
        subject,
        team_id,
    )
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Claim normalization
# ---------------------------------------------------------------------------


def _as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value if v is not None and str(v) != ""]
    return [str(value)]


# ---------------------------------------------------------------------------
# Core resolution + FastAPI dependency factory
# ---------------------------------------------------------------------------


def _bearer_token_from_header(authorization: Optional[str]) -> str:
    """Extract a bearer token from an ``Authorization`` header value."""
    if not authorization:
        raise TokenAuthError("Missing Authorization header")
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise TokenAuthError("Authorization header must be 'Bearer <token>'")
    token = parts[1].strip()
    if not token:
        raise TokenAuthError("Empty bearer token")
    return token


async def resolve_token_auth(
    token: str,
    db: Any,
    *,
    verifier: Optional[JWKSVerifier] = None,
    required_team: Optional[str] = None,
) -> TokenAuthContext:
    """Run the full token auth pipeline and return the auth context.

    Order (matches the contract):
      1. Verify signature against JWKS (cached).
      2. Check ``exp`` (done inside ``verifier.verify``).
      3. Reject if ``jti`` is revoked.
      4. Load authoritative active team_ids from memberships.
      5. If ``required_team`` is given, authorize iff it is in that set.

    Raises:
        TokenAuthError: on any verification/authorization failure.
    """
    active_verifier = verifier or get_verifier()
    claims = active_verifier.verify(token)

    subject = str(claims["sub"])
    jti = claims.get("jti")

    if await is_token_revoked(db, jti):
        raise TokenAuthError("Token has been revoked")

    team_ids = await load_active_team_ids(db, subject)

    if required_team is not None and required_team not in team_ids:
        raise TokenAuthError(f"Subject not authorized for team {required_team}")

    return TokenAuthContext(
        subject=subject,
        team_ids=team_ids,
        roles=_as_str_list(claims.get("roles")),
        agent_name=(claims.get("agent_name") or None),
        jti=str(jti) if jti else None,
        claims=claims,
    )


def get_token_auth(
    *,
    required_team_header: Optional[str] = None,
    verifier: Optional[JWKSVerifier] = None,
) -> Callable[..., Any]:
    """Build a FastAPI dependency that resolves a :class:`TokenAuthContext`.

    Usage (wiring done in the integration step, NOT here)::

        @router.get("/v1/whoami")
        async def whoami(auth: TokenAuthContext = Depends(get_token_auth())):
            return {"subject": auth.subject, "team_ids": auth.team_ids}

    Args:
        required_team_header: If set, the named request header supplies a team
            id that the subject must have an active membership for (otherwise the
            dependency raises 401). When ``None`` the dependency only proves
            identity and loads the authoritative team set.
        verifier: Optional explicit verifier (tests / overrides). Defaults to the
            shared env-configured singleton.

    Failures are surfaced as ``HTTPException(401)`` so they slot into existing
    FastAPI error handling.
    """

    async def _dependency(
        request: Request,
        authorization: Optional[str] = Header(default=None),
        db: Any = Depends(get_db),
    ) -> TokenAuthContext:
        required_team: Optional[str] = None
        if required_team_header:
            required_team = request.headers.get(required_team_header)
            if not required_team:
                raise HTTPException(
                    status_code=400,
                    detail=f"Missing required team header '{required_team_header}'",
                )
        try:
            token = _bearer_token_from_header(authorization)
            return await resolve_token_auth(
                token,
                db,
                verifier=verifier,
                required_team=required_team,
            )
        except TokenAuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    return _dependency

import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from redis.asyncio import from_url as async_redis_from_url
from starlette.routing import Mount

from awid.registry import CachedRegistryClient, RegistryClient
from .config import get_settings
from .db import DatabaseInfra
from .db import db_infra as default_db_infra
from awid.log_config import configure_logging
from .mutation_hooks import create_mutation_handler
from awid.ratelimit import build_rate_limiter
from .routing_utils import move_mount_before_spa_fallback
from .service_errors import ServiceError
from .mcp.server import NormalizeMountedMCPPathMiddleware
from .routes.agents import router as agents_router
from .routes.dashboard import router as dashboard_router
from .routes.chat import router as chat_router
from .routes.claims import router as claims_router
from .routes.contacts import router as contacts_router
from .routes.conversations import router as conversations_router
from .routes.events import router as events_router
from .routes.federation import router as federation_router
from .routes.hierarchy import router as hierarchy_router
from .routes.members import router as members_router
from .routes.members import hint_router as memberships_hint_router
from .routes.participants import router as participants_router
from .routes.presence import router as presence_router
from .routes.messages import router as messages_router
from .routes.reservations import router as reservations_router
from .routes.service_registration import router as service_registration_router
from .routes.status import router as status_router
from .coordination.routes.team_instructions import instructions_router
from .coordination.routes.team_roles import roles_router
from .coordination.routes.repos import router as repos_router
from .coordination.routes.workspaces import router as workspaces_router

logger = logging.getLogger(__name__)

# Max accepted request body. Bounds the in-memory buffering done by
# cache_body_middleware so a single large POST can't exhaust memory. Generous
# enough for encrypted envelopes; override with AWEB_MAX_BODY_BYTES.
MAX_REQUEST_BODY_BYTES = int(os.getenv("AWEB_MAX_BODY_BYTES", str(1024 * 1024)))


def _cached_body_receive(body: bytes):
    """Return an ASGI receive callable that replays a cached request body.

    After the cached body has been replayed, subsequent reads must terminate
    immediately with an empty request-body event. Waiting on the original
    receive callable here can hang POST error responses under Uvicorn because
    Starlette may poll the request stream after the endpoint has already raised.
    """
    replayed = False

    async def _receive():
        nonlocal replayed
        if not replayed:
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.request", "body": b"", "more_body": False}

    return _receive


async def _mount_mcp_app(
    app: FastAPI,
    db_infra: DatabaseInfra,
    redis: Redis,
    registry_client: RegistryClient,
) -> None:
    if any(isinstance(r, Mount) and r.path == "/mcp" for r in app.router.routes):
        return

    from .mcp import create_mcp_app

    mcp_app = create_mcp_app(
        db_infra=db_infra,
        redis=redis,
        registry_client=registry_client,
        streamable_http_path="/",
    )
    await mcp_app.startup()
    app.state.mcp_app = mcp_app
    app.mount("/mcp", mcp_app)
    move_mount_before_spa_fallback(app, "/mcp")
    logger.info("MCP endpoint mounted at /mcp/")


async def _shutdown_mcp_app(app: FastAPI) -> None:
    mcp_app = getattr(app.state, "mcp_app", None)
    if mcp_app is None:
        return
    await mcp_app.shutdown()
    app.state.mcp_app = None


async def _shutdown_awid_registry_client(app: FastAPI) -> None:
    registry_client = getattr(app.state, "awid_registry_client", None)
    if registry_client is None:
        return
    await registry_client.aclose()
    app.state.awid_registry_client = None


def _build_awid_registry_client(app: FastAPI, redis: Redis | None) -> RegistryClient:
    settings = get_settings()
    registry_url = settings.awid_registry_url
    client_class = CachedRegistryClient if redis is not None else RegistryClient
    client_kwargs = {"registry_url": registry_url}
    if redis is not None:
        return client_class(redis_client=redis, **client_kwargs)
    return client_class(**client_kwargs)


async def _setup_federation_trust(app: FastAPI, db_infra: DatabaseInfra) -> None:
    """Provision the server federation signing key + load the peer allowlist.

    Empty/absent ``AWEB_FEDERATION_PEERS`` => federation is disabled (no outbound
    trigger; inbound rejects every assertion at the allowlist gate). The signing
    key is still generated so this server can advertise its public did.
    """
    from .federation.server_key import ensure_server_key, load_federation_peers, PEERS_ENV

    server_key = await ensure_server_key(db_infra)
    by_domain, by_origin = load_federation_peers(os.getenv(PEERS_ENV))
    app.state.federation_server_key = server_key
    app.state.federation_peers_by_domain = by_domain
    app.state.federation_peers_by_origin = by_origin
    settings = get_settings()
    if not getattr(app.state, "public_origin", None):
        app.state.public_origin = settings.public_origin
    logger.info(
        "Federation trust configured: server_did=%s peers=%d",
        server_key.public_did,
        len(by_domain),
    )


async def _validate_awid_registry_client(registry_client: RegistryClient) -> None:
    # The token-auth product does not require awid at runtime; only the legacy
    # DIDKey identity-messaging path uses it. Warn (don't fail startup) when it
    # is unreachable so aweb can run standalone without an awid service.
    try:
        await registry_client.health()
    except Exception as exc:
        logger.warning(
            "AWID registry not reachable at %s (%s) — continuing; this is only "
            "needed for the legacy identity-messaging path.",
            registry_client.registry_url,
            exc,
        )


def _make_standalone_lifespan():
    """Create lifespan for standalone mode (creates own DB and Redis connections)."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        json_format = os.getenv("AWEB_LOG_JSON", "true").lower() == "true"
        settings = get_settings()
        configure_logging(log_level=settings.log_level, json_format=json_format)
        logger.info("Starting aweb coordination server (standalone mode)")

        # Fail closed if token auth is on without aud/iss configured.
        from aweb.token_auth import validate_token_auth_config

        validate_token_auth_config()

        redis: Redis | None = None
        redis_connected = False
        db_initialized = False

        try:
            # Phase 1: Initialize all resources (don't set app.state yet)
            redis = await async_redis_from_url(settings.redis_url, decode_responses=True)
            await redis.ping()
            redis_connected = True
            logger.info("Connected to Redis")

            await default_db_infra.initialize()
            db_initialized = True
            logger.info("Database initialized")

            # Phase 2: Only assign to app.state after ALL initialization succeeds
            app.state.redis = redis
            app.state.db = default_db_infra
            app.state.rate_limiter = build_rate_limiter(
            redis=redis, backend="redis" if redis is not None else None
        )
            app.state.on_mutation = create_mutation_handler(redis, default_db_infra)
            app.state.awid_registry_client = _build_awid_registry_client(app, redis)
            await _validate_awid_registry_client(app.state.awid_registry_client)
            await _setup_federation_trust(app, default_db_infra)
            await _mount_mcp_app(app, default_db_infra, redis, app.state.awid_registry_client)

        except Exception:
            # Log which phase failed
            if not redis_connected:
                logger.exception("Failed to connect to Redis")
            elif not db_initialized:
                logger.exception("Failed to initialize database")

            # Clean up any initialized resources on failure
            if db_initialized:
                await default_db_infra.close()
            if redis is not None:
                await redis.aclose()
            raise

        try:
            yield
        finally:
            logger.info("Shutting down aweb coordination server")
            await _shutdown_mcp_app(app)
            await _shutdown_awid_registry_client(app)
            await redis.aclose()
            await default_db_infra.close()

    return lifespan


def _make_library_lifespan(db_infra: DatabaseInfra, redis: Redis):
    """Create lifespan for library mode (uses externally provided connections)."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        json_format = os.getenv("AWEB_LOG_JSON", "true").lower() == "true"
        log_level = os.getenv("AWEB_LOG_LEVEL", "info")
        configure_logging(log_level=log_level, json_format=json_format)
        logger.info("Starting aweb coordination server (library mode)")

        # Fail closed on insecure token-auth config in embedded mode too.
        from aweb.token_auth import validate_token_auth_config

        validate_token_auth_config()

        # Use externally provided connections - no initialization needed
        app.state.redis = redis
        app.state.db = db_infra
        app.state.rate_limiter = build_rate_limiter(
            redis=redis, backend="redis" if redis is not None else None
        )
        app.state.on_mutation = create_mutation_handler(redis, db_infra)
        app.state.awid_registry_client = _build_awid_registry_client(app, redis)
        await _validate_awid_registry_client(app.state.awid_registry_client)
        await _setup_federation_trust(app, db_infra)
        await _mount_mcp_app(app, db_infra, redis, app.state.awid_registry_client)

        try:
            yield
        finally:
            # Don't close connections in library mode - caller manages them
            await _shutdown_mcp_app(app)
            await _shutdown_awid_registry_client(app)
            logger.info("Aweb coordination server stopping (library mode)")

    return lifespan


def create_app(
    *,
    db_infra: Optional[DatabaseInfra] = None,
    redis: Optional[Redis] = None,
) -> FastAPI:
    """Create the aweb coordination FastAPI application.

    Args:
        db_infra: External DatabaseInfra instance (library mode).
                  If None, creates own connections (standalone mode).
        redis: External async Redis client (library mode).
               If None, creates own connection (standalone mode).

    Library mode requires both db_infra and redis to be provided.
    Standalone mode requires neither (will create its own).

    Examples:
        Standalone mode (simple deployment)::

            app = create_app()
            # Run with: uvicorn aweb.api:create_app --factory

        Library mode (embedding in another FastAPI app)::

            from aweb.api import create_app
            from aweb.db import DatabaseInfra
            from redis.asyncio import Redis

            # Initialize shared infrastructure
            db_infra = DatabaseInfra()
            await db_infra.initialize()
            redis = await Redis.from_url("redis://localhost:6379")

            # Create the coordination app with shared connections
            coordination_app = create_app(db_infra=db_infra, redis=redis)

            # Mount under your main app
            main_app.mount("/coordination", coordination_app)
    """
    # Validate mode consistency
    if (db_infra is None) != (redis is None):
        raise ValueError(
            "Library mode requires both db_infra and redis, or neither for standalone mode"
        )

    library_mode = db_infra is not None

    # Validate db_infra is initialized in library mode
    if library_mode:
        assert db_infra is not None  # Type narrowing for mypy
        if not db_infra.is_initialized:
            raise ValueError(
                "db_infra must be initialized before passing to create_app() in library mode. "
                "Call 'await db_infra.initialize()' before creating the app."
            )
        assert redis is not None  # Required when db_infra is provided
        lifespan = _make_library_lifespan(db_infra, redis)
    else:
        lifespan = _make_standalone_lifespan()

    app = FastAPI(title="aweb coordination core", version="0.1.0", lifespan=lifespan)
    app.add_middleware(NormalizeMountedMCPPathMiddleware, mount_path="/mcp")

    # Browser CORS for the web UI (Next.js issuer/app). Off by default; set
    # AWEB_CORS_ORIGINS to a comma-separated list of allowed origins
    # (e.g. "http://localhost:3000"). Token auth uses the Authorization header,
    # so allow_headers must include it (covered by "*").
    _cors_origins = [
        o.strip() for o in os.getenv("AWEB_CORS_ORIGINS", "").split(",") if o.strip()
    ]
    if _cors_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=_cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def security_headers_middleware(request: Request, call_next):
        """Baseline hardening headers on every API response."""
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        # Pure-JSON API: lock CSP all the way down, and assert HSTS for HTTPS
        # deployments. Safe — no document/script/style is ever served here.
        response.headers.setdefault(
            "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"
        )
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=63072000; includeSubDomains"
        )
        return response

    @app.middleware("http")
    async def cache_body_middleware(request: Request, call_next):
        """Cache request body and compute SHA256 for signature verification.

        Replaces the receive callable so FastAPI can still read the body
        for Pydantic parsing after we've consumed the stream.
        """
        import hashlib as _hashlib

        if request.method in {"GET", "HEAD", "OPTIONS"}:
            request.state.cached_body = b""
            request.state.body_sha256 = _hashlib.sha256(b"").hexdigest()
            return await call_next(request)

        # Reject an oversized declared Content-Length up front...
        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                if int(declared) > MAX_REQUEST_BODY_BYTES:
                    return JSONResponse(status_code=413, content={"detail": "Request body too large"})
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})

        # Read via request.body() (which populates Starlette's body cache and is
        # safely replayable downstream) and reject if the actual size exceeds the
        # cap — this catches a missing/lying Content-Length too. NOTE: do not
        # swap this for request.stream(): consuming the stream here leaves the
        # downstream Request with no body, 422-ing every POST (caught by an
        # end-to-end agent run; see test_full_stack_post_body_is_parsed_by_pydantic).
        body = await request.body()
        if len(body) > MAX_REQUEST_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        request.state.cached_body = body
        request.state.body_sha256 = _hashlib.sha256(body).hexdigest() if body else _hashlib.sha256(b"").hexdigest()
        request._receive = _cached_body_receive(body)
        return await call_next(request)

    @app.exception_handler(ServiceError)
    async def _service_error_handler(request: Request, exc: ServiceError):
        if exc.status_code >= 500:
            logger.exception("Unhandled ServiceError", exc_info=exc)
            return JSONResponse(status_code=500, content={"detail": "Internal server error"})
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
        )

    @app.get("/health", tags=["internal"])
    async def health(request: Request) -> dict:
        checks = {}
        healthy = True

        # Check Redis
        try:
            redis: Redis = request.app.state.redis
            await redis.ping()
            checks["redis"] = "ok"
        except Exception:
            logger.error("Health check failed for Redis", exc_info=True)
            checks["redis"] = "error"
            healthy = False

        # Check Database
        try:
            db_infra: DatabaseInfra = request.app.state.db
            db = db_infra.get_manager("server")
            await db.fetch_value("SELECT 1")
            checks["database"] = "ok"
        except Exception:
            logger.error("Health check failed for database", exc_info=True)
            checks["database"] = "error"
            healthy = False

        return {"status": "ok" if healthy else "unhealthy", "checks": checks}

    app.include_router(agents_router)
    app.include_router(chat_router)
    app.include_router(dashboard_router)
    app.include_router(claims_router)
    app.include_router(contacts_router)
    app.include_router(conversations_router)
    app.include_router(events_router)
    app.include_router(federation_router)
    app.include_router(messages_router)
    app.include_router(reservations_router)
    app.include_router(service_registration_router)
    app.include_router(status_router)
    app.include_router(instructions_router)
    app.include_router(roles_router)
    app.include_router(workspaces_router)
    app.include_router(repos_router)
    # Simple-auth (Better Auth JWT) additive routers. Membership admin and the
    # Epic -> Story -> Issue hierarchy. See aweb.token_auth / aweb.routes.members
    # / aweb.routes.hierarchy.
    app.include_router(members_router)
    app.include_router(memberships_hint_router)
    app.include_router(participants_router)
    app.include_router(presence_router)
    app.include_router(hierarchy_router)

    return app


# Module-level app for uvicorn: `uvicorn aweb.api:app`
app = create_app()

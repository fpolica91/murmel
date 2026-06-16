from __future__ import annotations

import logging

import pytest
from httpx import ASGITransport, AsyncClient

from aweb.api import _cached_body_receive, create_app


class _FailingRedis:
    async def ping(self):
        raise RuntimeError("redis://secret@internal-host:6379/0 refused")


class _FailingDB:
    async def fetch_value(self, _query: str):
        raise RuntimeError("postgres://secret@db.internal/aweb refused")


class _DbInfra:
    is_initialized = True

    def get_manager(self, name: str = "aweb"):
        return _FailingDB()


@pytest.mark.asyncio
async def test_health_hides_internal_exception_details(monkeypatch, caplog):
    async def _noop_mount(_app, _db_infra, _redis, _registry_client):
        return None

    async def _noop_registry_validation(_registry_client):
        return None

    monkeypatch.setattr("aweb.api._mount_mcp_app", _noop_mount)
    monkeypatch.setattr("aweb.api._validate_awid_registry_client", _noop_registry_validation)
    caplog.set_level(logging.ERROR, logger="aweb.api")
    app = create_app(db_infra=_DbInfra(), redis=_FailingRedis())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "unhealthy",
        "checks": {
            "redis": "error",
            "database": "error",
        },
    }
    assert "redis://secret@internal-host:6379/0 refused" not in response.text
    assert "postgres://secret@db.internal/aweb refused" not in response.text
    assert "Health check failed for Redis" in caplog.text
    assert "Health check failed for database" in caplog.text


@pytest.mark.asyncio
async def test_cached_body_receive_terminates_after_replay():
    receive = _cached_body_receive(b'{"hello":"world"}')

    first = await receive()
    second = await receive()
    third = await receive()

    assert first == {"type": "http.request", "body": b'{"hello":"world"}', "more_body": False}
    assert second == {"type": "http.request", "body": b"", "more_body": False}
    assert third == {"type": "http.request", "body": b"", "more_body": False}


def test_full_stack_post_body_is_parsed_by_pydantic(monkeypatch):
    """Regression: cache_body_middleware must keep POST JSON bodies readable by
    pydantic through the FULL middleware stack, AND enforce the size cap.

    A round-7 change swapped the body read to request.stream(), which consumes
    the receive channel without populating Starlette's body cache, so every POST
    422'd ("body: Field required") on the live server. Router-only unit tests
    miss this (they skip create_app's middleware); an end-to-end agent run caught
    it. Uses Starlette's TestClient (httpx ASGITransport does not faithfully
    replay the middleware receive).
    """
    from fastapi import Body
    from starlette.testclient import TestClient

    async def _noop_mount(*_a, **_k):
        return None

    async def _noop_reg(*_a):
        return None

    monkeypatch.setattr("aweb.api._mount_mcp_app", _noop_mount)
    monkeypatch.setattr("aweb.api._validate_awid_registry_client", _noop_reg)
    monkeypatch.setattr("aweb.api.MAX_REQUEST_BODY_BYTES", 1024)
    app = create_app(db_infra=_DbInfra(), redis=_FailingRedis())

    @app.post("/v1/_test_echo_body")
    async def _echo(msg: str = Body(..., embed=True)):  # noqa: ANN202
        return {"msg": msg}

    # No context manager -> skip the app lifespan (needs a real DB/Redis); the
    # body middleware + route under test don't require app.state.
    client = TestClient(app)

    ok = client.post("/v1/_test_echo_body", json={"msg": "hello body"})
    assert ok.status_code == 200, ok.text
    assert ok.json() == {"msg": "hello body"}  # body reached pydantic

    too_big = client.post("/v1/_test_echo_body", json={"msg": "x" * 4096})
    assert too_big.status_code == 413, too_big.text  # size cap enforced

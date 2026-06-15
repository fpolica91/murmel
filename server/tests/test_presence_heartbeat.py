"""Presence heartbeat for token (human) identities.

Covers the PRESENCE CONTRACT (ai-completion/DEMO-PLAN.md §2):
  - POST /v1/presence/heartbeat resolves the human's REAL agent_id UUID via
    provision_human_participant and writes Redis presence keyed by that UUID
    with a 120s TTL, returning {agent_id, alias, online:true, last_seen};
  - GET /v1/participants joins that presence for HUMANS too (the kind=="agent"
    guard was removed), so the roster reflects live human presence.
"""

from __future__ import annotations

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest

from aweb.identity_auth_deps import provision_human_participant
from aweb.routes.participants import router as participants_router
from aweb.routes.presence import PRESENCE_TTL_SECONDS
from aweb.routes.presence import router as presence_router
from aweb.team_auth_deps import TeamIdentity, get_team_identity


TEAM_ID = "backend:acme.com"


class _DbShim:
    def __init__(self, aweb_db) -> None:
        self._db = aweb_db

    def get_manager(self, name: str = "aweb"):
        return self._db


class _FakeRedis:
    """In-memory async stand-in covering the presence read/write surface."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict] = {}
        self.sets: dict[str, set] = {}
        self.strings: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def hset(self, key, mapping=None):
        self.hashes.setdefault(key, {}).update({k: str(v) for k, v in (mapping or {}).items()})

    async def expire(self, key, ttl):
        self.ttls[key] = ttl

    async def sadd(self, key, *members):
        self.sets.setdefault(key, set()).update(str(m) for m in members)

    async def set(self, key, value, ex=None):
        self.strings[key] = str(value)
        if ex is not None:
            self.ttls[key] = ex

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    def pipeline(self):
        return _FakePipeline(self)


class _FakePipeline:
    def __init__(self, redis: _FakeRedis) -> None:
        self._redis = redis
        self._ops: list = []

    def hgetall(self, key):
        self._ops.append(("hgetall", key))
        return self

    async def execute(self):
        out = []
        for op, key in self._ops:
            if op == "hgetall":
                out.append(dict(self._redis.hashes.get(key, {})))
        return out


async def _seed_team(aweb_db) -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, 'acme.com', 'backend', 'did:key:z6Mkteam')
        ON CONFLICT DO NOTHING
        """,
        TEAM_ID,
    )


def _human_identity(alias: str = "Alice Human", subject: str = "user-alice") -> TeamIdentity:
    return TeamIdentity(
        team_id=TEAM_ID,
        alias=alias,
        did_key="",
        did_aw="",
        address="",
        agent_id=subject,
        identity_scope="token",
        certificate_id="",
    )


def _build_app(aweb_db, redis, identity: TeamIdentity) -> FastAPI:
    app = FastAPI()
    app.include_router(presence_router)
    app.include_router(participants_router)
    app.state.db = _DbShim(aweb_db)
    app.state.redis = redis
    app.state.on_mutation = None
    app.dependency_overrides[get_team_identity] = lambda: identity
    return app


@pytest.mark.asyncio
async def test_presence_heartbeat_marks_human_online(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    redis = _FakeRedis()
    app = _build_app(aweb_cloud_db.aweb_db, redis, _human_identity())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/v1/presence/heartbeat")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Real agent_id UUID (not the Better Auth subject string).
        assert body["agent_id"]
        assert body["agent_id"] != "user-alice"
        assert body["alias"] == "Alice Human"
        assert body["online"] is True
        assert body["last_seen"]

        # Presence keyed by the real UUID with the 120s TTL window.
        agent_id = body["agent_id"]
        key = f"presence:{agent_id}"
        assert key in redis.hashes
        assert redis.ttls[key] == PRESENCE_TTL_SECONDS
        assert redis.hashes[key]["status"] == "active"

        # The roster now reflects the human as online (guard removed).
        roster = await client.get("/v1/participants")
        assert roster.status_code == 200, roster.text
        human = {p["alias"]: p for p in roster.json()["participants"]}["Alice Human"]
        assert human["kind"] == "human"
        assert human["online"] is True
        assert human["status"] == "active"
        assert human["last_seen"]


@pytest.mark.asyncio
async def test_presence_heartbeat_is_idempotent_single_row(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    redis = _FakeRedis()
    app = _build_app(aweb_cloud_db.aweb_db, redis, _human_identity())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        first = (await client.post("/v1/presence/heartbeat")).json()
        second = (await client.post("/v1/presence/heartbeat")).json()
    assert first["agent_id"] == second["agent_id"]

    count = await aweb_cloud_db.aweb_db.fetch_value(
        "SELECT COUNT(*) FROM {{tables.agents}} WHERE team_id = $1 AND agent_type = 'human'",
        TEAM_ID,
    )
    assert int(count) == 1

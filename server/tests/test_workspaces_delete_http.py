"""HTTP-level regression tests for DELETE /v1/workspaces/{workspace_id}."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from aweb.coordination.routes import workspaces as workspace_routes
from aweb.coordination.routes.workspaces import router as workspaces_router
from aweb.team_auth_deps import TeamIdentity


def _fake_identity(team_id: str, alias: str = "bob", agent_id: str | None = None):
    async def _identity(_request, _db_infra):
        return TeamIdentity(
            team_id=team_id,
            alias=alias,
            agent_id=agent_id or str(uuid4()),
            identity_scope="token",
            did_key="",
            did_aw="",
            address="",
            certificate_id="",
        )

    return _identity


def _build_test_app(aweb_db, redis=None):
    app = FastAPI()
    app.include_router(workspaces_router)

    class _DbShim:
        def get_manager(self, name="aweb"):
            return aweb_db

    app.state.db = _DbShim()
    app.state.redis = redis
    app.state.awid_registry_client = AsyncMock()
    return app


class _FakeRedisPipeline:
    def __init__(self, redis):
        self.redis = redis
        self.actions = []

    def delete(self, key):
        self.actions.append(("delete", key))
        return self

    def srem(self, key, member):
        self.actions.append(("srem", key, member))
        return self

    async def execute(self):
        self.redis.pipeline_actions.extend(self.actions)
        return [1 for _ in self.actions]


class _FakeRedis:
    def __init__(self):
        self.published = []
        self.pipeline_actions = []

    async def publish(self, channel, message):
        self.published.append((channel, json.loads(message)))
        return 1

    def pipeline(self):
        return _FakeRedisPipeline(self)


@pytest.mark.asyncio
async def test_delete_workspace_soft_deletes_stale_ephemeral_identity(
    aweb_cloud_db, monkeypatch
):
    team_id = "backend:acme.com"
    workspace_id = uuid4()
    agent_id = uuid4()

    monkeypatch.setattr(
        workspace_routes,
        "get_team_identity",
        _fake_identity(team_id, alias="bob", agent_id=str(agent_id)),
    )

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        team_id,
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, $3, $4, 'local', 'developer')
        """,
        agent_id,
        team_id,
        "did:key:z6Mkbob",
        "bob",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.workspaces}}
            (workspace_id, team_id, agent_id, alias, workspace_path, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        workspace_id,
        team_id,
        agent_id,
        "bob",
        "/tmp/gone-worktree",
        datetime.now(timezone.utc) - timedelta(hours=1),
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.task_claims}}
            (team_id, workspace_id, alias, human_name, task_ref, claimed_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        team_id,
        workspace_id,
        "bob",
        "",
        "backend-1",
        datetime.now(timezone.utc),
    )

    redis = _FakeRedis()
    app = _build_test_app(aweb_cloud_db.aweb_db, redis=redis)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        resp = await client.delete(f"/v1/workspaces/{workspace_id}")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["workspace_id"] == str(workspace_id)
    assert body["alias"] == "bob"
    assert body["identity_deleted"] is True

    workspace_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at FROM {{tables.workspaces}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    agent_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at, status FROM {{tables.agents}}
        WHERE agent_id = $1
        """,
        agent_id,
    )
    claims_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT COUNT(*) AS count FROM {{tables.task_claims}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )

    assert workspace_row["deleted_at"] is not None
    assert agent_row["deleted_at"] is not None
    assert agent_row["status"] == "deleted"
    assert claims_row["count"] == 0
    assert any(
        channel == f"events:{workspace_id}"
        and payload["type"] == "task.unclaimed"
        and payload["workspace_id"] == str(workspace_id)
        and payload["task_ref"] == "backend-1"
        and payload["alias"] == "bob"
        for channel, payload in redis.published
    )
    assert any(
        channel == f"team-events:{team_id}"
        and payload["type"] == "task.unclaimed"
        and payload["team_id"] == team_id
        and payload["task_ref"] == "backend-1"
        and payload["alias"] == "bob"
        for channel, payload in redis.published
    )
    assert ("delete", f"presence:{workspace_id}") in redis.pipeline_actions
    assert ("srem", "idx:all_workspaces", str(workspace_id)) in redis.pipeline_actions


@pytest.mark.asyncio
async def test_delete_workspace_rejects_persistent_identity(aweb_cloud_db, monkeypatch):
    team_id = "backend:acme.com"
    workspace_id = uuid4()
    agent_id = uuid4()

    monkeypatch.setattr(
        workspace_routes,
        "get_team_identity",
        _fake_identity(team_id, alias="maintainer", agent_id=str(agent_id)),
    )

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        team_id,
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, did_aw, address, alias, identity_scope, role)
        VALUES ($1, $2, $3, $4, $5, $6, 'global', 'developer')
        """,
        agent_id,
        team_id,
        "did:key:z6Mkmaintainer",
        "did:aw:maintainer",
        "acme.com/maintainer",
        "maintainer",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.workspaces}}
            (workspace_id, team_id, agent_id, alias, workspace_path, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        workspace_id,
        team_id,
        agent_id,
        "maintainer",
        "/tmp/gone-worktree",
        datetime.now(timezone.utc) - timedelta(hours=1),
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.task_claims}}
            (team_id, workspace_id, alias, human_name, task_ref, claimed_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        team_id,
        workspace_id,
        "maintainer",
        "",
        "backend-2",
        datetime.now(timezone.utc),
    )

    app = _build_test_app(aweb_cloud_db.aweb_db)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        resp = await client.delete(f"/v1/workspaces/{workspace_id}")

    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"]["code"] == "global_identity_not_cleanup_eligible"
    assert body["detail"]["workspace_id"] == str(workspace_id)
    assert body["detail"]["identity_id"] == str(agent_id)
    assert body["detail"]["identity_scope"] == "global"

    workspace_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at FROM {{tables.workspaces}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    agent_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at, status, did_key, did_aw, address, identity_scope FROM {{tables.agents}}
        WHERE agent_id = $1
        """,
        agent_id,
    )
    claims_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT COUNT(*) AS count FROM {{tables.task_claims}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    assert workspace_row["deleted_at"] is None
    assert agent_row["deleted_at"] is None
    assert agent_row["status"] == "active"
    assert agent_row["did_key"] == "did:key:z6Mkmaintainer"
    assert agent_row["did_aw"] == "did:aw:maintainer"
    assert agent_row["address"] == "acme.com/maintainer"
    assert agent_row["identity_scope"] == "global"
    assert claims_row["count"] == 1


@pytest.mark.asyncio
async def test_delete_workspace_unknown_identity_scope_fails_closed(
    aweb_cloud_db, monkeypatch
):
    team_id = "backend:acme.com"
    workspace_id = uuid4()
    missing_agent_id = uuid4()

    monkeypatch.setattr(
        workspace_routes,
        "get_team_identity",
        _fake_identity(team_id, alias="caller"),
    )

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        team_id,
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, $3, 'local', 'developer')
        """,
        team_id,
        "did:key:z6Mkcaller",
        "caller",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.workspaces}}
            (workspace_id, team_id, agent_id, alias, workspace_path, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        workspace_id,
        team_id,
        missing_agent_id,
        "orphan",
        "/tmp/gone-worktree",
        datetime.now(timezone.utc) - timedelta(hours=1),
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.task_claims}}
            (team_id, workspace_id, alias, human_name, task_ref, claimed_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        team_id,
        workspace_id,
        "orphan",
        "",
        "backend-3",
        datetime.now(timezone.utc),
    )

    app = _build_test_app(aweb_cloud_db.aweb_db)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        resp = await client.delete(f"/v1/workspaces/{workspace_id}")

    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"]["code"] == "unknown_identity_scope_no_cleanup"
    assert body["detail"]["workspace_id"] == str(workspace_id)
    assert body["detail"]["identity_id"] == str(missing_agent_id)
    assert body["detail"]["identity_scope"] == "unknown"

    workspace_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at FROM {{tables.workspaces}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    claims_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT COUNT(*) AS count FROM {{tables.task_claims}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    assert workspace_row["deleted_at"] is None
    assert claims_row["count"] == 1


@pytest.mark.asyncio
async def test_delete_workspace_rejects_recent_ephemeral_workspace(
    aweb_cloud_db, monkeypatch
):
    team_id = "backend:acme.com"
    workspace_id = uuid4()
    agent_id = uuid4()

    monkeypatch.setattr(
        workspace_routes,
        "get_team_identity",
        _fake_identity(team_id, alias="bot", agent_id=str(agent_id)),
    )

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        team_id,
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, $3, $4, 'local', 'developer')
        """,
        agent_id,
        team_id,
        "did:key:z6Mkbot",
        "bot",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.workspaces}}
            (workspace_id, team_id, agent_id, alias, workspace_path, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        workspace_id,
        team_id,
        agent_id,
        "bot",
        "/tmp/recent-worktree",
        datetime.now(timezone.utc) - timedelta(minutes=5),
    )

    app = _build_test_app(aweb_cloud_db.aweb_db)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        resp = await client.delete(f"/v1/workspaces/{workspace_id}")

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "local_workspace_still_active"

    workspace_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at FROM {{tables.workspaces}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    agent_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at FROM {{tables.agents}}
        WHERE agent_id = $1
        """,
        agent_id,
    )
    assert workspace_row["deleted_at"] is None
    assert agent_row["deleted_at"] is None


@pytest.mark.asyncio
async def test_delete_workspace_rejects_cross_team_request(aweb_cloud_db, monkeypatch):
    team_a_address = "backend:acme.com"
    team_b_address = "dev:other.example"
    workspace_id = uuid4()
    agent_id = uuid4()

    # Caller authenticates as team B; the target workspace belongs to team A,
    # so it must not be visible (404) under team-scoped lookup.
    monkeypatch.setattr(
        workspace_routes,
        "get_team_identity",
        _fake_identity(team_b_address, alias="eve"),
    )

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)
        """,
        team_a_address,
        "acme.com",
        "backend",
        "did:key:z6Mkteama",
        team_b_address,
        "other.example",
        "dev",
        "did:key:z6Mkteamb",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, $3, $4, 'local', 'developer')
        """,
        agent_id,
        team_a_address,
        "did:key:z6Mkalice",
        "alice",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, $3, 'local', 'developer')
        """,
        team_b_address,
        "did:key:z6Mkeve",
        "eve",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.workspaces}}
            (workspace_id, team_id, agent_id, alias, workspace_path, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        workspace_id,
        team_a_address,
        agent_id,
        "alice",
        "/tmp/team-a-worktree",
        datetime.now(timezone.utc) - timedelta(hours=1),
    )

    app = _build_test_app(aweb_cloud_db.aweb_db)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        resp = await client.delete(f"/v1/workspaces/{workspace_id}")

    assert resp.status_code == 404

    workspace_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at FROM {{tables.workspaces}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    agent_row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT deleted_at FROM {{tables.agents}}
        WHERE agent_id = $1
        """,
        agent_id,
    )
    assert workspace_row["deleted_at"] is None
    assert agent_row["deleted_at"] is None

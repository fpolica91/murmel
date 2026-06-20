from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from aweb.coordination.routes.memories import memories_router
from aweb.team_auth_deps import TeamIdentity, get_team_identity

TEAM_A = "backend:acme.com"
TEAM_B = "outsiders:evil.com"


class _DbShim:
    def __init__(self, aweb_db) -> None:
        self._db = aweb_db

    def get_manager(self, name: str = "aweb"):
        return self._db


def _identity(team_id: str, alias: str):
    async def _dep() -> TeamIdentity:
        return TeamIdentity(
            team_id=team_id,
            alias=alias,
            did_key=f"did:key:z6Mk{alias}",
            did_aw=f"did:aw:{alias}",
            address=f"{team_id}/{alias}",
            agent_id=str(uuid4()),
            identity_scope="global",
            certificate_id="cert-001",
        )

    return _dep


def _build_app(aweb_db, *, team_id: str, alias: str) -> FastAPI:
    app = FastAPI()
    app.include_router(memories_router)
    app.state.db = _DbShim(aweb_db)
    app.dependency_overrides[get_team_identity] = _identity(team_id, alias)
    return app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_memory_crud_round_trip(aweb_cloud_db):
    app = _build_app(aweb_cloud_db.aweb_db, team_id=TEAM_A, alias="alice")
    async with _client(app) as client:
        # create
        resp = await client.post(
            "/v1/memories",
            json={
                "title": "Local stack port",
                "body_md": "The aweb python stack runs on **:8088**.",
                "tags": ["infra", "stack"],
            },
        )
        assert resp.status_code == 201, resp.text
        mem = resp.json()
        assert mem["title"] == "Local stack port"
        assert mem["team_id"] == TEAM_A
        # author byline is stamped server-side from identity, never the client
        assert mem["created_by_alias"] == "alice"
        assert sorted(mem["tags"]) == ["infra", "stack"]
        mid = mem["memory_id"]

        # get by id
        got = await client.get(f"/v1/memories/{mid}")
        assert got.status_code == 200, got.text
        assert got.json()["memory_id"] == mid

        # list (default = most recent)
        listed = await client.get("/v1/memories")
        assert listed.status_code == 200
        ids = [m["memory_id"] for m in listed.json()["memories"]]
        assert mid in ids


@pytest.mark.asyncio
async def test_memory_full_text_and_tag_search(aweb_cloud_db):
    app = _build_app(aweb_cloud_db.aweb_db, team_id=TEAM_A, alias="alice")
    async with _client(app) as client:
        await client.post(
            "/v1/memories",
            json={"title": "Redis cache", "body_md": "redis lives on port 6390", "tags": ["infra"]},
        )
        await client.post(
            "/v1/memories",
            json={"title": "Frontend fonts", "body_md": "Geist + Space Grotesk", "tags": ["ui"]},
        )

        # full-text q hits the redis note, not the fonts note
        hits = (await client.get("/v1/memories", params={"q": "redis"})).json()["memories"]
        titles = [m["title"] for m in hits]
        assert "Redis cache" in titles
        assert "Frontend fonts" not in titles

        # tag facet
        ui = (await client.get("/v1/memories", params={"tag": "ui"})).json()["memories"]
        assert [m["title"] for m in ui] == ["Frontend fonts"]


@pytest.mark.asyncio
async def test_memory_partial_update_and_delete(aweb_cloud_db):
    app = _build_app(aweb_cloud_db.aweb_db, team_id=TEAM_A, alias="alice")
    async with _client(app) as client:
        mid = (await client.post(
            "/v1/memories", json={"title": "Draft", "body_md": "v1", "tags": ["a"]}
        )).json()["memory_id"]

        # partial update: only body changes; title/tags preserved
        upd = await client.patch(f"/v1/memories/{mid}", json={"body_md": "v2 final"})
        assert upd.status_code == 200, upd.text
        body = upd.json()
        assert body["body_md"] == "v2 final"
        assert body["title"] == "Draft"
        assert body["tags"] == ["a"]

        # delete -> 204, then gone
        d = await client.delete(f"/v1/memories/{mid}")
        assert d.status_code == 204
        assert (await client.get(f"/v1/memories/{mid}")).status_code == 404
        assert (await client.patch(f"/v1/memories/{mid}", json={"title": "x"})).status_code == 404


@pytest.mark.asyncio
async def test_memory_cross_team_isolation(aweb_cloud_db):
    """The security bar: a memory created by TEAM_A must be invisible and
    un-gettable by TEAM_B, even with its exact id (direct-object exfil)."""
    app_a = _build_app(aweb_cloud_db.aweb_db, team_id=TEAM_A, alias="alice")
    app_b = _build_app(aweb_cloud_db.aweb_db, team_id=TEAM_B, alias="mallory")

    async with _client(app_a) as ca, _client(app_b) as cb:
        secret_id = (await ca.post(
            "/v1/memories",
            json={"title": "TEAM_A secret", "body_md": "do not leak"},
        )).json()["memory_id"]

        # B cannot read A's memory by id
        assert (await cb.get(f"/v1/memories/{secret_id}")).status_code == 404
        # B cannot update or delete it
        assert (await cb.patch(f"/v1/memories/{secret_id}", json={"title": "pwned"})).status_code == 404
        assert (await cb.delete(f"/v1/memories/{secret_id}")).status_code == 404
        # B's list and full-text search never surface A's content
        b_list = (await cb.get("/v1/memories")).json()["memories"]
        assert all(m["memory_id"] != secret_id for m in b_list)
        b_search = (await cb.get("/v1/memories", params={"q": "leak"})).json()["memories"]
        assert b_search == []

        # A still sees its own
        assert (await ca.get(f"/v1/memories/{secret_id}")).status_code == 200

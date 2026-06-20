from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from aweb.routes.hierarchy import router as hierarchy_router
from aweb.team_auth_deps import TeamIdentity, get_team_identity


TEAM_ID = "backend:acme.com"
OTHER_TEAM_ID = "frontend:other.com"


class _DbShim:
    def __init__(self, aweb_db) -> None:
        self._db = aweb_db

    def get_manager(self, name: str = "aweb"):
        return self._db


def _team_identity(team_id: str, *, alias: str):
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


def _build_app(aweb_db, *, team_id: str = TEAM_ID, alias: str = "alice") -> FastAPI:
    app = FastAPI()
    app.include_router(hierarchy_router)
    app.state.db = _DbShim(aweb_db)
    app.state.on_mutation = None
    app.dependency_overrides[get_team_identity] = _team_identity(team_id, alias=alias)
    return app


async def _seed_team(aweb_db, *, team_id: str, namespace: str, name: str) -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
        """,
        team_id,
        namespace,
        name,
        f"did:key:z6Mkteam-{namespace}",
    )


async def _setup(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db, team_id=TEAM_ID, namespace="acme.com", name="backend")
    await _seed_team(db, team_id=OTHER_TEAM_ID, namespace="other.com", name="frontend")
    return _build_app(db)


@pytest.mark.asyncio
async def test_add_and_get_dependency_neighbours(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        a = (await client.post("/v1/issues", json={"title": "Issue A"})).json()
        b = (await client.post("/v1/issues", json={"title": "Issue B"})).json()
        a_id, b_id = a["issue_id"], b["issue_id"]

        # A depends on B (A is blocked by B).
        post = await client.post(
            f"/v1/issues/{a_id}/dependencies", json={"depends_on_id": b_id}
        )
        assert post.status_code == 201, post.text
        body = post.json()
        assert body["issue_id"] == a_id
        # Fresh neighbours come back on the POST response itself.
        assert b_id in [d["issue_id"] for d in body["blocked_by"]]

        # GET A: B appears in A.blocked_by.
        a_deps = (await client.get(f"/v1/issues/{a_id}/dependencies")).json()
        blocked_by = a_deps["blocked_by"]
        assert [d["issue_id"] for d in blocked_by] == [b_id]
        assert blocked_by[0]["title"] == "Issue B"
        assert "status" in blocked_by[0]

        # GET B: A appears in B.blocks.
        b_deps = (await client.get(f"/v1/issues/{b_id}/dependencies")).json()
        assert [d["issue_id"] for d in b_deps["blocks"]] == [a_id]
        assert b_deps["blocked_by"] == []


@pytest.mark.asyncio
async def test_self_dependency_rejected(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        a = (await client.post("/v1/issues", json={"title": "Solo"})).json()
        a_id = a["issue_id"]

        resp = await client.post(
            f"/v1/issues/{a_id}/dependencies", json={"depends_on_id": a_id}
        )
        assert 400 <= resp.status_code < 500, resp.text


@pytest.mark.asyncio
async def test_cycle_rejected(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        a = (await client.post("/v1/issues", json={"title": "Issue A"})).json()
        b = (await client.post("/v1/issues", json={"title": "Issue B"})).json()
        a_id, b_id = a["issue_id"], b["issue_id"]

        # A depends on B is fine.
        ok = await client.post(
            f"/v1/issues/{a_id}/dependencies", json={"depends_on_id": b_id}
        )
        assert ok.status_code == 201, ok.text

        # B depends on A would close a cycle -> 4xx.
        cycle = await client.post(
            f"/v1/issues/{b_id}/dependencies", json={"depends_on_id": a_id}
        )
        assert 400 <= cycle.status_code < 500, cycle.text


@pytest.mark.asyncio
async def test_delete_removes_edge(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        a = (await client.post("/v1/issues", json={"title": "Issue A"})).json()
        b = (await client.post("/v1/issues", json={"title": "Issue B"})).json()
        a_id, b_id = a["issue_id"], b["issue_id"]

        await client.post(
            f"/v1/issues/{a_id}/dependencies", json={"depends_on_id": b_id}
        )

        delete = await client.delete(f"/v1/issues/{a_id}/dependencies/{b_id}")
        assert delete.status_code == 200, delete.text
        # The DELETE response already reflects the removal.
        assert delete.json()["blocked_by"] == []

        a_deps = (await client.get(f"/v1/issues/{a_id}/dependencies")).json()
        assert a_deps["blocked_by"] == []
        b_deps = (await client.get(f"/v1/issues/{b_id}/dependencies")).json()
        assert b_deps["blocks"] == []


@pytest.mark.asyncio
async def test_cross_team_issue_not_found(aweb_cloud_db):
    """An issue owned by another team is invisible: POST/GET both 404 for us."""
    db = aweb_cloud_db.aweb_db
    await _seed_team(db, team_id=TEAM_ID, namespace="acme.com", name="backend")
    await _seed_team(db, team_id=OTHER_TEAM_ID, namespace="other.com", name="frontend")

    # An issue created under OTHER_TEAM_ID (a different identity).
    other_app = _build_app(db, team_id=OTHER_TEAM_ID, alias="mallory")
    async with AsyncClient(
        transport=ASGITransport(app=other_app), base_url="http://test"
    ) as other_client:
        foreign = (
            await other_client.post("/v1/issues", json={"title": "Foreign"})
        ).json()
        foreign_id = foreign["issue_id"]

    # Our team's client owns a real issue we can use as the dependent.
    app = _build_app(db, team_id=TEAM_ID, alias="alice")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        mine = (await client.post("/v1/issues", json={"title": "Mine"})).json()
        mine_id = mine["issue_id"]

        # GET deps for a cross-team issue id -> 404.
        get = await client.get(f"/v1/issues/{foreign_id}/dependencies")
        assert get.status_code == 404, get.text

        # POST adding a dependency on a cross-team issue -> 404 (depends_on side).
        post = await client.post(
            f"/v1/issues/{mine_id}/dependencies", json={"depends_on_id": foreign_id}
        )
        assert post.status_code == 404, post.text

        # POST on a cross-team issue_id (the dependent side) -> 404.
        post2 = await client.post(
            f"/v1/issues/{foreign_id}/dependencies", json={"depends_on_id": mine_id}
        )
        assert post2.status_code == 404, post2.text

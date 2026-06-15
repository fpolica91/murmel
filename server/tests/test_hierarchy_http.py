from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from aweb.routes.hierarchy import router as hierarchy_router
from aweb.team_auth_deps import TeamIdentity, get_team_identity


TEAM_ID = "backend:acme.com"


class _DbShim:
    def __init__(self, aweb_db) -> None:
        self._db = aweb_db

    def get_manager(self, name: str = "aweb"):
        return self._db


def _build_app(aweb_db) -> FastAPI:
    app = FastAPI()
    app.include_router(hierarchy_router)
    app.state.db = _DbShim(aweb_db)
    app.state.on_mutation = None
    app.dependency_overrides[get_team_identity] = _fake_team_identity
    return app


async def _fake_team_identity() -> TeamIdentity:
    return TeamIdentity(
        team_id=TEAM_ID,
        alias="alice",
        did_key="did:key:z6Mkalice",
        did_aw="did:aw:alice",
        address="acme.com/alice",
        agent_id=str(uuid4()),
        identity_scope="global",
        certificate_id="cert-001",
    )


async def _seed_team(aweb_db) -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, 'acme.com', 'backend', 'did:key:z6Mkteam')
        ON CONFLICT DO NOTHING
        """,
        TEAM_ID,
    )


async def _setup(aweb_cloud_db):
    app = _build_app(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)
    return app


@pytest.mark.asyncio
async def test_create_epic_story_issue(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        epic_resp = await client.post("/v1/epics", json={"title": "Q3 platform"})
        assert epic_resp.status_code == 201, epic_resp.text
        epic = epic_resp.json()
        assert epic["title"] == "Q3 platform"
        assert epic["status"] == "open"
        assert epic["team_id"] == TEAM_ID
        epic_id = epic["epic_id"]

        story_resp = await client.post(
            "/v1/stories",
            json={"title": "Auth flow", "epic_id": epic_id},
        )
        assert story_resp.status_code == 201, story_resp.text
        story = story_resp.json()
        assert story["title"] == "Auth flow"
        assert story["epic_id"] == epic_id
        assert story["team_id"] == TEAM_ID
        story_id = story["story_id"]

        issue_resp = await client.post(
            "/v1/issues",
            json={
                "title": "Build login page",
                "description": "Wire up the UI",
                "epic_id": epic_id,
                "story_id": story_id,
            },
        )
        assert issue_resp.status_code == 201, issue_resp.text
        issue = issue_resp.json()
        assert issue["title"] == "Build login page"
        assert issue["description"] == "Wire up the UI"
        assert issue["status"] == "todo"
        assert issue["epic_id"] == epic_id
        assert issue["story_id"] == story_id
        assert issue["team_id"] == TEAM_ID


@pytest.mark.asyncio
async def test_list_epics_and_stories(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        epic_id = (await client.post("/v1/epics", json={"title": "Epic A"})).json()["epic_id"]
        story_id = (
            await client.post("/v1/stories", json={"title": "Story A", "epic_id": epic_id})
        ).json()["story_id"]

        epics_resp = await client.get("/v1/epics")
        assert epics_resp.status_code == 200
        epics_body = epics_resp.json()
        assert epics_body["team_id"] == TEAM_ID
        assert epic_id in [e["epic_id"] for e in epics_body["epics"]]

        stories_resp = await client.get("/v1/stories")
        assert stories_resp.status_code == 200
        stories_body = stories_resp.json()
        assert stories_body["team_id"] == TEAM_ID
        assert story_id in [s["story_id"] for s in stories_body["stories"]]

        # filter stories by epic_id
        filtered = await client.get("/v1/stories", params={"epic_id": epic_id})
        assert filtered.status_code == 200
        assert [s["story_id"] for s in filtered.json()["stories"]] == [story_id]


@pytest.mark.asyncio
async def test_list_issues_with_filters(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        epic_id = (await client.post("/v1/epics", json={"title": "Epic F"})).json()["epic_id"]

        todo_issue = (
            await client.post(
                "/v1/issues",
                json={"title": "Todo issue", "epic_id": epic_id},
            )
        ).json()
        assigned_issue = (
            await client.post(
                "/v1/issues",
                json={
                    "title": "Assigned issue",
                    "status": "in_progress",
                    "assignee_type": "agent",
                    "assignee_id": "did:aw:bob",
                    "epic_id": epic_id,
                },
            )
        ).json()

        # all issues for the epic appear
        all_resp = await client.get("/v1/issues", params={"epic_id": epic_id})
        assert all_resp.status_code == 200
        ids = {i["issue_id"] for i in all_resp.json()["issues"]}
        assert ids == {todo_issue["issue_id"], assigned_issue["issue_id"]}

        # filter by status
        status_resp = await client.get("/v1/issues", params={"status": "in_progress"})
        status_ids = [i["issue_id"] for i in status_resp.json()["issues"]]
        assert assigned_issue["issue_id"] in status_ids
        assert todo_issue["issue_id"] not in status_ids

        # filter by assignee_type
        assignee_resp = await client.get(
            "/v1/issues", params={"assignee_type": "agent"}
        )
        assignee_ids = [i["issue_id"] for i in assignee_resp.json()["issues"]]
        assert assignee_ids == [assigned_issue["issue_id"]]


@pytest.mark.asyncio
async def test_get_issue_and_404(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = (
            await client.post("/v1/issues", json={"title": "Fetch me"})
        ).json()
        issue_id = created["issue_id"]

        get_resp = await client.get(f"/v1/issues/{issue_id}")
        assert get_resp.status_code == 200
        assert get_resp.json()["issue_id"] == issue_id
        assert get_resp.json()["team_id"] == TEAM_ID

        missing = await client.get(f"/v1/issues/{uuid4()}")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_update_issue(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        issue_id = (
            await client.post("/v1/issues", json={"title": "Original"})
        ).json()["issue_id"]

        update_resp = await client.patch(
            f"/v1/issues/{issue_id}",
            json={
                "title": "Updated title",
                "status": "in_review",
                "assignee_type": "human",
                "assignee_id": "alice@acme.com",
            },
        )
        assert update_resp.status_code == 200, update_resp.text
        updated = update_resp.json()
        assert updated["title"] == "Updated title"
        assert updated["status"] == "in_review"
        assert updated["assignee_type"] == "human"
        assert updated["assignee_id"] == "alice@acme.com"
        assert updated["team_id"] == TEAM_ID


@pytest.mark.asyncio
async def test_claim_issue_moves_to_in_progress(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        issue_id = (
            await client.post("/v1/issues", json={"title": "Claimable"})
        ).json()["issue_id"]

        claim_resp = await client.post(
            f"/v1/issues/{issue_id}/claim",
            json={"assignee_type": "agent", "assignee_id": "did:aw:worker"},
        )
        assert claim_resp.status_code == 200, claim_resp.text
        claimed = claim_resp.json()
        assert claimed["assignee_type"] == "agent"
        assert claimed["assignee_id"] == "did:aw:worker"
        assert claimed["status"] == "in_progress"
        assert claimed["team_id"] == TEAM_ID


@pytest.mark.asyncio
async def test_update_issue_status(aweb_cloud_db):
    app = await _setup(aweb_cloud_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        issue_id = (
            await client.post("/v1/issues", json={"title": "Status test"})
        ).json()["issue_id"]

        status_resp = await client.patch(
            f"/v1/issues/{issue_id}/status",
            json={"status": "done"},
        )
        assert status_resp.status_code == 200, status_resp.text
        body = status_resp.json()
        assert body["status"] == "done"
        assert body["issue_id"] == issue_id
        assert body["team_id"] == TEAM_ID

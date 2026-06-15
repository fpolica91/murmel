from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from aweb.coordination.hierarchy import (
    claim_issue,
    create_epic,
    create_issue,
    create_story,
    get_issue,
    list_issues,
    update_issue,
)
from aweb.routes.members import hint_router
from aweb.service_errors import NotFoundError, ValidationError


TEAM_ID = "backend:acme.com"


class _DbShim:
    def __init__(self, aweb_db) -> None:
        self._db = aweb_db

    def get_manager(self, name: str = "aweb"):
        return self._db


def _build_hint_app(aweb_db) -> FastAPI:
    app = FastAPI()
    app.include_router(hint_router)
    app.state.db = _DbShim(aweb_db)
    return app


async def _seed_team(aweb_db, team_id: str = TEAM_ID, namespace: str = "acme.com") -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, 'backend', 'did:key:z6Mkteam')
        ON CONFLICT DO NOTHING
        """,
        team_id,
        namespace,
    )


async def _insert_membership(
    aweb_db,
    *,
    subject: str,
    team_id: str,
    role: str,
    status: str = "active",
) -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.memberships}} (subject, team_id, role, status)
        VALUES ($1, $2, $3, $4)
        """,
        subject,
        team_id,
        role,
        status,
    )


# ---------------------------------------------------------------------------
# PART 1 -- the memberships-hint endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hint_correct_header_returns_active_teams_only(aweb_cloud_db, monkeypatch):
    monkeypatch.setenv("AWEB_MEMBERSHIPS_HINT_KEY", "test-secret")
    db = aweb_cloud_db.aweb_db
    await _seed_team(db, team_id="backend:acme.com", namespace="acme.com")
    await _seed_team(db, team_id="frontend:acme.com", namespace="acme.com")
    await _seed_team(db, team_id="ops:acme.com", namespace="acme.com")

    # Two active memberships + one suspended (must be excluded).
    await _insert_membership(db, subject="user-1", team_id="backend:acme.com", role="admin")
    await _insert_membership(db, subject="user-1", team_id="frontend:acme.com", role="member")
    await _insert_membership(
        db, subject="user-1", team_id="ops:acme.com", role="owner", status="suspended"
    )

    app = _build_hint_app(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get(
            "/v1/memberships",
            params={"subject": "user-1"},
            headers={"X-AWEB-Internal-Key": "test-secret"},
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["team_ids"] == ["backend:acme.com", "frontend:acme.com"]
    assert "ops:acme.com" not in body["team_ids"]
    assert body["roles"] == ["admin", "member"]
    assert "owner" not in body["roles"]


@pytest.mark.asyncio
async def test_hint_wrong_header_returns_401(aweb_cloud_db, monkeypatch):
    monkeypatch.setenv("AWEB_MEMBERSHIPS_HINT_KEY", "test-secret")
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _insert_membership(db, subject="user-1", team_id=TEAM_ID, role="admin")

    app = _build_hint_app(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get(
            "/v1/memberships",
            params={"subject": "user-1"},
            headers={"X-AWEB-Internal-Key": "wrong-secret"},
        )

    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_hint_missing_header_returns_401(aweb_cloud_db, monkeypatch):
    monkeypatch.setenv("AWEB_MEMBERSHIPS_HINT_KEY", "test-secret")
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _insert_membership(db, subject="user-1", team_id=TEAM_ID, role="admin")

    app = _build_hint_app(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/memberships", params={"subject": "user-1"})

    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_hint_unknown_subject_returns_empty_lists(aweb_cloud_db, monkeypatch):
    monkeypatch.setenv("AWEB_MEMBERSHIPS_HINT_KEY", "test-secret")
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)

    app = _build_hint_app(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get(
            "/v1/memberships",
            params={"subject": "nobody-here"},
            headers={"X-AWEB-Internal-Key": "test-secret"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"team_ids": [], "roles": []}


@pytest.mark.asyncio
async def test_hint_disabled_when_key_unset_returns_404(aweb_cloud_db, monkeypatch):
    monkeypatch.delenv("AWEB_MEMBERSHIPS_HINT_KEY", raising=False)
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _insert_membership(db, subject="user-1", team_id=TEAM_ID, role="admin")

    app = _build_hint_app(db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get(
            "/v1/memberships",
            params={"subject": "user-1"},
            headers={"X-AWEB-Internal-Key": "anything"},
        )

    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# PART 2 -- the work-hierarchy data-access service (tested directly)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_hierarchy_and_get_issue(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    epic = await create_epic(db, team_id=TEAM_ID, title="Epic A")
    story = await create_story(db, team_id=TEAM_ID, title="Story A", epic_id=epic["epic_id"])
    issue = await create_issue(
        db,
        team_id=TEAM_ID,
        title="Issue A",
        description="do the thing",
        epic_id=epic["epic_id"],
        story_id=story["story_id"],
    )

    assert issue["epic_id"] == epic["epic_id"]
    assert issue["story_id"] == story["story_id"]
    assert issue["status"] == "todo"
    assert issue["assignee_id"] is None

    fetched = await get_issue(db, team_id=TEAM_ID, issue_id=issue["issue_id"])
    assert fetched["issue_id"] == issue["issue_id"]
    assert fetched["title"] == "Issue A"
    assert fetched["description"] == "do the thing"


@pytest.mark.asyncio
async def test_list_issues_filters(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    epic1 = await create_epic(db, team_id=TEAM_ID, title="Epic 1")
    epic2 = await create_epic(db, team_id=TEAM_ID, title="Epic 2")
    story1 = await create_story(db, team_id=TEAM_ID, title="Story 1", epic_id=epic1["epic_id"])
    story2 = await create_story(db, team_id=TEAM_ID, title="Story 2", epic_id=epic2["epic_id"])

    todo = await create_issue(
        db,
        team_id=TEAM_ID,
        title="Todo issue",
        epic_id=epic1["epic_id"],
        story_id=story1["story_id"],
    )
    in_progress = await create_issue(
        db,
        team_id=TEAM_ID,
        title="In progress issue",
        status="in_progress",
        epic_id=epic2["epic_id"],
        story_id=story2["story_id"],
        assignee_type="agent",
        assignee_id="agent-7",
    )

    # No filter -> both.
    all_issues = await list_issues(db, team_id=TEAM_ID)
    assert {i["issue_id"] for i in all_issues} == {todo["issue_id"], in_progress["issue_id"]}

    # status filter
    only_todo = await list_issues(db, team_id=TEAM_ID, status="todo")
    assert [i["issue_id"] for i in only_todo] == [todo["issue_id"]]

    # assignee_type filter
    by_agent = await list_issues(db, team_id=TEAM_ID, assignee_type="agent")
    assert [i["issue_id"] for i in by_agent] == [in_progress["issue_id"]]

    # epic_id filter
    by_epic = await list_issues(db, team_id=TEAM_ID, epic_id=epic1["epic_id"])
    assert [i["issue_id"] for i in by_epic] == [todo["issue_id"]]

    # story_id filter
    by_story = await list_issues(db, team_id=TEAM_ID, story_id=story2["story_id"])
    assert [i["issue_id"] for i in by_story] == [in_progress["issue_id"]]


@pytest.mark.asyncio
async def test_claim_issue_sets_assignee_and_in_progress(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    issue = await create_issue(db, team_id=TEAM_ID, title="Claim me")
    assert issue["status"] == "todo"
    assert issue["assignee_id"] is None

    claimed = await claim_issue(
        db,
        team_id=TEAM_ID,
        issue_id=issue["issue_id"],
        assignee_type="human",
        assignee_id="alice",
    )

    assert claimed["issue_id"] == issue["issue_id"]
    assert claimed["status"] == "in_progress"
    assert claimed["assignee_type"] == "human"
    assert claimed["assignee_id"] == "alice"


@pytest.mark.asyncio
async def test_create_issue_unknown_epic_raises_not_found(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    import uuid

    with pytest.raises(NotFoundError):
        await create_issue(
            db,
            team_id=TEAM_ID,
            title="Orphan",
            epic_id=str(uuid.uuid4()),
        )


@pytest.mark.asyncio
async def test_create_story_invalid_epic_id_raises_validation(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    with pytest.raises(ValidationError):
        await create_story(
            db,
            team_id=TEAM_ID,
            title="Bad parent",
            epic_id="not-a-uuid",
        )


@pytest.mark.asyncio
async def test_claim_issue_invalid_assignee_type_raises_validation(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    issue = await create_issue(db, team_id=TEAM_ID, title="Claim me")

    with pytest.raises(ValidationError):
        await claim_issue(
            db,
            team_id=TEAM_ID,
            issue_id=issue["issue_id"],
            assignee_type="robot",
            assignee_id="x",
        )


@pytest.mark.asyncio
async def test_update_issue_unknown_issue_raises_not_found(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    import uuid

    with pytest.raises(NotFoundError):
        await update_issue(
            db,
            team_id=TEAM_ID,
            issue_id=str(uuid.uuid4()),
            title="ghost",
        )

"""HTTP tests for the team-membership admin REST routes.

Covers the main ``members.router`` (GET/POST/PATCH/DELETE under
``/v1/teams/{team_id}/members``). The hint_router (``/v1/memberships``) is
covered elsewhere and is intentionally not exercised here.

Auth is stubbed via ``app.dependency_overrides``: each route declares its auth
dependency as ``Depends(get_token_auth())``, which produces a distinct inner
``_dependency`` callable per route. We override every one of those callables to
yield a :class:`TokenAuthContext` for a chosen subject. ``_require_team_admin``
then re-checks the *authoritative* membership row in the DB, so each test also
seeds the caller's membership (admin or non-admin) to drive authorization.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from aweb.deps import get_db
from aweb.routes.members import router as members_router
from aweb.token_auth import TokenAuthContext


TEAM_ID = "backend:acme.com"
ADMIN_SUBJECT = "user_admin"
MEMBER_SUBJECT = "user_member"


class _DbShim:
    def __init__(self, aweb_db) -> None:
        self._db = aweb_db

    def get_manager(self, name: str = "aweb"):
        return self._db


def _make_auth(subject: str):
    """Build a TokenAuthContext factory for ``subject`` with that one team."""

    async def _fake_auth() -> TokenAuthContext:
        return TokenAuthContext(
            subject=subject,
            team_ids=[TEAM_ID],
            roles=[],
        )

    return _fake_auth


def _build_app(aweb_db, *, caller_subject: str) -> FastAPI:
    app = FastAPI()
    app.include_router(members_router)
    app.state.db = _DbShim(aweb_db)

    # The auth dependency from get_token_auth() is captured per-route at
    # decoration time, so override each route's auth callable individually.
    fake_auth = _make_auth(caller_subject)
    for route in members_router.routes:
        for dep in getattr(route, "dependant").dependencies:
            if dep.call is not get_db:
                app.dependency_overrides[dep.call] = fake_auth
    return app


async def _seed_team(aweb_db) -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, 'acme.com', 'backend', 'did:key:z6Mkteam')
        ON CONFLICT DO NOTHING
        """,
        TEAM_ID,
    )


async def _seed_member(aweb_db, subject: str, role: str, status: str = "active") -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.memberships}} (subject, team_id, role, status)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (subject, team_id) DO UPDATE SET role = EXCLUDED.role,
                                                     status = EXCLUDED.status
        """,
        subject,
        TEAM_ID,
        role,
        status,
    )


@pytest.mark.asyncio
async def test_list_members_admin(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _seed_member(db, ADMIN_SUBJECT, "admin")
    await _seed_member(db, MEMBER_SUBJECT, "member")

    app = _build_app(db, caller_subject=ADMIN_SUBJECT)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get(f"/v1/teams/{TEAM_ID}/members")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["team_id"] == TEAM_ID
    subjects = {m["subject"]: m["role"] for m in body["members"]}
    assert subjects == {ADMIN_SUBJECT: "admin", MEMBER_SUBJECT: "member"}


@pytest.mark.asyncio
async def test_add_member(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _seed_member(db, ADMIN_SUBJECT, "admin")

    app = _build_app(db, caller_subject=ADMIN_SUBJECT)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            f"/v1/teams/{TEAM_ID}/members",
            json={"subject": "user_new", "role": "member", "status": "active"},
        )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["subject"] == "user_new"
    assert body["role"] == "member"
    assert body["status"] == "active"

    row = await db.fetch_one(
        "SELECT role, status FROM {{tables.memberships}} WHERE subject = $1 AND team_id = $2",
        "user_new",
        TEAM_ID,
    )
    assert row is not None
    assert row["role"] == "member"


@pytest.mark.asyncio
async def test_update_member_role(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _seed_member(db, ADMIN_SUBJECT, "admin")
    await _seed_member(db, MEMBER_SUBJECT, "member")

    app = _build_app(db, caller_subject=ADMIN_SUBJECT)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            f"/v1/teams/{TEAM_ID}/members/{MEMBER_SUBJECT}",
            json={"role": "admin"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "admin"

    row = await db.fetch_one(
        "SELECT role FROM {{tables.memberships}} WHERE subject = $1 AND team_id = $2",
        MEMBER_SUBJECT,
        TEAM_ID,
    )
    assert row["role"] == "admin"


@pytest.mark.asyncio
async def test_remove_member(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _seed_member(db, ADMIN_SUBJECT, "admin")
    await _seed_member(db, MEMBER_SUBJECT, "member")

    app = _build_app(db, caller_subject=ADMIN_SUBJECT)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.delete(f"/v1/teams/{TEAM_ID}/members/{MEMBER_SUBJECT}")

    assert resp.status_code == 204, resp.text

    row = await db.fetch_one(
        "SELECT 1 FROM {{tables.memberships}} WHERE subject = $1 AND team_id = $2",
        MEMBER_SUBJECT,
        TEAM_ID,
    )
    assert row is None


@pytest.mark.asyncio
async def test_remove_missing_member_returns_404(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await _seed_member(db, ADMIN_SUBJECT, "admin")

    app = _build_app(db, caller_subject=ADMIN_SUBJECT)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.delete(f"/v1/teams/{TEAM_ID}/members/does_not_exist")

    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_non_admin_caller_forbidden(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    # Caller has only a plain 'member' membership -> not authorized to administer.
    await _seed_member(db, MEMBER_SUBJECT, "member")

    app = _build_app(db, caller_subject=MEMBER_SUBJECT)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            f"/v1/teams/{TEAM_ID}/members",
            json={"subject": "user_new", "role": "member", "status": "active"},
        )

    assert resp.status_code == 403, resp.text

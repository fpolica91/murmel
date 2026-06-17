"""Humans as first-class participants (backend lane).

Covers the contract in ai-completion/AUDIT.md:
  - a human is provisioned into the agents (participant) directory with
    agent_type='human', non-empty alias, human_name from the name claim, and
    address='<domain>/<alias>' (resolvable form) (and the upsert is idempotent + keeps them in sync);
  - GET /v1/participants returns BOTH humans and agents with an authoritative
    ``kind`` to a non-admin caller;
  - a human is resolvable as a chat recipient by alias (the human filter was
    dropped from the chat alias resolvers);
  - a human's issue comment attributes with author_kind='human', an agent's with
    author_kind='agent';
  - an issue is assignable to a human and GET reflects assignee_kind +
    assignee_display_name.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from aweb.coordination import hierarchy as hierarchy_service
from aweb.identity_auth_deps import provision_human_participant
from aweb.messaging.chat import (
    get_agent_by_alias,
    get_agents_by_aliases,
    resolve_participant_kinds,
)
from aweb.routes.hierarchy import router as hierarchy_router
from aweb.routes.participants import router as participants_router
from aweb.team_auth_deps import TeamIdentity, get_team_identity


TEAM_ID = "backend:acme.com"


class _DbShim:
    def __init__(self, aweb_db) -> None:
        self._db = aweb_db

    def get_manager(self, name: str = "aweb"):
        return self._db


async def _seed_team(aweb_db) -> None:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, 'acme.com', 'backend', 'did:key:z6Mkteam')
        ON CONFLICT DO NOTHING
        """,
        TEAM_ID,
    )


async def _seed_agent(aweb_db, *, alias: str) -> str:
    """Insert a plain (agent_type='agent') participant; returns its agent_id."""
    row = await aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, alias, human_name, agent_type, identity_scope, address)
        VALUES ($1, $2, $3, '', 'agent', 'local', $4)
        RETURNING agent_id
        """,
        TEAM_ID,
        f"did:key:z6Mk{alias}",
        alias,
        f"{TEAM_ID}/{alias}",
    )
    return str(row["agent_id"])


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


def _build_app(aweb_db, identity: TeamIdentity) -> FastAPI:
    app = FastAPI()
    app.include_router(hierarchy_router)
    app.include_router(participants_router)
    app.state.db = _DbShim(aweb_db)
    app.state.redis = None
    app.state.on_mutation = None
    app.dependency_overrides[get_team_identity] = lambda: identity
    return app


# ---------------------------------------------------------------------------
# B. Provisioning
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provision_human_participant_creates_and_syncs(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    row = await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-alice", name="Alice Human"
    )
    assert row is not None
    assert row["alias"] == "Alice Human"
    assert row["human_name"] == "Alice Human"
    # Address is the resolvable DOMAIN form (<domain>/<alias>), not the raw
    # team_id form — team_id "backend:acme.com" -> domain "acme.com".
    assert row["address"] == "acme.com/Alice Human"

    # Exactly one human row, with agent_type='human'.
    got = await aweb_cloud_db.aweb_db.fetch_all(
        """
        SELECT alias, human_name, agent_type, address, did_key
        FROM {{tables.agents}}
        WHERE team_id = $1 AND agent_type = 'human' AND deleted_at IS NULL
        """,
        TEAM_ID,
    )
    assert len(got) == 1
    assert got[0]["agent_type"] == "human"
    assert got[0]["human_name"] == "Alice Human"
    assert got[0]["did_key"] == "did:key:jwt-user-alice"

    # Idempotent on (team_id, did_key). The display name (human_name) syncs to a
    # changed name claim, but the routing alias (handle) stays stable so existing
    # addressing/assignments don't break on a rename.
    again = await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-alice", name="Alice Renamed"
    )
    assert again["alias"] == "Alice Human"
    assert again["human_name"] == "Alice Renamed"
    count = await aweb_cloud_db.aweb_db.fetch_value(
        "SELECT COUNT(*) FROM {{tables.agents}} WHERE team_id = $1 AND agent_type = 'human'",
        TEAM_ID,
    )
    assert int(count) == 1


@pytest.mark.asyncio
async def test_provision_human_distinct_alias_for_same_name(aweb_cloud_db):
    """Two different subjects with the SAME display name coexist in one team:
    each gets a distinct routing alias (handle), but both keep the shared display
    name — no (team_id, alias) unique-index collision. Regression for same-name
    humans being unable to join the same team."""
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)

    a = await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-1", name="Sam Twin"
    )
    b = await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-2", name="Sam Twin"
    )

    assert a["alias"] == "Sam Twin"
    assert b["alias"] == "Sam Twin 2"
    assert a["human_name"] == "Sam Twin"
    assert b["human_name"] == "Sam Twin"
    assert a["did_key"] != b["did_key"]

    # Re-provisioning the second human keeps its disambiguated handle stable.
    b_again = await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-2", name="Sam Twin"
    )
    assert b_again["alias"] == "Sam Twin 2"


@pytest.mark.asyncio
async def test_provision_human_name_falls_back_to_subject(aweb_cloud_db):
    db = _DbShim(aweb_cloud_db.aweb_db)
    await _seed_team(aweb_cloud_db.aweb_db)
    # No name claim and no agent_name: alias and human_name fall back to subject.
    row = await provision_human_participant(db, team_id=TEAM_ID, subject="user-bob")
    assert row["alias"] == "user-bob"
    assert row["human_name"] == "user-bob"


# ---------------------------------------------------------------------------
# A. Participants roster (non-admin, both kinds, authoritative kind)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_participants_lists_humans_and_agents(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    db = _DbShim(aweb_cloud_db.aweb_db)
    await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-alice", name="Alice Human"
    )
    await _seed_agent(aweb_cloud_db.aweb_db, alias="bot-1")

    app = _build_app(aweb_cloud_db.aweb_db, _human_identity())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/participants")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["team_id"] == TEAM_ID
    by_alias = {p["alias"]: p for p in body["participants"]}

    human = by_alias["Alice Human"]
    assert human["kind"] == "human"
    assert human["agent_type"] == "human"
    assert human["display_name"] == "Alice Human"
    assert human["online"] is False
    assert human["status"] == "offline"
    assert human["last_seen"] is None

    agent = by_alias["bot-1"]
    assert agent["kind"] == "agent"
    assert agent["display_name"] == "bot-1"


# ---------------------------------------------------------------------------
# C. Chat recipient resolution (human filter dropped)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_human_resolvable_as_chat_recipient(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    db = _DbShim(aweb_cloud_db.aweb_db)
    await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-alice", name="Alice Human"
    )

    one = await get_agent_by_alias(db, team_id=TEAM_ID, alias="Alice Human")
    assert one is not None
    assert one["alias"] == "Alice Human"

    many = await get_agents_by_aliases(db, team_id=TEAM_ID, aliases=["Alice Human"])
    assert [r["alias"] for r in many] == ["Alice Human"]


# ---------------------------------------------------------------------------
# C. Message sender kind (from_kind), authoritative from the directory
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_participant_kinds_by_did_and_alias(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    db = _DbShim(aweb_cloud_db.aweb_db)
    await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-alice", name="Alice Human"
    )
    await _seed_agent(aweb_cloud_db.aweb_db, alias="bot-1")

    kinds = await resolve_participant_kinds(
        db,
        team_id=TEAM_ID,
        dids=["did:key:jwt-user-alice", "did:key:z6Mkbot-1"],
        aliases=["Alice Human", "bot-1"],
    )
    # Resolvable by synthetic did_key and by alias.
    assert kinds["did:key:jwt-user-alice"] == "human"
    assert kinds["Alice Human"] == "human"
    assert kinds["did:key:z6Mkbot-1"] == "agent"
    assert kinds["bot-1"] == "agent"
    # Unknown references are simply absent (caller defaults to "agent").
    assert "did:key:ghost" not in kinds


# ---------------------------------------------------------------------------
# E. Comment attribution kind
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_comment_author_kind_human_vs_agent(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    db = _DbShim(aweb_cloud_db.aweb_db)
    await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-alice", name="Alice Human"
    )
    await _seed_agent(aweb_cloud_db.aweb_db, alias="bot-1")

    issue = await hierarchy_service.create_issue(db, team_id=TEAM_ID, title="T")
    await hierarchy_service.add_issue_comment(
        db, team_id=TEAM_ID, issue_id=issue["issue_id"], author="Alice Human", body="human says hi"
    )
    await hierarchy_service.add_issue_comment(
        db, team_id=TEAM_ID, issue_id=issue["issue_id"], author="bot-1", body="agent says hi"
    )
    # Legacy / unresolved author never errors; defaults to "agent".
    await hierarchy_service.add_issue_comment(
        db, team_id=TEAM_ID, issue_id=issue["issue_id"], author="ghost", body="who am i"
    )

    comments = await hierarchy_service.list_issue_comments(
        db, team_id=TEAM_ID, issue_id=issue["issue_id"]
    )
    by_author = {c["author"]: c for c in comments}
    assert by_author["Alice Human"]["author_kind"] == "human"
    assert by_author["bot-1"]["author_kind"] == "agent"
    assert by_author["ghost"]["author_kind"] == "agent"


# ---------------------------------------------------------------------------
# D. Issue assignable to a human, with assignee_kind / display_name on GET
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_issue_assignable_to_human(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    db = _DbShim(aweb_cloud_db.aweb_db)
    await provision_human_participant(
        db, team_id=TEAM_ID, subject="user-alice", name="Alice Human"
    )

    app = _build_app(aweb_cloud_db.aweb_db, _human_identity())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post("/v1/issues", json={"title": "Fix login"})
        assert created.status_code == 201, created.text
        issue_id = created.json()["issue_id"]

        patched = await client.patch(
            f"/v1/issues/{issue_id}",
            json={"assignee_type": "human", "assignee_id": "Alice Human"},
        )
        assert patched.status_code == 200, patched.text

        got = await client.get(f"/v1/issues/{issue_id}")
        assert got.status_code == 200, got.text
        body = got.json()
        assert body["assignee_type"] == "human"
        assert body["assignee_id"] == "Alice Human"
        assert body["assignee_kind"] == "human"
        assert body["assignee_display_name"] == "Alice Human"


@pytest.mark.asyncio
async def test_issue_assignee_kind_falls_back_when_unresolved(aweb_cloud_db):
    await _seed_team(aweb_cloud_db.aweb_db)
    db = _DbShim(aweb_cloud_db.aweb_db)

    app = _build_app(aweb_cloud_db.aweb_db, _human_identity())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post(
            "/v1/issues",
            json={"title": "Orphan", "assignee_type": "agent", "assignee_id": "missing-bot"},
        )
        assert created.status_code == 201, created.text
        issue_id = created.json()["issue_id"]

        got = await client.get(f"/v1/issues/{issue_id}")
        body = got.json()
        # Unresolved assignee: kind mirrors stored type, display falls back to id.
        assert body["assignee_kind"] == "agent"
        assert body["assignee_display_name"] == "missing-bot"

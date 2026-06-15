"""HTTP-level regression tests for GET /v1/events/stream."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import aweb.routes.events as events_module
from aweb.routes.events import router as events_router
from aweb.team_auth_deps import TeamIdentity, get_team_identity


def _build_test_app(aweb_db, identity: TeamIdentity):
    app = FastAPI()
    app.include_router(events_router)

    class _DbShim:
        def get_manager(self, name="aweb"):
            return aweb_db

    app.state.db = _DbShim()
    app.state.redis = None

    async def _fake_team_identity() -> TeamIdentity:
        return identity

    app.dependency_overrides[get_team_identity] = _fake_team_identity
    return app


@pytest.mark.asyncio
async def test_events_stream_includes_existing_unread_mail(aweb_cloud_db):
    bob_did_key = "did:key:z6MkBob"
    alice_did_key = "did:key:z6MkAlice"

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        "backend:acme.com",
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )

    alice = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, alias, address, identity_scope, role)
        VALUES ($1, $2, 'alice', 'acme.com/alice', 'global', 'developer')
        RETURNING agent_id
        """,
        "backend:acme.com",
        alice_did_key,
    )
    bob = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, 'bob', 'global', 'developer')
        RETURNING agent_id
        """,
        "backend:acme.com",
        bob_did_key,
    )

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.messages}}
            (from_did, to_did, from_alias, to_alias, subject, body, team_id, from_agent_id, to_agent_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        """,
        alice_did_key,
        bob_did_key,
        "alice",
        "bob",
        "",
        "hello from alice",
        "backend:acme.com",
        alice["agent_id"],
        bob["agent_id"],
    )

    identity = TeamIdentity(
        team_id="backend:acme.com",
        alias="bob",
        did_key=bob_did_key,
        did_aw="did:aw:bob",
        address="",
        agent_id=str(bob["agent_id"]),
        identity_scope="token",
        certificate_id="",
    )
    app = _build_test_app(aweb_cloud_db.aweb_db, identity)
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/events/stream", params={"deadline": deadline})

    assert resp.status_code == 200
    assert "event: connected" in resp.text
    assert '"team_id": "backend:acme.com"' in resp.text
    assert "event: actionable_mail" in resp.text
    assert '"from_alias": "alice"' in resp.text
    assert f'"from_did": "{alice_did_key}"' in resp.text
    assert '"from_address": "acme.com/alice"' in resp.text


@pytest.mark.asyncio
async def test_events_stream_sends_idle_heartbeats(aweb_cloud_db, monkeypatch):
    bob_did_key = "did:key:z6MkBob"

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        "backend:acme.com",
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )
    bob = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, 'bob', 'global', 'developer')
        RETURNING agent_id
        """,
        "backend:acme.com",
        bob_did_key,
    )

    monkeypatch.setattr(events_module, "EVENTS_POLL_INTERVAL", 0.01)
    monkeypatch.setattr(events_module, "EVENTS_HEARTBEAT_INTERVAL", 0.01)

    identity = TeamIdentity(
        team_id="backend:acme.com",
        alias="bob",
        did_key=bob_did_key,
        did_aw="did:aw:bob",
        address="",
        agent_id=str(bob["agent_id"]),
        identity_scope="token",
        certificate_id="",
    )
    app = _build_test_app(aweb_cloud_db.aweb_db, identity)
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=0.05)).isoformat()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/events/stream", params={"deadline": deadline})

    assert resp.status_code == 200
    assert resp.text.count(": keepalive") >= 2


@pytest.mark.asyncio
async def test_events_stream_matches_unread_mail_across_viewer_dids(aweb_cloud_db):
    bob_did_key = "did:key:z6MkBob"
    alice_did_key = "did:key:z6MkAlice"

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        "backend:acme.com",
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )

    alice = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, did_aw, alias, address, identity_scope, role)
        VALUES ($1, $2, $3, 'alice', 'acme.com/alice', 'global', 'developer')
        RETURNING agent_id
        """,
        "backend:acme.com",
        alice_did_key,
        "did:aw:alice",
    )
    bob = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, 'bob', 'global', 'developer')
        RETURNING agent_id
        """,
        "backend:acme.com",
        bob_did_key,
    )

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.messages}}
            (from_did, to_did, from_alias, to_alias, subject, body, team_id, from_agent_id, to_agent_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        """,
        "did:aw:alice",
        "did:aw:bob",
        "alice",
        "bob",
        "",
        "hello stable bob",
        "backend:acme.com",
        alice["agent_id"],
        bob["agent_id"],
    )

    identity = TeamIdentity(
        team_id="backend:acme.com",
        alias="bob",
        did_key=bob_did_key,
        did_aw="did:aw:bob",
        address="",
        agent_id=str(bob["agent_id"]),
        identity_scope="token",
        certificate_id="",
    )
    app = _build_test_app(aweb_cloud_db.aweb_db, identity)
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/events/stream", params={"deadline": deadline})

    assert resp.status_code == 200
    assert "event: actionable_mail" in resp.text
    assert '"from_alias": "alice"' in resp.text
    assert '"from_address": "acme.com/alice"' in resp.text


@pytest.mark.asyncio
async def test_current_actionable_mail_includes_from_stable_id_for_current_sender_key(aweb_cloud_db):
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES
            ('backend:acme.com', 'acme.com', 'backend', 'did:key:team'),
            ('frontend:acme.com', 'acme.com', 'frontend', 'did:key:team-frontend')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.messages}}
            (message_id, from_did, to_did, from_alias, subject, body, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        """,
        uuid4(),
        "did:key:z6MkAliceCurrent",
        "did:aw:bob",
        "",
        "hello",
        "body",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}} (agent_id, team_id, did_aw, did_key, alias, address)
        VALUES ($1, 'backend:acme.com', 'did:aw:alice', 'did:key:z6MkAliceCurrent', 'alice', 'acme.com/alice')
        """,
        uuid4(),
    )

    actionable = await events_module._current_actionable_mail(
        aweb_cloud_db.aweb_db,
        inbox_dids=["did:aw:bob", "did:key:z6MkBobCurrent"],
    )

    assert len(actionable) == 1
    assert actionable[0]["from_did"] == "did:key:z6MkAliceCurrent"
    assert actionable[0]["from_stable_id"] == "did:aw:alice"
    assert actionable[0]["from_address"] == "acme.com/alice"


@pytest.mark.asyncio
async def test_current_actionable_mail_prefers_stored_sender_address_without_local_metadata(aweb_cloud_db):
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.messages}}
            (message_id, from_did, to_did, from_alias, from_address, subject, body, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        """,
        uuid4(),
        "did:aw:gsk",
        "did:aw:bob",
        "gsk",
        "otherco.com/gsk",
        "external",
        "body",
    )

    actionable = await events_module._current_actionable_mail(
        aweb_cloud_db.aweb_db,
        inbox_dids=["did:aw:bob"],
    )

    assert len(actionable) == 1
    assert actionable[0]["from_did"] == "did:aw:gsk"
    assert actionable[0]["from_alias"] == "gsk"
    assert actionable[0]["from_address"] == "otherco.com/gsk"


@pytest.mark.asyncio
async def test_current_actionable_mail_redacts_encrypted_subject(aweb_cloud_db):
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.messages}} (
            message_id, from_did, to_did, from_alias, subject, body, created_at,
            content_mode, message_version, encrypted_envelope, encrypted_ciphertext,
            encrypted_key_wraps, encrypted_ciphertext_hash, encrypted_ciphertext_size,
            encrypted_key_wraps_hash, encrypted_inner_header_hash, encrypted_suite,
            encrypted_signing_key_id, signed_envelope_hash
        )
        VALUES (
            $1, 'did:aw:alice', 'did:aw:bob', 'alice', '', '', now(),
            'encrypted_v2', 2, '{}'::jsonb, 'ciphertext-bytes',
            '[]'::jsonb, 'sha256:ciphertext', 16,
            'sha256:wraps', 'sha256:inner', 'E2EEv2-X25519-HPKE-AES256GCM-Ed25519',
            'did:key:z6MkAlice', 'sha256:envelope'
        )
        """,
        uuid4(),
    )

    actionable = await events_module._current_actionable_mail(
        aweb_cloud_db.aweb_db,
        inbox_dids=["did:aw:bob"],
    )

    assert len(actionable) == 1
    assert actionable[0]["subject"] == ""
    assert actionable[0]["content_mode"] == "encrypted_v2"
    assert actionable[0]["message_version"] == 2
    assert actionable[0]["encrypted"] is True
    assert "ciphertext-bytes" not in str(actionable[0])


@pytest.mark.asyncio
async def test_events_stream_matches_pending_chat_across_viewer_dids(aweb_cloud_db):
    bob_did_key = "did:key:z6MkBob"
    alice_did_key = "did:key:z6MkAlice"

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        "backend:acme.com",
        "acme.com",
        "backend",
        "did:key:z6Mkteam",
    )

    alice = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, did_aw, alias, address, identity_scope, role)
        VALUES ($1, $2, $3, 'alice', 'acme.com/alice', 'global', 'developer')
        RETURNING agent_id
        """,
        "backend:acme.com",
        alice_did_key,
        "did:aw:alice",
    )
    bob = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, alias, identity_scope, role)
        VALUES ($1, $2, 'bob', 'global', 'developer')
        RETURNING agent_id
        """,
        "backend:acme.com",
        bob_did_key,
    )
    session = await aweb_cloud_db.aweb_db.fetch_one(
        """
        INSERT INTO {{tables.chat_sessions}} (team_id, created_by)
        VALUES ($1, $2)
        RETURNING session_id
        """,
        "backend:acme.com",
        "did:aw:alice",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_participants}} (session_id, did, agent_id, alias)
        VALUES
            ($1, $2, $3, 'alice'),
            ($1, $4, $5, 'bob')
        """,
        session["session_id"],
        "did:aw:alice",
        alice["agent_id"],
        "did:aw:bob",
        bob["agent_id"],
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_messages}} (session_id, from_agent_id, from_did, from_alias, body)
        VALUES ($1, $2, $3, $4, $5)
        """,
        session["session_id"],
        alice["agent_id"],
        "did:aw:alice",
        "alice",
        "hello stable bob",
    )

    identity = TeamIdentity(
        team_id="backend:acme.com",
        alias="bob",
        did_key=bob_did_key,
        did_aw="did:aw:bob",
        address="",
        agent_id=str(bob["agent_id"]),
        identity_scope="token",
        certificate_id="",
    )
    app = _build_test_app(aweb_cloud_db.aweb_db, identity)
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/events/stream", params={"deadline": deadline})

    assert resp.status_code == 200
    assert "event: actionable_chat" in resp.text
    assert f'"conversation_id": "{session["session_id"]}"' in resp.text
    assert '"from_alias": "alice"' in resp.text
    assert '"from_did": "did:aw:alice"' in resp.text
    assert '"from_address": "acme.com/alice"' in resp.text


@pytest.mark.asyncio
async def test_current_actionable_chat_uses_per_session_participant_lists(aweb_cloud_db, monkeypatch):
    class _DbShim:
        def __init__(self, aweb_db):
            self._aweb_db = aweb_db

        def get_manager(self, name="aweb"):
            assert name == "aweb"
            return self._aweb_db

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES
            ('backend:acme.com', 'acme.com', 'backend', 'did:key:team'),
            ('frontend:acme.com', 'acme.com', 'frontend', 'did:key:team-frontend')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_sessions}} (session_id, team_id, created_by)
        VALUES
            ('11111111-1111-4111-8111-111111111111', 'backend:acme.com', 'did:aw:alice'),
            ('22222222-2222-4222-8222-222222222222', 'backend:acme.com', 'did:aw:carol')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_participants}} (session_id, did, alias)
        VALUES
            ('11111111-1111-4111-8111-111111111111', 'did:aw:bob', 'bob'),
            ('11111111-1111-4111-8111-111111111111', 'did:aw:alice', 'alice'),
            ('22222222-2222-4222-8222-222222222222', 'did:aw:bob', 'bob'),
            ('22222222-2222-4222-8222-222222222222', 'did:aw:carol', 'carol')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_messages}} (session_id, from_did, from_alias, body)
        VALUES
            ('11111111-1111-4111-8111-111111111111', 'did:aw:alice', 'alice', 'hello from alice'),
            ('22222222-2222-4222-8222-222222222222', 'did:aw:carol', 'carol', 'hello from carol')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}} (agent_id, team_id, did_aw, did_key, alias, address)
        VALUES
            ($1, 'backend:acme.com', 'did:aw:alice', 'did:key:z6MkAlice', 'alice', 'acme.com/alice'),
            ($2, 'backend:acme.com', 'did:aw:bob', 'did:key:z6MkBob', 'bob', 'acme.com/bob'),
            ($3, 'frontend:acme.com', 'did:aw:carol', 'did:key:z6MkCarol', 'carol', NULL)
        """,
        uuid4(),
        uuid4(),
        uuid4(),
    )

    seen: dict[str, list[str]] = {}

    async def _fake_get_waiting_agents(_redis, session_id: str, participant_dids: list[str]):
        seen[session_id] = list(participant_dids)
        return list(participant_dids)

    monkeypatch.setattr(events_module, "get_waiting_agents", _fake_get_waiting_agents)

    actionable = await events_module._current_actionable_chat(
        _DbShim(aweb_cloud_db.aweb_db),
        None,
        participant_dids=["did:aw:bob", "did:key:bob"],
        viewer_team_id="backend:acme.com",
        participant_agent_id=None,
    )

    assert seen["11111111-1111-4111-8111-111111111111"] == ["did:aw:alice"]
    assert seen["22222222-2222-4222-8222-222222222222"] == ["did:aw:carol"]
    assert {item["session_id"] for item in actionable} == {
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    }
    assert {item["conversation_id"] for item in actionable} == {
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    }
    assert all(item["sender_waiting"] is True for item in actionable)
    by_session = {item["session_id"]: item for item in actionable}
    assert by_session["11111111-1111-4111-8111-111111111111"]["from_address"] == "acme.com/alice"
    assert by_session["11111111-1111-4111-8111-111111111111"]["participant_addresses"] == [
        "acme.com/alice"
    ]
    assert by_session["22222222-2222-4222-8222-222222222222"]["from_address"] == "frontend~carol"
    assert by_session["22222222-2222-4222-8222-222222222222"]["participant_addresses"] == [
        "frontend~carol"
    ]


@pytest.mark.asyncio
async def test_current_actionable_chat_includes_from_stable_id_for_current_sender_key(aweb_cloud_db, monkeypatch):
    class _DbShim:
        def __init__(self, aweb_db):
            self._aweb_db = aweb_db

        def get_manager(self, name="aweb"):
            assert name == "aweb"
            return self._aweb_db

    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ('backend:acme.com', 'acme.com', 'backend', 'did:key:team')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_sessions}} (session_id, team_id, created_by)
        VALUES ('33333333-3333-4333-8333-333333333333', 'backend:acme.com', 'did:key:z6MkAliceCurrent')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_participants}} (session_id, did, alias)
        VALUES
            ('33333333-3333-4333-8333-333333333333', 'did:aw:bob', 'bob'),
            ('33333333-3333-4333-8333-333333333333', 'did:key:z6MkAliceCurrent', 'alice')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.chat_messages}} (session_id, from_did, from_alias, body)
        VALUES ('33333333-3333-4333-8333-333333333333', 'did:key:z6MkAliceCurrent', '', 'hello from current key')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}} (agent_id, team_id, did_aw, did_key, alias, address)
        VALUES ($1, 'backend:acme.com', 'did:aw:alice', 'did:key:z6MkAliceCurrent', 'alice', 'acme.com/alice')
        """,
        uuid4(),
    )

    async def _fake_get_waiting_agents(_redis, _session_id: str, participant_dids: list[str]):
        return list(participant_dids)

    monkeypatch.setattr(events_module, "get_waiting_agents", _fake_get_waiting_agents)

    actionable = await events_module._current_actionable_chat(
        _DbShim(aweb_cloud_db.aweb_db),
        None,
        participant_dids=["did:aw:bob", "did:key:z6MkBobCurrent"],
        viewer_team_id="backend:acme.com",
        participant_agent_id=None,
    )

    assert len(actionable) == 1
    assert actionable[0]["from_did"] == "did:key:z6MkAliceCurrent"
    assert actionable[0]["conversation_id"] == "33333333-3333-4333-8333-333333333333"
    assert actionable[0]["from_stable_id"] == "did:aw:alice"
    assert actionable[0]["from_address"] == "acme.com/alice"


@pytest.mark.asyncio
async def test_current_actionable_mail_keeps_newest_unread_in_diff_window(aweb_cloud_db):
    created_at = datetime.now(timezone.utc) - timedelta(hours=1)
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ('backend:acme.com', 'acme.com', 'backend', 'did:key:team')
        """
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}} (agent_id, team_id, did_aw, did_key, alias, address)
        VALUES ($1, 'backend:acme.com', 'did:aw:alice', 'did:key:z6MkAlice', 'alice', 'acme.com/alice')
        """,
        uuid4(),
    )
    for i in range(50):
        await aweb_cloud_db.aweb_db.execute(
            """
            INSERT INTO {{tables.messages}}
                (message_id, from_did, to_did, from_alias, to_alias, subject, body, created_at)
            VALUES ($1, 'did:aw:alice', 'did:aw:bob', 'alice', 'bob', $2, $3, $4)
            """,
            f"00000000-0000-4000-8000-{i + 1:012d}",
            f"old-{i}",
            f"old-body-{i}",
            created_at + timedelta(minutes=i),
        )

    previous = await events_module._current_actionable_mail(
        aweb_cloud_db.aweb_db,
        inbox_dids=["did:aw:bob"],
    )
    assert len(previous) == 50
    assert all(item["conversation_id"] == item["message_id"] for item in previous)

    newest_message_id = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    newest_conversation_id = "99999999-9999-4999-8999-999999999999"
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.conversations}} (
            conversation_id, conversation_type, created_by_did, created_at, updated_at
        )
        VALUES ($1, 'mail', 'did:aw:alice', $2, $2)
        """,
        newest_conversation_id,
        created_at + timedelta(hours=2),
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.messages}}
            (message_id, conversation_id, from_did, to_did, from_alias, to_alias, subject, body, created_at)
        VALUES ($1, $2, 'did:aw:alice', 'did:aw:bob', 'alice', 'bob', 'newest', 'newest-body', $3)
        """,
        newest_message_id,
        newest_conversation_id,
        created_at + timedelta(hours=2),
    )

    current = await events_module._current_actionable_mail(
        aweb_cloud_db.aweb_db,
        inbox_dids=["did:aw:bob"],
    )
    changed = events_module._new_or_changed_events(
        current,
        events_module._index_events(previous, key_field="message_id"),
        key_field="message_id",
    )

    assert newest_message_id in {item["message_id"] for item in current}
    assert newest_message_id in {item["message_id"] for item in changed}
    newest = next(item for item in current if item["message_id"] == newest_message_id)
    assert newest["conversation_id"] == newest_conversation_id

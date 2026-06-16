"""HTTP-level tests for /v1/agents routes."""

from __future__ import annotations

import base64
import hashlib
import json
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey

from awid.did import did_from_public_key
from awid.signing import canonical_json_bytes, sign_message
from aweb.routes.agents import router as agents_router
from aweb.team_auth_deps import TeamIdentity, get_team_identity


def _make_keypair():
    sk = SigningKey.generate()
    pk = bytes(sk.verify_key)
    did_key = did_from_public_key(pk)
    return bytes(sk), pk, did_key


def _raw_standard_b64(data: bytes) -> str:
    return base64.b64encode(data).rstrip(b"=").decode("ascii")


def _encryption_key_id(raw_public_key: bytes) -> str:
    digest = hashlib.sha256(b"aweb-e2ee-v2 encryption-key\n" + raw_public_key).digest()
    return "sha256:" + _raw_standard_b64(digest)


def _make_encryption_assertion(
    signing_key: bytes,
    *,
    did_key: str,
    stable_id: str | None = None,
    raw_public_key: bytes = b"\x01" * 32,
    created_at: str = "2026-05-25T12:00:00Z",
    not_before: str = "2026-05-25T11:59:00Z",
    expires_at: str = "2126-05-26T12:00:00Z",
    custody: str | None = None,
) -> dict:
    payload = {
        "operation": "publish_encryption_key",
        "version": "aweb-e2ee-key-v1",
        "identity_did": did_key,
        "encryption_key_id": _encryption_key_id(raw_public_key),
        "encryption_public_key": _raw_standard_b64(raw_public_key),
        "algorithm": "x25519",
        "created_at": created_at,
        "not_before": not_before,
        "expires_at": expires_at,
    }
    if stable_id:
        payload["identity_stable_id"] = stable_id
    if custody is not None:
        payload["custody"] = custody
    payload["signature"] = sign_message(signing_key, canonical_json_bytes(payload))
    return payload


def _build_test_app(
    aweb_db,
    *,
    team_id: str = "backend:acme.com",
    agent_id,
    did_key: str,
    alias: str = "alice",
    identity_scope: str = "local",
    did_aw: str = "",
):
    app = FastAPI()
    app.include_router(agents_router)

    class _DbShim:
        def get_manager(self, name="aweb"):
            return aweb_db

    app.state.db = _DbShim()
    app.state.redis = None
    app.state.rate_limiter = None

    async def _fake_team_identity() -> TeamIdentity:
        return TeamIdentity(
            team_id=team_id,
            alias=alias,
            agent_id=str(agent_id),
            identity_scope=identity_scope,
            did_key=did_key,
            did_aw=did_aw,
            address="",
            certificate_id="",
        )

    app.dependency_overrides[get_team_identity] = _fake_team_identity
    return app


async def _insert_team(aweb_db, team_id: str, team_did_key: str) -> None:
    team_name, namespace = team_id.split(":", 1)
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        team_id,
        namespace,
        team_name,
        team_did_key,
    )


@pytest.mark.asyncio
async def test_suggest_alias_prefix_returns_next_available_name(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    _, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    alice_agent_id = uuid4()
    bob_agent_id = uuid4()
    alice01_agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES
            ($1, $2, $3, $4, 'local', 'active'),
            ($5, $2, $6, 'bob', 'local', 'active'),
            ($7, $2, $8, 'alice-01', 'local', 'active')
        """,
        alice_agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
        bob_agent_id,
        "did:key:z6Mkbob",
        alice01_agent_id,
        "did:key:z6Mkalice01",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.workspaces}}
            (workspace_id, team_id, agent_id, alias, workspace_type)
        VALUES
            ($1, $2, $3, 'alice', 'agent'),
            ($4, $2, $5, 'bob', 'agent'),
            ($6, $2, $7, 'alice-01', 'agent')
        """,
        uuid4(),
        "backend:acme.com",
        alice_agent_id,
        uuid4(),
        bob_agent_id,
        uuid4(),
        alice01_agent_id,
    )

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=alice_agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/v1/agents/suggest-alias-prefix",
            content=b"{}",
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "team_id": "backend:acme.com",
        "name_prefix": "charlie",
    }


@pytest.mark.asyncio
async def test_suggest_alias_prefix_uses_agent_aliases_without_workspace_rows(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    _, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/v1/agents/suggest-alias-prefix",
            content=b"{}",
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "team_id": "backend:acme.com",
        "name_prefix": "bob",
    }


@pytest.mark.asyncio
async def test_patch_agent_workspace_accepts_canonical_role_name(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    _, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    agent_id = uuid4()
    workspace_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.workspaces}}
            (workspace_id, team_id, agent_id, alias, role, workspace_type)
        VALUES ($1, $2, $3, 'alice', 'developer', 'agent')
        """,
        workspace_id,
        "backend:acme.com",
        agent_id,
    )

    body_bytes = json.dumps({"role_name": "Reviewer"}, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            "/v1/agents/me",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["role_name"] == "reviewer"
    assert data["role"] == "reviewer"

    row = await aweb_cloud_db.aweb_db.fetch_one(
        """
        SELECT role
        FROM {{tables.workspaces}}
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    assert row["role"] == "reviewer"


@pytest.mark.asyncio
async def test_get_my_inbound_mode_returns_current_global_agent_policy(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    _, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status, inbound_mode)
        VALUES ($1, $2, $3, $4, 'global', 'active', 'team_and_contacts')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    app = _build_test_app(
        aweb_cloud_db.aweb_db,
        agent_id=agent_id,
        did_key=agent_did_key,
        identity_scope="global",
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/agents/me/inbound-mode")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "agent_id": str(agent_id),
        "team_id": "backend:acme.com",
        "alias": "alice",
        "identity_scope": "global",
        "inbound_mode": "team_and_contacts",
        "configurable": True,
    }


@pytest.mark.asyncio
async def test_patch_my_inbound_mode_updates_global_agent_policy(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    _, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status, inbound_mode)
        VALUES ($1, $2, $3, $4, 'global', 'active', 'open')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    body_bytes = json.dumps({"inbound_mode": "team_and_contacts"}, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db,
        agent_id=agent_id,
        did_key=agent_did_key,
        identity_scope="global",
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            "/v1/agents/me/inbound-mode",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json()["inbound_mode"] == "team_and_contacts"
    stored = await aweb_cloud_db.aweb_db.fetch_val(
        "SELECT inbound_mode FROM {{tables.agents}} WHERE agent_id = $1",
        agent_id,
    )
    assert stored == "team_and_contacts"


@pytest.mark.asyncio
async def test_patch_my_inbound_mode_rejects_local_agent(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    _, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status, inbound_mode)
        VALUES ($1, $2, $3, $4, 'local', 'active', 'open')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    body_bytes = json.dumps({"inbound_mode": "team_and_contacts"}, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db,
        agent_id=agent_id,
        did_key=agent_did_key,
        identity_scope="local",
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            "/v1/agents/me/inbound-mode",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 409, resp.text
    assert "global" in resp.text


@pytest.mark.asyncio
async def test_publish_my_encryption_key_for_local_agent_and_list_returns_verified_key(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    agent_sk, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    assertion = _make_encryption_assertion(agent_sk, did_key=agent_did_key)
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        publish = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )
        listed = await client.get("/v1/agents")

    assert publish.status_code == 200, publish.text
    assert publish.json()["encryption_key"]["encryption_key_id"] == assertion["encryption_key_id"]
    assert "identity_stable_id" not in publish.json()["encryption_key"]
    assert listed.status_code == 200, listed.text
    [agent] = listed.json()["agents"]
    assert agent["agent_id"] == str(agent_id)
    assert agent["repo"] is None
    assert agent["encryption_key"]["encryption_key_id"] == assertion["encryption_key_id"]
    assert "identity_stable_id" not in agent["encryption_key"]


@pytest.mark.asyncio
async def test_publish_my_encryption_key_preserves_signed_custody(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    agent_sk, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    assertion = _make_encryption_assertion(agent_sk, did_key=agent_did_key, custody="self")
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        publish = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )
        listed = await client.get("/v1/agents")

    assert publish.status_code == 200, publish.text
    assert publish.json()["encryption_key"]["custody"] == "self"
    assert listed.status_code == 200, listed.text
    [agent] = listed.json()["agents"]
    assert agent["agent_id"] == str(agent_id)
    assert agent["encryption_key"]["custody"] == "self"


@pytest.mark.asyncio
async def test_publish_my_encryption_key_rejects_unsigned_custody_mutation(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    agent_sk, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)
    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    assertion = _make_encryption_assertion(agent_sk, did_key=agent_did_key)
    assertion["custody"] = "self"
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 422, resp.text
    assert "invalid signature" in resp.json()["detail"]["message"]


@pytest.mark.asyncio
async def test_replayed_older_local_encryption_key_does_not_roll_back_listed_key(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    agent_sk, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)
    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    older = _make_encryption_assertion(
        agent_sk,
        did_key=agent_did_key,
        raw_public_key=b"\x01" * 32,
        created_at="2026-05-25T12:00:00Z",
        not_before="2026-05-25T12:00:00Z",
    )
    newer = _make_encryption_assertion(
        agent_sk,
        did_key=agent_did_key,
        raw_public_key=b"\x02" * 32,
        created_at="2026-05-25T12:01:00Z",
        not_before="2026-05-25T12:01:00Z",
    )

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        for assertion in (older, newer, older):
            body = json.dumps(assertion, separators=(",", ":")).encode()
            resp = await client.put(
                "/v1/agents/me/encryption-key",
                content=body,
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 200, resp.text

        listed = await client.get("/v1/agents")

    assert listed.status_code == 200, listed.text
    [agent] = listed.json()["agents"]
    assert agent["encryption_key"]["encryption_key_id"] == newer["encryption_key_id"]


@pytest.mark.asyncio
async def test_publish_my_encryption_key_rejects_team_controller_substitution(aweb_cloud_db):
    team_sk, _, team_did_key = _make_keypair()
    _, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)
    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    # Assertion signed by the team key, not the agent's own identity key.
    assertion = _make_encryption_assertion(team_sk, did_key=agent_did_key)
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "invalid_encryption_key_assertion"
    assert "invalid signature" in resp.json()["detail"]["message"]


@pytest.mark.asyncio
async def test_publish_my_encryption_key_rejects_empty_local_stable_id_field(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    agent_sk, _, agent_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)
    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        "alice",
    )

    assertion = _make_encryption_assertion(agent_sk, did_key=agent_did_key)
    assertion["identity_stable_id"] = ""
    assertion["signature"] = sign_message(
        agent_sk,
        canonical_json_bytes({k: v for k, v in assertion.items() if k != "signature"}),
    )
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db, agent_id=agent_id, did_key=agent_did_key
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 422, resp.text
    assert "omit identity_stable_id" in resp.json()["detail"]["message"]


@pytest.mark.asyncio
async def test_publish_my_encryption_key_requires_global_stable_id(aweb_cloud_db):
    _, _, team_did_key = _make_keypair()
    agent_sk, _, agent_did_key = _make_keypair()
    stable_id = "did:aw:2exampleglobal"

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)
    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, did_aw, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, $5, 'global', 'active')
        """,
        agent_id,
        "backend:acme.com",
        agent_did_key,
        stable_id,
        "alice",
    )

    assertion = _make_encryption_assertion(agent_sk, did_key=agent_did_key)
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db,
        agent_id=agent_id,
        did_key=agent_did_key,
        identity_scope="global",
        did_aw=stable_id,
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        missing = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

        good_assertion = _make_encryption_assertion(
            agent_sk,
            did_key=agent_did_key,
            stable_id=stable_id,
            raw_public_key=b"\x02" * 32,
        )
        good_body = json.dumps(good_assertion, separators=(",", ":")).encode()
        ok = await client.put(
            "/v1/agents/me/encryption-key",
            content=good_body,
            headers={"Content-Type": "application/json"},
        )

    assert missing.status_code == 422, missing.text
    assert "identity_stable_id" in missing.json()["detail"]["message"]
    assert ok.status_code == 200, ok.text
    assert ok.json()["encryption_key"]["identity_stable_id"] == stable_id


@pytest.mark.asyncio
async def test_token_identity_publishes_self_custodial_key_and_list_returns_it(aweb_cloud_db):
    """A token (Better Auth JWT) caller publishes a self-custodial E2E key.

    Token participants have no server-side did:key — their agents row is keyed by
    a synthetic local routing DID (did:key:jwt-<subject>). The key they publish is
    self-signed with their LOCAL custodial did:key:z..., so it must validate
    against the assertion's own identity_did (custody=self, no did:aw), bind to
    the participant by agent_id, and surface in GET /v1/agents for E2E discovery
    even though the participant is agent_type='human'. Regression for the
    `aw init` token-only 422 "identity_did must match current did:key".
    """
    _, _, team_did_key = _make_keypair()
    custodial_sk, _, custodial_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    subject = "user-token-subject"
    synthetic_did = f"did:key:jwt-{subject}"
    agent_id = uuid4()
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, human_name, agent_type, identity_scope, status)
        VALUES ($1, $2, $3, $4, $5, 'human', 'local', 'active')
        """,
        agent_id,
        "backend:acme.com",
        synthetic_did,
        "Founder",
        "Founder",
    )

    # Self-custodial assertion signed by the LOCAL custodial key, NOT the
    # synthetic routing DID.
    assertion = _make_encryption_assertion(
        custodial_sk, did_key=custodial_did_key, custody="self"
    )
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    # Token identity: empty server did_key, identity_scope='token', agent_id is
    # the JWT subject string (NOT the UUID agents.agent_id).
    app = _build_test_app(
        aweb_cloud_db.aweb_db,
        agent_id=subject,
        did_key="",
        alias="Founder",
        identity_scope="token",
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        publish = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )
        listed = await client.get("/v1/agents")

    assert publish.status_code == 200, publish.text
    assert publish.json()["agent_id"] == str(agent_id)
    assert publish.json()["encryption_key"]["encryption_key_id"] == assertion["encryption_key_id"]
    assert publish.json()["encryption_key"]["identity_did"] == custodial_did_key
    assert publish.json()["encryption_key"]["custody"] == "self"

    assert listed.status_code == 200, listed.text
    agents = {a["alias"]: a for a in listed.json()["agents"]}
    assert "Founder" in agents, listed.text
    founder = agents["Founder"]
    assert founder["agent_id"] == str(agent_id)
    assert founder["encryption_key"]["encryption_key_id"] == assertion["encryption_key_id"]
    assert founder["encryption_key"]["identity_did"] == custodial_did_key


@pytest.mark.asyncio
async def test_token_identity_rejects_hosted_custodial_key(aweb_cloud_db):
    """Token callers may only publish self-custodial keys."""
    _, _, team_did_key = _make_keypair()
    custodial_sk, _, custodial_did_key = _make_keypair()

    await _insert_team(aweb_cloud_db.aweb_db, "backend:acme.com", team_did_key)

    subject = "user-token-hosted"
    await aweb_cloud_db.aweb_db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, alias, human_name, agent_type, identity_scope, status)
        VALUES ($1, $2, $3, $4, $4, 'human', 'local', 'active')
        """,
        uuid4(),
        "backend:acme.com",
        f"did:key:jwt-{subject}",
        "Founder",
    )

    assertion = _make_encryption_assertion(
        custodial_sk, did_key=custodial_did_key, custody="hosted_custodial"
    )
    body_bytes = json.dumps(assertion, separators=(",", ":")).encode()

    app = _build_test_app(
        aweb_cloud_db.aweb_db,
        agent_id=subject,
        did_key="",
        alias="Founder",
        identity_scope="token",
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.put(
            "/v1/agents/me/encryption-key",
            content=body_bytes,
            headers={"Content-Type": "application/json"},
        )

    assert resp.status_code == 422, resp.text
    assert "self-custodial" in resp.json()["detail"]["message"]

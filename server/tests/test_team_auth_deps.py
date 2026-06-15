"""Tests for the team (token) FastAPI auth dependency + messaging auth."""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import aweb.identity_auth_deps as _identity_auth_mod
from aweb.identity_auth_deps import IdentityAuth, get_messaging_auth
from aweb.team_auth_deps import TeamIdentity


def _request_with_headers(headers: dict[str, str]) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/mcp",
            "query_string": b"",
            "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 12345),
            "http_version": "1.1",
        }
    )


class TestTeamIdentity:
    def test_dataclass_fields(self):
        from aweb.team_auth_deps import TeamIdentity

        identity = TeamIdentity(
            team_id="backend:acme.com",
            alias="alice",
            did_key="did:key:z6Mktest",
            did_aw="did:aw:alice",
            address="acme.com/alice",
            agent_id="agent-uuid",
            identity_scope="global",
            certificate_id="cert-001",
        )

        assert identity.team_id == "backend:acme.com"
        assert identity.alias == "alice"
        assert identity.did_key == "did:key:z6Mktest"
        assert identity.did_aw == "did:aw:alice"
        assert identity.address == "acme.com/alice"
        assert identity.agent_id == "agent-uuid"
        assert identity.identity_scope == "global"
        assert identity.certificate_id == "cert-001"

    def test_frozen(self):
        from aweb.team_auth_deps import TeamIdentity

        identity = TeamIdentity(
            team_id="backend:acme.com",
            alias="alice",
            did_key="did:key:z6Mktest",
            did_aw="did:aw:alice",
            address="acme.com/alice",
            agent_id="agent-uuid",
            identity_scope="global",
            certificate_id="cert-001",
        )

        with pytest.raises(AttributeError):
            identity.team_id = "other"


@pytest.mark.asyncio
async def test_get_messaging_auth_accepts_raw_manager(aweb_cloud_db, monkeypatch):
    db = aweb_cloud_db.aweb_db
    agent_id = uuid.uuid4()

    await db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, $2, $3, $4)
        """,
        "backend:acme.com",
        "acme.com",
        "backend",
        "did:key:z6MkTeam",
    )

    await db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, did_aw, address, alias, identity_scope, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'global', 'active')
        """,
        agent_id,
        "backend:acme.com",
        "did:key:z6MkAlice",
        "did:aw:alice",
        "acme.com/alice",
        "alice",
    )

    async def _fake_get_team_identity(_request, _db):
        return TeamIdentity(
            team_id="backend:acme.com",
            alias="alice",
            did_key="did:key:z6MkAlice",
            did_aw="did:aw:alice",
            address="acme.com/alice",
            agent_id=str(agent_id),
            identity_scope="global",
            certificate_id="cert-1",
        )

    monkeypatch.setattr(_identity_auth_mod, "get_team_identity", _fake_get_team_identity)

    auth = await get_messaging_auth(
        _request_with_headers(
            {
                "Authorization": "DIDKey did:key:z6MkAlice signature",
                "X-AWID-Team-Certificate": "certificate",
            }
        ),
        db,
    )

    assert auth.agent_id == str(agent_id)
    assert auth.did_aw == "did:aw:alice"
    assert auth.address == "acme.com/alice"


@pytest.mark.asyncio
async def test_get_messaging_auth_enriches_identity_auth_from_agent_row(aweb_cloud_db, monkeypatch):
    db = aweb_cloud_db.aweb_db
    agent_id = uuid.uuid4()

    await db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ('ops:gsk.aweb.ai', 'gsk.aweb.ai', 'ops', 'did:key:z6MkTeam')
        """
    )
    await db.execute(
        """
        INSERT INTO {{tables.agents}}
            (agent_id, team_id, did_key, did_aw, address, alias, identity_scope, status)
        VALUES ($1, 'ops:gsk.aweb.ai', $2, NULL, NULL, 'gsk', 'local', 'active')
        """,
        agent_id,
        "did:key:z6MkGsk",
    )

    async def _fake_resolve_identity_auth(_request):
        return IdentityAuth(did_key="did:key:z6MkGsk", did_aw=None, address=None)

    monkeypatch.setattr(_identity_auth_mod, "resolve_identity_auth", _fake_resolve_identity_auth)

    auth = await get_messaging_auth(
        _request_with_headers({"Authorization": "DIDKey did:key:z6MkGsk signature"}),
        db,
    )

    assert auth.did_key == "did:key:z6MkGsk"
    assert auth.team_id == "ops:gsk.aweb.ai"
    assert auth.alias == "gsk"
    assert auth.agent_id == str(agent_id)
    assert auth.identity_scope == "local"


@pytest.mark.asyncio
async def test_get_messaging_auth_rejects_ambiguous_identity_auth_agent_rows(aweb_cloud_db, monkeypatch):
    db = aweb_cloud_db.aweb_db

    await db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES
            ('ops:gsk.aweb.ai', 'gsk.aweb.ai', 'ops', 'did:key:z6MkTeamOps'),
            ('dev:gsk.aweb.ai', 'gsk.aweb.ai', 'dev', 'did:key:z6MkTeamDev')
        """
    )
    await db.execute(
        """
        INSERT INTO {{tables.agents}}
            (team_id, did_key, did_aw, address, alias, identity_scope, status)
        VALUES
            ('ops:gsk.aweb.ai', 'did:key:z6MkGsk', NULL, NULL, 'gsk', 'local', 'active'),
            ('dev:gsk.aweb.ai', 'did:key:z6MkGsk', NULL, NULL, 'gsk', 'local', 'active')
        """
    )

    async def _fake_resolve_identity_auth(_request):
        return IdentityAuth(did_key="did:key:z6MkGsk", did_aw=None, address=None)

    monkeypatch.setattr(_identity_auth_mod, "resolve_identity_auth", _fake_resolve_identity_auth)

    with pytest.raises(HTTPException) as exc_info:
        await get_messaging_auth(
            _request_with_headers({"Authorization": "DIDKey did:key:z6MkGsk signature"}),
            db,
        )

    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_get_messaging_auth_allows_identity_scoped_persistent_multi_membership(aweb_cloud_db, monkeypatch):
    db = aweb_cloud_db.aweb_db

    await db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES
            ('ops:gsk.aweb.ai', 'gsk.aweb.ai', 'ops', 'did:key:z6MkTeamOps'),
            ('dev:gsk.aweb.ai', 'gsk.aweb.ai', 'dev', 'did:key:z6MkTeamDev')
        """
    )
    await db.execute(
        """
        INSERT INTO {{tables.agents}}
            (team_id, did_key, did_aw, address, alias, identity_scope, status)
        VALUES
            ('ops:gsk.aweb.ai', 'did:key:z6MkGsk', 'did:aw:gsk', 'gsk.aweb.ai/grace', 'grace', 'global', 'active'),
            ('dev:gsk.aweb.ai', 'did:key:z6MkGsk', 'did:aw:gsk', 'gsk.aweb.ai/grace', 'grace', 'global', 'active')
        """
    )

    async def _fake_resolve_identity_auth(_request):
        return IdentityAuth(did_key="did:key:z6MkGsk", did_aw="did:aw:gsk", address="gsk.aweb.ai/grace")

    monkeypatch.setattr(_identity_auth_mod, "resolve_identity_auth", _fake_resolve_identity_auth)

    auth = await get_messaging_auth(
        _request_with_headers({"Authorization": "DIDKey did:key:z6MkGsk signature"}),
        db,
    )

    assert auth.did_key == "did:key:z6MkGsk"
    assert auth.did_aw == "did:aw:gsk"
    assert auth.address == "gsk.aweb.ai/grace"
    assert auth.team_id is None
    assert auth.alias is None
    assert auth.agent_id is None

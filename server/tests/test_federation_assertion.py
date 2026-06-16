"""Option A.2 token-only federation: server-vouched outer delivery assertion.

These tests exercise the *outer* trust layer end-to-end against the inbound
handler (`receive_federated_message`) plus the config loaders. Every adversarial
case asserts REJECTION — they stay red against attacks. The happy path proves the
full mechanism (allowlist -> binding -> pinned-key signature -> inner participant
signature -> delivery) works.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock

from awid.did import did_from_public_key
from awid.signing import canonical_json_bytes, sign_message
from nacl.signing import SigningKey

from aweb.federation.envelope import (
    FederationEnvelope,
    ServerDeliveryAssertion,
    assertion_signing_bytes,
    compute_envelope_hash,
)
from aweb.federation.server_key import (
    FederationConfigError,
    Peer,
    ServerKey,
    load_federation_peers,
    server_key_from_seed,
)
from aweb.routes.federation import router as federation_router


# --------------------------------------------------------------------------- #
# Fixed test keys
# --------------------------------------------------------------------------- #

SENDER_SERVER_SK = SigningKey.generate()
SENDER_SERVER_PRIVATE = bytes(SENDER_SERVER_SK)
SENDER_SERVER_DID = did_from_public_key(bytes(SENDER_SERVER_SK.verify_key))
SENDER_ORIGIN = "https://sender.example"
RECIPIENT_ORIGIN = "https://recipient.example"


def _keypair():
    sk = SigningKey.generate()
    return bytes(sk), did_from_public_key(bytes(sk.verify_key))


def _now(offset_seconds: int = 0) -> str:
    return (
        (datetime.now(timezone.utc).replace(microsecond=0) + timedelta(seconds=offset_seconds))
        .isoformat()
        .replace("+00:00", "Z")
    )


# --------------------------------------------------------------------------- #
# App + DB harness (reuses the conftest aweb_cloud_db migrated schema)
# --------------------------------------------------------------------------- #


def _build_app(aweb_db, *, pin_did: str = SENDER_SERVER_DID):
    app = FastAPI()
    app.include_router(federation_router)

    class _DbShim:
        def get_manager(self, name="aweb"):
            return aweb_db

    app.state.db = _DbShim()
    app.state.awid_registry_client = AsyncMock()
    app.state.public_origin = RECIPIENT_ORIGIN
    local_sk = SigningKey.generate()
    app.state.federation_server_key = ServerKey(
        private_key=bytes(local_sk), public_did=did_from_public_key(bytes(local_sk.verify_key))
    )
    app.state.federation_peers_by_domain = {}
    app.state.federation_peers_by_origin = {
        SENDER_ORIGIN: Peer(
            addressing_domain="alpha.example",
            delivery_origin=SENDER_ORIGIN,
            pinned_server_did=pin_did,
        )
    }
    return app


async def _insert_bob(aweb_db, bob_did_key: str) -> str:
    await aweb_db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ('default:beta.example', 'beta.example', 'default', 'did:key:z6Mkteam')
        """
    )
    row = await aweb_db.fetch_one(
        """
        INSERT INTO {{tables.agents}} (team_id, did_key, did_aw, address, alias, identity_scope, role, inbound_mode)
        VALUES ('default:beta.example', $1, 'did:aw:bob', 'beta.example/bob', 'bob', 'global', 'developer', 'open')
        RETURNING agent_id
        """,
        bob_did_key,
    )
    return str(row["agent_id"])


def _mail_envelope(*, sender_sk, sender_did_key, bob_did_key, **overrides) -> dict:
    message_id = overrides.get("message_id", str(uuid4()))
    conversation_id = overrides.get("conversation_id", str(uuid4()))
    timestamp = overrides.get("timestamp", _now())
    sender_address = overrides.get("sender_address", "alpha.example/alice")
    target_address = overrides.get("target_address", "beta.example/bob")
    body = overrides.get("body", "hello cross-server")
    subject = overrides.get("subject", "federated")
    signed = canonical_json_bytes(
        {
            "body": body,
            "conversation_id": conversation_id,
            "from": sender_address,
            "from_did": sender_did_key,
            "from_stable_id": "did:aw:alice",
            "message_id": message_id,
            "priority": "normal",
            "subject": subject,
            "timestamp": timestamp,
            "to": target_address,
            "to_did": bob_did_key,
            "to_stable_id": "did:aw:bob",
            "type": "mail",
        }
    ).decode()
    envelope = {
        "version": 1,
        "type": "mail",
        "sender_did_aw": "did:aw:alice",
        "sender_current_did_key": sender_did_key,
        "sender_address": sender_address,
        "sender_delivery_origin": overrides.get("sender_delivery_origin", SENDER_ORIGIN),
        "target_address": target_address,
        "target_did_aw": overrides.get("target_did_aw", "did:aw:bob"),
        "target_current_did_key": overrides.get("target_current_did_key", bob_did_key),
        "target_delivery_origin": overrides.get("target_delivery_origin", RECIPIENT_ORIGIN),
        "body": body,
        "message_id": message_id,
        "timestamp": timestamp,
        "signed_payload": signed,
        "conversation_id": conversation_id,
        "subject": subject,
        "priority": "normal",
    }
    return {"envelope": envelope, "signature": sign_message(sender_sk, signed.encode())}


def _vouch(
    payload: dict,
    *,
    server_private: bytes = SENDER_SERVER_PRIVATE,
    server_origin: str = SENDER_ORIGIN,
    override: dict | None = None,
    timestamp: str | None = None,
) -> dict:
    env = FederationEnvelope.model_validate(payload["envelope"])
    fields = {
        "version": 1,
        "server_origin": server_origin,
        "sender_did_key": env.sender_current_did_key,
        "sender_address": env.sender_address or "",
        "target_address": env.target_address,
        "envelope_hash": compute_envelope_hash(env),
        "message_id": env.message_id,
        "timestamp": timestamp or env.timestamp,
        "nonce": str(uuid4()),
    }
    if override:
        fields.update(override)
    assertion = ServerDeliveryAssertion(**fields, server_signature="placeholder")
    assertion = assertion.model_copy(
        update={
            "server_signature": sign_message(server_private, assertion_signing_bytes(assertion))
        }
    )
    payload["assertion"] = assertion.model_dump(mode="json")
    return payload


async def _post(app, payload):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/v1/federation/messages", json=payload)


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_happy_path_vouched_delivery_succeeds(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    bob_agent_id = await _insert_bob(db, bob_did)
    app = _build_app(db)
    payload = _vouch(_mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did))

    resp = await _post(app, payload)
    assert resp.status_code == 200, resp.text
    row = await db.fetch_one(
        "SELECT to_did, to_agent_id, signature FROM {{tables.messages}} WHERE message_id = $1",
        UUID(payload["envelope"]["message_id"]),
    )
    assert row["to_did"] == "did:aw:bob"
    assert str(row["to_agent_id"]) == bob_agent_id
    assert row["signature"] == payload["signature"]


# --------------------------------------------------------------------------- #
# Negative 1 — un-allowlisted origin (403 at step 3, before any crypto)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_unallowlisted_origin_rejected_before_crypto(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    # Sender vouches for an origin that is not in the receiver's allowlist.
    payload = _mail_envelope(
        sender_sk=alice_sk,
        sender_did_key=alice_did,
        bob_did_key=bob_did,
        sender_delivery_origin="https://evil.example",
    )
    _vouch(payload, server_origin="https://evil.example")

    resp = await _post(app, payload)
    assert resp.status_code == 403, resp.text
    assert "not allowlisted" in resp.text


# --------------------------------------------------------------------------- #
# Negative 2 — server signature from a non-pinned key (403 at step 5)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_server_signature_from_non_pinned_key_rejected(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    attacker_private, _ = _keypair()  # a key that is NOT peer.pinned_server_did
    payload = _mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did)
    _vouch(payload, server_private=attacker_private)

    resp = await _post(app, payload)
    assert resp.status_code == 403, resp.text
    assert "server signature invalid" in resp.text


# --------------------------------------------------------------------------- #
# Negative 3 — tampered inner payload (422 at BOTH step 4 hash and step 7 sig)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_tampered_inner_payload_rejected_by_envelope_hash(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    payload = _vouch(_mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did))
    # Mutate an inner field AFTER vouching: the assertion envelope_hash no longer
    # matches -> step 4 rejects (422) before the inner signature is even checked.
    payload["envelope"]["body"] = "tampered body"

    resp = await _post(app, payload)
    assert resp.status_code == 422, resp.text
    assert "envelope_hash" in resp.text


@pytest.mark.asyncio
async def test_tampered_inner_payload_rejected_by_inner_signature(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    payload = _mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did)
    # Tamper the body, then re-vouch so the OUTER hash matches but the INNER
    # participant signature (over the original signed_payload) fails -> step 7.
    payload["envelope"]["body"] = "tampered but re-vouched"
    _vouch(payload)

    resp = await _post(app, payload)
    assert resp.status_code == 422, resp.text
    # The inner participant binding/signature gate rejects.
    assert "signed_payload" in resp.text or "signature" in resp.text


# --------------------------------------------------------------------------- #
# Negative 4 — replayed message_id (idempotent 200 same content; 409 if differs)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_replayed_message_id_is_idempotent_then_conflicts(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    base = _mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did)
    payload = _vouch(json.loads(json.dumps(base)))

    first = await _post(app, payload)
    assert first.status_code == 200, first.text
    # Re-POST identical content (fresh nonce): idempotent no-op 200, same response.
    replay = await _post(app, _vouch(json.loads(json.dumps(base))))
    assert replay.status_code == 200, replay.text
    assert replay.json()["message_id"] == first.json()["message_id"]

    # Same message_id, different content -> 409.
    conflicting = _mail_envelope(
        sender_sk=alice_sk,
        sender_did_key=alice_did,
        bob_did_key=bob_did,
        message_id=base["envelope"]["message_id"],
        conversation_id=base["envelope"]["conversation_id"],
        body="different body, same id",
    )
    resp = await _post(app, _vouch(conflicting))
    assert resp.status_code == 409, resp.text

    count = await db.fetch_value(
        "SELECT COUNT(*) FROM {{tables.messages}} WHERE message_id = $1",
        UUID(base["envelope"]["message_id"]),
    )
    assert count == 1


# --------------------------------------------------------------------------- #
# Negative 5 — missing assertion (403 at step 2; no registry fallback)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_missing_assertion_rejected(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    payload = _mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did)
    # No assertion attached at all.

    resp = await _post(app, payload)
    assert resp.status_code == 403, resp.text
    assert "requires a server delivery assertion" in resp.text


# --------------------------------------------------------------------------- #
# Negative 6 — assertion binding mismatch (422 at step 4)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "field,value",
    [
        ("sender_did_key", "did:key:z6MkDifferentSender"),
        ("sender_address", "alpha.example/mallory"),
        ("target_address", "beta.example/eve"),
        ("message_id", str(uuid4())),
    ],
)
@pytest.mark.asyncio
async def test_assertion_binding_mismatch_rejected(aweb_cloud_db, field, value):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    payload = _mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did)
    # The assertion is well-signed but disagrees with the inner envelope on one
    # bound field.
    _vouch(payload, override={field: value})

    resp = await _post(app, payload)
    assert resp.status_code == 422, resp.text
    assert "does not match" in resp.text


# --------------------------------------------------------------------------- #
# Negative 7 — server_origin != sender_delivery_origin (422 at step 4)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_server_origin_mismatch_with_envelope_rejected(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    # Pin the *other* origin too so we pass the allowlist gate and reach step 4.
    app = _build_app(db)
    app.state.federation_peers_by_origin["https://other.example"] = Peer(
        addressing_domain="other.example",
        delivery_origin="https://other.example",
        pinned_server_did=SENDER_SERVER_DID,
    )
    # Envelope claims sender origin SENDER_ORIGIN, but assertion vouches a
    # different (allowlisted) origin.
    payload = _mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did)
    _vouch(payload, server_origin="https://other.example")

    resp = await _post(app, payload)
    assert resp.status_code == 422, resp.text
    assert "server_origin does not match" in resp.text


# --------------------------------------------------------------------------- #
# Negative 8 — stale assertion timestamp (422)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_stale_assertion_timestamp_rejected(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    # Envelope timestamp is fresh (passes inner skew), but the assertion vouches a
    # timestamp 10 minutes old -> outside the 300s window.
    payload = _mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did)
    _vouch(payload, timestamp=_now(-600))

    resp = await _post(app, payload)
    assert resp.status_code == 422, resp.text
    assert "timestamp outside accepted skew" in resp.text


# --------------------------------------------------------------------------- #
# Negative 9 — wrong target origin (421 at step 6)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_wrong_target_origin_rejected(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    alice_sk, alice_did = _keypair()
    _, bob_did = _keypair()
    await _insert_bob(db, bob_did)
    app = _build_app(db)
    app.state.public_origin = "https://different.example"  # B serves a different origin
    payload = _vouch(_mail_envelope(sender_sk=alice_sk, sender_did_key=alice_did, bob_did_key=bob_did))

    resp = await _post(app, payload)
    assert resp.status_code == 421, resp.text


# --------------------------------------------------------------------------- #
# Server-key endpoint
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_server_key_endpoint_advertises_public_did(aweb_cloud_db):
    app = _build_app(aweb_cloud_db.aweb_db)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/federation/server-key")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["server_origin"] == RECIPIENT_ORIGIN
    assert data["public_did"] == app.state.federation_server_key.public_did


# --------------------------------------------------------------------------- #
# Config loaders + signing-key derivation (pure unit)
# --------------------------------------------------------------------------- #


def test_load_peers_empty_disables_federation():
    by_domain, by_origin = load_federation_peers(None)
    assert by_domain == {} and by_origin == {}
    assert load_federation_peers("") == ({}, {})


def test_load_peers_indexes_by_domain_and_origin():
    raw = json.dumps(
        {
            "peers": [
                {
                    "addressing_domain": "B.Example",
                    "delivery_origin": "https://b.example/",
                    "pinned_server_did": SENDER_SERVER_DID,
                }
            ]
        }
    )
    by_domain, by_origin = load_federation_peers(raw)
    assert "b.example" in by_domain
    assert "https://b.example" in by_origin
    assert by_origin["https://b.example"].pinned_server_did == SENDER_SERVER_DID


def test_load_peers_rejects_invalid_pinned_did():
    raw = json.dumps(
        {"peers": [{"addressing_domain": "b.example", "delivery_origin": "https://b.example", "pinned_server_did": "did:key:notvalid"}]}
    )
    with pytest.raises(FederationConfigError):
        load_federation_peers(raw)


def test_load_peers_rejects_duplicate_domain():
    raw = json.dumps(
        {
            "peers": [
                {"addressing_domain": "b.example", "delivery_origin": "https://b.example", "pinned_server_did": SENDER_SERVER_DID},
                {"addressing_domain": "b.example", "delivery_origin": "https://b2.example", "pinned_server_did": SENDER_SERVER_DID},
            ]
        }
    )
    with pytest.raises(FederationConfigError):
        load_federation_peers(raw)


def test_server_key_from_seed_is_deterministic():
    seed = hashlib.sha256(b"seed").digest()
    k1 = server_key_from_seed(seed)
    k2 = server_key_from_seed(seed)
    assert k1.public_did == k2.public_did
    assert k1.private_key == seed


def test_assertion_signing_bytes_excludes_signature_and_is_canonical():
    assertion = ServerDeliveryAssertion(
        server_origin=SENDER_ORIGIN,
        sender_did_key="did:key:z6MkAlice",
        sender_address="alpha.example/alice",
        target_address="beta.example/bob",
        envelope_hash="a" * 64,
        message_id=str(uuid4()),
        timestamp=_now(),
        nonce=str(uuid4()),
        server_signature="ignored",
    )
    raw = assertion_signing_bytes(assertion)
    decoded = json.loads(raw)
    assert "server_signature" not in decoded
    # canonical: sorted keys, tight separators
    assert raw == canonical_json_bytes(decoded)

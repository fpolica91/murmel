from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from nacl.signing import SigningKey

from awid.did import did_from_public_key
from awid.signing import canonical_json_bytes, sign_message
from aweb.messaging.verification import message_verification_status


def _make_keypair():
    sk = SigningKey.generate()
    pk = bytes(sk.verify_key)
    return bytes(sk), did_from_public_key(pk)


def test_message_verification_uses_signed_payload_did_when_row_has_stable_did():
    sender_sk, sender_did_key = _make_keypair()
    sender_did_aw = "did:aw:alice-stable"
    recipient_did_key = "did:key:z6MkBobCurrent"
    recipient_did_aw = "did:aw:bob-stable"
    conversation_id = str(uuid4())
    message_id = str(uuid4())
    timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    signed_payload = canonical_json_bytes(
        {
            "body": "hello",
            "conversation_id": conversation_id,
            "from": "myco/alice",
            "from_did": sender_did_key,
            "from_stable_id": sender_did_aw,
            "message_id": message_id,
            "subject": "stable sender row",
            "timestamp": timestamp,
            "to": "otherco/bob",
            "to_did": recipient_did_key,
            "to_stable_id": recipient_did_aw,
            "type": "mail",
        }
    )

    status = message_verification_status(
        {
            "message_id": message_id,
            "conversation_id": conversation_id,
            "from_did": sender_did_aw,
            "to_did": recipient_did_aw,
            "signature": sign_message(sender_sk, signed_payload),
            "signed_payload": signed_payload.decode(),
        }
    )

    assert status == "verified"


def test_server_attributed_token_message_is_verified_server():
    # A Better Auth token caller has no client signing key: the server verifies
    # the bearer JWT and writes the message under the synthetic routing DID with
    # no signature. That must read as server-vouched, not "unverified".
    status = message_verification_status(
        {
            "message_id": str(uuid4()),
            "conversation_id": str(uuid4()),
            "from_did": "did:key:jwt-ULxKUSOPtj7yZT3qWUySVfe4kVI9akcv",
            "from_alias": "Ada (agent)",
            "content_mode": "legacy_plaintext_v1",
            "signature": None,
            "signed_payload": None,
        }
    )
    assert status == "verified_server"


def test_server_attributed_takes_precedence_over_stray_signature():
    # Even if a (meaningless) signature/payload is present, a did:key:jwt- row is
    # server-authenticated — there is no key to verify a jwt DID against, so the
    # server's JWT check is the attribution. It must not fall through to "failed".
    status = message_verification_status(
        {
            "message_id": str(uuid4()),
            "conversation_id": str(uuid4()),
            "from_did": "did:key:jwt-rrJJ8ZLIj65sL8ZecCalBEBWTUXhiCya",
            "signature": "not-a-real-signature",
            "signed_payload": "{}",
        }
    )
    assert status == "verified_server"


def test_plaintext_without_token_did_stays_unverified():
    # Regression guard: a genuinely unsigned message that is NOT a server-
    # attributed token identity must still read as "unverified".
    status = message_verification_status(
        {
            "message_id": str(uuid4()),
            "conversation_id": str(uuid4()),
            "from_did": "did:key:z6MkSomeRealClientKey",
            "signature": None,
            "signed_payload": None,
        }
    )
    assert status == "unverified"

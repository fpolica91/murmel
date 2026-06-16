"""Server federation signing key + peer allowlist (Option A.2).

This module owns the *outer* trust layer for token-only federation:

- ``ServerKey`` — the server's long-lived Ed25519 signing key (origin-bound to
  the server's ``public_origin``). One key per server, DB-backed (single row) so
  it survives restarts and is shared across replicas. Generated at lifespan
  startup via :func:`ensure_server_key`.
- ``Peer`` + :func:`load_federation_peers` — the explicit peer allowlist loaded
  once at startup from ``AWEB_FEDERATION_PEERS`` (JSON). Indexed by addressing
  domain (outbound trigger) and by canonical delivery origin (inbound pinned-key
  lookup).

The inner participant-signed envelope is untouched; this is the wrapper around
it. See ai-completion/FEDERATION-IMPL-SPEC.md.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass

from awid.did import did_from_public_key, generate_keypair, validate_did
from awid.log import canonical_server_origin

#: env override for the server signing key (base64, 32-byte Ed25519 seed). When
#: set, the key is derived deterministically and the DB row is *not* written —
#: used by the two-stack test/ops harness so both servers have stable keys.
SIGNING_SEED_ENV = "AWEB_FEDERATION_SIGNING_SEED"

#: env holding the peer allowlist JSON.
PEERS_ENV = "AWEB_FEDERATION_PEERS"


@dataclass(frozen=True)
class ServerKey:
    """This server's long-lived Ed25519 federation signing key."""

    private_key: bytes
    public_did: str


@dataclass(frozen=True)
class Peer:
    """A single allowlisted federation peer."""

    addressing_domain: str
    delivery_origin: str
    pinned_server_did: str


class FederationConfigError(ValueError):
    """Raised when federation env config is malformed (fails startup)."""


def _decode_signing_seed(value: str) -> bytes:
    raw = value.strip()
    if not raw:
        raise FederationConfigError(f"{SIGNING_SEED_ENV} must not be empty")
    padded = raw + "=" * (-len(raw) % 4)
    try:
        seed = base64.b64decode(padded, validate=True)
    except Exception:
        try:
            seed = base64.urlsafe_b64decode(padded)
        except Exception as exc:  # pragma: no cover - defensive
            raise FederationConfigError(
                f"{SIGNING_SEED_ENV} must be valid base64"
            ) from exc
    if len(seed) != 32:
        raise FederationConfigError(
            f"{SIGNING_SEED_ENV} must decode to a 32-byte seed, got {len(seed)}"
        )
    return seed


def server_key_from_seed(seed: bytes) -> ServerKey:
    """Derive a :class:`ServerKey` deterministically from a 32-byte seed."""
    from nacl.signing import SigningKey

    signing_key = SigningKey(seed)
    public_key = bytes(signing_key.verify_key)
    return ServerKey(private_key=bytes(seed), public_did=did_from_public_key(public_key))


async def ensure_server_key(db) -> ServerKey:
    """Return the server's federation signing key, generating it once.

    If ``AWEB_FEDERATION_SIGNING_SEED`` is set, the key is derived from that seed
    and the DB row is skipped (deterministic test/ops keys). Otherwise the key is
    read from (or inserted into) the single-row ``federation_server_key`` table.
    The ``ON CONFLICT (id) DO NOTHING`` + re-read makes concurrent first-boot
    replicas converge on one key.
    """
    seed_env = os.getenv(SIGNING_SEED_ENV)
    if seed_env is not None and seed_env.strip():
        return server_key_from_seed(_decode_signing_seed(seed_env))

    aweb_db = db.get_manager("aweb")
    row = await aweb_db.fetch_one(
        "SELECT private_key, public_did FROM {{tables.federation_server_key}} WHERE id = TRUE"
    )
    if row is not None:
        return ServerKey(private_key=bytes(row["private_key"]), public_did=row["public_did"])

    private_key, public_key = generate_keypair()
    public_did = did_from_public_key(public_key)
    row = await aweb_db.fetch_one(
        "INSERT INTO {{tables.federation_server_key}} (id, private_key, public_did) "
        "VALUES (TRUE, $1, $2) ON CONFLICT (id) DO NOTHING "
        "RETURNING private_key, public_did",
        private_key,
        public_did,
    )
    if row is None:  # lost the race against another replica — re-read.
        row = await aweb_db.fetch_one(
            "SELECT private_key, public_did FROM {{tables.federation_server_key}} WHERE id = TRUE"
        )
    return ServerKey(private_key=bytes(row["private_key"]), public_did=row["public_did"])


def load_federation_peers(
    raw: str | None,
) -> tuple[dict[str, Peer], dict[str, Peer]]:
    """Parse ``AWEB_FEDERATION_PEERS`` JSON into two indexes.

    Returns ``(by_domain, by_origin)`` where ``by_domain`` is keyed by case-folded
    addressing domain (outbound trigger) and ``by_origin`` is keyed by canonical
    delivery origin (inbound pinned-key lookup). Empty/absent => both empty
    (federation fully disabled). Duplicate domains/origins or an invalid pinned
    did:key fail startup.
    """
    by_domain: dict[str, Peer] = {}
    by_origin: dict[str, Peer] = {}
    if raw is None or not raw.strip():
        return by_domain, by_origin

    try:
        parsed = json.loads(raw)
    except Exception as exc:
        raise FederationConfigError(f"{PEERS_ENV} must be valid JSON") from exc

    if isinstance(parsed, dict):
        entries = parsed.get("peers", [])
    elif isinstance(parsed, list):
        entries = parsed
    else:
        raise FederationConfigError(f"{PEERS_ENV} must be a JSON object or array")

    if not isinstance(entries, list):
        raise FederationConfigError(f"{PEERS_ENV} 'peers' must be an array")

    for entry in entries:
        if not isinstance(entry, dict):
            raise FederationConfigError(f"{PEERS_ENV} entries must be objects")
        domain = str(entry.get("addressing_domain") or "").strip().lower()
        origin_raw = str(entry.get("delivery_origin") or "").strip()
        pinned = str(entry.get("pinned_server_did") or "").strip()
        if not domain:
            raise FederationConfigError(f"{PEERS_ENV} entry missing addressing_domain")
        if not origin_raw:
            raise FederationConfigError(f"{PEERS_ENV} entry missing delivery_origin")
        if not pinned:
            raise FederationConfigError(f"{PEERS_ENV} entry missing pinned_server_did")
        if not validate_did(pinned):
            raise FederationConfigError(
                f"{PEERS_ENV} entry pinned_server_did is not a valid did:key: {pinned}"
            )
        try:
            origin = canonical_server_origin(origin_raw)
        except Exception as exc:
            raise FederationConfigError(
                f"{PEERS_ENV} entry delivery_origin does not canonicalize: {origin_raw}"
            ) from exc
        peer = Peer(addressing_domain=domain, delivery_origin=origin, pinned_server_did=pinned)
        if domain in by_domain:
            raise FederationConfigError(f"{PEERS_ENV} duplicate addressing_domain: {domain}")
        if origin in by_origin:
            raise FederationConfigError(f"{PEERS_ENV} duplicate delivery_origin: {origin}")
        by_domain[domain] = peer
        by_origin[origin] = peer

    return by_domain, by_origin

# Federation token-only — Option A.2 implementation spec

_Branch: `feature/simple-auth-ui`. Companion / successor to
[FEDERATION-TOKEN-ONLY.md](FEDERATION-TOKEN-ONLY.md) (the design + recommendation).
This document is the precise, buildable spec for the recommended **Option A.2**:
per-server Ed25519 signing key + explicit peer allowlist + a server-vouched
**outer delivery assertion** that wraps the existing participant-signed **inner
envelope**._

**Non-negotiable invariant:** the inner participant-signed envelope
(`FederationEnvelope` + `verify_federation_envelope` +
`_enforce_signed_payload_binding` / `_enforce_encrypted_payload_binding` +
`verify_did_key_signature`) is **sound and is PRESERVED byte-for-byte**. A.2 adds
an outer layer *around* it and replaces only the two registry-dependent
resolution steps (`_verify_sender_current_key`, `_resolve_target_identity`) with
server-vouching + local directory resolution. No inner-envelope field, validator,
or binding rule changes.

---

## 0. Trust model in one paragraph

B trusts **A-the-server**, pinned by A's long-lived Ed25519 server key, listed in
B's explicit `federation_peers` allowlist. A authenticates its own member locally
(JWT), then signs an **outer delivery assertion** with its server key vouching
"my member `<sender_address>` (self-custodial key `<sender_current_did_key>`) sent
this exact inner envelope to `<target_address>`." B verifies, in order: (1) the
asserting origin is allowlisted; (2) the outer server signature verifies against
the **pinned** pubkey for that origin; (3) the inner participant signature
verifies against the self-custodial key the assertion vouches for; (4) the
message has not been delivered before (replay). A compromised/hostile peer can
forge only **its own** members, never a third peer's — the outer assertion is
bound to A's pinned key. Closed federation only: no peer in the allowlist ⇒ no
federation in or out.

---

## 1. Server signing key — generation, storage, config

### 1.1 Key material

Reuse the existing primitives in `awid/src/awid/{did,signing}.py` — do **not**
add a new crypto stack:

- Generate: `awid.did.generate_keypair() -> (private_32, public_32)`.
- Public did:key: `awid.did.did_from_public_key(public_32)` → `did:key:z...`.
- Sign: `awid.signing.sign_message(private_32, payload_bytes)` → unpadded
  base64 signature string (same shape the inner envelope already uses).
- Verify: `awid.signing.verify_did_key_signature(did_key=..., payload=...,
  signature_b64=...)` (raises on mismatch) — identical to inner verification, so
  the outer layer and inner layer share one verified codepath.

The server key is **origin-bound**: it vouches for exactly one delivery origin
(A's `public_origin`). One key per server, long-lived.

### 1.2 Storage (DB-backed, single row)

Store the keypair in a new table (migration `013`, §7) rather than a file, so it
survives container restarts and is shared across replicas of the same server:

```
federation_server_key(
    id            boolean PRIMARY KEY DEFAULT TRUE CHECK (id),  -- single-row guard
    private_key   bytea NOT NULL,        -- 32-byte Ed25519 seed
    public_did    text  NOT NULL,        -- did:key:z... derived from public key
    created_at    timestamptz NOT NULL DEFAULT now()
)
```

`id boolean PRIMARY KEY DEFAULT TRUE CHECK (id)` enforces at most one row.

**Generation at startup (idempotent).** In `aweb.api` lifespan, after DB infra is
ready and migrations have run, call a new `aweb.federation.server_key.ensure_server_key(db)`:

```python
async def ensure_server_key(db) -> ServerKey:
    aweb_db = db.get_manager("aweb")
    row = await aweb_db.fetch_one("SELECT private_key, public_did FROM {{tables.federation_server_key}} WHERE id = TRUE")
    if row is not None:
        return ServerKey(private_key=bytes(row["private_key"]), public_did=row["public_did"])
    private_key, public_key = generate_keypair()
    public_did = did_from_public_key(public_key)
    row = await aweb_db.fetch_one(
        "INSERT INTO {{tables.federation_server_key}} (id, private_key, public_did) "
        "VALUES (TRUE, $1, $2) ON CONFLICT (id) DO NOTHING "
        "RETURNING private_key, public_did",
        private_key, public_did,
    )
    if row is None:  # lost the race against another replica — re-read
        row = await aweb_db.fetch_one("SELECT private_key, public_did FROM {{tables.federation_server_key}} WHERE id = TRUE")
    return ServerKey(private_key=bytes(row["private_key"]), public_did=row["public_did"])
```

The `ON CONFLICT DO NOTHING` + re-read makes concurrent first-boot replicas
converge on one key. Cache the result on `app.state.federation_server_key`
(a small frozen dataclass `ServerKey(private_key: bytes, public_did: str)`).

**Override for tests / explicit ops:** if env `AWEB_FEDERATION_SIGNING_SEED`
(base64, 32 bytes) is set, derive the key from it instead of generating, and skip
the DB insert (deterministic two-stack harness keys). The DB row remains the
production source of truth.

### 1.3 Public-key endpoint

`GET /v1/federation/server-key` — unauthenticated read (like a JWKS), in
`server/src/aweb/routes/federation.py`:

```json
{ "server_origin": "https://a.example", "public_did": "did:key:z6Mk..." }
```

`server_origin` is `canonical_server_origin(settings.public_origin)`. This is a
convenience for **manual** peer pinning only. **It is NOT consulted at verify
time** — B always verifies against the *configured pinned* key, never a key
fetched live from the peer (fetching live would defeat pinning).

---

## 2. Peer allowlist — config shape

A new `app.state.federation_peers`, loaded once at startup from env
`AWEB_FEDERATION_PEERS` (JSON). Each peer entry:

```jsonc
{
  "peers": [
    {
      "addressing_domain": "b.example",          // the domain side of domain/name addresses
      "delivery_origin":   "https://b.example",  // canonicalized; where A POSTs; what B advertises
      "pinned_server_did": "did:key:z6MkB..."    // B's server public did:key, pinned by A
    }
  ]
}
```

Normalize and index into two dicts on `app.state`:

- `federation_peers_by_domain: dict[str, Peer]` keyed by `addressing_domain`
  (case-folded) — used **outbound** to decide whether a recipient address is
  federated and to which origin.
- `federation_peers_by_origin: dict[str, Peer]` keyed by
  `canonical_server_origin(delivery_origin)` — used **inbound** to look up the
  pinned key for the asserting `server_origin`.

`Peer` = frozen dataclass `(addressing_domain: str, delivery_origin: str,
pinned_server_did: str)`. Validate at load time: `pinned_server_did` must pass
`awid.did.validate_did`; `delivery_origin` must canonicalize; duplicate
domains/origins are a config error (fail startup).

**Mutuality is operational, not enforced in code:** for A→B to work, A lists B
(pins B's key) AND B lists A (pins A's key). Empty/absent `AWEB_FEDERATION_PEERS`
⇒ federation fully disabled (no outbound trigger, inbound rejects every
assertion with 403). This makes the feature opt-in and the default safe.

A peer **table** (`federation_peers`) is explicitly **out of scope for v2 first
cut** — env/JSON config is the allowlist. (A table can come later without
changing the wire format.) No migration is needed for the allowlist; the only
schema change is the single-row server-key table (§7).

---

## 3. Outer delivery assertion — structure + canonical signing bytes

### 3.1 Wire structure

Extend `FederatedDeliveryRequest` (`server/src/aweb/federation/envelope.py`) with
an **optional** outer assertion block. Optional so the model stays
backwards-shape-compatible and so the *handler* (not pydantic) enforces presence
under A.2. The inner `envelope` + inner `signature` are unchanged.

```python
class ServerDeliveryAssertion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    server_origin: str = Field(..., min_length=1, max_length=512)   # A's delivery origin (canonical)
    sender_did_key: str = Field(..., min_length=1, max_length=256)  # sender self-custodial did:key:z...
    sender_address: str = Field(..., min_length=1, max_length=256)  # A-side global address domain/name
    target_address: str = Field(..., min_length=1, max_length=256)  # B-side global address domain/name
    envelope_hash: str = Field(..., min_length=1, max_length=128)   # sha256 hex of canonical inner bytes
    message_id: str = Field(..., min_length=1, max_length=64)       # UUID, == envelope.message_id
    timestamp: str = Field(..., min_length=1, max_length=64)        # RFC3339 second-precision, tz-aware
    nonce: str = Field(..., min_length=1, max_length=64)            # UUID, replay salt
    server_signature: str = Field(..., min_length=1, max_length=512)

    @field_validator("server_origin")
    @classmethod
    def _canon_origin(cls, v): return canonical_server_origin(v)

    @field_validator("sender_did_key")
    @classmethod
    def _did_key(cls, v):
        v = v.strip()
        if not v.startswith("did:key:"): raise ValueError("must be a did:key")
        return v

    @field_validator("message_id", "nonce")
    @classmethod
    def _uuid(cls, v): return str(UUID(v.strip()))

    @field_validator("timestamp")
    @classmethod
    def _ts(cls, v): _parse_timestamp(v); return v


class FederatedDeliveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    envelope: FederationEnvelope
    signature: str = Field(..., min_length=1, max_length=512)       # inner participant signature (UNCHANGED)
    assertion: ServerDeliveryAssertion | None = None               # NEW outer layer (A.2)
```

### 3.2 `envelope_hash` — what is hashed

`envelope_hash = sha256_hex( canonical_inner_bytes )` where
`canonical_inner_bytes = canonical_json_bytes(envelope.model_dump(mode="json",
exclude_none=True))`, using the existing `awid.signing.canonical_json_bytes`
(sorted keys, `(",", ":")` separators, `ensure_ascii=False`). This binds the
assertion to the *entire* inner envelope (which itself already binds the inner
participant signature to body/subject/to/from/message_id/timestamp). Tampering
with any inner field changes `envelope_hash` ⇒ outer signature fails. Provide one
shared helper used by both send and receive so the bytes never diverge:

```python
def compute_envelope_hash(envelope: FederationEnvelope) -> str:
    canonical = canonical_json_bytes(envelope.model_dump(mode="json", exclude_none=True))
    return hashlib.sha256(canonical).hexdigest()
```

### 3.3 Canonical signing bytes for the server signature

```python
def assertion_signing_bytes(a: ServerDeliveryAssertion) -> bytes:
    return canonical_json_bytes({
        "version": a.version,
        "server_origin": a.server_origin,
        "sender_did_key": a.sender_did_key,
        "sender_address": a.sender_address,
        "target_address": a.target_address,
        "envelope_hash": a.envelope_hash,
        "message_id": a.message_id,
        "timestamp": a.timestamp,
        "nonce": a.nonce,
    })
```

`server_signature` is computed over **exactly these bytes** (the assertion fields
minus `server_signature` itself), via `sign_message(server_private_key, bytes)`,
and verified via `verify_did_key_signature(did_key=pinned_server_did,
payload=bytes, signature_b64=server_signature)`. Sorted-key canonical JSON makes
the bytes order-independent and stable across Python/Go.

**Binding rules the handler enforces** (assertion ↔ inner envelope must agree):

| assertion field | must equal |
|---|---|
| `envelope_hash` | `compute_envelope_hash(envelope)` |
| `message_id` | `envelope.message_id` |
| `sender_did_key` | `envelope.sender_current_did_key` |
| `sender_address` | `envelope.sender_address` |
| `target_address` | `envelope.target_address` |
| `server_origin` | `envelope.sender_delivery_origin` AND an allowlisted peer origin |
| `timestamp` | within `FEDERATION_TIMESTAMP_SKEW_SECONDS` of now |

Any mismatch ⇒ reject (422). This makes the server's vouch and the participant's
signature describe the *same* message, sender, and route.

---

## 4. Send-side wrapping (outbound path)

File: `server/src/aweb/routes/messages.py`, `_deliver_remote_mail_and_project_locally`
and its trigger.

### 4.1 New federation trigger (replaces registry `delivery_origin`)

Today the federated branch fires only when `_remote_delivery_origin(recipient)`
(a registry-published origin on the agent row) is non-empty — which never
happens for token agents. Replace the trigger:

- Parse the recipient/target address `domain/name`. Look `domain` up in
  `app.state.federation_peers_by_domain`. If found ⇒ federated; the peer's
  `delivery_origin` is where we POST. If not found ⇒ not federated (existing
  local/424 behavior).
- Keep `_remote_delivery_origin(recipient)` as a fallback **only** if a
  registry-era origin is still present (mixed deployments); the peer-domain path
  takes precedence.

### 4.2 Build the inner envelope (UNCHANGED) then wrap

The inner `FederationEnvelope` is built and `verify_federation_envelope`-checked
exactly as today (lines 788-824). The one substantive change required by §8 of
the design: the inner `signed_payload` / `from_did` MUST be signed with the
sender's **self-custodial** key (`agent_encryption_keys.identity_did`,
`did:key:z...`), never the synthetic `did:key:jwt-...`. `sender_current_did_key`
on the envelope is that self-custodial key. (This is CLI-side work — the client
already holds the E2E signing key from commit `a07fd564`; the federated send must
thread it through as `from_did`/`sender_current_did_key`. The synthetic key, if
present at all, stays an opaque routing label and never enters the signed surface
or the assertion.)

Then construct and sign the outer assertion:

```python
server_key = request.app.state.federation_server_key
assertion = ServerDeliveryAssertion(
    server_origin=_local_public_origin(request),
    sender_did_key=envelope.sender_current_did_key,
    sender_address=envelope.sender_address,
    target_address=envelope.target_address,
    envelope_hash=compute_envelope_hash(envelope),
    message_id=envelope.message_id,
    timestamp=envelope.timestamp,
    nonce=str(uuid4()),
    server_signature="",  # filled next
)
assertion = assertion.model_copy(update={
    "server_signature": sign_message(server_key.private_key, assertion_signing_bytes(assertion))
})
```

`envelope.sender_delivery_origin` MUST equal `assertion.server_origin`
(`_local_public_origin(request)`), so B's `server_origin == sender_delivery_origin`
check holds. POST `FederatedDeliveryRequest(envelope=..., signature=...,
assertion=...)` via `deliver_federated_message`. Extend
`deliver_federated_message` (`federation/mail.py`) to accept and serialize the
optional `assertion` (add an `assertion: ServerDeliveryAssertion | None`
parameter; include it in `model_dump(... exclude_none=True)`).

If `app.state.federation_server_key` is unset (federation disabled / key not
provisioned) the outbound federated branch raises 424 — never send unsigned.

---

## 5. Receive-side verification ORDER (inbound path)

File: `server/src/aweb/routes/federation.py`, `receive_federated_message`. The
order is load-bearing — cheapest, most-authoritative gates first; do not deliver
until all pass.

1. **Type gate** (unchanged): `type ∈ {mail, chat}` else 422.

2. **Assertion present** (A.2): `payload.assertion is None` ⇒ **403**
   ("Federation requires a server delivery assertion"). Under A.2 there is no
   registry fallback; a bare inner envelope is rejected.

3. **Allowlisted origin.** `origin = canonical_server_origin(assertion.server_origin)`.
   `peer = app.state.federation_peers_by_origin.get(origin)`. If `peer is None`
   ⇒ **403** ("Federation peer origin not allowlisted"). This is checked
   **before** any signature math so an un-allowlisted caller never reaches crypto.

4. **Assertion↔envelope binding** (the §3.3 table). Any mismatch ⇒ **422**.
   In particular `assertion.server_origin == envelope.sender_delivery_origin` and
   `assertion.envelope_hash == compute_envelope_hash(envelope)`.

5. **Outer server signature against the PINNED key.**
   `verify_did_key_signature(did_key=peer.pinned_server_did,
   payload=assertion_signing_bytes(assertion),
   signature_b64=assertion.server_signature)`. Raises ⇒ **403**
   ("Federation server signature invalid"). The pinned key comes from B's config,
   never from the wire or a live fetch.

6. **Target origin is here** (unchanged): `_require_target_origin_here` —
   `envelope.target_delivery_origin ∈ B's public origins`, else 421.

7. **Inner participant signature + binding (UNCHANGED, PRESERVED).**
   `verify_federation_envelope(payload.envelope, payload.signature, expected={...})`
   — same `expected` dict as today (lines 535-543). This proves the participant
   whose self-custodial key the assertion vouches for actually signed the inner
   payload (`verify_did_key_signature` + `_enforce_signed_payload_binding` /
   `_enforce_encrypted_payload_binding`). Combined with step 5, A vouches for the
   key↔member binding and the member signed the content.

8. **Replace registry resolution with local directory resolution.**
   - Drop `_verify_sender_current_key(registry_client, ...)` (step 3 old) — the
     server assertion now vouches for `sender_current_did_key`. (Keep the
     synthetic-key/self-key equality guard for `did:key:` senders.)
   - Replace `_resolve_target_identity(registry_client, ...)` (step 4 old) with
     **local** resolution: split `envelope.target_address` into `domain/name`,
     resolve `name` against B's own agent directory
     (`resolve_agent_by_did` already runs below on `target_did_aw`; add a
     `get_agent_by_namespace_alias`-style local lookup keyed by the local alias /
     address). Assert the resolved agent's `did_key` == `target_current_did_key`
     and that the agent's address domain is one B serves. No awid call.

9. **Recipient resolution + authorization** (unchanged): `resolve_agent_by_did`,
   `did_key` match (422), `authorize_message_delivery`.

10. **Idempotency / replay** (unchanged + extended, §6): `_idempotent_existing_*`
    then `_claim_federated_delivery`. Only after the claim succeeds is the message
    stored.

The `registry_client` requirement at the top of the handler (lines 527-529) is
**removed** under A.2 (federation no longer needs awid at runtime). Encrypted-v2
(`_is_encrypted_v2`) flows through identically — the assertion wraps the
encrypted inner envelope; `envelope_hash` covers the `encrypted_envelope` object
because it is part of the canonical inner dump.

---

## 6. Replay protection

Two layers, both preserved/extended; neither depends on auth mode:

### 6.1 Existing delivery claim (unchanged)

`_claim_federated_delivery` INSERTs into `federated_message_deliveries` with
`ON CONFLICT (message_type, sender_did_aw, target_did_aw, message_id) DO NOTHING`.
First delivery wins the claim and stores; a **replayed `message_id`** loses the
claim. Combined with the `_idempotent_existing_message` pre-check, a replay of an
already-delivered message returns the **same** `_delivery_response` (idempotent
no-op, 200) if content matches, or **409** if the same `message_id` carries
different content. This is exactly the required behavior (design §3 negative test
iv) and needs no change.

### 6.2 Assertion nonce + timestamp (defense in depth)

- The assertion `timestamp` is skew-bounded via `_parse_timestamp` +
  `FEDERATION_TIMESTAMP_SKEW_SECONDS` (300s) — an assertion older/newer than the
  window is rejected (422) before delivery, so a captured assertion cannot be
  replayed indefinitely.
- The assertion carries a `nonce` (UUID) included in the signed bytes. The
  `message_id`-keyed delivery claim already collapses true duplicates; the nonce
  exists so two *distinct* assertions over the same `message_id` (e.g. a
  re-vouch) remain individually well-formed and signature-distinct without
  weakening the message-level idempotency. No separate nonce table is required
  for v2 first cut — `message_id` uniqueness in `federated_message_deliveries` is
  the authoritative replay boundary; the timestamp window bounds assertion reuse.

---

## 7. Migration

New numbered file (never edit an existing migration): create
`server/src/aweb/migrations/aweb/013_federation_server_key.sql`. The
`{{tables.federation_server_key}}` placeholder must be registered wherever the
other `{{tables.*}}` names are registered (same place `federated_message_deliveries`
is) so pgdbm resolves it.

```sql
-- 013_federation_server_key.sql
-- Single-row table holding this server's long-lived Ed25519 federation
-- signing key (Option A.2 server-vouched delivery assertions).
CREATE TABLE IF NOT EXISTS {{tables.federation_server_key}} (
    id          boolean PRIMARY KEY DEFAULT TRUE CHECK (id),
    private_key bytea       NOT NULL,
    public_did  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
```

This is **additive** (new table only) — no edits to `001_initial.sql`, no
checksum break. The peer allowlist needs **no** migration (env/JSON config).

---

## 8. Negative-test matrix (all MUST reject; these stay red)

Unit (`server/tests/test_federation_envelope.py` — add outer-assertion vectors
mirroring the existing inner-signature vectors) + handler-level
(`server/tests/...` against `receive_federated_message`):

1. **Un-allowlisted origin** — assertion `server_origin` not in
   `federation_peers_by_origin` ⇒ **403** at step 3, before any crypto.
2. **Server-sig from a non-pinned key** — valid inner envelope, well-formed
   assertion, but `server_signature` produced by a key that is not the pinned
   `peer.pinned_server_did` ⇒ **403** at step 5
   (`verify_did_key_signature` raises).
3. **Tampered inner payload** — any inner field mutated after signing: caught
   first by `assertion.envelope_hash != compute_envelope_hash(envelope)` ⇒ 422
   (step 4); and independently by the inner `verify_federation_envelope`
   participant-signature failure ⇒ 422 (step 7). Both gates reject; test both.
4. **Replayed `message_id`** — re-POST a delivered message: idempotent no-op
   (200, same response) if content identical (delivery claim conflict); **409**
   if `message_id` reused with different content.
5. **Missing assertion** — `assertion is None` ⇒ **403** (step 2).
6. **Assertion binding mismatch** — assertion well-signed but
   `sender_did_key`/`sender_address`/`target_address`/`message_id` disagrees with
   the inner envelope ⇒ **422** (step 4).
7. **server_origin ≠ sender_delivery_origin** — A vouches for an origin different
   from the envelope's claimed sender origin ⇒ **422** (step 4).
8. **Stale assertion timestamp** — outside the 300s skew window ⇒ **422**.
9. **Wrong target origin** — `target_delivery_origin` not one of B's public
   origins ⇒ **421** (step 6, unchanged).

The four headline cases from the design (i un-allowlisted, ii non-pinned key, iii
tampered inner, iv replay) map to tests 1, 2, 3, 4 respectively. The two-full-stack
e2e harness (`scripts/e2e-oss-federation.sh`, two cross-configured stacks) keeps
these red end-to-end.

---

## 9. Files to touch

- `server/src/aweb/federation/envelope.py` — add `ServerDeliveryAssertion`,
  `assertion`-field on `FederatedDeliveryRequest`, `compute_envelope_hash`,
  `assertion_signing_bytes`. Inner envelope/binding code UNCHANGED.
- `server/src/aweb/federation/server_key.py` — **NEW**: `ServerKey` dataclass +
  `ensure_server_key(db)` + `assertion_signing_bytes`/sign/verify helpers (or
  keep the helpers in `envelope.py`).
- `server/src/aweb/federation/mail.py` — thread optional `assertion` through
  `deliver_federated_message` / `deliver_federated_mail` and into the POST body.
- `server/src/aweb/routes/federation.py` — new verification order (steps 2-5,
  8); drop `_verify_sender_current_key`; replace `_resolve_target_identity` with
  local directory resolution; remove the hard `registry_client` requirement;
  add `GET /v1/federation/server-key`.
- `server/src/aweb/routes/messages.py` — new federation trigger (peer-domain
  lookup), build + server-sign the outer assertion in
  `_deliver_remote_mail_and_project_locally`.
- `server/src/aweb/config.py` — parse `AWEB_FEDERATION_PEERS` +
  `AWEB_FEDERATION_SIGNING_SEED`; add `federation_peers` to `Settings` (or load
  directly into app.state).
- `server/src/aweb/api.py` — lifespan: `ensure_server_key`, build
  `federation_peers_by_domain` / `federation_peers_by_origin`, set
  `app.state.federation_server_key` / `app.state.federation_peers*`.
- `server/src/aweb/migrations/aweb/013_federation_server_key.sql` — **NEW**
  (single-row server-key table) + register `{{tables.federation_server_key}}`.
- `server/tests/test_federation_envelope.py` (+ a handler test module) — the §8
  negative matrix and outer-assertion positive vectors.
- `cli/go` (separate epic slice) — sign the inner payload with the
  self-custodial key on federated send (design §8); not required for the
  server-side spec but required for the e2e harness to pass.

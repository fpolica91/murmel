# Federation under token-only auth — breakage, design, scope verdict

_Branch: `feature/simple-auth-ui` (== main at time of writing). Companion to
[PIVOT-FOLLOWUPS.md](PIVOT-FOLLOWUPS.md) §2 and [STATUS.md](STATUS.md)._

**Scope of this document:** investigate what the token-only pivot broke in
cross-server federation (aweb server A → aweb server B mail/chat), design the
options for restoring it WITHOUT reintroducing certs/DIDs, recommend one, and
give an honest verdict on whether any bounded, safe piece can land now. This is
cross-server security; the explicit goal is **not** to weaken cross-server trust
or half-build a trust mechanism.

**Verdict up front:** federation under token-only is a **deliberate v2
re-architecture**, not a bug to patch. The trust root that the entire federation
path depends on (the awid registry resolving a global address → did:aw →
current did:key → delivery origin, and the receiving server cryptographically
verifying the sender's signature against a registry-published key) has **no
token-only equivalent**. Restoring it safely requires a new server-to-server
trust primitive that does not exist yet. **No bounded code change is landed in
this pass** — doing so would be a half-built trust mechanism. The deliverable is
this precise design + an updated honest record. Server suite stays at **629**
(no code touched). Details and the exact why are below.

---

## 1. What exactly breaks (file/function level)

Federation has two halves: the **outbound** path (server A builds and signs the
cross-server envelope) and the **inbound** path (server B verifies and delivers
it). Both are anchored on the awid registry and on DID-signed payloads. The
pivot removed the provisioning that populates that anchor, so both halves lose
their trust root.

### 1.1 The trust chain the inbound path enforces

`server/src/aweb/routes/federation.py::receive_federated_message` (the
`POST /v1/federation/messages` handler) runs four trust checks in order:

1. **`verify_federation_envelope(...)`**
   (`server/src/aweb/federation/envelope.py:126`). For plaintext mail/chat this
   calls `verify_did_key_signature(did_key=model.sender_current_did_key, ...)`
   (envelope.py:153). That function
   (`awid/src/awid/signing.py:102` → `verify_signature` at line 87) **requires
   the key to start with `did:key:z`** (line 91) — a real multibase Ed25519
   public key. The whole point is that B cryptographically verifies A's
   participant signed the payload, with no trust in A's server.

2. **`_require_target_origin_here`** (federation.py:176) — envelope is addressed
   to one of B's public origins. (This still works; it's local config.)

3. **`_verify_sender_current_key(registry_client, envelope)`**
   (federation.py:120). For a `did:aw:` sender it calls
   `registry_client.resolve_key(sender_did_aw)` and asserts the registry's
   published `current_did_key` equals the envelope's `sender_current_did_key`.
   **This is the cross-server identity anchor: B trusts the shared awid registry,
   not A, to vouch that this did:key currently belongs to this did:aw.**

4. **`_resolve_target_identity(registry_client, envelope)`**
   (federation.py:139) — on first contact, calls
   `registry_client.resolve_address(domain, name)` and asserts the registry's
   `did_aw`, `current_did_key`, and `delivery.origin` all match the envelope.
   This is how B knows the global address `domain/name` maps to a real local
   recipient and that A routed it to the right place.

### 1.2 Why token-only has nothing to feed checks 1, 3, and 4

Under token-only (`server/src/aweb/identity_auth_deps.py`):

- A token participant authenticates by a Better Auth **JWT verified against the
  LOCAL server's issuer/JWKS** (`resolve_token_team_identity`). The JWT issuer
  and JWKS are **per-server** — server B cannot verify server A's JWTs, and
  there is no shared issuer.
- Their routing identity is a **synthetic** `did:key:jwt-<subject>`
  (`_jwt_synthetic_did_key`, identity_auth_deps.py:146). The docstring is
  explicit: *"It is purely a local routing key — it is never published to AWID
  and never used for signature verification."* It is **not** a `did:key:z...`
  multibase key, so `verify_did_key_signature` on it **raises `invalid
  signature`** → `verify_federation_envelope` raises `FederationEnvelopeError` →
  **422**. Check 1 fails outright for a synthetic sender DID.
- They have **`did_aw = None`** and **no global awid address**. So check 3's
  `resolve_key(did_aw)` has no did:aw to resolve, and check 4's
  `resolve_address(domain, name)` has nothing the registry knows — there is no
  provisioning path that ever wrote a global address, a published did:key, or a
  `delivery.origin` for a token participant. `e2e-oss-federation.sh` documents
  exactly this: the removed `aw id create` / `aw id namespace
  set-delivery-origin` cluster was what populated those registry rows.

### 1.3 The outbound path has the same hole

`server/src/aweb/routes/messages.py::_deliver_remote_mail_and_project_locally`
(line 728) only fires when `_remote_delivery_origin(recipient)` is non-empty
(line 744) — i.e. when the **recipient** resolved to an agent row carrying a
`delivery_origin`. Under token-only, recipient rows are provisioned by
`provision_human_participant` (identity_auth_deps.py:158), which writes **no
`delivery_origin`** (it isn't even a column the token path sets). So:

- A token sender **never enters the federated branch** — there is no remote
  delivery origin to trigger it, because token onboarding never learns a
  cross-server address for anyone. Cross-server mail is simply unreachable, not
  broken-with-an-error.
- Even if it did fire, the outbound envelope is built with
  `sender_did_aw = auth.did_aw or auth.did_key` (messages.py:766). For a token
  human that is the synthetic `did:key:jwt-<subject>`, and
  `sender_current_did_key` would have to be a real signing key — but the only
  real signing key a token human has is their **self-custodial E2E key**
  (`agent_encryption_keys.identity_did`), which is published as an *encryption*
  assertion on the roster, **not** as a registry-resolvable routing identity. B
  has no way to fetch it, because B doesn't share A's database or registry.

### 1.4 The real signing key DOES exist locally — but only same-server

The multi-device trust fix (commit `a07fd564`, "server-anchored key trust")
established the pattern that matters here: a token human has a **real
self-custodial Ed25519 key** (`did:key:z...`), published to **A's own** roster
via `GET /v1/agents` (`server/src/aweb/routes/agents.py:212`, the
`agent_encryption_keys` LATERAL join at line 229). The CLI verifier
(`cli/go/awid/client.go::NormalizeSenderTrust`) resolves the sender's *current
server-published* key from that roster and treats it as authoritative.

**This is a server-anchored trust model — and it is exactly the shape
federation needs — but it only works inside one server.** A's roster is reachable
by A's members over A's auth. Server B cannot call A's `GET /v1/agents` as a
trusted source, because there is no server-to-server trust relationship and no
shared registry to mediate it. That missing edge is the entire gap.

**Net:** the cryptographic verification (`verify_did_key_signature`) and the
envelope binding (`_enforce_signed_payload_binding`) are sound and reusable.
What's gone is the **provisioning + cross-server resolution** that tells B
*which key to trust for this sender* and *which address routes to this
recipient*. That is a trust-root problem, not a code bug.

---

## 2. Design options (no certs, no DIDs)

All three keep local auth token-only. They differ in **who B trusts to vouch for
A's participant** and in **how the sender's signing key crosses the boundary**.

### Option A — Server-to-server vouching ("A vouches, signed with a server key")

**Trust model:** B trusts **A-the-server** (not A's individual participants).
A authenticates its own local participant by JWT (as today), then **A's server**
asserts to B: "my authenticated member `<alias>@A> sent this; here is their
self-custodial signing key and my signature over the whole assertion." B
verifies A's **server** signature/identity, not the participant's JWT.

How the server↔server trust is rooted — pick one mechanism:

- **A.1 — mTLS between federation peers.** B pins A's server cert (or a CA). The
  TLS peer identity *is* the server identity. Simple, standard, but requires
  cert distribution/ops between peers.
- **A.2 — Server signing key + a peer allowlist.** Each aweb server holds a
  long-lived Ed25519 **server key** and publishes its public key at a
  well-known endpoint (e.g. `GET /v1/federation/server-key`). B keeps a
  configured **federation peer allowlist** mapping `origin → pinned server
  pubkey`. A signs an outer "delivery assertion" (envelope hash + sender
  identity + timestamp + nonce) with its server key; B verifies against the
  pinned key. This is the cleanest fit for the existing envelope code (the
  envelope already carries `sender_delivery_origin`; we add a server-signed
  outer layer).
- **A.3 — Shared federation secret (HMAC).** A and B share a symmetric secret;
  A HMACs the assertion. Easiest to build, **weakest** (symmetric = either side
  can forge the other's messages; no non-repudiation; secret rotation is
  painful). Only acceptable for a closed two-party deployment.

**Security tradeoffs:** the trust unit becomes the *server*, not the
*participant*. B is trusting A to honestly report which of A's members sent the
message — A could lie about its own members (it always could, since A controls
its members). What A **cannot** do is impersonate a *third* server's members,
because the outer assertion is bound to A's pinned server key/cert. This is the
standard email/Matrix-homeserver trust model and is **safe and bounded** if the
peer set is explicitly configured (allowlist), not open-federation.

**What it touches:**
- New: server-key generation/storage + `GET /v1/federation/server-key`; a
  `federation_peers` config/table (`origin → pinned pubkey`, allowlisted).
- `federation/envelope.py`: a new **outer** server-assertion layer
  (`FederatedDeliveryRequest` gains a server signature + signing origin; verify
  it *before* the existing payload checks). The inner participant signature
  (`verify_did_key_signature`) becomes: verify against the **sender's
  self-custodial key as asserted by A and bound by A's server signature** —
  i.e. drop the registry `resolve_key` dependency (check 3) and replace it with
  "A's server vouches for this key."
- `federation.py`: replace `_verify_sender_current_key` (registry) and
  `_resolve_target_identity` (registry `resolve_address`) with server-assertion
  verification + a **token-native target resolution** (B resolves
  `domain/name` against its *own* local agent directory, not awid).
- Outbound (`messages.py`): trigger federation when the recipient address's
  domain maps to a configured remote peer origin (a peer table), not a
  registry-published `delivery_origin`. Sign the outer assertion with A's
  server key; carry the sender's self-custodial pubkey in the envelope.
- Addressing: define a token-native global address. Simplest:
  `<peer-origin-or-alias>/<local-alias>` where the domain side maps via the
  `federation_peers` allowlist to a concrete origin.

### Option B — Federation key directory (shared, read-only)

**Trust model:** stand up a **minimal shared directory** (could be the awid
registry stripped to *just* the federation-addressing rows, could be a new tiny
service) that maps `global-address → {current signing did:key, delivery
origin}`. Local auth stays token; the directory is consulted **only** for
cross-server addressing/keys. This is essentially keeping check 3 + check 4 but
pointing them at a token-populated directory instead of the cert-era one.

**Security tradeoffs:** reintroduces a **shared trust root** (the directory) —
the very thing the pivot removed to make aweb standalone. B trusts the directory,
not A. Better non-repudiation than A.3, and it federates to >2 servers cleanly.
But it's operationally heavier (a always-on shared service the pivot
deliberately made optional — see `api.py:118`
`_validate_awid_registry_client`'s "does not require awid at runtime" comment),
and it needs a **token-aware publish path** (how does a token participant get a
row in the directory without the removed `aw id namespace` commands? → a new
server-side "publish my federation address" flow gated by the local JWT).

**What it touches:** less envelope surgery than A (the existing registry-shaped
checks stay), but a **new publish flow** + a directory service contract + making
awid (or its replacement) a hard runtime dependency again for federated teams.
Larger product/ops footprint than A.

### Option C — Keep awid global-address registry for federation addressing ONLY

**Trust model:** narrowest version of B. Local auth is token. For federation,
re-expose a **single** server-side capability: "register this local
JWT-authenticated participant's global federation address + publish their
self-custodial signing key + my delivery origin to awid." Everything else
(local mail/chat/tasks) never touches awid. B's existing checks 3 + 4 work
unchanged because the registry rows exist again — just provisioned by a
token-gated server endpoint instead of the removed CLI cluster.

**Security tradeoffs:** smallest *code* delta on the verification side (the
inbound path is already written for this exact shape). But it **re-establishes
awid as a runtime dependency** for any federated team and requires the awid
service to accept a **new token-authenticated provisioning call** — which means
awid has to trust the *sending aweb server's* assertion that "this JWT subject is
my member and may claim address X." That trust edge (aweb→awid) is the same
server-vouching problem as Option A, just relocated into the registry. So C ≈ B
with the directory fixed to awid, and inherits B's "shared always-on root"
downside.

### Comparison

| | Trust unit | Shared always-on service? | Non-repudiation | Scales past 2 peers | New trust primitive needed | Code blast radius |
|---|---|---|---|---|---|---|
| **A.2 (server key + allowlist)** | Server (pinned) | No (peer config) | Yes (asymmetric) | Yes (add peers) | Server key + peer pinning | Medium (new outer envelope layer) |
| A.1 (mTLS) | Server (TLS) | No | Transport-only | Yes | Cert distribution/ops | Medium + ops |
| A.3 (HMAC) | Server (symmetric) | No | **No** | Poorly | Shared secret | Small but **unsafe** |
| B (key directory) | Directory | **Yes** | Yes | Yes | Token-aware publish flow | Medium + new service |
| C (awid for fed only) | awid registry | **Yes** | Yes | Yes | Token-gated awid provisioning | Small inbound, new awid endpoint |

---

## 3. Recommendation + minimal implementation plan

**Recommend Option A.2 (server signing key + explicit peer allowlist).** It is
the only option that (a) keeps aweb **standalone** — no reintroduced always-on
shared root, honoring the pivot's central design win — (b) gives **asymmetric
non-repudiation** (unlike A.3's HMAC), (c) matches the trust model aweb *already
adopted internally* in commit `a07fd564` (server is the trust anchor; the
self-custodial key is authoritative and server-published), just extended across
an explicitly-configured peer edge, and (d) reuses the existing, sound inner
envelope/signature machinery — we wrap it, we don't rewrite it.

It is explicitly **closed federation** (configured peer allowlist), not open
federation. That is the right security posture for a v2 first cut: every trust
edge is an operator decision, there is no discovery, and a compromised/ hostile
server can only forge **its own** members, never a third peer's.

### Minimal implementation plan (v2 epic — NOT this pass)

1. **Server identity key.** Generate a long-lived Ed25519 server key at first
   boot; store it; expose the pubkey at `GET /v1/federation/server-key`
   (unauthenticated read, like a JWKS). Origin-bound.
2. **Peer allowlist.** `federation_peers` (config or table):
   `{origin, pinned_server_pubkey, addressing_domain}`. No peer in the list ⇒
   no federation to/from it. Mutual: A lists B, B lists A.
3. **Token-native global address.** Define `addressing_domain/<local-alias>`
   where `addressing_domain` resolves via the peer allowlist to exactly one
   origin. B resolves the local side against its **own** agent directory
   (`get_agent_by_namespace_alias`), never awid.
4. **Outer server assertion.** Extend `FederatedDeliveryRequest` with
   `server_origin` + `server_signature` over a canonical
   `{envelope_hash, sender_self_custodial_did_key, sender_alias, target_address,
   timestamp, nonce}`. A signs with its server key; carries the sender's real
   self-custodial `did:key:z...` (from `agent_encryption_keys.identity_did`).
5. **Inbound rewrite (federation.py).** Replace `_verify_sender_current_key`
   (registry) with: verify `server_signature` against the pinned pubkey for
   `server_origin`; assert `server_origin` is allowlisted and matches
   `sender_delivery_origin`. Then the existing
   `verify_did_key_signature(sender_current_did_key=<asserted self-custodial
   key>)` proves the *participant* signed the payload, and A's server signature
   proves A *vouches* for that key↔member binding. Replace
   `_resolve_target_identity` (registry `resolve_address`) with local directory
   resolution.
6. **Outbound rewrite (messages.py).** Trigger the federated branch when the
   recipient address's `addressing_domain` is a configured peer (not a
   registry `delivery_origin`). Build + server-sign the outer assertion.
7. **Replay/idempotency unchanged.** `federated_message_deliveries` claim
   (federation.py:301) and the idempotency checks are auth-agnostic and stay.
8. **Make the inner signing real.** Token humans must sign the federated payload
   with their **self-custodial** key (not the synthetic `did:key:jwt-`). The CLI
   already holds this key (E2E signing key from `a07fd564`); the federated
   `from_did`/`signed_payload` must use it. (Today's outbound code at
   messages.py:766 would put the synthetic key in `sender_did_aw` — the v2 work
   must thread the real key through as `sender_current_did_key` and keep the
   synthetic only as an opaque routing label, or drop it from the signed
   surface entirely.)

### 2-server local test harness it would need

A real federation-token-only build is only validated by **two full stacks**:

- **Two independent aweb servers**, each with its **own** Better Auth JWT issuer
  + JWKS (per-server, by design) + Postgres + Redis. The existing
  `e2e-oss-user-journey.sh` already stands up one such stack hermetically
  (compose project, internal-only DB/Redis, UI issuer minting JWTs) — the
  harness is **two of those** on disjoint ports, cross-configured as federation
  peers (A's allowlist pins B's server pubkey and vice versa).
- **Provisioning per side:** sign-up + membership seed + mint JWT (reuse the
  journey's headless Better-Auth bootstrap), `aw init` cert-less on each, and
  each side publishes its self-custodial signing key (already happens at
  `aw init`).
- **The assertion:** A's member sends `mail`/`chat` to
  `B-domain/<B-member-alias>`; B's `/v1/federation/messages` verifies the
  **server** signature against the pinned key, then the **participant**
  signature against the asserted self-custodial key, then delivers; B's member
  reads it. Negative tests that MUST stay red: (i) un-allowlisted origin → 4xx;
  (ii) valid envelope but server signature from a non-pinned key → 4xx;
  (iii) tampered inner payload (participant signature breaks) → 422;
  (iv) replay of a delivered message_id → idempotent no-op.
- Unit-level, `server/tests/test_federation_envelope.py` would gain
  outer-assertion vectors mirroring the existing inner-signature vectors.

Until that two-stack harness exists and runs green with the negative tests red,
federation-token-only is **not** validated — which is precisely why a partial
implementation now would be a security liability, not progress.

---

## 4. Honest verdict — is any bounded, safe piece landable now?

**No — and nothing was implemented.** Every candidate "small piece" turns out to
be load-bearing for the trust model:

- **Making `verify_did_key_signature` accept synthetic `did:key:jwt-` keys** —
  would be a *catastrophic* security hole: those keys never sign anything and
  carry no private key, so accepting them means accepting unsigned messages.
  Correctly **not** done.
- **Populating a `delivery_origin` for token agents to "re-enable" the outbound
  branch** — would route mail to an origin with no server-to-server trust edge
  and no way for B to verify the sender. Half a trust mechanism. **Not** done.
- **Adding the outer server-assertion envelope field as a "harmless additive
  helper"** — a server-signature field that nothing generates and nothing
  verifies is dead weight at best and, if partially wired, an unverified trust
  surface at worst. The only safe version is the *complete* Option A.2, which is
  the v2 epic. **Not** done.
- **A standalone "publish my federation address" endpoint (Option C seed)** —
  re-introduces awid as a runtime dependency and needs the aweb→awid vouching
  edge to be safe; that edge is itself the unbuilt primitive. **Not** done.

There is **no clear bug** in the existing federation code: the inbound
verification (`verify_federation_envelope`,
`_enforce_signed_payload_binding`, `_verify_sender_current_key`,
`_resolve_target_identity`) is internally consistent and correctly **fails
closed** for token-only senders (synthetic key → 422; no did:aw → no registry
match → 422/404). The code isn't broken; the *provisioning + cross-server trust
root it depends on* was removed. Restoring that is, by definition, the v2
re-architecture described in §3 — not a quiet additive change.

**Therefore the correct outcome of this task is a precise design and an honest
"implement nothing," which is what this is.** No server code was touched; the
suite stays at **629**. The federation tests
(`server/tests/test_federation_envelope.py`, 14 cases) and the rest of the
inbound path remain exactly as they are — still correct for the cert/DID model
they were written for, and still the salvageable core of any v2 build.

### One-line summary for the epic tracker

> Federation = v2 re-architecture. Adopt **Option A.2** (per-server Ed25519
> signing key + explicit peer allowlist + server-vouched delivery assertion
> wrapping the existing participant-signed envelope), reusing the
> `a07fd564` server-anchored-trust model across a configured peer edge. Needs a
> two-full-stack harness with the four negative tests red before it is real. No
> bounded piece is safe to land standalone.

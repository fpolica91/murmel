# Multi-device chat/mail trust — server-anchored key trust

## Problem

The product is now TOKEN-ONLY + CUSTODIAL. The aweb server authenticates every
identity by Better Auth JWT and stores each participant's published
self-custodial key (`custody=self`), selecting the most-recent published key as
the active one (`server/src/aweb/routes/agents.py` GET `/v1/agents` lateral join
`ORDER BY assertion_created_at DESC`). **The server is the trust anchor.**

The CLI chat/mail verifier, however, still did TOFU (trust-on-first-use) pinning
in `~/.config/aw/known_agents.yaml`. When the same identity onboarded on a
**different machine** (no shared `~/.config/aw`), it minted/published a new
self-custodial signing key. The server's active key updated correctly, but a
recipient who had TOFU-pinned the OLD key reported `[IDENTITY MISMATCH]` — a
false positive. The TOFU pin was a vestige of the removed cert/DID
peer-to-peer trust model and conflicted with the server-anchored custodial
model.

## Fix (server-anchored key trust)

The local pin store is now a **cache that follows the server**, not a hard trust
gate that rejects legitimate rotations.

For token/custodial self-custodial senders (no `did:aw` stable identity), the
verifier resolves the sender's **current server-published active key** from the
roster (GET `/v1/agents`) and treats it as authoritative:

- A message whose signature is valid AND whose `from_did` equals the sender's
  current server-published key = **VERIFIED**, even if it differs from a
  previously-pinned key (a legitimate rotation / new device). The pin is updated
  to follow the server.
- A message whose signature does NOT validate under `from_did` never reaches
  `Verified` (the cryptographic signature gate in `DecryptE2EEEnvelope` /
  `VerifyMessage` rejects it first) — forgeries stay `[unverified]`/invalid.
- A message whose `from_did` is a key the server has **not** published yields no
  roster confirmation, so the existing mismatch handling still returns
  `IdentityMismatch`. Mismatches are not blanket-passed.

Scope: only the token/custodial path (synthetic `did:key:jwt-<sub>` roster
entries with `custody=self` published keys, `from_stable_id == ""`). The
cert/DID `did:aw` rotation-announcement path is untouched (the cert cluster was
removed, so this is effectively all token identities now).

### Files

- `cli/go/awid/agents.go` — new `rosterPublishedKey()` resolves a sender's
  current server-published active signing key from GET `/v1/agents`. For token
  humans the roster `did_key` is a synthetic placeholder, so the real
  self-custodial key is the published assertion's `identity_did`
  (`encryptionVerificationDID()`). Per-sender cached on the client.
- `cli/go/awid/client.go` —
  - `NormalizeSenderTrust` computes `rosterConfirmedCurrentKey` (only for
    already-`Verified` token/custodial senders with no `did:aw`) and threads it
    into the TOFU check.
  - `checkTOFUPinWithMeta` gains a `rosterConfirmedCurrentKey` parameter; in the
    `PinMismatch` case for `from_stable_id == ""`, a server-confirmed key
    replaces the stale pin and returns `Verified` instead of `IdentityMismatch`.
- `cli/go/awid/client_test.go`, `cli/go/awid/trust_conformance_test.go` —
  tests + conformance-vector field for the new parameter.

## Security tradeoff

Server-anchored trust **assumes the aweb server is trusted to report the correct
active key**. This is consistent with the custodial model: the server already
mediates authentication (Better Auth JWT) and message routing, and it is the
source of truth for each identity's published key. The client no longer
independently proves key continuity for token identities — it defers to the
server's published key.

What is preserved: the cryptographic signature check is unchanged. A message is
only ever considered for "server-confirmed rotation" *after* its signature has
already verified against `from_did`. A key the server has not published is never
accepted. So a compromised/malicious server could at most cause the client to
*accept* a key the server vouches for (already implied by the custodial model);
it cannot cause the client to accept a message that fails its own signature
check.

## Live cross-machine validation (localhost aweb :8088, auth :3030)

Simulated two machines with separate `HOME`s (no shared pin/identity cache),
non-blocking chat only (`send-and-leave`):

- **Machine A** (`HOME=/tmp/mA`): onboarded ada + founder, published keys.
  founder (key-A `z6Mkw2dD…ykrD`) sent a chat to "Ada (agent)". Ada read
  history → message **VERIFIED**, pin recorded founder key-A.
- **Machine B** (`HOME=/tmp/mB`, fresh): founder re-onboarded → fresh key-B
  (`z6MkqQWu…jduX`), published (server active key updated to key-B). founder
  sent a NEW chat to Ada.
- **Recipient (ada, Machine A)** re-read history → the machine-B message showed
  **VERIFIED** (not `[IDENTITY MISMATCH]`); ada's pin followed the server and
  updated to key-B.
- **Control** (verifier probe against the live roster): a message signed with
  the current server-published key → `verified`; a message claiming Founder but
  signed with a key the server has NOT published → `identity_mismatch`.
  Verification is not disabled.

Also observed: the server itself rejects a send whose `from_did` is not the
sender's current published key (`422 from_did must match the authenticated
sender`), so a stale-key message can only reach a recipient via genuine forgery
— which the client signature gate + roster confirmation catch.

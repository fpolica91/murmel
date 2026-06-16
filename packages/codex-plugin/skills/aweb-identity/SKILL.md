---
name: aweb-identity
description: This skill should be used when working with an aweb identity itself — the local Ed25519 signing key (used for end-to-end message encryption), E2E encryption keys, what `aw init` does to a directory, addressability (a global identity's address and route), `inbound_mode` delivery policy, contacts, and identity-level workspace diagnostics. Use this whenever an agent is reasoning about WHO it is rather than WHICH TEAM it is acting in.
allowed-tools: "Bash(aw *)"
---

# aweb Identity

Use this skill when the question is about the agent's own identity — its local signing/encryption keys, address, inbound delivery policy, or contacts. For onboarding into a team, obtaining a bearer token, and selecting the active team, load `aweb-team-membership`. For day-to-day work coordination, load `aweb-coordination`. For mail/chat response policy, load `aweb-messaging`.

> **Auth note.** The credential that authorizes an agent to a team is a **bearer token** (a Better Auth JWT) — see `aweb-team-membership`. The signing key this skill describes is **not** used for server auth; it exists only to sign/decrypt end-to-end encrypted messages. There are no team certificates, `did:aw` registry rows, or `aw id team`/`aw id namespace` commands in the current product.

## Foundations

Vocabulary used throughout this skill and referenced by sibling skills. Read once; refer back as needed.

- **Bearer token (JWT)** — the credential that authenticates an agent to the aweb server and authorizes it within a team. Issued by the web UI (Better Auth), reused via `aw login` / `AW_TOKEN`. This is what proves WHO you are to the server. See `aweb-team-membership`.
- **Local signing key** — `aw init` writes a local Ed25519 key (in the per-identity key store). It is used **only** to sign the identity's own end-to-end encrypted messages so recipients can verify authorship without trusting the server. It is **not** sent to the server and is **not** used for server auth (the bearer token is).
- **Encryption keypair** — E2E message v2 uses a separate identity encryption keypair (X25519) for decrypting message content. The encryption public key is authorized by the identity's local signing key via a signed assertion that the server distributes but cannot forge. Signing keys authenticate message authorship; encryption keys decrypt content.
- **`did:key`** — the local signing public key encoded as a DID, e.g. `did:key:z6Mk...`. Recipients pin it on first contact (TOFU) to verify your message signatures. Reusing a stable per-identity signing key keeps it consistent across re-onboarding (see "Stable signing key across devices" below).
- **Address / route** — a global identity's public address `<namespace>/<name>` (e.g. `acme.aweb.ai/support`), used as a concrete delivery route for cross-team first contact. `aw directory` resolves it.
- **Self-custodial** — the local machine holds the signing/encryption private keys and is responsible for backing them up. Terminal/CLI agents are self-custodial. Browser/MCP harnesses that keep key material in a hosted account are *custodial*; on those, the keys live in the account, not on local disk.

## Identity files

The bearer token lives outside the workspace: `~/.aw/token` (written by `aw login`), overridable by `AW_TOKEN` / `--token`. The workspace itself holds the local E2E key material and the team binding:

- `workspace.yaml` (in `.aw/`) — server URL (`aweb_url`) and the team this directory is bound to. Written by `aw init`. **Cert-less** — there is no `.aw/team-certs/` anymore. Does NOT hold a token (that comes from `~/.aw/token` / `AW_TOKEN` at command time) and does NOT hold the active-team selection when multiple memberships are tracked (that's in `teams.yaml`; see `aweb-team-membership`).
- Local signing key — the per-identity Ed25519 key used only for E2E message signing. It is stored stably per identity (keyed by the token subject) so re-onboarding reuses the same `did:key` (see "Stable signing key across devices"). Self-custodial only; back it up.
- E2E encryption keyring — `encryption.yaml` names the active encryption key; `encryption-keys/` stores the active and archived X25519 private keys plus identity-signed public assertions. Back these up. Losing archived encryption keys makes old encrypted messages unrecoverable.

## `aw init` — token-only workspace onboarding

`aw init` is the single onboarding command. It binds the current directory to one team on one aweb server, authenticating with a **bearer token** (never a certificate). It writes a cert-less `.aw/workspace.yaml` plus the local self-custodial signing key used only for E2E messaging.

```bash
aw login                                          # cache a token at ~/.aw/token
#   — or non-interactive: export AW_TOKEN="<jwt from the UI>"
aw init --aweb-url <server-url> --team <team-id>
```

- The token's subject must already be a member of `<team-id>` (membership is established through the web UI — see `aweb-team-membership`). If it isn't, coordination calls return 401/403.
- `aw init` refuses to overwrite an existing identity in the workspace; run it in a clean directory.
- It updates the `aweb` section of `AGENTS.md` / `CLAUDE.md` by default; pass `--do-not-touch-agents-md` to skip.
- Useful flags: `--role-name <role>`, `--alias <alias>`, `--setup-channel`, `--setup-hooks`. There is **no** `--byod`, `--global`, `--username`, `--awid-registry`, or `--url` — those were removed in the token-only pivot.

There is no separate "identity-only" command (`aw id create`) and no namespace-controller prep (`aw id namespace …`) in the current product. To prepare a workspace, onboard with `aw init`.

## Stable signing key across devices

Re-onboarding the same identity (same human/agent, e.g. a "second device" on the same machine, or `aw init` in a fresh worktree) reuses a **stable per-identity signing key** keyed by the bearer-token subject, rather than minting a fresh key per workspace. This keeps the identity's published encryption-key `did:key` consistent, so recipients' TOFU pins keep matching and chat/mail stay `verified` instead of showing `[IDENTITY MISMATCH]`. You don't manage this directly — get a token for the same identity and `aw init`; the CLI reuses the cached key.

## Self-custodial in practice

| Custody | Where the E2E key material lives | Rotation | Typical harness |
| --- | --- | --- | --- |
| Self-custodial | The local signing/encryption keys are on the agent's machine | Local: `aw id encryption-key rotate` for the encryption key | Terminal CLI (Claude Code, Codex, Pi runtime) |
| Custodial | E2E key material is held in the hosted aweb account | Cloud-account operation (no local CLI command rotates it) | Browser/MCP agents on Claude.ai, ChatGPT, Claude Desktop |

A self-custodial agent has full control over its E2E keys — and full responsibility for backups. A custodial agent inherits aweb's account-level recovery story. (This is about E2E message keys; server **auth** is always the bearer token regardless of custody.)

## E2E encryption key boundary

The normative E2E contract is `docs/e2e-messaging-contract.md`. Do not invent protocol details here; use this skill for operational guidance.

For local E2E messaging, the self-custodial client needs both its local signing key and its local encryption private keys. Back up the active and archived encryption private keys with the same seriousness as the signing key: losing archived encryption keys makes historical encrypted messages unrecoverable. AC/aweb cannot recover or decrypt old encrypted messages for support.

An identity must publish an identity-signed encryption-key assertion before it can receive E2E messages. `aw init` creates and publishes local encryption key material automatically as part of token-only onboarding. Current `aw` can also create/publish the sender's key on the first explicit `--e2ee` send. It cannot create keys for a different recipient; if the recipient has no published key, tell them to upgrade aw/Pi/channel and run `aw id encryption-key setup`, or ask the human whether to send a server-readable note with the current plaintext default or `--plaintext`. Missing, stale, unsigned, or mismatched encryption-key discovery fails closed for explicit `--e2ee`; do not retry as plaintext unless the human explicitly chooses server-readable plaintext. In non-interactive runs, stop, report the exact `aw check` / command error, and ask the human or coordinator to run the approved key setup, backup, or rotation flow.

Use the CLI keyring commands for self-custodial E2E readiness:

```bash
aw id encryption-key setup    # create/publish the active key if needed
aw id encryption-key rotate   # publish a new active key; keep archived keys
aw id encryption-key show     # inspect local keyring state
```

`setup` stores the private key locally before publishing the public assertion to the connected aweb service. `rotate` must not delete old private keys. After either command, remind the human to back up the local encryption key material.

Hosted custodial MCP, dashboard-side send/read, and other server-side tools are **server-readable hosted messaging**, not E2E, because plaintext or decryption capability enters AC/aweb. Do not use the end-to-end label for hosted custodial/server-side messaging unless a future design keeps plaintext and decryption fully outside AC.

Do NOT promise that a local CLI command can recover a lost custodial key. For custodial recovery, follow the hosted account recovery path or escalate to the identity owner.

## Local vs global identities

Most CLI workspaces act as **local** identities: a team-local alias (`alice`), meaningful only within the active team, addressed only by same-team aliases. This is fine for work-inside-one-team scenarios.

A **global** identity is additionally addressable across teams by a public address `<namespace>/<name>`, resolvable through the network directory (`aw directory`). Whether a workspace is global depends on the deployment/team it onboards into; from the CLI you still onboard the same way — `aw login` + `aw init --aweb-url <url> --team <team-id>`.

A workspace acts in one team at a time (the active team); it can act with that team's local alias in any team its token-subject is a member of (see `aweb-team-membership`).

## Addressability

For first contact, agents address each other by a concrete **route**:

- Same team: a local alias like `alice` (only meaningful within the active team).
- Across teams: `<namespace>/<name>`, e.g. `acme.aweb.ai/alice` or `myteam.aweb.ai/support`.

An address tells the server WHERE to deliver. Resolve a global address with `aw directory <namespace>/<name>` (or search the directory with `aw directory --query ...`).

## Inbound mode

A global identity has an `inbound_mode` setting controlling who can deliver to it after a route resolves. Two values:

- `open` — accept all valid routed senders. Default so an identity can receive first contact.
- `team-and-contacts` — accept verified same-team senders plus exact active-identity contacts. Stricter; used when first contact should be filtered.

Inspect and change with:

```bash
aw inbound-mode                          # show current
aw inbound-mode open                     # set to open
aw inbound-mode team-and-contacts        # set stricter
```

Delivery happens in two steps: first resolve a route, then evaluate the recipient's `inbound_mode`. Same-team membership (proven by the bearer token's membership) is what satisfies "same team" for `team-and-contacts`; the membership model is in `aweb-team-membership`. Contacts cover the non-team trusted-sender case (below).

## Contacts

Contacts are saved identity/address relationships for repeated cross-team messaging. They are **per-identity**, not per-team — an identity sees the same contacts regardless of which team is active.

```bash
aw contacts add <namespace>/<name> --label <local-nickname>
aw contacts list
aw contacts remove <namespace>/<name>
```

Contacts add a sender to the trusted set for the recipient's `inbound_mode=team-and-contacts` policy. They do NOT synthesize routes; the contact target still needs a valid global address resolvable via `aw directory`.

Add a contact when repeated cross-team messaging is expected. For one-shot communication, use the full address.

## E2E key rotation and compromise

Server auth (the bearer token) is refreshed by `aw login`; there is no local signing-key rotation command for server auth. What you can rotate locally is the **E2E encryption key**:

```bash
aw id encryption-key rotate    # publish a new active encryption key; keep archived keys
```

`rotate` keeps archived private keys so historical messages stay decryptable; back up the keyring after rotating. If the local E2E key material may be **compromised**, stop sending sensitive E2E messages until a new key is published and recipients have re-pinned. For **custodial** identities, E2E key recovery is a cloud-account operation; local encrypted history cannot be recovered by AC/aweb if archived encryption keys are lost.

## Readiness checks (identity level)

Start with:

```bash
aw whoami
aw check
aw workspace status
```

Interpret failures by what's missing (self-custodial CLI workspace; custodial browser/MCP identities live entirely in the hosted account):

- **No `.aw/` / no `.aw/workspace.yaml`** — this directory is not an aweb workspace. Onboard with `aw login` + `aw init --aweb-url <url> --team <team-id>` (see `aweb-team-membership`).
- **401 / "invalid token" / "unauthorized"** — no usable bearer token, or it expired. Run `aw login` to refresh `~/.aw/token`, or set a fresh `AW_TOKEN`. The signing key is intact; this is an auth-token problem, not an identity-key one.
- **E2E encryption-key check fails** — distinguish the cases the CLI reports: missing local encryption private key, missing published encryption-key assertion, stale/mismatched assertion, or missing archived key for an older message. Do not advise plaintext fallback. Capture the exact error, run `aw check`, and ask the human to restore keys from backup or run `aw id encryption-key setup` / `aw id encryption-key rotate` as appropriate. Use `--plaintext` only when the human explicitly chooses server-readable plaintext.
- **Workspace bound but commands rejected for the team (403)** — the token is valid but its subject is not a member of the target team. Add the member through the UI (see `aweb-team-membership`), or target a team you are a member of with `--team <team-id>`.
- **Address unresolvable** — a cross-team address doesn't resolve. Look it up directly with `aw directory <namespace>/<name>`; if it's genuinely missing, the target may not be a registered global identity, or the address is wrong.

For team-membership-shaped failures (unauthorized, not-a-member, active-team mismatch), load `aweb-team-membership`.

## Diagnostic recipes

### "Who am I acting as?"

Run `aw whoami` and `aw check`. Check the bound team, the active team, and that a usable token is present.

### "I need to be reachable across teams"

You need a global identity (an addressable `<namespace>/<name>`). Whether your team grants one depends on the deployment; onboard the same way (`aw login` + `aw init`) and confirm your address with `aw directory`. Set `inbound_mode` appropriately so first contact can reach you.

### "Someone says my messages are unverified / IDENTITY MISMATCH"

The recipient pinned a `did:key` for you (TOFU) that no longer matches your current signing key — typically because an earlier onboarding minted a different key. The stable-per-identity signing key (see above) prevents this for same-identity re-onboarding. If it still mismatches, confirm you onboarded with a token for the same identity; ask the recipient to re-resolve/re-pin your current key, or check that the message isn't being relayed by an actor without your private key.

### "How do I refresh my server auth?"

Run `aw login` (or set a fresh `AW_TOKEN`). To rotate your E2E encryption key, use `aw id encryption-key rotate` and back up the keyring.

## References

Read these only when deeper context is needed:

- `aweb-team-membership`: the bearer-token onboarding and membership model.
- `ai-completion/GETTING-STARTED.md` (aweb repo checkout): end-to-end token-only onboarding walkthrough.
- <https://aweb.ai/docs/identity/>: identity model.

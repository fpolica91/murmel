# Token-only pivot — dangling-reference follow-ups

_Branch: `feature/simple-auth-ui` (== main at time of writing). Companion to
[STATUS.md](STATUS.md)._

The token-only pivot made Better Auth JWT the sole aweb auth and **removed the
cert/DID/bootstrap CLI cluster**:

- `aw init` lost `--byod`, `--awid-registry`, `--username`, `--global`, `--url`.
  It is now token-only: `aw init --aweb-url <url> --team <team>` with
  `aw login` / `AW_TOKEN` / `--token` for the bearer JWT.
- `aw id` now has only the `encryption-key` subcommand. **Removed:**
  `aw id team {create,request,add-member,fetch-cert,accept-invite,remove-member,delete,register,switch,import-request,cleanup-cloud}`,
  `aw id namespace {prepare-controller,check-txt,assign-address,resolve,...}`,
  `aw id {create,resolve,addresses,rotate-key,show}`.
- **Removed entirely:** `aw team`, `aw agents` (bootstrap/provision/add/...),
  `aw service`, `aw identities`, `aw workspace connect`.

This file lists every place still referencing that removed surface, split into
**fixed in this pass** and **deferred (needs real work — do NOT half-fix)**.

---

## Fixed in this pass (safe + clear)

| File | What was wrong | Fix |
|---|---|---|
| `README.md` | "Create/join team" + "Add another agent" sections used `aw init --username`, `aw team invite/join`, `aw workspace connect`, `aw id team request/add-member/fetch-cert`, `aw init --awid-registry`, `.aw/team-certs/` as the auth credential, "Team-certificate authentication" | Rewrote to token-only: `aw login` / `AW_TOKEN` + `aw init --aweb-url --team`; auth credential is now the Better Auth JWT |
| `cli/go/README.md` | Quick Start + "Joining from another machine" + Concepts (auth) + config-file table + CLI Reference identity block + Network Directory + Registry reads + Go-library note all described the cert/DID/team/namespace surface | Rewrote to token-only flow; trimmed removed commands from the CLI reference; updated config table to `~/.aw/token` + signing-key-for-E2E-only |
| `server/README.md` | "Bootstrap Flow" used `aw init --url`, `aw id team accept-invite`, `aw id create`, `aw id team create/invite`, "awid-backed team certificates" | Rewrote to `aw login` / `AW_TOKEN` + `aw init --aweb-url --team` |
| `AGENTS.md` | Repo-architecture blurb said server "Authentication is by **team certificate**" and `.aw/team-certs/` "holds the credential" | Updated to bearer-token (Better Auth JWT); noted residual federation/back-compat header handling |
| `docs/cli-command-reference.md` | 910 lines documenting removed `aw id team`/`aw id namespace`/`aw service`/`aw agents` commands | **Regenerated** from the live `aw` binary via `scripts/regenerate-cli-reference.sh`; `--check` now passes |

---

## Deferred — needs real work (documented, intentionally NOT half-fixed)

### 1. `channel/` and `channel-core/` token-auth path — ✅ DONE

**Status (2026-06-16):** Landed on `feature/simple-auth-ui`. The channel now
authenticates token-only workspaces with a bearer JWT.

- `channel-core/src/config.ts` + `channel/src/config.ts` `resolveConfig()` now
  detect mode: a cert-less binding (empty `cert_path` and no matching
  `.aw/team-certs/` entry) resolves to `authMode: "token"` and sources the JWT
  from `AW_TOKEN` then `~/.aw/token` (`access_token` field), mirroring the Go
  CLI's bearer precedence. The active team comes from `teams.yaml`
  `active_team` (unchanged), so no cert is needed to discover the team. The
  legacy cert path is preserved (`authMode: "cert"`); the "no cert AND no
  token" case still errors clearly.
- `channel-core/src/api/client.ts` + `channel/src/api/client.ts` send
  `Authorization: Bearer <jwt>` + `X-AWEB-Team-Id: <team>` on every route in
  token mode (mail/chat/events), skipping the DIDKey/`X-AWID-Team-Certificate`
  signing. `createChannelClient` threads `bearerToken` through; `index.ts`
  exports `AuthMode` + `resolveBearerToken`.
- Tests: `channel/test/config.test.ts` gains token-mode detection + bearer
  sourcing tests; `channel/test/client.test.ts` gains bearer header
  construction tests (Bearer + team header, no DIDKey/timestamp/cert headers).
  Cert back-compat tests retained. `npm test` = **110 passing** (was 105).
- Server already accepts the bearer path on these routes: `/v1/events/stream`
  via `get_team_identity` (bearer-only) and `/v1/messages/*` + `/v1/chat/*`
  via `get_messaging_auth` (token path when no cert header).
- **Live proof:** against aweb :8088 with a token-only workspace created by
  `AW_TOKEN=$JWT aw init --aweb-url http://localhost:8088 --team default:local`,
  channel-core's client fetched `GET /v1/messages/inbox` → **2xx** from both
  `AW_TOKEN` and `~/.aw/token` sources; a bogus token → 401 (bearer is really
  verified). **Residual:** a full event-delivery-into-a-live-Claude-session
  wake demo was not run headlessly — it would additionally exercise the SSE
  `/v1/events/stream` consumer + MCP notification path end-to-end, but the auth
  (the regression) and an authenticated aweb API call are proven.

---

#### Original report (kept for context)

The channel product authenticated ONLY by
team certificate:

- `channel/src/config.ts` / `channel-core/src/config.ts`:
  `loadActiveTeamCertificate()` hard-requires `.aw/team-certs/` and throws
  `No .aw/team-certs directory found ... Run aw workspace migrate-multi-team ...`
  when the dir is absent.
- `channel/src/api/client.ts` sends `Authorization: DIDKey <did> <sig>` plus the
  `X-AWID-Team-Certificate` header — never a `Bearer` token.

After the pivot, `aw init` writes a **cert-less** `.aw/workspace.yaml` (no
`.aw/team-certs/`). So the channel **cannot onboard a token-only workspace** —
it errors on startup. It still works against a *legacy* workspace that already
has a cert on disk (the aweb server retained the DIDKey + `X-AWID-Team-Certificate`
back-compat path in `server/src/aweb/identity_auth_deps.py` and
`token_team_scope.py` for the messaging-identity route), but no current
onboarding flow produces such a workspace.

**Why deferred:** this is a feature, not a doc fix. It needs (a) the channel to
read `~/.aw/token` / `AW_TOKEN` and send `Authorization: Bearer <jwt>` +
`X-AWEB-Team-Id`, (b) a decision on how the channel discovers the active team
without a cert, (c) new channel tests, and (d) confirmation the server's
event/notification routes the channel hits accept the token path. `npm test`
(105) passes today because the suite tests the *existing* cert code in
isolation; it does not cover token onboarding.

**Note:** `channel/test/config.test.ts` exercises the cert path on purpose —
leave it until the token path lands, then add token coverage alongside (don't
delete the back-compat tests while the server still honors the cert header).

### 2. The three e2e scripts were built on the removed cert/team CLI — ✅ user-journey + federation (A.2) + A2A-gateway ALL REWRITTEN + RUN GREEN

**Status (2026-06-16):** Reconciled on `feature/simple-auth-ui`.

#### `scripts/e2e-oss-user-journey.sh` — rewritten to token-only, RAN GREEN

The 3110-line cert/DID/team/namespace/bootstrap journey was replaced with a
focused, hermetic **token-only** journey that actually exercises the pivoted
product:

- **Ports / isolation:** starts the FULL stack (UI Better-Auth issuer + aweb +
  awid + Postgres + Redis) under a distinct compose project (`aweb-oss-e2e-$$`)
  via the committed `docker-compose.yml` + `docker-compose.ui.yml` + a generated
  parameterizing overlay. Host ports are safe and non-forbidden: UI `3035`,
  aweb `8090`, awid `8011`. Postgres/Redis are **internal-only** (seeded via
  `docker compose exec`), so the run never binds 5432/6379 and never collides
  with the dev stack on 5544/6390/5433. The overlay sets iss (`= UI host URL`),
  aud (`= aweb host URL`), and JWKS (`http://ui:3000/...`, internal) so JWTs
  minted through the published UI port verify against aweb.
- **Auth bootstrap (headless, mirrors `ui/e2e/global-setup.ts`):** for each
  identity it POSTs Better Auth `sign-up/email`, resolves the user id from
  `aweb."user"`, seeds an active `memberships` row, then signs in + GETs
  `/api/auth/token` to mint a bearer JWT. No browser.
- **Onboarding:** `AW_TOKEN=$JWT aw init --aweb-url … --team default:local`
  (cert-less). Asserts the workspace has **no** `.aw/team-certs/` and is bound
  to the team. A no-token `aw init` is asserted to fail closed.
- **Coordination over the bearer token:** `whoami`, a 401-on-bogus-token /
  200-on-valid-token check, `work ready`, `task create` + `task list`, and
  `mail send` → peer `mail inbox` (recipient addressed by its resolvable
  namespace address, see quirk below). Chat is a NON-FATAL probe.
- **RUN LEDGER (honest):** executed end-to-end against Docker on this machine
  on 2026-06-16 → **`ALL PASSED: 28 tests`**. The full stack built and came up
  on the safe ports, all health checks passed, JWTs minted, both identities
  onboarded cert-less, mail delivered + read over the token, and cleanup
  (`compose down -v`) left no lingering containers/volumes and did not disturb
  the dev stack.

**Two server-side token-path quirks surfaced (NOT auth/journey bugs; flagged
here, fixed nowhere — they need server work):**

1. **`mail/chat --to <bare-alias>` 404s on the token path.** `POST /v1/messages`
   with `to_alias` returns 404 "Recipient agent not found" even though the row
   exists (`to_agent_id` and `to_address` both deliver 200). The journey routes
   mail by the **namespace** address `"<team-namespace>/<alias>"` (e.g.
   `local/Ada (agent)`) instead. Note the related inconsistency: the
   `/v1/participants` directory advertises a *team-id*-scoped `address`
   (`default:local/<alias>`), but `_local_recipient_from_address` →
   `get_agent_by_namespace_alias` matches on the team **namespace** (`local`),
   so the advertised address does not resolve as-is. Worth a server fix
   (align the directory's advertised address with the resolver, and make the
   bare-alias token path resolve).
2. **CLI chat over the token path fails signing** with `422 signed_payload
   recipient must match the chat target` / `[unverified]` (consistent with the
   STATUS.md chat note). The journey reports it non-fatally.

#### `scripts/e2e-oss-federation.sh` — REWRITTEN to token-only (A.2) + RAN GREEN (2026-06-16, later pass)

Token-only federation (Option A.2) is now **implemented** (commit `7825fe3b`;
server suite 650; `server/tests/test_federation_assertion.py` 21 passing), so the
quarantined exit-1 stub was **replaced with a real two-stack journey** and
**un-quarantined**.

- **What it now does:** stands up TWO fully isolated aweb stacks (A + B, each =
  aweb + Better Auth UI issuer + Postgres + Redis) under distinct compose
  projects (`aweb-fed-e2e-a-$$` / `-b-$$`) on DISJOINT SAFE host ports (UI
  3036/3037, aweb 8091/8092; pg/redis internal-only) — never touching the dev
  stack (3030/8088/5544/6390) or the forbidden set. It cross-configures the two
  as federation peers via `AWEB_FEDERATION_PEERS` (each pins the OTHER's
  seed-derived server DID) + `AWEB_FEDERATION_SIGNING_SEED` (deterministic
  per-stack keys), and verifies each live `GET /v1/federation/server-key`
  advertises exactly the pinned DID. It token-onboards a human on each home
  server (Better Auth sign-up → membership → JWT → `AW_TOKEN aw init`, cert-less)
  to exercise the membership/token model, then drives the **real A.2 wire**:
  the inner participant-signed envelope + outer server-vouched delivery
  assertion are built by the **server's own modules** (`compose exec aweb python`
  → byte-identical canonical JSON / Ed25519, no reimplementation), and POSTed to
  the peer's `/v1/federation/messages`.
  - **HAPPY PATH:** A vouches + delivers a cross-server mail to B's
    self-custodial recipient → B returns 200 and stores it for the recipient;
    reverse B→A for mutuality. Both proven against the live receiver (the full
    inbound chain ran: allowlist → pinned-key outer sig → inner participant sig →
    local directory resolution → delivery).
  - **ATTACKS (each rejected by LIVE B):** un-allowlisted origin → **403**;
    outer sig from a non-pinned key → **403**; tampered inner payload → **422**;
    replayed `message_id` → idempotent **200**, then **409** on conflicting
    content (stored exactly once).
- **RUN LEDGER (honest):** executed end-to-end against Docker on this machine on
  2026-06-16 → **`ALL PASSED: 26 tests`** (`EXIT=0`). Both UI+aweb+awid+pg+redis
  stacks built and came up healthy on the safe ports, both server keys advertised
  the pinned DIDs, both JWTs minted, both onboarded cert-less, cross-server mail
  delivered + stored in BOTH directions, all four attacks rejected with the exact
  expected codes, and `compose down -v` on both projects left no lingering
  containers/volumes and did not disturb the dev stack. `shellcheck` clean.
- **Why the cross-stack delivery is driven by a direct federated POST (not
  `aw mail send`):** commit `7825fe3b` shipped the SERVER receive/send wire +
  config + 21 tests, but is **server-only** — it did NOT ship a CLI
  self-custodial federated-send path, and the outbound first-contact `external`
  trigger in `routes/messages.py` still gates on an awid `resolve_address`, which
  A.2 deliberately drops from the trust path (`_remote_delivery_origin`'s new
  peer-domain trigger is wired but only reachable once `recipient["external"]` is
  set, which without a registry happens only on conversation continuations). The
  faithful, registry-free way to drive a genuine cross-stack delivery is
  therefore to build the real signed `FederatedDeliveryRequest` with the server's
  own code and POST it to the peer — exactly the wire two cooperating aweb
  servers speak. This exercises the ENTIRE implemented A.2 receive mechanism on a
  live peer.
- **Residual (documented, not faked):** a CLI-originated first-contact federated
  `aw mail send --to-address domain/name` across stacks still needs (a) a
  CLI self-custodial federated-send slice and (b) a token-only outbound trigger
  that marks a peer-domain recipient `external` without awid. Until those land,
  CLI origination is not the e2e's delivery driver; the server-to-server wire
  (the load-bearing A.2 mechanism) is fully exercised live.

#### `scripts/e2e-a2a-gateway-docker.sh` — REWRITTEN to token-only, RAN GREEN (26/26)

The Go blocker was already resolved (token-only `tokenWorkspaceMailClient`, see
below); this pass finished the **bash/Docker** rewrite and ran it green.

- **DONE (Go, prior pass):** the OSS gateway's `workspaceMailClient` previously
  hard-required a team certificate, so it could not build a mail client from a
  cert-less token-only workspace at all. It now branches: when the resolved
  membership has no `cert_path`, it calls
  `cli/go/cmd/aweb-a2a-gw/token_auth.go:tokenWorkspaceMailClient`, which builds
  an `awid.Client` via `SetBearerProvider` (token from `AW_TOKEN` /
  `~/.aw/token`, auto-refreshed) + `SetTeamID`, sending
  `Authorization: Bearer <jwt>` + `X-AWEB-Team-Id`. The local self-custodial
  signing key is wired as the E2EE envelope-signing key so outgoing mail is
  signed from the gateway's real did:key. The legacy cert/DIDKey path is
  untouched (branch on mode).

- **DONE (bash/Docker, this pass):** the journey was rewritten from the removed
  onboarding cluster (`aw id create` / `aw id team` / `aw init --url`) to the
  token-only flow, mirroring `e2e-oss-user-journey.sh`. It stands up the full
  stack (UI issuer + aweb + awid + pg + redis) under a distinct compose project
  on disjoint safe ports (UI 3036 / aweb 8092 / awid 8012 / gateway 8095;
  Postgres/Redis internal), token-onboards a `gw` + a `responder` identity
  (cert-less `aw init --aweb-url --team`), then builds + runs the real
  `aweb-a2a-gw` against the gw token workspace with `AW_TOKEN` set. It asserts:
    - `aweb-a2a-gw -check` validates the config and the gateway process serves;
    - runtime `/health` is **200** — `awid_registry.reachable` + `.compatible`
      (awid 0.5.12 ≥ min 0.5.11) and the non-AC workspace identity reports
      `status:"workspace"`/`usable:true` (the token-only mode targets the
      workspace identity path, NOT an AC global `gateway_identity`);
    - the agent card (`/.well-known/agent-card.json`) and per-route card are
      **200**;
    - the SAME bearer credentials the gateway uses authenticate to aweb
      token-only: `GET /v1/participants` → **200**, bogus bearer → **401**;
    - a minimal A2A JSON-RPC `SendMessage` drives the gateway's real
      `MailBridge` client to a token-authenticated aweb call that reaches
      business logic **past bearer auth**. The script classifies the outcome:
      a working task (mail accepted) OR a post-auth recipient-resolution **404**
      ("Namespace not found" / "resolve recipient ... for signed mail") is a
      PASS (token transport authenticated; aweb processed the JWT and only then
      refused on the missing binding); a **401/cert** error is a hard fail.
  - **Result:** `ALL PASSED: 26 tests`, exit 0, on Docker.
  - **Documented non-fatal limit (full delivered round-trip):**
    `tokenWorkspaceMailClient` pins `SetRequireRecipientBindingForDirectAddresses
    (true)`, so the gateway's signed direct-address mail resolves the
    recipient's published key binding via the awid registry. A token-only e2e
    stack provisions **no awid namespace** for that direct address, so the send
    is refused post-auth (404). A fully *delivered* round-trip would need (1)
    that recipient binding provisioned and (2) a live responder agent posting an
    A2A reply envelope into the gateway's mail thread (ingested + surfaced via
    `GetTask`). Both are emitted as non-fatal INFO so the run stays honest about
    what token-auth A2A proves (gateway boot + card + /health + token-
    authenticated aweb call) vs. doesn't deliver headlessly today.

**Makefile:** `test-e2e` runs the green token-only user journey;
`test-federation-e2e` runs the green token-only **A.2** federation journey;
`test-a2a-gateway-e2e` is now **un-quarantined** (the script no longer exits 1)
and runs the green token-only A2A-gateway journey (also wired into
`release-a2a-gateway-check`). `make ship` runs the user + federation journeys;
the A2A-gateway journey runs in the per-product `release-a2a-gateway-check`
gate.

### 3. Resource-pack / codex-plugin skills duplicate the removed surface — ✅ DONE

**Status (2026-06-16):** Reconciled on `feature/simple-auth-ui`. The
`skills/` tree and its lockstep mirror under `packages/codex-plugin/skills/`
now teach token-only onboarding.

- `aweb-coordination` — replaced `aw id team switch` / `aw team join` /
  `aw workspace connect` references with `aw login` + `aw init --aweb-url --team`
  (token-only). Structure/purpose unchanged.
- `aweb-team-membership` (SKILL.md + `references/team-membership-reference.md`)
  — rewritten to the bearer-token model: get a token (`aw login` / `AW_TOKEN`),
  bind with `aw init --aweb-url --team`, select the active team across
  memberships, auth/membership diagnostics. The hosted/BYOT cert/controller
  cluster, accept-invite/fetch-cert, custody×authority matrix, and fresh-BYOT
  setup were removed; membership is granted via the web UI.
- `aweb-identity` — kept the genuinely-current content (local E2E
  signing/encryption keys, `aw id encryption-key {setup,rotate,show}`,
  addressability, inbound mode, contacts, `aw directory`) and removed the
  cert/`did:aw`-registry/`aw id create`/`aw id namespace`/`aw id rotate-key`
  surface. Added the stable-per-identity-signing-key section; clarified server
  auth is the bearer token and the signing key is E2E-only.
- `aweb-bootstrap` (SKILL.md + `references/bootstrap-scenarios.md`) — **RETIRED**
  (the `aw agents`/`aw service` layout-generator cluster has no token-only
  equivalent). Now a retirement notice pointing to token-only onboarding and the
  other skills. `skills/DECISIONS.md` and the codex `plugin.json`
  `longDescription` were updated to match.
- **Lockstep:** `skills/` and `packages/codex-plugin/skills/` verified identical
  (`diff -rq` clean) after the edits.
- **Validation:** built `/tmp/aw`; confirmed the current surface (`aw id` has
  only `encryption-key`; `aw team`/`aw agents`/`aw service` are gone; `aw init`
  is token-only). Ran the exact skill onboarding sequence live against aweb
  :8088 — minted a founder JWT from the UI (:3030), then
  `AW_TOKEN=$JWT aw init --aweb-url http://localhost:8088 --team default:local`
  → `Status: connected`, **cert-less** workspace (no `.aw/team-certs/`), local
  E2E keys written; `aw whoami` / `aw workspace status` (membership active) /
  `aw work ready` / `aw mail inbox` / `aw task list` all succeed over the bearer
  token. (Minor: `aw whoami`'s inbound-mode sub-read returns a server 500 — a
  pre-existing, unrelated quirk; the command and all coordination calls still
  exit 0.)
- **Gate:** `scripts/check-resource-packs.sh` and the cli-reference `--check`
  both pass.

### 4. `docs/` user guides still reference removed commands — ✅ user-facing tutorials DONE; deep SoT/contract docs intentionally left

**Status (2026-06-16):** The user-facing onboarding **tutorials** were
reconciled to the token-only flow on `feature/simple-auth-ui`:

- `docs/cli-tutorial.md` — headline "agent gets set up" tutorial. Onboarding is
  now `aw login` / `AW_TOKEN` then `aw init --aweb-url <server> --team <team-id>`;
  the `.aw/` description is cert-less workspace + `~/.aw/token` + E2E signing
  key; the second-agent flow is "same token, separate dir/worktree".
- `docs/agent-guide.md` — auth changed from team-certificate/DIDKey to bearer
  JWT; onboarding/team-setup/Add-existing-identity/BYOT blocks collapsed to a
  token-only onboarding + membership section; messaging/tasks/roles kept.
- `docs/teams.md` — "how a team comes into existence" now: web-UI sign-up
  provisions the team, membership rows grant access (dropped `aw init --byod`
  and controller-key/member-cert framing). team_id format kept.
- `docs/aw-run.md` — wizard onboarding routes through `aw login` + token-only
  `aw init` (dropped `team-certs/` / `aw id team accept-invite` routes).
- `docs/configuration.md` — added `~/.aw/token` (the credential); marked
  `~/.awid/` controller state and `.aw/team-certs/` as legacy/not-part-of the
  token-only flow; removed `cert_path` from the `workspace.yaml` sample.
- `docs/self-hosting-guide.md` — local onboarding is the token-only `aw init`
  form; the company path replaces the `aw id create`/namespace/team/invite
  procedure with a token-issuer (Better Auth UI) + token-only agent onboarding;
  flags `e2e-oss-user-journey.sh` as pivot-broken and points to
  `GETTING-STARTED.md`.

**Intentionally LEFT (residual — architecture / awid-the-service references,
not actionable user onboarding):** the SoT and contract docs that describe the
awid registry service or record historical bootstrap design still mention the
removed CLI surface, but they are reference/architecture material, not
step-by-step user onboarding. Left as-is:

- `docs/agents-layout-lifecycle-contract.md`, `docs/team-bootstrap.md`,
  `docs/bootstrap-layout-contract.md`,
  `docs/bootstrapping-operating-patterns-worklog.md` — describe the retired
  bootstrap/layout era (covered by the retired `aweb-bootstrap` skill).
- `docs/cli-setup-surface-sot.md`, `docs/aweb-sot.md`,
  `docs/product-authority-sot.md`, `docs/setup-surface-release-gates.md` —
  setup-surface/authority SoT contracts.
- `docs/awid-sot.md`, `docs/identity-guide.md`, `docs/identity.md`,
  `docs/trust-model.md`, `docs/byot-onboarding-contract.md` — awid-registry /
  DID / namespace / trust-chain service docs (the registry still issues these
  as a *service*; these are conceptual, not "run this removed `aw` command").
- `docs/support-tools.md`, `docs/support-contract-v1.md`,
  `docs/team-blueprints-sot.md`, `docs/resource-pack-template-contract.md`,
  `docs/hermes-aweb-gateway-integration.md`,
  `docs/a2a-*`, `docs/federation-architecture.md`,
  `docs/team-auth-envelope-v2.md` — operator/contract/integration docs.

These need a separate, careful SoT-reconciliation pass (and several encode
historical decisions worth preserving). The authoritative *user* entry points
(`README.md`, `cli/go/README.md`, `server/README.md`, regenerated
`docs/cli-command-reference.md`, the user tutorials above) and
`ai-completion/GETTING-STARTED.md` now all give the accurate token-only path.

---

## Things that look dangling but are NOT (intentionally retained working code)

- `server/src/aweb/identity_auth_deps.py`, `token_team_scope.py`,
  `federation/envelope.py` still handle `X-AWID-Team-Certificate` / DIDKey. This
  is **retained back-compat / federation code**; the server suite (629) passes.
  Not a dangling reference.
- `scripts/check-resource-packs.sh` lists `did:key:z`, `certificate:`, etc. as
  **forbidden-secret markers** to scan for — it is a guard, not a usage.
- `channel/test/config.test.ts` cert fixtures — testing retained back-compat
  (see follow-up 1).

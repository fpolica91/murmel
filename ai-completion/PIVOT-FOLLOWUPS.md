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

### 2. The three e2e scripts were built on the removed cert/team CLI — ✅ primary REWRITTEN + RUN GREEN; federation + A2A-gateway QUARANTINED (honest)

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

#### `scripts/e2e-oss-federation.sh` + `scripts/e2e-a2a-gateway-docker.sh` — QUARANTINED (cannot pass; not faked)

Both were replaced with short, self-documenting scripts that **exit 1** with the
reason, rather than driving removed commands or pretending to pass:

- **Federation:** cross-server delivery needs awid global addresses + namespace
  delivery-origins, all provisioned by the removed `aw id create` / `aw id team`
  / `aw id namespace set-delivery-origin` cluster. Token-only onboarding has no
  headless way to stand up two federated, cross-server-routable identities, so
  the journey cannot be made green by a script rewrite — it needs a **product
  decision** on whether/how federation onboarding survives the pivot.
- **A2A gateway:** two blockers, the load-bearing one in **Go, not bash**: the
  OSS gateway's `cli/go/cmd/aweb-a2a-gw/main.go:workspaceMailClient` hard-requires
  a team certificate (`missing cert_path`, `LoadTeamCertificate`,
  `NewWithCertificate`, awid resolver). Token-only `aw init` writes a cert-less
  workspace, so the gateway literally cannot build a mail client from it. The
  awid Go client already has a bearer path (`SetBearerProvider`) and the
  channel product was ported (follow-up 1) — porting the gateway is the same
  shape, but it is a feature change out of scope for a bash rewrite. The gateway
  health gate also still asserts awid-registry reachability + an active global
  `gateway_identity`. Reliable A2A signal post-pivot stays `make test-a2a`.

**Makefile:** `test-e2e` now runs the green token-only journey;
`test-federation-e2e` / `test-a2a-gateway-e2e` are documented as quarantined
(exit 1 by design). `make ship` runs the green journey first (so its proof is
captured) and prints a NOTE before the federation gate that it is expected to
fail until the gaps above are closed — the breakage stays **visible**, not
hidden.

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

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

### 2. The three e2e scripts are built on the removed cert/team CLI — need token-bootstrap rewrites

All three invoke removed commands and will fail immediately:

- `scripts/e2e-oss-user-journey.sh` (3110 lines) — `aw id namespace
  prepare-controller/resolve/assign-address/set-delivery-origin`, `aw id team
  request/add-member/fetch-cert`, reads `.aw/team-certs/`, asserts awid
  `/certificates` counts, `aw init --awid-registry`. The entire team-creation
  and cross-machine-join spine is gone.
- `scripts/e2e-oss-federation.sh` (870 lines) — `aw id namespace
  set-delivery-origin` and the same cert-bootstrap assumptions.
- `scripts/e2e-a2a-gateway-docker.sh` (495 lines) — `aw id team
  create/invite/accept-invite` plus `aw init --url` (now `--aweb-url`).

**Why deferred:** each needs a real rewrite to the token-bootstrap model: stand
up the UI (Better Auth issuer) in the compose stack, sign up + mint JWTs for
each test identity (or seed memberships directly in Postgres the way
`ui/e2e/global-setup.ts` does), wire `AW_TOKEN` per identity, and drop the
namespace/cert/registry assertions. That is the same shape as the working
Playwright `global-setup.ts`, but for the bash CLI journeys. `make test-e2e`,
the federation journey, and `make test-a2a-gateway-e2e` (`make ship`'s e2e gate)
will not pass until these are rewritten. **They were left intact, not
half-edited**, so the breakage is honest (they fail loudly on the first removed
command) rather than silently mid-script.

### 3. Resource-pack / codex-plugin skills duplicate the removed surface

`skills/aweb-team-membership/` and `skills/aweb-bootstrap/` (and their copies
under `packages/codex-plugin/skills/`) document `aw id namespace …`, `aw id team
…`, and `aw agents bootstrap/provision/add` end to end. `skills/aweb-coordination/`
references `aw id team switch` and `aw team join`.

**Why deferred:** these are published skill bundles whose entire premise (BYOT
team membership, namespace controllers, certificate request/fetch) was removed.
They need a rewrite to the token model or retirement — a content decision, not a
mechanical edit. `scripts/check-resource-packs.sh` still passes (it checks
manifest shape and forbidden secret markers, not command validity), so there is
no gate forcing the fix yet.

### 4. `docs/` user guides still reference removed commands

~24 docs match the removed surface. Some legitimately describe the **awid
registry service**, which still issues DIDs/namespaces/certificates as a service
(`docs/awid-sot.md`, `docs/trust-model.md`, `docs/identity-guide.md`) — those
are not necessarily wrong. But the user-facing onboarding tutorials instruct
readers to run removed CLI commands and ARE broken:

- `docs/cli-tutorial.md`, `docs/agent-guide.md`, `docs/team-bootstrap.md`,
  `docs/teams.md`, `docs/self-hosting-guide.md`, `docs/configuration.md`,
  `docs/aw-run.md`, `docs/cli-setup-surface-sot.md`.

**Why deferred:** large surface, and disentangling "describes awid-the-service
(fine)" from "tells the user to run a removed `aw` command (broken)" is a
careful per-doc judgement. The authoritative entry points were fixed instead
(`README.md`, `cli/go/README.md`, `server/README.md`, regenerated
`docs/cli-command-reference.md`), and `ai-completion/GETTING-STARTED.md` gives
the accurate token-only path as the canonical starting point.

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

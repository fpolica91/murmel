# aw CLI token-only port plan

Branch: `feature/simple-auth-ui` · Work area: `cli/go` (cmd/aw + awconfig).
Status: **not started** — the cert/DID/team-bootstrap cluster is fully intact;
every onboarding command still funnels through `initCertificateConnectWithOptions`.

This supersedes the prose in `ai-completion/PHASE3-PLAN.md` with a concrete,
ordered, build-green-able step list. It is a self-contained `cmd/aw` refactor:
no server/awid edits, no migrations, no cross-repo coordination (server + awid
are already token-only — Tasks 1–5 done).

---

## Target architecture (token-only)

**A workspace identity is a stored bearer token, not a team certificate.**

1. **Token source (3 ways, already built — KEEP):**
   - `aw login` — RFC 8628 device flow against the Better Auth issuer
     (`AWEB_AUTH_ISSUER`), opens the UI `/device` page for approval, exchanges
     the device session for a JWKS-verifiable JWT at `{issuer}/token`, caches
     access+refresh at `~/.aw/token` via `awconfig.SaveToken`
     (`login.go` + `token_bearer.go`). Auto-refresh via `sessionRefresher`.
   - `--token` flag / `AW_TOKEN` env — an injectable bearer JWT for
     non-interactive use (CI, scripts). **NEW**: thread an env/flag override
     into `awconfig.LoadValidToken`/`bearerTokenProvider` so a supplied token
     bypasses the `~/.aw/token` cache (no refresh; the caller owns lifetime).
   - The founder/dev JWT (`POST {UI}/api/auth/sign-in/email` → cookie →
     `GET {UI}/api/auth/token`) is just the `AW_TOKEN` path: paste that JWT.

2. **Workspace binding (`.aw/workspace.yaml`) becomes cert-less.** Today every
   `WorktreeMembership` requires `cert_path` (`workspace.go validate()` line
   227). The token-only binding stores: `aweb_url`, one membership with
   `team_id` (+ optional `alias`/`role_name`), `human_name`, `agent_type` — and
   **no** `cert_path`, **no** `team-certs/`, **no** DID/namespace/signing-key
   ceremony for *auth*. Team scoping = `--team` / `X-AWEB-Team-Id` header / the
   server's sole-membership fallback (the same fallback
   `resolveWorkspacelessBearerClient` already relies on).

3. **Client resolution already supports token auth — no rewiring needed.**
   `helpers.go resolveClientSelectionForDirWithTeamOverride` falls back to
   `bearerClientIfAvailable` when `resolveCertificateClient` returns nil (no
   cert, line 237-248); `resolveClient` falls back to
   `resolveWorkspacelessBearerClient` for the no-`.aw/` case (line 513). The
   bearer is attached via `SetBearerProvider(bearerTokenProvider)`. **Once
   onboarding stops writing certs and writes a cert-less binding, every kept
   coordination command authenticates by token with zero further wiring.**

4. **E2EE messaging key (`setupOrRotateIdentityEncryptionKeyForDir`) — KEEP,
   but it still needs a local signing key.** Its cert resolver
   (`resolveActiveCertificateIdentityForEncryptionKey`, id_encryption_key.go:324)
   already returns `(nil, nil)` when no cert and falls back to
   `awconfig.ResolveIdentity` → local `.aw/signing.key` (id_encryption_key.go:287).
   So it survives cert removal **only if the token-only init still creates a
   local self-custodial signing key + minimal `.aw/identity.yaml`** (DID derived
   from the key, custody=self). The signing key is for message encryption, NOT
   for server auth. Reachable from KEPT `mail.go:761`
   (`ensureE2EEKeyReadyForSend`) and the `aw id encryption-key` command.

**Onboarding flows after the port:**

| Command | Token-only behavior |
|---|---|
| `aw init` | Require a usable token (cached `~/.aw/token` OR `--token`/`AW_TOKEN`); write a cert-less `.aw/workspace.yaml` (aweb_url + team + alias + human/agent), create the local E2EE signing key/identity, ensure `.aw/context`, run docs/channel/hooks add-ons unchanged. If no token: tell the user to `aw login` (or pass `--token`). Drop `--byod/--global/--username/--domain/--inbound-mode/--awid-registry` (cert/registry-only) → hard usage errors pointing at `aw login`. |
| `aw run` | Replace the "initialize now?" `guidedOnboardingWizard` branch (run.go:464) with the token-only init writer, or a clean "run `aw login` then `aw init`" error. |
| `aw workspace add-worktree` | Collapse `addWorktreeViaLocalTeamKey` + `addWorktreeViaCloudBootstrap` + `addWorktreeViaPrimaryInvite` (workspace.go:432-545) into ONE token-only worktree binder: create the worktree, write a cert-less binding inheriting `aweb_url`/team/alias from the parent, create the worktree's own E2EE key, no invite/cert/rollback dance. `status`/`delete`/`migrate-multi-team` gate cert reads behind "cert present". |
| `aw service` | Delete (its entire contract is "connect an existing team certificate to a service"; service.go:63 → dead cert connect). |

**Removed (the cert/DID/namespace/team/bootstrap cluster):**
`connect.go`, `init_connect.go`, `init_apikey.go`, `init_local.go`,
`onboarding_wizard.go`, `id_create.go`, `id_registry.go`,
`id_registry_read.go` (+`_format`), `id_request.go`, `id_format.go`,
`id_team.go` (+`_format`), `id_namespace_*.go` (assign/delete/check-txt/
delivery-origin/prepare-controller), `team_bootstrap.go`, `team_request.go`,
`service.go`, and their `*_test.go`. (`id_sign_request.go`/`team_selector.go`
already gone.) **KEEP**: `login.go`, `token_bearer.go`, `logout.go`,
`id_encryption_key.go`, `setupOrRotateIdentityEncryptionKeyForDir`, `mail.go`,
`claim_human.go`. **KEEP or inline** `onboarding_urls.go`
(`resolveOnboardingServiceURLs` is a pure URL resolver used by kept
`claim_human.go`).

---

## Gate methodology

Capture a baseline first (the sandbox has ~132 pre-existing environmental
cmd/aw failures — outbound DNS like `beads.dev.netbird.internal` cannot
resolve): `git stash` → `cd cli/go && go test ./... 2>&1 | tee /tmp/base.txt |
grep -c -- "--- FAIL"`; record the per-package FAIL set; `git stash pop`. Each
step must end with: `go build ./...` exit 0, `make fmt` clean, and **zero new**
FAIL lines vs `/tmp/base.txt`. The token-only packages
`a2a/a2agw/internal/conformance/awid/awconfig` must stay green throughout.

---

## Ordered steps (each individually build-green-able)

1. [ ] **Baseline capture** — `git stash`; `cd cli/go && go test ./... 2>&1 | tee /tmp/base.txt | grep -c -- "--- FAIL"`; record per-package FAIL set; `git stash pop`. (No code change.)
2. [ ] **Relax the workspace schema for cert-less bindings** — in `awconfig/workspace.go`, make `cert_path` optional in `validate()` (require `team_id` only); keep `cert_path` round-tripping when present. Add/adjust `awconfig/workspace_test.go` for a no-cert membership. Build + tests green.
3. [ ] **Add an injectable token override** — thread `--token`/`AW_TOKEN` into `bearerTokenProvider`/`LoadValidToken` (an explicit token bypasses the `~/.aw/token` cache and refresh). Unit-test the override precedence (flag > env > cached file). Build + tests green.
4. [ ] **Add the token-only workspace writer** (new `init_token.go`) — given workingDir + aweb_url + team + alias + human/agent: require a usable token (cached or injected), write a cert-less `.aw/workspace.yaml` via `awconfig.SaveWorktreeWorkspaceTo`, create the local E2EE signing key + minimal `.aw/identity.yaml` (custody=self, DID from key) so `setupOrRotateIdentityEncryptionKeyForDir` works, ensure `.aw/context`. Pure new code + unit test; nothing calls it yet. Build green.
5. [ ] **Rewire `aw init`** (`init.go`) — route the default path through the token writer; delete the API-key/cert/implicit-local/guided branches; keep the add-on-only short-circuit, docs injection, channel/hooks, next-steps. Turn `--byod/--global/--username/--domain/--inbound-mode/--awid-registry` into usage errors pointing at `aw login`. Update `init_test.go`/`init_output_test.go`. Build + tests green.
6. [ ] **Rewire `aw run`** (`run.go:464`) — replace the `guidedOnboardingWizard` branch with the token writer (or a clean `aw login` + `aw init` error). Update `run_test.go`. Build + tests green.
7. [ ] **Rewire `aw workspace add-worktree`** (`workspace.go:432-545`) — collapse the three worktree-connect strategies into one token-only binder (worktree + cert-less binding inheriting parent aweb_url/team/alias + per-worktree E2EE key; no invite/cert/rollback). Gate `status`/`delete`/`migrate-multi-team` cert reads behind "cert present". Update `workspace_test.go`. Build + tests green.
8. [ ] **Delete `aw service`** (`service.go` + `service_test.go`); drop its `rootCmd.AddCommand` registration. Build + tests green.
9. [ ] **Delete the cluster files** — `connect.go`, `init_connect.go`, `init_apikey.go`, `init_local.go`, `onboarding_wizard.go`, `id_create.go`, `id_registry.go`, `id_registry_read*.go`, `id_request.go`, `id_format.go`, `id_team*.go`, `id_namespace_*.go`, `team_bootstrap.go`, `team_request.go`, plus every matching `*_test.go`. Inline `resolveOnboardingServiceURLs` into `claim_human.go` if `onboarding_urls.go` becomes the sole consumer. Build green.
10. [ ] **Fix command-registration + help-surface fallout** — confirm the `aw id` parent still registers `encryption-key` (drop the empty parent if nothing else remains); update `aw_test.go`/`id_commands_test.go`/`root.go` help-surface and command-list assertions for the removed `connect`/`id team`/`id namespace`/`service` surface. Build + tests green.
11. [ ] **Final gate** — `make fmt`; `go build ./...`; `go test ./a2a/... ./a2agw/... ./internal/conformance/... ./awid/... ./awconfig/...` (must stay green); `go test ./...` and diff the FAIL set vs `/tmp/base.txt` — require zero new failures.
12. [ ] **Manual smoke (local stack)** — with UI :3030 / aweb :8088: mint `AW_TOKEN` (`POST /api/auth/sign-in/email` → cookie → `GET /api/auth/token`), `AW_TOKEN=<jwt> aw init --aweb-url http://localhost:8088 --team default:local` in a clean dir, then `aw mail inbox` / `aw work ready` succeed token-authed (header `Authorization: Bearer <jwt>` + `X-AWEB-Team-Id: default:local`).
13. [ ] **Review, merge to main, merge main back to branch.**

---

## Risks / open questions

- **Token-only `aw init` still creates a signing key.** The E2EE key path
  (KEEP) needs a local `.aw/signing.key` + identity even with no cert. Step 4
  must create them; otherwise `aw id encryption-key` / encrypted mail break.
  This signing key is for *message encryption only* — never sent for auth.
- **`team_bootstrap.go` is ~4.7k lines** and re-exports cluster entrypoints
  (`agentsAddConnectGlobalAgent = initCertificateConnectWithOptions`, etc.).
  Grep every kept command for stray helpers it pulls from the cluster before
  deleting (Step 9), or the build breaks. `agents.go` (`aw agents add`) may
  reference `team_bootstrap` symbols — confirm and rewire/remove.
- **Worktree token sharing**: a worktree under a token-bound workspace reuses
  the same user JWT; the server's sole-membership fallback must accept multiple
  workspace bindings for one token. If the server needs explicit per-workspace
  registration, that becomes a small token-authed POST — still no certs.
- **`X-AWEB-Team-Id` header**: confirm `bearerClientIfAvailable`'s
  `c.SetTeamID(teamID)` emits the `X-AWEB-Team-Id` header the server expects
  (the dev contract uses `default:local`); the token-only binding's `team_id`
  feeds it.
</content>
</invoke>

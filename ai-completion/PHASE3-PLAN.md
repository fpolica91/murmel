# Phase 3 — Token-only auth pivot in the `aw` CLI (plan)

Branch: `feature/simple-auth-ui` · Work area: `cli/go`

## Goal

Finish the token-only auth pivot in the `aw` CLI: remove the
cert/DID/team-bootstrap onboarding cluster and rewire the kept onboarding
commands (`aw init`, `aw run`, `aw workspace`, `aw service`) to the
token-only flow (`aw login` device-flow + cached bearer JWT). Keep
`aw login` / bearer / `aw api`-style token path and the mail/chat
encryption helper `setupOrRotateIdentityEncryptionKeyForDir`.

## Why this is now possible (and necessary)

Phases 1–2 already removed the **server side** of cert onboarding:

- `POST /v1/connect` is gone (no route under `server/src/aweb/routes/`;
  grep for `v1/connect` in `server/src` returns nothing). `aw init`'s
  certificate path (`initCertificateConnectWithOptions` →
  `postConnect`) calls a **dead endpoint**.
- `POST /api/v1/workspaces/init` (the API-key cloud bootstrap target in
  `init_apikey.go:704`) is also gone — there is no `workspaces` route
  file server-side.

So today every cert-based onboarding path in the CLI targets endpoints
that no longer exist. The web product is token-only: `ui/src/lib/auth.ts`
wires Better Auth `deviceAuthorization` + `bearer` + `jwt` plugins, the
device approval page lives at `ui/src/app/device/page.tsx`, and
`/api/auth/token` mints the JWKS-verifiable JWT. The CLI's `aw login`
(`login.go` + `token_bearer.go`) already implements the full RFC 8628
device flow against that issuer and caches the token via
`awconfig.SaveToken`. The token path is real and complete; only
onboarding still points at the dead cert plumbing.

## Token-only onboarding the CLI should use

1. **`aw login`** (already implemented, keep as-is): RFC 8628 device
   flow against the Better Auth issuer (`AWEB_AUTH_ISSUER`), opens
   `ui/src/app/device/page.tsx` for approval, exchanges the device
   session for a JWT at `{issuer}/token`, caches access+refresh at
   `~/.aw/token` (`awconfig.SaveToken`). Auto-refresh via
   `sessionRefresher` in `token_bearer.go`.
2. **`aw init` (token mode)**: instead of cert connect, write a minimal
   token-only `.aw/workspace.yaml` binding — `aweb_url` (from
   `--aweb-url`/`AWEB_URL`), alias, human_name, agent_type, and `.aw/context`
   — **without** a team certificate or signing key. Team scoping comes
   from `--team` / the server's sole-membership fallback (the same
   fallback `resolveWorkspacelessBearerClient` already relies on). If no
   token is cached, instruct the user to run `aw login` first.
3. **Client resolution** already supports this: `helpers.go`
   `resolveClientSelectionForDir` falls back to `bearerClientIfAvailable`
   when `resolveCertificateClient` returns nil (no cert), and
   `resolveWorkspacelessBearerClient` handles the no-`.aw/` case. The
   bearer is attached by `SetBearerProvider(bearerTokenProvider)`. So once
   onboarding stops writing certs, the existing coordination commands
   authenticate by token with **no further wiring**.
4. **Encryption key** (`setupOrRotateIdentityEncryptionKeyForDir`,
   `id_encryption_key.go`): KEEP. Its cert resolver
   (`resolveActiveCertificateIdentityForEncryptionKey`) already returns
   `(nil, nil)` when no cert is present and falls back to
   `ResolveIdentity` / local signing key, so it survives cert removal.
   Still reachable from KEPT `mail.go:761` (`ensureE2EEKeyReadyForSend`)
   and the `aw id encryption-key` command. (Phase 4 — custodial JWT key
   directory — is already marked complete; this plan does not re-touch the
   messaging-key architecture, only stops the cert onboarding from being a
   prerequisite.)

## The cert/DID/bootstrap cluster (remove)

Command + plumbing files whose sole purpose is cert/DID/team-registry
onboarding (all target dead endpoints or AWID registry plumbing the
token pivot drops):

- `init_connect.go` — `initCertificateConnect*` + `postConnect` (dead
  `POST /v1/connect`), `connectOutput`/`connectResponse`/`connectRequest`,
  `loadCertificateForConnect`, `hasCertificateForInit`, `formatConnect`.
  This is the shared cert-connect engine every onboarding path funnels
  into.
- `connect.go` — the `aw connect` command (`runConnect` →
  `bootstrapConnect` → `registerBootstrapDID`): token-redeem-into-cert
  bootstrap, also cert-terminal. Remove with the cluster.
- `init_apikey.go` — API-key cloud bootstrap → dead
  `POST /api/v1/workspaces/init`.
- `init_local.go` — `runImplicitLocalInit` → AWID registry +
  `bootstrapLocalTeamMemberWithLifetime` + cert connect.
- `onboarding_wizard.go` — `guidedOnboardingWizard` (hosted/BYOD/local
  cert onboarding orchestration).
- `id_create.go`, `id_registry.go`, `id_registry_read*.go`,
  `id_request.go`, `id_sign_request*.go`, `id_format.go`,
  `id_namespace_*.go` (assign/delete/check-txt/delivery-origin/
  prepare-controller), `id_team.go` + `id_team_format.go` — the
  `aw id …` DID/namespace/team-registry surface and shared plumbing
  (`createTeamInviteToken`, `acceptTeamInviteWithDetails`,
  `revokeAcceptedTeamCertificate`, `requireTeamStateForMembership`,
  `bootstrapLocalTeamMemberWithLifetime`).
- `team_bootstrap.go`, `team_request.go`, `team_selector.go` — local team
  bootstrap + request/selection plumbing.
- `service.go` — cert-only `aw service init` (connects an existing cert to
  a service via `initCertificateConnectWithOptions`). Either delete the
  command or reduce it to a token-bind no-op; deleting is cleanest.
- Matching `*_test.go` for every removed file.

KEEP `onboarding_urls.go` (`resolveOnboardingServiceURLs` is used by the
KEPT `claim_human.go` and is a pure URL resolver, not cert plumbing) —
or inline the one function it still needs.

## Kept commands that call into the cluster (must be rewired)

| Kept command | Cluster call today | Rewire to |
|---|---|---|
| `aw init` (`init.go`) | `initCertificateConnectWithOptions`, `guidedOnboardingWizard`, `runImplicitLocalInit`, `runAPIKeyBootstrapInit`, `resolveOnboardingServiceURLs`, `hasCertificateForInit` | token-only: require cached token (`awconfig.LoadToken`), write a cert-less `.aw/workspace.yaml` (aweb_url + alias + human/agent), ensure `.aw/context`, run docs injection / channel / hooks add-ons unchanged. Drop `--byod`/`--username`/`--domain`/`--global`/`--inbound-mode` (cert/registry-only) or make them hard usage errors pointing at `aw login`. |
| `aw run` (`run.go:464`) | `guidedOnboardingWizard` when workspace missing | replace the "initialize now?" branch with: prompt → run the token-only init (same writer as `aw init`), or error telling the user to `aw login` + `aw init`. |
| `aw workspace add-worktree` (`workspace.go:499`, `addWorktreeViaLocalTeamKey`, `addWorktreeViaCloudBootstrap`) | `initCertificateConnectWithOptions`, `createTeamInviteToken`, `acceptTeamInviteWithDetails`, `revokeAcceptedTeamCertificate`, `runAPIKeyBootstrapInit` | replace both worktree-connect strategies with a single token-only path: create the worktree, write a cert-less `.aw/workspace.yaml` inheriting `aweb_url`/team/alias from the parent, no invite/cert dance. `workspace status` / `delete` / `migrate-multi-team` are token-safe once cert reads are gated behind "cert present" checks. |
| `aw service` (`service.go`) | `initCertificateConnectWithOptions`, `requireTeamStateForMembership`, `activateExistingTeamMembership`, `resolveOnboardingServiceURLs` | delete the command (its entire contract is "connect an existing team certificate to a service"); nothing token-only remains for it. If a service-bind is still wanted, reduce to writing `aweb_url` into the workspace binding. |
| `aw claim-human` (`claim_human.go:206`) | `resolveOnboardingServiceURLs` only (pure URL resolver) | keep the helper; no cert coupling. |

## Feasibility

**Feasible = true**, as an isolated, green-gated change, with these
caveats the implement lane must honor:

- The cluster is large (`team_bootstrap.go` alone is ~4.7k lines) and the
  kept commands have **hard compile-time** references to cluster symbols
  (`init.go`, `run.go`, `workspace.go`, `service.go`). Removal is not a
  pure delete: each kept command must be rewired in the **same** change or
  the build breaks. This is a self-contained cmd/aw refactor — no server
  or awid edits, no migration.
- Server/awid are already token-only, so there is **no cross-repo
  coordination** needed and no endpoint to keep alive.
- Gate methodology (capture baseline first): `git stash` the change, run
  `cd cli/go && go test ./... 2>&1 | grep -c -- "--- FAIL"` to record the
  pre-existing cmd/aw failure count (~132, all environmental: outbound
  DNS like `beads.dev.netbird.internal` cannot resolve in the sandbox).
  Unstash, re-run, require **zero new** FAIL lines. `go build ./...` exit
  0; `a2a/a2agw/internal/conformance/awid/awconfig` green (verified green
  now); `make fmt` clean.

## Step-by-step the implement lane follows

1. Baseline: `git stash` → `cd cli/go && go test ./... 2>&1 | tee /tmp/base.txt | grep -c "FAIL"`; record per-package + total FAIL set. `git stash pop`.
2. Add a token-only workspace writer (new small file, e.g. `init_token.go`): given workingDir + aweb_url + alias + human/agent, require `awconfig.LoadToken`, write a cert-less `.aw/workspace.yaml` (no `team-certs/`, no signing key), ensure `.aw/context`. Reuse `awconfig.SaveWorktreeWorkspaceTo`.
3. Rewire `aw init` (`init.go`): delete the cert/API-key/implicit-local/guided branches; keep add-on-only short-circuit, docs injection, channel/hooks, next-steps. Route the default path through the token writer. Turn `--byod/--global/--username/--domain/--inbound-mode` into usage errors pointing at `aw login`.
4. Rewire `aw run` (`run.go`): replace the `guidedOnboardingWizard` branch with the token writer (or a clean error).
5. Rewire `aw workspace add-worktree` (`workspace.go`): collapse `addWorktreeViaLocalTeamKey` + `addWorktreeViaCloudBootstrap` into one token-only worktree binder; drop invite/cert rollback paths. Gate `workspace status`/`delete` cert reads behind "cert present".
6. Delete `aw service` (`service.go` + test) or reduce to a token bind.
7. Delete the cluster files + their tests (list above). Keep `onboarding_urls.go` (or inline `resolveOnboardingServiceURLs` into `claim_human.go`). Keep `id_encryption_key.go`, `login.go`, `token_bearer.go`, `logout.go`, `mail.go`.
8. Fix fallout: remove now-dead references in `aw_test.go` help-surface assertions and any `aw id …`/`aw team` command-registration tests; update `init_*_test.go`, `connect_test.go`, `onboarding_wizard_test.go`, `team_*_test.go`.
9. `cd cli/go && make fmt`; `go build ./...`; `go test ./a2a/... ./a2agw/... ./internal/conformance/... ./awid/... ./awconfig/...` (must stay green); `go test ./...` and diff FAIL set vs `/tmp/base.txt` — require zero new failures.
10. Review, merge to main, merge main back to branch.

## Risks / open questions

- `aw id encryption-key` and the `aw id` group: after removing the cert
  `aw id` subcommands, confirm the `id` parent command still registers at
  least `encryption-key` (and `log` if kept) so `rootCmd` has a valid `id`
  group; otherwise drop the empty parent. Verify help-surface tests.
- `aw workspace add-worktree` token semantics: a worktree under a
  token-bound workspace shares the same user JWT; confirm the server
  accepts multiple workspace bindings for one token (sole-membership
  fallback). If the server needs an explicit per-workspace registration
  call, that becomes a small token-authenticated POST — still no certs.
- `team_bootstrap.go` is huge; ensure no KEPT command imports a stray
  helper from it beyond the listed entrypoints (grep before deleting).

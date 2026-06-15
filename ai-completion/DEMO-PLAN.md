# aweb Demo-Readiness + Cleanup Plan

Branch: `feature/simple-auth-ui`
Stack (local): UI `http://localhost:3030`, aweb `http://localhost:8088`,
Postgres `localhost:5544` (`PGPASSWORD=change-me -U aweb -d aweb`), Redis
`localhost:6390`. Server tests: `TEST_DB_PORT=5433 TEST_DB_USER=postgres
TEST_DB_PASSWORD=postgres` (docker `aweb-testdb` on `:5433`).

Goal: make the product DEMO-READY (real app-shell UI + a logged-in human
appears online and can chat) and finish the cert cleanup (Phases 2–4).

This is a PLAN doc. Nothing here is implemented except this file. Each numbered
section below is handed to an implementation lane.

---

## 1. UI / UX — Linear-style app shell (LEFT SIDEBAR)

### Problem
There is no sidebar. Navigation is a cramped top bar in
`ui/src/components/topbar.tsx`, mounted by `ui/src/app/dashboard/layout.tsx`.
Brand, team switcher, nav links, user name, and Sign-out are all crammed into a
single horizontal `.topbar` row. It does not read as a product.

### Target layout
A fixed **left sidebar** + a **main content column**, like Linear:

```
┌────────────┬───────────────────────────────────────────┐
│  SIDEBAR   │  CONTENT                                   │
│ (240px)    │  (flex:1, scrolls)                         │
│            │                                            │
│ ▸ brand    │  page header (optional, per-route)         │
│ ▸ team sw  │  page body                                 │
│            │                                            │
│ ─ nav ─    │                                            │
│ ▸ Console  │                                            │
│ ▸ Work     │                                            │
│ ▸ Chat     │                                            │
│ ▸ Members  │                                            │
│            │                                            │
│ (spacer)   │                                            │
│ ─ footer ─ │                                            │
│ ● user ▸   │                                            │
│   Sign out │                                            │
└────────────┴───────────────────────────────────────────┘
```

Sidebar regions, top to bottom:
1. **Brand block** — `aweb` wordmark (reuse `.brand`), small product subtitle.
2. **Team switcher** — the existing `<TeamSwitcher>`, restyled to fill width
   (the `<select>` becomes a full-width control, label above it).
3. **Primary nav** — vertical list: Console / Work / Chat / Members. Each item:
   leading icon + label, full-width hit target, rounded, with hover + active
   states (active = filled `#1d2027` background + `--text` color + left accent
   bar or accent icon). Preserve the existing `isActive` prefix-match logic.
4. **Spacer** — `flex:1` to push the footer to the bottom.
5. **Footer (pinned bottom)** — signed-in user: an **online indicator dot**
   (green when the presence hook reports online, muted otherwise) + the user
   display name; below it a full-width **Sign out** button (reuse `.btn`).

### Concrete component structure
- **NEW** `ui/src/components/app-sidebar.tsx` (client component):
  - `<aside className="sidebar">`
    - `<div className="sidebar-brand">aweb</div>`
    - `<div className="sidebar-team"><TeamSwitcher/></div>`
    - `<nav className="sidebar-nav">` mapping `NAV_LINKS` (moved here from
      topbar) to `<Link className="sidebar-link [active]">` with an icon slot.
    - `<div className="sidebar-spacer" />`
    - `<div className="sidebar-footer">` with `<UserBadge/>` + Sign-out button.
  - Keep `signOut()` import from `@/lib/auth-client`; keep `usePathname` +
    `isActive` logic verbatim.
- **NEW** `ui/src/components/user-badge.tsx` (client component): renders the
  online dot + display name. Consumes the presence hook from §2
  (`usePresence()` → `{ online }`). Props: `userName: string`.
- **NEW** `ui/src/components/use-presence.ts` — the heartbeat hook (see §2). It
  is the single owner of the heartbeat interval and exposes `{ online }`.
- **NEW** `ui/src/components/icons.tsx` (or inline SVGs) — four small 16px
  stroke icons: Console (grid/home), Work (checklist), Chat (bubble), Members
  (people). Inline SVG, `currentColor`, `strokeWidth=1.5`. No icon dependency.
- **CHANGE** `ui/src/app/dashboard/layout.tsx`:
  - Replace `<Topbar .../>` + `<main className="content">` with a two-column
    shell: `<div className="dashboard-shell"><AppSidebar userName=.../>
    <main className="content">{children}</main></div>`.
  - The root `app-shell` (in `ui/src/app/layout.tsx`) is `display:flex;
    flex-direction:column; min-height:100vh`. The dashboard shell must be the
    horizontal flex row that fills it: `display:flex; min-height:100vh`.
- **REMOVE/RETIRE** `ui/src/components/topbar.tsx` — its `NAV_LINKS`,
  `DashboardNav`, `isActive`, and sign-out move into `app-sidebar.tsx`. Delete
  the file after the sidebar lands (it has no other importer than the layout).

### Styling tokens to reuse (`ui/src/app/globals.css`)
Reuse existing CSS variables — do NOT invent a new palette:
`--bg #0b0c0f`, `--panel #15171c`, `--border #262a33`, `--text #e6e8ec`,
`--muted #9aa1ad`, `--accent #4f8cff`. Reuse `.btn` / `.btn-primary`,
`.muted`, `.panel`. The active-nav fill `#1d2027` already exists (used by
`.topnav-link.active` and `.team-switcher select`) — reuse it.

New CSS classes to add to `globals.css` (replace `.topbar/.topnav*` block):
```css
.dashboard-shell { display:flex; min-height:100vh; }
.sidebar {
  width:240px; flex:0 0 240px; display:flex; flex-direction:column;
  gap:0.25rem; padding:1rem 0.75rem; border-right:1px solid var(--border);
  background:var(--panel);
}
.sidebar-brand { font-weight:600; font-size:1.05rem; padding:0.25rem 0.5rem 0.75rem; }
.sidebar-team { padding:0 0.25rem 0.75rem; border-bottom:1px solid var(--border); margin-bottom:0.5rem; }
.sidebar-team select { width:100%; }   /* team switcher fills the rail */
.sidebar-nav { display:flex; flex-direction:column; gap:0.15rem; }
.sidebar-link {
  display:flex; align-items:center; gap:0.6rem; padding:0.5rem 0.6rem;
  border-radius:8px; color:var(--muted); text-decoration:none;
  border:1px solid transparent; font-size:0.92rem;
}
.sidebar-link:hover { color:var(--text); background:#1a1d24; }
.sidebar-link.active { color:var(--text); background:#1d2027; border-color:var(--border); }
.sidebar-link svg { flex:0 0 16px; }
.sidebar-spacer { flex:1; }
.sidebar-footer { border-top:1px solid var(--border); padding-top:0.75rem; display:flex; flex-direction:column; gap:0.5rem; }
.user-badge { display:flex; align-items:center; gap:0.5rem; padding:0 0.25rem; font-size:0.9rem; }
.online-dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:0 0 8px; }
.online-dot.online { background:#3fb950; box-shadow:0 0 0 2px rgba(63,185,80,0.18); }
.content { flex:1; padding:1.75rem 2rem; overflow:auto; }
```
The `.content` padding is bumped from `1.5rem` for breathing room. Keep the
existing `.team-switcher select` rule; `.sidebar-team select { width:100% }`
augments it inside the rail.

### Demo-ready acceptance
- Sidebar is fixed-width, full-height, distinct panel background.
- All four nav items have clear hover + active states; the active route is
  unambiguous.
- Team switcher fills the rail and switches context (unchanged behavior).
- User badge + online dot + Sign out are pinned to the bottom.
- Content column has comfortable padding and scrolls independently.
- `cd ui && npm run build` passes; `npm run lint` clean.

---

## 2. PRESENCE — a logged-in human appears online

### Why the existing heartbeat is not enough
`/v1/agents/heartbeat` (`server/src/aweb/routes/agents.py`) casts
`identity.agent_id::UUID` and updates the `workspaces` table. For a **token
(human)** identity, `aweb.token_team_scope.token_identity` sets
`agent_id = auth.subject` (a Better-Auth subject STRING, not a UUID) and
`identity_scope="token"`, and a human has **no `workspaces` row**. So that
endpoint cannot mark a human online.

Also, `GET /v1/participants` **deliberately skips presence for humans**
(`presence = presence_by_id.get(agent_id) if kind == "agent" else None`), so
even if a human had a presence record, the roster would still show them
offline.

### Design (minimal)
A human's participant row already exists via
`identity_auth_deps.provision_human_participant(...)`, which **returns the real
`agent_id` UUID** (the `agents` row keyed by synthetic
`did:key:jwt-<subject>`). Presence in Redis is keyed by that `agent_id`
(`presence:<agent_id>`), exactly like agents. So:

1. Add a presence-write heartbeat that, for the calling identity:
   - resolves the human's real `agent_id` UUID (provision/refresh the row),
   - writes Redis presence keyed by that UUID via `update_agent_presence(...)`,
   - returns `{ agent_id, alias, online:true, last_seen }`.
2. Compute `online` from Redis presence with a small TTL window (presence key
   has a TTL; "online" == presence key exists with a fresh `last_seen`).
3. Change `GET /v1/participants` to JOIN presence for **humans too** (remove the
   `kind == "agent"` guard), so the roster reflects live human presence.

### PRESENCE CONTRACT (verbatim — both lanes implement to this)

**Server endpoint — `POST /v1/presence/heartbeat`**
(new module `server/src/aweb/routes/presence.py`, router prefix `/v1/presence`,
included in `server/src/aweb/api.py` alongside the other v1 routers).

- Auth: `Depends(get_team_identity)` (Better Auth bearer JWT + `X-AWEB-Team-Id`),
  same as every other v1 route.
- Request body: none.
- Behavior:
  1. `row = await provision_human_participant(db, team_id=identity.team_id,
     subject=identity.agent_id, name=identity.alias)` to obtain the human's
     real `agent_id` UUID (`row["agent_id"]`). (For a future non-human token
     this still resolves the agents row; provisioning is idempotent.)
  2. `last_seen = await update_agent_presence(redis, agent_id=str(row["agent_id"]),
     alias=identity.alias, team_id=identity.team_id, human_name=row["human_name"],
     status="active", ttl_seconds=PRESENCE_TTL_SECONDS)`.
  3. Return `200`:
     ```json
     { "agent_id": "<uuid>", "alias": "<alias>", "online": true,
       "last_seen": "<iso-8601>" }
     ```
- `PRESENCE_TTL_SECONDS = 120` (2 min). The UI re-pings well inside the TTL so a
  live tab stays online; closing the tab lets presence expire → offline.
- Errors: `401` if unauthenticated (inherited from `get_team_identity`). No
  team selected → the standard `get_team_identity` 400/403.

**Online computation (server, authoritative)**
`online == (a fresh presence:<agent_id> hash exists in Redis)`. The presence
key TTL (`PRESENCE_TTL_SECONDS`) IS the window — when it expires the participant
is offline. `GET /v1/participants` and `GET /v1/agents` read presence via
`list_agent_presences_by_workspace_ids(redis, agent_ids)` and set
`online=True, status=presence.status, last_seen=presence.last_seen` whenever a
presence record is found. The `kind == "agent"` guard in
`routes/participants.py` (line ~101) is REMOVED so humans get the same join. The
`ParticipantView`/`Participant` docstrings that assert "humans never have
presence" are updated to "presence applies to any participant that heartbeats".

**UI heartbeat hook — `ui/src/components/use-presence.ts`**
```ts
// usePresence(): mounted once in the dashboard shell (via <UserBadge/>).
// - On mount: POST /v1/presence/heartbeat (via authedRequest, teamId from useTeam()).
// - Then every PRESENCE_PING_MS = 45_000 ms, re-POST while the tab is mounted.
// - Re-ping immediately when document.visibilityState flips to "visible".
// - Expose { online: boolean } — true after a successful heartbeat, set false
//   on a failed/aborted heartbeat. Used to drive the sidebar online dot.
// - Pause the interval when the tab is hidden (visibilitychange); resume + ping
//   on becoming visible. Clear the interval on unmount.
// - Re-run when activeTeam changes (a heartbeat is team-scoped).
```
- Transport: the existing `authedRequest("/v1/presence/heartbeat",
  { method:"POST", teamId })` in `ui/src/lib/api/http.ts` (do NOT edit that
  shared helper; just call it). A thin
  `ui/src/lib/api/presence.ts` wrapper (`sendHeartbeat(teamId)`) is fine.
- `PRESENCE_PING_MS (45s) < PRESENCE_TTL_SECONDS (120s)` so a live tab is always
  online with margin for one missed ping.

**Agreement points the two lanes must not diverge on**
- Endpoint path: `POST /v1/presence/heartbeat`. No body. Team via
  `X-AWEB-Team-Id` (added by `authedRequest`).
- Redis presence key: `presence:<agent_id-uuid>` (existing `update_agent_presence`).
- Window: server TTL 120s; UI ping 45s.
- The roster (`GET /v1/participants`) is the source of truth the Members page
  reads to render every participant's online dot; the sidebar's own dot is
  driven by the local hook's last heartbeat result.

### Presence acceptance
- Log in → within one ping the user's own sidebar dot is green.
- `GET /v1/participants` shows the logged-in human with `online:true`,
  `status:"active"`, a recent `last_seen`.
- Close the tab, wait > TTL → the human shows offline on next roster fetch.

---

## 3. PHASE 2 — remove dead aweb cert code + the awid cert/DID/namespace/dns SERVICE (keep the awid utility library)

### What is dead (verified)
- `server/src/aweb/team_auth_envelope.py` — only imported by
  `team_auth_deps.py` (the cert path) and two cert tests. Dead once the cert
  path in `team_auth_deps.py` is removed.
- `server/src/aweb/team_auth_deps.py` cert functions:
  `verify_request_certificate`, `resolve_team_identity`, `_resolve_team_key`,
  `_get_revoked_certificates`, `_team_auth_allowed_audiences`, and the cert-only
  imports (`verify_did_key_signature`, `parse_team_id`, `parse_didkey_auth`,
  `require_timestamp`, `enforce_timestamp_skew`, `parse_and_verify_certificate`,
  `team_auth_signature_payload`). KEEP `TeamIdentity`, `get_team_identity`
  (token path), `_aweb_db`, and the `legacy_lifetime_for_scope` import only if
  still referenced by `TeamIdentity.lifetime` (drop the property if nothing
  reads it).
- `server/src/aweb/team_auth.py`: `_verify_certificate_signature` and
  `parse_and_verify_certificate` are cert-only → remove. **`verify_dashboard_token`
  MUST stay** — it is still used by `server/src/aweb/routes/dashboard.py`
  (`_require_dashboard_auth`). Verify with `grep -rn verify_dashboard_token
  server/src`.
- `server/src/aweb/mcp/auth.py`: `verify_request_certificate` is imported but
  **never called** (`_resolve_auth` only does internal-proxy + bearer-token).
  `request_has_team_certificate` is also imported-but-unused now. Remove both
  from the import lines.
- awid cert/DID/namespace/dns **SERVICE** routes (registered in
  `awid/src/awid_service/main.py`): `routes/did.py`, `routes/dns_addresses.py`,
  `routes/dns_namespace_reverify.py`, `routes/dns_namespaces.py`,
  `routes/teams.py` (team registration + certificate issuance records). Remove
  the files AND their `include_router(...)` lines in `main.py`. Keep
  `routes/a2a_publications.py` (A2A is a live product surface — covered by
  `make test-a2a`).

### What MUST be kept (do NOT touch)
- The awid **utility library** `awid/src/awid/*` — `signing`, `team_ids`,
  `pagination`, `db_config`, `log`/`log_config`, `registry`, `ratelimit`,
  `e2ee_keys`, etc. It is imported by aweb (`grep -rn "from awid" server/src`
  shows `awid_registry_client` is used by `federation.py`, `messages.py`,
  `service_registration.py`, `chat.py`, `identity_auth_deps.py`,
  `e2ee_keys` by `routes/agents.py`). Removing it breaks the server.
- `awid_registry_client` wiring in aweb is NOT cert-only; leave it.

### Migrations rule (hard constraint)
awid uses a consolidated `001_registry.sql` and pgdbm hashes every applied
migration. **Do NOT edit any existing migration** (001 or any of 002–007) to
drop the DID/namespace/team tables. Service-route removal is code-only. If
dropping now-orphaned tables is ever wanted, that is a NEW ordered migration
(`awid 008_*.sql`) AND a planned cutover — out of scope for the demo; escalate
to coord-awid (Goto). For the demo, leaving the tables in place is correct and
safe.

### Safe removal ORDER
1. `mcp/auth.py`: drop the two unused imports
   (`verify_request_certificate`, `request_has_team_certificate`). Run
   `make test-server`.
2. `team_auth_deps.py`: delete the cert functions + cert-only imports; keep
   `TeamIdentity` + `get_team_identity`. Delete/rewrite `test_team_auth_deps.py`
   (cert cases). Run `make test-server`.
3. Delete `team_auth_envelope.py` + `test_team_auth_envelope.py`. Run
   `make test-server`.
4. `team_auth.py`: remove `_verify_certificate_signature` +
   `parse_and_verify_certificate`; KEEP `verify_dashboard_token`. Run
   `make test-server`.
5. awid service: delete `routes/{did,dns_addresses,dns_namespace_reverify,
   dns_namespaces,teams}.py` + their `include_router` lines in `main.py`;
   delete/rewrite the matching `awid/tests/*` for those routes. Run
   `make test-awid`.
6. Full gate: `make test-server` (with `TEST_DB_PORT=5433 TEST_DB_USER=postgres
   TEST_DB_PASSWORD=postgres`) and `make test-awid` both green; `make test-a2a`
   still green (proves the awid library + a2a_publications survived).

### Test gates
```
TEST_DB_PORT=5433 TEST_DB_USER=postgres TEST_DB_PASSWORD=postgres make test-server
make test-awid
make test-a2a   # regression guard for the kept awid library + a2a route
```

---

## 4. PHASE 3 — remove cert-based CLI (keep aw login / bearer / api / token flow)

CLI lives in `cli/go/cmd/aw`. Build/test gate after EACH removal step:
`cd cli/go && go build ./... && go test ./...`.

### REMOVE (cert / DID / namespace / team-registration / bootstrap)
- `connect.go`, `connect_test.go` — cert-based `aw connect`/`/v1/connect`.
- `init_connect.go`, `init_connect_test.go` — cert bootstrap during init.
- The cert/DID/namespace `id_*` commands:
  `id_create.go`, `id_request.go`, `id_sign_request*.go`, `id_rotate_key.go`,
  `id_rotation_recovery.go`, `id_registry*.go`, `id_namespace_*.go`,
  `id_team*.go` (+ their `_test.go`). These drive DID issuance, namespace TXT
  proofs, address assignment, and team registration against the awid service
  being deleted in Phase 2. `id_encryption_key.go` — REMOVE only if it talks to
  the cert/DID issuance flow; KEEP if it is the E2E key-publish helper for the
  custodial JWT model (grep its target endpoint first: keep iff it targets
  `/v1/agents/me/encryption-key`).
- `team_bootstrap.go` + `team_bootstrap_test.go`, `team_human.go`,
  `team_request.go` + `team_request_test.go`, `team_selector*.go` — cert team
  bootstrap/registration.
- `init_apikey.go`/`init_apikey_test.go`, `init_local.go`,
  `init_inbound_mode*.go`, `init_addon_test.go`, `init_output_test.go` — audit
  each: anything that mints/installs a team certificate goes; anything that only
  writes `.aw/workspace.yaml` (team binding, no cert) and is still reachable
  from a kept command stays. Strip cert branches from `init.go` rather than
  deleting it if `aw init` still has a non-cert reason to exist; otherwise
  remove `aw init`'s cert subcommands and keep only the token path.

For every file removed, also remove its `rootCmd.AddCommand(...)` /
`identityCmd.AddCommand(...)` / `agentsCmd.AddCommand(...)` registration and any
now-orphaned parent command (e.g. drop `identityCmd`/`agentsCmd` if every child
is gone). Fix dangling references the compiler flags.

### KEEP (the token flow + everything non-cert)
- `login.go` — `aw login` (browser sign-in, caches an aweb access token). KEEP.
- `token_bearer.go` — bearer-token helpers. KEEP.
- `aw api` (the raw authenticated API passthrough) — KEEP.
- All coordination commands (mail, chat, work/tasks, roles, contacts,
  heartbeat, events, control, claim, doctor, a2a, version, upgrade). KEEP.
- `id_format.go`/`id_team_format.go`/`id_registry_read_format.go` — KEEP only if
  a kept command still formats those payloads; otherwise remove with their
  command.

### Gate
```
cd cli/go && go build ./... && go test ./... && make fmt
```
Also re-run the a2a conformance gate (`make test-a2a`) since the gateway shares
the CLI module.

---

## 5. PHASE 4 — verdict on the JWT / custodial encryption-key directory

### Verdict: **DONE** (for the demo's purpose).

Rationale:
- The custodial / zero-ceremony identity model is in place. A human/token
  participant gets a deterministic synthetic identity
  `did:key:jwt-<subject>` via `provision_human_participant`
  (`server/src/aweb/identity_auth_deps.py`) with **no key ceremony** — the row
  is created idempotently on first authenticated request.
- The encryption-key DIRECTORY exists and carries the custody signal:
  - migration `server/src/aweb/migrations/aweb/002_agent_encryption_keys.sql`
    (the directory table) plus
    `007_agent_encryption_key_custody.sql`, which adds
    `assertion_custody TEXT CHECK (... IN ('self','hosted_custodial'))` — the
    sender-visible custody flag.
  - `PUT /v1/agents/me/encryption-key` (`routes/agents.py`) publishes an
    identity-signed `aweb-e2ee-key-v1` assertion (validated by
    `awid.e2ee_keys.validate_encryption_key_assertion`), and `GET /v1/agents`
    returns the active key per participant via the
    `agent_encryption_keys` lateral join (custody included). The directory is
    queryable per `(agent_id, did_key, did_aw)` with not-before/expiry/revocation
    filtering.
  - awid mirrors the model: `awid 006_identity_encryption_key_custody.sql`.
- So "JWT identity + custodial key directory with zero key ceremony" already
  holds end to end (provision → publish → list with custody). The demo path
  (authenticate → online → chat) does not require any additional crypto
  re-architecture.

### NEEDS-WORK caveats (NOT required for the demo; do NOT implement crypto here)
These are follow-ups, not blockers:
- The custodial server-side key custody (actually holding/deriving the hosted
  key material for `hosted_custodial`) is a directory + assertion model today;
  a true server-side custodial keystore (where aweb mints/stores the x25519
  private key for a JWT participant who never runs a CLI) is not part of this
  workflow. Track separately if/when humans must transparently decrypt E2E
  messages from the browser.
- If the demo needs a logged-in human to send/receive **encrypted** chat (not
  just plaintext coordination), a browser-side key-publish step is missing.
  The demo scope is "authenticate, appear online, chat" — plaintext chat over
  the token path is sufficient and already works.

Conclusion: **DONE** for demo-readiness; the custodial-keystore item is a
tracked NEEDS-WORK follow-up outside this workflow.

---

## Definition of Done

- [ ] **Sidebar present & navigable** — left rail with brand, team switcher,
      Console/Work/Chat/Members (icons + hover + active), user badge + online
      dot + Sign out pinned bottom. `topbar.tsx` retired. `cd ui && npm run
      build` green.
- [ ] **User appears online** — `POST /v1/presence/heartbeat` live; UI
      `usePresence` pings on load + every 45s + on tab-visible; logged-in human
      shows `online:true` in `GET /v1/participants`; own sidebar dot green;
      goes offline after TTL (120s) when the tab closes.
- [ ] **Chat works across pairings** — a logged-in human can open a conversation
      and exchange messages with another participant (human or agent) selected
      from the roster; verified against the local stack (UI :3030 → aweb :8088).
- [ ] **Phase 2 done or safely blocked** — dead aweb cert code removed
      (`team_auth_envelope.py`, cert funcs in `team_auth_deps.py`/`team_auth.py`
      with `verify_dashboard_token` KEPT, unused imports in `mcp/auth.py`);
      awid cert/DID/namespace/dns **service** routes removed; awid **library**
      kept. `make test-server` (TEST_DB_* env) + `make test-awid` +
      `make test-a2a` green. No migration edited.
- [ ] **Phase 3 done or safely blocked** — cert/DID/namespace/team/bootstrap CLI
      removed; `aw login`/bearer/`aw api`/token flow + coordination commands
      kept; `cd cli/go && go build ./... && go test ./...` green; `make fmt`
      clean.
- [ ] **Phase 4 verdict recorded** — **DONE** (custodial JWT key directory via
      migration 007 + `did:key:jwt-<subject>` provisioning); custodial keystore
      noted as a tracked follow-up, no crypto implemented in this workflow.

---

## Notes for the lanes
- `ui/src/lib/api/http.ts` is a SHARED helper — do NOT edit it; call
  `authedRequest` for the heartbeat.
- The server and UI presence lanes MUST agree on the verbatim contract in §2
  (path `POST /v1/presence/heartbeat`, no body, team via `X-AWEB-Team-Id`,
  Redis key `presence:<agent_id>`, TTL 120s, UI ping 45s).
- Run server tests with `TEST_DB_PORT=5433 TEST_DB_USER=postgres
  TEST_DB_PASSWORD=postgres` (docker `aweb-testdb` on :5433).
- Keep changes small and reviewable; merge to main and back per the repo's
  branch-sync rule when each phase lands.

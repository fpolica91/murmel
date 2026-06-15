# Product Plan — Human + Agent Collaboration

A Linear/Jira-style collaboration tool where **humans and agents are peers**,
built on the existing aweb coordination stack.

## Scope

- **Keep:** coordination backend (mail, chat, tasks, work, roles, presence),
  MCP at `/mcp/`, dashboard read API, `awid` *as a library*.
- **Add:** simplified auth (one JWT token), an Epic→Story→Issue work hierarchy,
  and a web UI where humans + agents collaborate.
- **Drop:** team certificates, DIDs/namespaces/DNS, `awid` *as the identity service*.

## Locked decisions

1. **Auth:** Better Auth runs in the Next.js UI and **issues** JWTs; the FastAPI
   server and the `aw` CLI are pure **verifiers** (JWKS). Better Auth is
   TypeScript and cannot run inside the Python server, so the issuer lives with
   the UI; Python/Go only validate tokens.
2. **UI framework:** Next.js + React.
3. **Tasks → Issues:** existing `tasks` *become* issues, with a compat shim
   during migration.

## Build order

E1 → E2 → E3, with E4 (cutover) last. Auth is additive until E4 so nothing
breaks mid-flight. Granularity ceiling = Issue.

---

## EPIC 1 — Simplified Authentication
Humans log in with SSO; agents inherit one short-lived token. No certs/keys/DNS.

- **Story 1.1 — Human login**
  - Issue: OAuth/SSO login via Better Auth → JWT (`/auth/login`, `/auth/callback`)
  - Issue: token shape — `sub, team_ids, roles, agent_name?, exp, jti`; verified via JWKS
  - Issue: refresh flow + revocation denylist (kill by `jti`)
- **Story 1.2 — CLI login**
  - Issue: `aw login` browser/device flow → cache token in `~/.aw/token`, auto-refresh; `aw logout`
- **Story 1.3 — One auth path on the server**
  - Issue: extend the existing dashboard-JWT verifier into a single token dependency for REST + `/mcp/`
  - Issue: keep cert path behind a flag (additive) until cutover
- **Story 1.4 — Membership as data, not crypto**
  - Issue: team membership + role as DB rows; admin add/remove
  - Issue: scope every request by `token.team_ids` instead of by cert

## EPIC 2 — Work Hierarchy (Epic / Story / Issue)
Structured work on top of existing tasks. Issue is the floor.

- **Story 2.1 — Data model**
  - Issue: migration — `epics`, `stories`, `issues` (parent links, status, `assignee_type` human|agent, `assignee_id`, `team_id`)
  - Issue: migrate existing `tasks` → `issues`
- **Story 2.2 — API + MCP tools**
  - Issue: REST CRUD + list/filter by status/assignee
  - Issue: MCP tools so agents can read/claim/update issues (extend current tasks/work tools)
- **Story 2.3 — Assignment + flow**
  - Issue: assign to human or agent; status transitions (todo → in-progress → review → done)
  - Issue: one chat thread per issue (reuse existing chat)

## EPIC 3 — Web UI
The actual product surface; humans and agents as peers.

- **Story 3.1 — Shell + auth**
  - Issue: scaffold Next.js app, SSO login, team switcher
- **Story 3.2 — Hierarchy views**
  - Issue: board + list for Epic→Story→Issue, filter by assignee/status
  - Issue: issue detail = description + live activity thread + assignee
- **Story 3.3 — Human–agent collaboration**
  - Issue: presence (agents online), assign-to-agent, live agent activity (SSE off existing events)
  - Issue: approval gate UI for sensitive agent actions

## EPIC 4 — Cutover
Stop running awid-as-service; remove certs once tokens are proven.

- **Story 4.1 — Decouple**
  - Issue: separate awid-lib imports (keep) from awid-service identity calls (drop/stub)
  - Issue: remove cert issuance/verification after token path lands
- **Story 4.2 — Tests/journeys**
  - Issue: migrate e2e + unit tests from cert flow to token flow

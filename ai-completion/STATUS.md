# aweb — token-only pivot + full-app status ledger

_Branch: `feature/simple-auth-ui`. Local stack: UI :3030, aweb :8088, Postgres :5544, Redis :6390._
_Updated as work lands. "Validated" = independently re-run, not just self-reported._
_Last full E2E validation: 2026-06-15. No code changes were needed — every scenario passed against the existing stack._

## ✅ Completed (validated)

| Area | What | Proof |
|---|---|---|
| Auth (server) | Better Auth JWT is the only server auth; cert/DIDKey path removed | server suite pass (TEST_DB_PORT=5433); 401 without token |
| Auth (UI) — **A** | Login → token; protected-route redirect; wrong-password reject | Playwright `login.spec` (3 tests) green |
| Demo UI — **A** | Sidebar app-shell, nav, presence (appear online), chat | `demo.spec` SIDEBAR/ONLINE/CHAT green |
| Collab UI — **A** | Live human↔agent chat feed, roster, work board | `collab.spec` (3 tests) green |
| Humans + agents first-class — **A/D** | Both humans + both agents in roster with type badges | `complete.spec` MEMBERS; live UI Members page screenshot |
| Tasks | Epic→Story→Issue; assign to human OR agent; status; comments | `complete.spec` TASKS/COMMENTS |
| Chat (UI) | human↔human, human↔agent, agent↔agent render with badges | `complete.spec`, `demo.spec` |
| Console home (UI) | Real `/dashboard` overview: team composition + presence, work status counts + recent issues, recent chat activity, quick links — replaces the placeholder | `login.spec` "Console home" test; live Chrome screenshot |
| **Full Playwright suite — A** | 15/15 tests passed (login, demo, collab, complete + new Console home) | `npx playwright test` → `15 passed (28.1s)` |
| CLI port | `aw` token-only; cert/DID/bootstrap cluster removed; onboarding via token | `aw init` (4 identities) + mail/chat bearer e2e |
| E2E keys — all 4 identities | Founder, Mia, **Ada, Bob** all publish self-custodial key after `aw init` | live `/v1/agents`: all `custody=self` |
| Encrypted mail human↔human — **B** | Founder↔Mia, BOTH dirs: `encrypted_v2`, ciphertext-in-transit (0 plaintext rows), decrypt OK | transcripts below |
| Encrypted mail agent comms — **C** | Ada↔Bob and Ada↔Founder, BOTH dirs: `encrypted_v2`, 0 plaintext, decrypt OK | transcripts below |
| Chat agent↔human — **C** | Founder↔Ada chat send + read over CLI token path, both dirs | transcripts below |
| Web UI reflects agents — **D** | `/v1/agents` + `/v1/participants` + UI Members page show Ada/Bob with self keys | screenshot + API |

## Validation transcripts (2026-06-15)

### A — LOGIN / web Playwright
`cd ui && npx playwright test` → **15 passed (28.1s)**, 0 failed.
Includes: `login.spec` (4: redirect, wrong-password reject, login→dashboard→create issue, **Console home shows real team overview + work snapshot**),
`demo.spec` (3: sidebar, appear-online, chat), `collab.spec` (3), `complete.spec` (5: chat HH/HA, tasks, comments, members roster).
Console home (`/dashboard`) now renders a real at-a-glance overview (team counts + presence from `/v1/participants`, status counts + recent issues from `/v1/issues`, recent chat from `/v1/conversations`, quick links) instead of the old "Team console" placeholder.
(The `[e2e setup] sign-up → HTTP 403` lines are idempotent setup; users already exist. All tests pass.)

### B — Messaging (CLI encrypted, human↔human, both directions)
**B1 Founder→Mia** `aw mail send --to Mia --e2ee --subject HHtest --body HH-<nonce>`
→ `Sent mail ... message_id=31d6adb3-...`
DB row: `content_mode=encrypted_v2`, `subject`/`body` EMPTY, `encrypted_ciphertext` 563 bytes.
Plaintext leak scan across all text/json cols: **0 rows**.
Mia `aw mail inbox` → `default:local/Founder — HHtest: HH-<nonce>` (decrypted).

**B2 Mia→Founder** (reverse) → `message_id=273fbc03-...`, `encrypted_v2`, body empty, leak rows **0**,
Founder inbox decrypts → `HHrev: HH-<nonce>`.

### C — Agent communication
Onboarded Ada+Bob via `aw init` (per-user clean workspace + token); `/v1/agents` now lists all four with `custody=self`.

**C1a Ada→Bob** `--e2ee` → `encrypted_v2`, ct 559B, leak **0**; Bob inbox decrypts → `AB: AA-<nonce>`.
**C1b Bob→Ada** (reverse) → `encrypted_v2`, ct 559B, leak **0**; Ada inbox decrypts → `BA: BB-<nonce>`.
**C2a Ada→Founder** → `encrypted_v2`, ct 559B, leak **0**; Founder inbox decrypts → `AF: AF-<nonce>`.
**C2b Founder→Ada** (reverse) → `encrypted_v2`, ct 558B, leak **0**; Ada inbox decrypts → `FA: FA-<nonce>`.
**Chat** Founder→Ada `aw chat send-and-leave` → Ada `aw chat history Founder` shows `CHAT-<nonce>` + `aw chat pending` lists it unread.
Reverse Ada→Founder → Founder `aw chat history "Ada (agent)"` shows `CHATREV-<nonce>`.
(Chat lines render `[unverified]` — a signature display state, not a delivery failure; send+read both work.)

### D — Web UI / API reflects agent activity
- `/v1/agents`: Ada, Bob, Founder, Mia all `key=SET custody=self`.
- `/v1/participants`: all 4 listed with correct `agent_type` (Founder/Mia=human active/online, Ada/Bob=agent).
- UI Members page (logged in as Founder, active): "HUMANS 2" (Founder, Mia) + "AI AGENTS 2" (Ada engineer, Bob reviewer).
- DB encrypted-message peer pairs present: Ada↔Bob, Ada↔Founder, Founder↔Mia (all both directions).

## Gates
- `cd cli/go && go build ./...` → exit 0.
- `go test -c ./cmd/aw/` → compile exit 0 (no new failures vs baseline).
- `cd server && TEST_DB_PORT=5433 ... uv run pytest -q` → green (629 baseline; no server code changed).
- aweb `/health` → 200; UI `/` → 307 (redirect to login). No server restart needed (no code changes).

## Remaining / deferred
| Item | Status |
|---|---|
| Merge `feature/simple-auth-ui` → `main` | deferred (release decision; not auto-merged) |

## Notes
- No code fixes were required: login, encrypted messaging (both dirs), agent onboarding/comms (both dirs), and chat all worked against the existing CLI + server.
- Chat history shows `[unverified]` next to messages; cosmetic signature-verification display, deliveries succeed. Candidate follow-up if verified badges are desired in the CLI.
- Server tests need `TEST_DB_PORT=5433 TEST_DB_USER=postgres TEST_DB_PASSWORD=postgres`.

export const meta = {
  name: 'build-collab-product',
  description: 'Build the agent-collaboration UI (chat feed, members/presence, issue thread+assign) in parallel worktrees, merge, and live-test on :3030',
  phases: [
    { title: 'Contracts', detail: 'map backend API + create shared UI api helpers' },
    { title: 'Build', detail: '3 parallel worktree agents: chat / members / issue-thread' },
    { title: 'Integrate', detail: 'merge worktree branches + add navigation' },
    { title: 'Verify', detail: 'seed a human<->agent conversation, live-test, screenshot every page' },
  ],
}

const REPO = '/Users/fabricio/Desktop/aweb'
const UI = '/Users/fabricio/Desktop/aweb/ui'
const SERVER_ROUTES = '/Users/fabricio/Desktop/aweb/server/src/aweb/routes'
const BASE_BRANCH = 'feature/simple-auth-ui'
const STACK = 'UI=http://localhost:3030  aweb=http://localhost:8088  Postgres=localhost:5544 (PGPASSWORD=change-me -U aweb -d aweb)'
const CREDS = 'founder@local.test / Test1234!pass on team default:local'

const CONTRACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['committed', 'summary', 'shared_files', 'notes'],
  properties: {
    committed: { type: 'boolean' },
    summary: { type: 'string', description: 'Self-contained markdown the build agents will be given verbatim: every endpoint each feature needs (verb, path, request, response), how to use the shared helpers, how to read the active team, and the styling conventions.' },
    shared_files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['feature', 'branch', 'files_created', 'files_edited', 'typecheck', 'done', 'notes'],
  properties: {
    feature: { type: 'string' },
    branch: { type: 'string' },
    files_created: { type: 'array', items: { type: 'string' } },
    files_edited: { type: 'array', items: { type: 'string' } },
    endpoints_used: { type: 'array', items: { type: 'string' } },
    typecheck: { type: 'string', description: 'pass | fail: <detail>' },
    degraded: { type: 'string', description: 'anything that had no backend endpoint and was stubbed/omitted' },
    done: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merged_branches', 'nav_added', 'typecheck', 'done', 'notes'],
  properties: {
    merged_branches: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'string' },
    nav_added: { type: 'boolean' },
    typecheck: { type: 'string' },
    sha: { type: 'string' },
    done: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overall_passed', 'results', 'screenshots', 'seeded_conversation', 'notes'],
  properties: {
    overall_passed: { type: 'boolean' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'passed', 'detail'],
        properties: { name: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } },
      },
    },
    screenshots: { type: 'array', items: { type: 'string' }, description: 'absolute disk paths' },
    seeded_conversation: { type: 'string', description: 'what human<->agent messages were seeded so the feed is non-empty' },
    bugs_fixed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
phase('Contracts')
const contracts = await agent(
  `You are mapping the aweb backend API and preparing shared UI helpers so three parallel agents can build collaboration UI without colliding. You work on the MAIN checkout at ${REPO} (current branch ${BASE_BRANCH}). Stack: ${STACK}.

STEP 1 — Map the backend. Read these route files and extract, for each endpoint the UI needs, the HTTP verb, path, required request body/query, and response shape. Focus ONLY on what the three features below need; ignore federation/reservations/etc.
  - ${SERVER_ROUTES}/chat.py  and ${SERVER_ROUTES}/conversations.py and ${SERVER_ROUTES}/messages.py  -> the conversation/chat model (sessions, messages, sending). Determine the SIMPLEST way for the UI to (a) list conversations/sessions, (b) read messages in one, (c) send a message. Note whether a session needs a peer/recipient.
  - ${SERVER_ROUTES}/members.py and ${SERVER_ROUTES}/agents.py and ${SERVER_ROUTES}/status.py -> list team members, list agents, and any presence/online/last-seen/status. Note exactly which fields distinguish a human from an agent and what presence data (if any) exists.
  - ${SERVER_ROUTES}/hierarchy.py -> issue comment endpoints (the issue list shows comment_count, so comments exist somewhere — find the GET/POST comment endpoints) and the issue assignment fields (assignee_type/assignee_id on issues; how to set them — the PATCH issue endpoint).
  Note the auth contract: every aweb call needs Authorization: Bearer <jwt> AND the X-AWEB-Team-Id header. Confirm the exact team header name by reading ${UI}/src/lib/api/client.ts.

STEP 2 — Read the UI conventions so build agents match them:
  - ${UI}/src/lib/api/client.ts (the token mint via /api/auth/token, the request() helper, the team header)
  - ${UI}/src/lib/api/types.ts (existing types)
  - ${UI}/src/components/team-context.tsx (how a component reads the active team id: useTeam())
  - ${UI}/src/app/dashboard/layout.tsx and ${UI}/src/app/globals.css and ${UI}/src/components/work/work.module.css (styling: classes like .panel/.btn/.btn-primary and the CSS-module pattern)

STEP 3 — Create shared helpers (NEW files, do not modify client.ts):
  - ${UI}/src/lib/api/http.ts : export async getAccessToken(): Promise<string|null> and export async authedRequest<T>(path, opts?: {method?, query?, body?, teamId?}): Promise<T>. It mints the JWT from \`\${origin}/api/auth/token\` (same pattern as client.ts), prefixes NEXT_PUBLIC_AWEB_API_URL (default http://localhost:8088), and attaches Authorization: Bearer + the X-AWEB-Team-Id header (use the SAME header name client.ts uses). Reuse the ApiError pattern.
  - ${UI}/src/lib/api/members.ts : typed listMembers(teamId) and listAgents(teamId) wired to the REAL endpoints you found, using authedRequest. Export the member/agent TypeScript types too.

STEP 4 — Write ${UI}/CONTRACTS.md. It must be SELF-CONTAINED (build agents see only it + your summary). Include:
  - The exact endpoints for each of the 3 features (verb, path, request, response), copied from your STEP-1 findings.
  - How to import and use @/lib/api/http (authedRequest) and @/lib/api/members.
  - How to get the active team id in a client component (useTeam from @/components/team-context) and pass it as teamId.
  - Styling rules: reuse existing global classes (.panel, .btn, .btn-primary, .muted) and create a co-located *.module.css per component, matching ${UI}/src/components/work/work.module.css. Dark theme. Make it look like a real product (Linear-ish): clear headers, spacing, empty states.
  - HARD RULES for build agents: ONLY create files inside your assigned feature folders; the only pre-existing files you may edit are the ones explicitly assigned to your feature; NEVER edit client.ts, http.ts, members.ts, layout.tsx, team-context.tsx, or globals.css; navigation links are added later by the integrator, so do NOT touch the top bar/layout.

STEP 5 — Commit http.ts, members.ts, and CONTRACTS.md to ${BASE_BRANCH}:
  cd ${REPO} && git add ui/src/lib/api/http.ts ui/src/lib/api/members.ts ui/CONTRACTS.md && git commit -m "feat(ui): shared api helpers + CONTRACTS for collab build"

Return: committed=true, the full CONTRACTS.md content as \`summary\` (the build agents get this verbatim), shared_files, and notes (call out anything that has NO backend endpoint so features degrade gracefully).`,
  { label: 'contracts', phase: 'Contracts', schema: CONTRACTS_SCHEMA },
)

if (!contracts || !contracts.committed) {
  log('Contracts phase did not commit — aborting build to avoid worktrees missing shared helpers.')
  return { error: 'contracts-failed', contracts }
}
log('Contracts committed. Shared helpers + CONTRACTS.md ready. Fanning out 3 worktree build agents.')

const CONTRACT_SUMMARY = contracts.summary

// Common boilerplate every worktree build agent needs.
const worktreeSetup = (branch) => `You are in an ISOLATED git worktree (a separate checkout of this repo). Do all work here; you will be merged later.
SETUP (run first):
  cd "$(git rev-parse --show-toplevel)"
  git checkout -B ${branch} ${BASE_BRANCH}   # branch from the up-to-date base that has the shared helpers + CONTRACTS.md
  cd ui
  [ -e node_modules ] || ln -s ${UI}/node_modules ./node_modules   # reuse installed deps for typecheck
  [ -e .env.local ] || ln -s ${UI}/.env.local ./.env.local
  test -f CONTRACTS.md && test -f src/lib/api/http.ts && test -f src/lib/api/members.ts || { echo "MISSING shared files — base branch not up to date"; exit 1; }
Read ui/CONTRACTS.md in full before writing any code.
VERIFY GATE before you finish: run \`npm run typecheck\` from ui/ and make sure it reports NO errors in the files you created/edited. Fix until clean.
COMMIT on your branch: cd "$(git rev-parse --show-toplevel)" && git add -A && git commit -m "<feature commit message>".
Report your branch name as ${branch}.`

const CONTRACT_BLOCK = `\n\n==== CONTRACTS.md (authoritative API + rules) ====\n${CONTRACT_SUMMARY}\n==== end CONTRACTS ====\n`

phase('Build')
const builds = await parallel([
  () => agent(
    `${worktreeSetup('feat/chat')}
${CONTRACT_BLOCK}
FEATURE: Agent conversation feed (the headline screen — "see humans and AI agents talking").
Create ONLY these files:
  - ui/src/app/dashboard/chat/page.tsx  (route, client component)
  - ui/src/components/chat/*  (e.g. conversation-list.tsx, message-thread.tsx, message-composer.tsx, chat.module.css)
  - ui/src/lib/api/chat.ts  (wired to the REAL chat/conversation endpoints in CONTRACTS.md, via authedRequest)
Behavior: show conversations/sessions for the active team; selecting one shows its messages (sender alias/name, body, timestamp, visually distinguishing agent vs human senders); a composer posts a new message and the thread refreshes (poll every few seconds is fine; use the stream endpoint only if trivial). Clear empty state ("No conversations yet"). Match the dark product styling in CONTRACTS.md. Do NOT edit layout/top bar. If the chat model needs a recipient to start a conversation, let the user pick a team member (from @/lib/api/members). If something has no endpoint, degrade and note it.`,
    { label: 'build:chat', phase: 'Build', schema: BUILD_SCHEMA },
  ),
  () => agent(
    `${worktreeSetup('feat/members')}
${CONTRACT_BLOCK}
FEATURE: Members & presence ("humans and agents side-by-side as teammates").
Create ONLY these files:
  - ui/src/app/dashboard/members/page.tsx  (route, client component)
  - ui/src/components/members/*  (e.g. member-list.tsx, member-row.tsx, members.module.css)
Use @/lib/api/members (listMembers/listAgents) — do NOT redefine it. Behavior: list everyone on the active team, clearly tagging each row as Human or AI agent, showing role and any presence/online/last-seen/status that exists. If no presence endpoint exists, show role/status from membership and note the degrade. Nice product styling, avatars or a colored dot for agent vs human, clear empty state. Do NOT edit layout/top bar.`,
    { label: 'build:members', phase: 'Build', schema: BUILD_SCHEMA },
  ),
  () => agent(
    `${worktreeSetup('feat/issue-thread')}
${CONTRACT_BLOCK}
FEATURE: Issue conversation thread + assign-to-agent (where an agent picks up and discusses an issue).
Create these files:
  - ui/src/components/work/issue-thread.tsx  (comment thread + composer, agent vs human styling)
  - ui/src/components/work/assignee-picker.tsx  (assign the issue to a member/agent; uses @/lib/api/members)
  - ui/src/lib/api/comments.ts  (issue comment endpoints from CONTRACTS.md, via authedRequest)
You MAY edit ONLY this pre-existing file (no other agent touches it):
  - ui/src/app/dashboard/work/issues/[issueId]/page.tsx  -> render the issue, the AssigneePicker, and the IssueThread below it.
Behavior: open an issue, see its comments (sender, body, time; distinguish agent vs human), post a comment; pick an assignee (human or agent) which PATCHes the issue's assignee_type/assignee_id. Match styling. If the [issueId] page already loads the issue, extend it; otherwise fetch the issue via the existing work api/types. Note any missing endpoint as a degrade.`,
    { label: 'build:issue-thread', phase: 'Build', schema: BUILD_SCHEMA },
  ),
])

const okBuilds = builds.filter(Boolean)
log(`Build: ${okBuilds.length}/3 returned — ${okBuilds.map(b => `${b.feature}:${b.done ? 'done' : 'partial'}(${b.typecheck})`).join(' | ')}`)

phase('Integrate')
const buildSummary = okBuilds.map(b =>
  `- ${b.feature} on branch ${b.branch}: created ${(b.files_created || []).join(', ')}; edited ${(b.files_edited || []).join(', ') || '(none)'}; typecheck=${b.typecheck}; degraded=${b.degraded || 'none'}`,
).join('\n')

const integrate = await agent(
  `You are integrating three feature branches into ${BASE_BRANCH} on the MAIN checkout at ${REPO}, then adding navigation so the new screens are reachable. Stack is live: ${STACK} (the dev server on :3030 hot-reloads as you commit).

Build results:
${buildSummary}

STEP 1 — Merge each feature branch into ${BASE_BRANCH} (you are already on it):
  cd ${REPO}
  for b in feat/chat feat/members feat/issue-thread; do git merge --no-edit "$b" || { echo "CONFLICT in $b"; git status; }; done
  Resolve any conflicts. File boundaries were designed to be disjoint except the shared helpers (which only the Contracts commit created), so conflicts should be rare — if two branches both added the same shared file, keep one coherent version.

STEP 2 — Add navigation. Edit ${UI}/src/app/dashboard/layout.tsx (the authenticated top bar) to add links next to the team switcher: "Console" -> /dashboard, "Work" -> /dashboard/work, "Chat" -> /dashboard/chat, "Members" -> /dashboard/members. Use Next <Link>. Match the existing styling (small, muted, active-state if easy). This is the ONLY place nav is added.

STEP 3 — Verify the combined app typechecks: cd ${UI} && npm run typecheck. Fix every error (these are real integration bugs — wrong imports, type mismatches). Do not silence with \`any\` unless truly unavoidable.

STEP 4 — Commit: cd ${REPO} && git add -A && git commit -m "feat(ui): wire chat, members, and issue-thread screens into the dashboard nav".

Return merged_branches, whether nav was added, the final typecheck result (must be pass), the commit sha, done=true only if typecheck passes and all three screens are reachable from the nav, and notes on any conflicts resolved.`,
  { label: 'integrate', phase: 'Integrate', schema: INTEGRATE_SCHEMA },
)

log(`Integrate: ${integrate && integrate.done ? 'DONE' : 'ISSUES'} — nav=${integrate && integrate.nav_added} typecheck=${integrate && integrate.typecheck}`)

phase('Verify')
const verify = await agent(
  `You live-test the assembled collaboration product against the RUNNING stack and prove it works by seeding a real human<->agent conversation and screenshotting every screen. ${STACK}. Existing login creds: ${CREDS}. The dev server on :3030 already serves the merged code.

SETUP / SEED a human<->agent conversation (so the feeds are non-empty and visibly show two parties talking):
  1. Ensure two identities exist with active membership on team default:local:
     - founder@local.test (the human, already exists)
     - ada@local.test / Test1234!pass (a stand-in AI agent teammate). Create via: curl -s -X POST http://localhost:3030/api/auth/sign-up/email -H 'content-type: application/json' -d '{"email":"ada@local.test","password":"Test1234!pass","name":"Ada (agent)"}' (tolerate 403 if exists). Then seed its membership in Postgres: look up its id from aweb."user" by email and INSERT into aweb.memberships (subject, team_id, role, status) VALUES (<id>,'default:local','member','active') ON CONFLICT DO UPDATE SET status='active'. (psql -h localhost -p 5544 -U aweb -d aweb, PGPASSWORD=change-me.)
  2. For EACH identity, sign in (POST /api/auth/sign-in/email with its creds, keep its cookie jar) and mint a JWT (GET /api/auth/token). Now you can call aweb :8088 AS each party (Authorization: Bearer <jwt>, X-AWEB-Team-Id: default:local — confirm the header name from ${UI}/CONTRACTS.md).
  3. Read ${UI}/CONTRACTS.md to learn the exact chat + comment endpoints. Using the two tokens, POST an alternating conversation (3-4 messages) between founder and ada in a chat session/conversation, AND post 2-3 alternating comments from founder and ada on an existing issue (list issues via GET /v1/issues; pick one). Also PATCH that issue to assign it to ada (assignee_type/assignee_id per CONTRACTS.md). This makes the chat feed, the issue thread, and the assignee visibly populated.

LIVE BROWSER TEST — use Playwright (already installed in ${UI}; config at ${UI}/playwright.config.ts, artifacts go to ${UI}/e2e/artifacts). Add a spec ${UI}/e2e/collab.spec.ts that logs in as founder (reuse the placeholder/role selectors from ${UI}/e2e/login.spec.ts) and:
  - Navigates to /dashboard/chat: asserts the seeded conversation is visible (both senders' messages). Screenshot to e2e/artifacts/10-chat.png.
  - Navigates to /dashboard/members: asserts both founder and Ada appear and that humans vs agents are distinguishable. Screenshot 11-members.png.
  - Opens the issue you seeded (navigate /dashboard/work, click into it, or go to /dashboard/work/issues/<id>): asserts the comment thread shows the seeded comments and the assignee shows Ada. Screenshot 12-issue-thread.png.
  - Also screenshot the work board 13-board.png.
  Run: cd ${UI} && npx playwright test e2e/collab.spec.ts. If a test fails because of a real UI bug (not a selector typo), FIX the UI/code on this main checkout, re-run until green. If it is a selector/locator mismatch, fix the spec. Cap fixes at a few rounds; if a screen is fundamentally broken, report it clearly rather than looping forever.

After green, commit: cd ${REPO} && git add -A && git commit -m "test(ui): live collab E2E (chat feed, members, issue thread) + fixes".

Return overall_passed, per-screen results, the absolute screenshot paths under ${UI}/e2e/artifacts, what conversation you seeded, any bugs you fixed, and notes.`,
  { label: 'verify', phase: 'Verify', schema: VERIFY_SCHEMA },
)

log(`Verify: ${verify && verify.overall_passed ? 'PASS' : 'ISSUES'} — ${verify ? verify.results.map(r => `${r.name}:${r.passed ? 'ok' : 'x'}`).join(' ') : 'no result'}`)

return {
  contracts: { committed: contracts.committed, shared_files: contracts.shared_files },
  builds: okBuilds.map(b => ({ feature: b.feature, branch: b.branch, done: b.done, typecheck: b.typecheck, degraded: b.degraded })),
  integrate,
  verify,
  overall: !!(integrate && integrate.done && verify && verify.overall_passed),
}

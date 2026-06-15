export const meta = {
  name: 'complete-collab-product',
  description: 'Make humans first-class participants (chat/comments/tasks), close UI degrades, and validate humans+agents+tasks+chats+UI end-to-end',
  phases: [
    { title: 'Audit', detail: 'confirm participant model, define the contract + definition-of-done' },
    { title: 'Implement', detail: 'parallel worktrees: backend humans-first-class + UI (chat/members + issue/assign)' },
    { title: 'Integrate', detail: 'merge worktrees, server tests + ui typecheck' },
    { title: 'Validate', detail: 'restart stack, seed multi-party, E2E across every surface, loop-until-green' },
  ],
}

const REPO = '/Users/fabricio/Desktop/aweb'
const UI = '/Users/fabricio/Desktop/aweb/ui'
const SERVER = '/Users/fabricio/Desktop/aweb/server'
const ROUTES = '/Users/fabricio/Desktop/aweb/server/src/aweb/routes'
const MIGRATIONS = '/Users/fabricio/Desktop/aweb/server/src/aweb/migrations/aweb'
const BASE_BRANCH = 'feature/simple-auth-ui'
const STACK = 'UI=http://localhost:3030  aweb=http://localhost:8088  Postgres=localhost:5544 (PGPASSWORD=change-me -U aweb -d aweb)  Redis=localhost:6390'
const KEY_FACT = 'The aweb `agents` table is really a PARTICIPANT/identity table: columns include agent_id, team_id, did_key, did_aw, address, alias, human_name, agent_type, role, status, inbound_mode, identity_scope. Chat/messages route to recipients by alias/address/did pulled from this table. So a HUMAN becomes a first-class chat/comment participant by having a row here (agent_type marking it human, human_name + alias + address set) — provisioned automatically when a human gets an active membership or first authenticates. NO key ceremony, NO certs.'
const MIGRATION_RULE = `Schema changes = a NEW numbered SQL file in ${MIGRATIONS} (e.g. 0NN_humans_as_participants.sql). NEVER edit an existing migration (pgdbm checksums them and refuses to boot on a changed file).`

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['committed', 'contract', 'definition_of_done', 'risks', 'notes'],
  properties: {
    committed: { type: 'boolean', description: 'true if AUDIT.md / contract was written+committed to the base branch' },
    contract: { type: 'string', description: 'Self-contained spec the build lanes implement to: the participant-directory shape (fields incl. a definitive human-vs-agent type), how humans get auto-provisioned, the exact chat/comment/members/assign endpoint behaviors for humans, and the API field names both backend and UI must agree on.' },
    definition_of_done: { type: 'array', items: { type: 'string' }, description: 'concrete, checkable end-to-end criteria across humans, agents, tasks, chats, UI' },
    risks: { type: 'string' },
    notes: { type: 'string' },
  },
}
const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lane', 'branch', 'files', 'checks', 'done', 'notes'],
  properties: {
    lane: { type: 'string' },
    branch: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    checks: { type: 'string', description: 'typecheck / unit-test results — must be green for the files in this lane' },
    degraded: { type: 'string' },
    done: { type: 'boolean' },
    notes: { type: 'string' },
  },
}
const INTEGRATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['merged', 'server_tests', 'ui_typecheck', 'done', 'notes'],
  properties: {
    merged: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'string' },
    server_tests: { type: 'string' },
    ui_typecheck: { type: 'string' },
    sha: { type: 'string' },
    done: { type: 'boolean' },
    notes: { type: 'string' },
  },
}
const VALIDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['overall_passed', 'matrix', 'screenshots', 'seeded', 'bugs_fixed', 'remaining_gaps', 'notes'],
  properties: {
    overall_passed: { type: 'boolean', description: 'true ONLY if every definition-of-done item is validated green' },
    matrix: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['scenario', 'passed', 'detail'],
        properties: { scenario: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } },
      },
    },
    screenshots: { type: 'array', items: { type: 'string' } },
    seeded: { type: 'string' },
    bugs_fixed: { type: 'array', items: { type: 'string' } },
    remaining_gaps: { type: 'array', items: { type: 'string' }, description: 'anything still NOT working end-to-end (empty if 100% done)' },
    notes: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
phase('Audit')
const audit = await agent(
  `You are the architect closing the gaps so this collaboration product works end-to-end for HUMANS and AGENTS alike. Work on the MAIN checkout at ${REPO} (branch ${BASE_BRANCH}). Stack live: ${STACK}.

KEY FACT (verified): ${KEY_FACT}

KNOWN DEGRADES to eliminate (from the last build):
  1. Humans cannot be chat recipients (chat targets agents by alias; humans have no participant identity).
  2. Human member roster is admin-gated and shows a raw auth subject instead of a name; messages/comments have NO authoritative human-vs-agent flag (the UI guesses by matching the sender alias against the agent list).
  3. Issue assignee picker can't assign to humans (only agents appear).

YOUR JOB — investigate and DECIDE the minimal, SAFE design (do not ask anyone):
  - Read ${ROUTES}/chat.py, conversations.py, messages.py, members.py, agents.py, hierarchy.py and the services behind them (server/src/aweb/coordination/*). Confirm exactly where/how a participant identity is created for agents, and what it takes to auto-provision one for a human on active membership (or first authenticated request). Prefer reusing the existing agents/participant table + human_name/agent_type over any new table.
  - Decide the definitive human-vs-agent type signal exposed to the UI (e.g. agent_type value, or a kind field) so the UI never guesses.
  - Decide how humans become selectable chat recipients and issue assignees, and how their comments/messages attribute correctly.
  - ${MIGRATION_RULE}
  - Do NOT break existing agent messaging or the passing server test suite.

OUTPUT:
  - Write ${REPO}/ai-completion/AUDIT.md with: the chosen design, the exact API CONTRACT (endpoint behaviors + field names) that the backend lane and the UI lanes must both implement to, and a concrete Definition-of-Done checklist spanning humans, agents, tasks, chats, UI (each item must be end-to-end checkable). Create the ai-completion/ dir.
  - Commit it: cd ${REPO} && mkdir -p ai-completion && git add ai-completion/AUDIT.md && git commit -m "docs: completion audit + humans-first-class contract".

Return committed=true, the full contract text (the build lanes get it verbatim), the definition_of_done array, risks, and notes.`,
  { label: 'audit', phase: 'Audit', schema: AUDIT_SCHEMA },
)

if (!audit || !audit.committed) {
  log('Audit did not commit a contract — aborting so build lanes are not uncoordinated.')
  return { error: 'audit-failed', audit }
}
log(`Audit committed. DoD has ${audit.definition_of_done.length} criteria. Fanning out build lanes.`)

const CONTRACT = `\n\n==== COMPLETION CONTRACT (authoritative — implement to this) ====\n${audit.contract}\n\nDEFINITION OF DONE:\n${audit.definition_of_done.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n==== end ====\n`

const setup = (branch) => `You are in an ISOLATED git worktree. SETUP first:
  cd "$(git rev-parse --show-toplevel)"
  git checkout -B ${branch} ${BASE_BRANCH}
Read ${REPO}/ai-completion/AUDIT.md fully before coding. Implement strictly to the contract below so the other lanes integrate cleanly.
COMMIT on your branch when green: cd "$(git rev-parse --show-toplevel)" && git add -A && git commit -m "<message>". Report branch=${branch}.`

phase('Implement')
const builds = await parallel([
  // --- Backend lane: humans become first-class participants ---
  () => agent(
    `${setup('feat/humans-backend')}
${CONTRACT}
LANE: BACKEND — make humans first-class participants. Work only under ${SERVER}.
Implement the contract's server side: auto-provision a participant identity for a human on active membership/first-auth (reuse the agents/participant table; human_name + alias + address + a definitive human type), expose the human-vs-agent type on the members/agents/chat/comment payloads, let chat + comments + issue-assignment accept humans, and make the basic team roster return humans without requiring admin.
  - ${MIGRATION_RULE}
  - Add/extend tests under ${SERVER}/tests for: human gets provisioned, human can be a chat recipient, human comment attributes as human, issue assignable to a human.
VERIFY GATE: cd ${SERVER} && uv run pytest -q must pass (no regressions). Report the result in checks. If a migration was added, confirm the server still boots/migrates cleanly.`,
    { label: 'impl:backend', phase: 'Implement', schema: BUILD_SCHEMA },
  ),
  // --- UI lane A: chat + members ---
  () => agent(
    `${setup('feat/humans-ui-chat')}
${CONTRACT}
LANE: UI chat + members. Work only under ${UI}. Setup deps: cd ${UI} && ([ -e node_modules ] || ln -s ${UI}/node_modules ./node_modules) && ([ -e .env.local ] || ln -s ${UI}/.env.local ./.env.local).
Update to the contract:
  - Chat (src/app/dashboard/chat/*, src/components/chat/*, src/lib/api/chat.ts): let users start/continue conversations with HUMANS and agents (use the participant directory + type from the contract); render each message's author type from the authoritative field (no alias-guessing).
  - Members (src/app/dashboard/members/*, src/components/members/*, src/lib/api/members.ts): list humans + agents with correct type + display name (not a raw subject) + role + presence; basic roster must not break for non-admins.
  Only edit files in those areas; do not touch the issue/work files (another lane owns them) or layout/topbar.
VERIFY GATE: cd ${UI} && npm run typecheck must be clean. Report in checks.`,
    { label: 'impl:ui-chat', phase: 'Implement', schema: BUILD_SCHEMA },
  ),
  // --- UI lane B: issue thread + assignee (humans) ---
  () => agent(
    `${setup('feat/humans-ui-issue')}
${CONTRACT}
LANE: UI issue thread + assignment. Work only under ${UI}. Setup deps: cd ${UI} && ([ -e node_modules ] || ln -s ${UI}/node_modules ./node_modules) && ([ -e .env.local ] || ln -s ${UI}/.env.local ./.env.local).
Update to the contract:
  - Issue thread (src/components/work/issue-thread.tsx, src/lib/api/comments.ts): attribute each comment's author type from the authoritative field, not by guessing.
  - Assignee picker (src/components/work/assignee-picker.tsx): offer HUMANS and agents as assignees (from the participant directory), and persist assignee_type/assignee_id for humans too.
  - You may edit src/app/dashboard/work/issues/[issueId]/page.tsx and src/components/work/board-view.tsx (assignee chip) — no other lane touches these. Do not touch chat/members files or layout/topbar.
VERIFY GATE: cd ${UI} && npm run typecheck must be clean. Report in checks.`,
    { label: 'impl:ui-issue', phase: 'Implement', schema: BUILD_SCHEMA },
  ),
])

const okBuilds = builds.filter(Boolean)
log(`Implement: ${okBuilds.length}/3 — ${okBuilds.map(b => `${b.lane}:${b.done ? 'done' : 'partial'}(${b.checks})`).join(' | ')}`)

phase('Integrate')
const buildList = okBuilds.map(b => `- ${b.lane} on ${b.branch}: ${(b.files || []).join(', ')}; checks=${b.checks}`).join('\n')
const integrate = await agent(
  `Integrate the completion lanes into ${BASE_BRANCH} on the MAIN checkout at ${REPO}. Stack is live (${STACK}).
Build lanes:
${buildList}

  1. Merge each branch: cd ${REPO}; for b in feat/humans-backend feat/humans-ui-chat feat/humans-ui-issue; do git merge --no-edit "$b" || { echo CONFLICT $b; git status; }; done. Resolve conflicts coherently (lanes were scoped disjoint: server/ vs ui chat/members vs ui work/issues).
  2. Server tests: cd ${SERVER} && uv run pytest -q — must pass. Fix real regressions.
  3. UI typecheck: cd ${UI} && npm run typecheck — must be clean. Fix integration errors (no blanket \`any\`).
  4. Commit: cd ${REPO} && git add -A && git commit -m "feat: humans as first-class participants across chat, comments, and tasks".
Return merged branches, server_tests + ui_typecheck results, the sha, done=true only if BOTH suites are green, and notes on conflicts.`,
  { label: 'integrate', phase: 'Integrate', schema: INTEGRATE_SCHEMA },
)
log(`Integrate: ${integrate && integrate.done ? 'DONE' : 'ISSUES'} — server=${integrate && integrate.server_tests} ui=${integrate && integrate.ui_typecheck}`)

phase('Validate')
const validate = await agent(
  `You prove the WHOLE product works end-to-end and you do NOT pass unless every Definition-of-Done item is green. Main checkout ${REPO}, stack ${STACK}.
${CONTRACT}

  1. Apply backend changes to the running server: the aweb backend on :8088 must run the merged code + any new migration. Restart it — discover how it's currently run (ps eww on the :8088 pid, or ${SERVER}/.env) and relaunch it the SAME way (token-auth issuer http://localhost:3030, audience http://localhost:8088, JWKS http://localhost:3030/api/auth/jwks, Postgres :5544, Redis :6390, AWID unreachable is fine). Confirm migrations applied and /health is 200. The Next UI on :3030 hot-reloads.
  2. Seed a MULTI-PARTY team on default:local so every pairing is exercised: the human founder@local.test (admin), a SECOND human user (e.g. mia@local.test / Test1234!pass, sign up + active membership), the agent ada@local.test, and a SECOND agent (provision one via the participant/agents path). Sign in as each human to mint JWTs; for agents use their participant tokens/identities as the contract specifies.
  3. Exercise and ASSERT, via API + the live browser (Playwright; config at ${UI}/playwright.config.ts, add e2e/complete.spec.ts; artifacts ${UI}/e2e/artifacts):
     - CHAT: human<->agent, human<->human, agent<->agent — messages send AND render with correct author + type tags. Screenshot 20-chat-human-human.png and 21-chat-human-agent.png.
     - TASKS: create an issue, assign it to a HUMAN and (a second one) to an AGENT, change status across columns, and confirm it persists + renders. Screenshot 22-board.png.
     - COMMENTS: a human and an agent each comment on a task; both attribute with the correct HUMAN/AGENT badge from the authoritative field. Screenshot 23-issue-thread.png.
     - MEMBERS: roster shows both humans (by name) and both agents with correct type + presence. Screenshot 24-members.png.
     - LOGIN/regression: existing e2e suite (npx playwright test) all green; server pytest green.
  4. If anything fails because of a real bug, FIX it on this main checkout (UI or server) and re-run. LOOP until everything is green; only stop fixing when the full matrix passes or you hit a genuine blocker you cannot resolve (then report it precisely in remaining_gaps).
  5. Commit: cd ${REPO} && git add -A && git commit -m "test: full end-to-end validation across humans, agents, tasks, chats, UI".

Return overall_passed (true ONLY if the entire matrix is green and remaining_gaps is empty), the matrix, screenshot paths, what you seeded, bugs fixed, and remaining_gaps (empty == 100% done).`,
  { label: 'validate', phase: 'Validate', schema: VALIDATE_SCHEMA },
)
log(`Validate: ${validate && validate.overall_passed ? 'ALL GREEN' : 'GAPS REMAIN'} — ${validate ? validate.matrix.map(m => `${m.scenario}:${m.passed ? 'ok' : 'x'}`).join(' ') : 'no result'}`)

return {
  audit: { committed: audit.committed, dod: audit.definition_of_done },
  builds: okBuilds.map(b => ({ lane: b.lane, branch: b.branch, done: b.done, checks: b.checks })),
  integrate,
  validate,
  complete: !!(integrate && integrate.done && validate && validate.overall_passed && validate.remaining_gaps.length === 0),
}

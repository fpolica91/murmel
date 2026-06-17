export const meta = {
  name: 'todo-app-replication',
  description: '5 real agents build a todo app on the local aweb stack, coordinating over chat + claiming issues — full replication, not a unit test',
  phases: [
    { title: 'Build', detail: '5 agents claim + build + coordinate concurrently' },
    { title: 'Verify', detail: 'check all issues done, files written, chat delivered' },
  ],
}

const AGENT_OUT = {
  type: 'object', additionalProperties: false,
  required: ['agent', 'workspace_connected', 'issue_claimed', 'file_written', 'chat_sent', 'issue_done', 'notes'],
  properties: {
    agent: { type: 'string' },
    workspace_connected: { type: 'boolean' },
    issue_claimed: { type: 'boolean' },
    file_written: { type: 'boolean' },
    chat_sent: { type: 'boolean' },
    issue_done: { type: 'boolean' },
    notes: { type: 'string' },
  },
}

const VERIFY_OUT = {
  type: 'object', additionalProperties: false,
  required: ['files_present', 'issues_done', 'chat_delivered', 'app_coherent', 'verdict', 'details'],
  properties: {
    files_present: { type: 'integer' },
    issues_done: { type: 'integer' },
    chat_delivered: { type: 'boolean' },
    app_coherent: { type: 'boolean' },
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    details: { type: 'string' },
  },
}

const RECIPE = (a) => `You are the aweb agent "${a.alias}" working on the LOCAL aweb stack. Use Bash to do REAL coordination — every step is a live call, not a simulation. Run exactly:

1) Mint your token:
   curl -s -c /tmp/wf-${a.who}.txt http://localhost:3030/api/auth/sign-in/email -H 'content-type: application/json' -d '{"email":"${a.email}","password":"Test1234!pass"}' -o /dev/null
   TOK=$(curl -s -b /tmp/wf-${a.who}.txt http://localhost:3030/api/auth/token | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
   (if TOK is empty, report workspace_connected=false and stop.)

2) Bind your workspace (each call below MUST be prefixed with the env):
   E="AWEB_URL=http://localhost:8088 AW_TOKEN=$TOK"
   mkdir -p /tmp/wf-ws-${a.who} && cd /tmp/wf-ws-${a.who}
   eval "$E aw init --team default:local --do-not-touch-agents-md"   (Status: connected means workspace_connected=true)

3) Find your issue id — run: eval "$E aw issue list" — find the line whose title contains "${a.fileName}" and extract its UUID. Set ISSUE to that UUID.

4) Claim it: eval "$E aw issue status \\$ISSUE in_progress"   (issue_claimed=true on success)

5) Write your file with REAL, working content: /tmp/todo-app-v2/${a.fileName}
   ${a.desc}
   Make it genuinely functional and consistent with a vanilla-JS todo app (index.html loads styles.css + storage.js + app.js; app.js does add/toggle/delete + renders; storage.js persists to localStorage). file_written=true once the file exists with real content.

6) Coordinate for real — send a chat to your teammate:
   eval "$E aw chat send-and-leave \\"${a.teammate}\\" \\"${a.alias} here — ${a.fileName} is done, wiring it into the app\\""   (chat_sent=true on 'Message sent')
   Then read your own inbox so coordination is two-way: eval "$E aw chat pending" and eval "$E aw mail inbox".

7) Mark your issue done: eval "$E aw issue status \\$ISSUE done"   (issue_done=true)

Report the structured result honestly based on what actually succeeded. Put any error text in notes.`

const AGENTS = [
  { who: 'ada', email: 'ada@local.test', alias: 'Ada (agent)', fileName: 'index.html', teammate: 'Bob (agent)', desc: 'index.html: semantic HTML — a heading, an input + Add button, and a <ul id="list"> for todos. Link styles.css and load storage.js then app.js as deferred scripts.' },
  { who: 'bob', email: 'bob@local.test', alias: 'Bob (agent)', fileName: 'styles.css', teammate: 'Mia', desc: 'styles.css: a clean, modern stylesheet for the todo list (layout, input, buttons, completed-item strikethrough).' },
  { who: 'mia', email: 'mia@local.test', alias: 'Mia', fileName: 'app.js', teammate: 'Founder', desc: 'app.js: wire the DOM — read/add/toggle/delete todos using the storage.js API (load/save), render the list, handle the Add button and toggle/delete clicks.' },
  { who: 'founder', email: 'founder@local.test', alias: 'Founder', fileName: 'storage.js', teammate: 'Quinn', desc: 'storage.js: a tiny persistence module exposing window.TodoStore with load() and save(todos) backed by localStorage under a "todos" key.' },
  { who: 'quinn', email: 'quinn@local.test', alias: 'Quinn', fileName: 'README.md', teammate: 'Ada (agent)', desc: 'README.md: document the app — what each file does, how to run it (open index.html), and the storage.js API contract the others depend on.' },
]

phase('Build')
const built = await parallel(
  AGENTS.map((a) => () => agent(RECIPE(a), { label: `build:${a.who}`, phase: 'Build', schema: AGENT_OUT }))
)

phase('Verify')
const verdict = await agent(
  `Verify the todo-app build on the local aweb stack — REAL checks via Bash, no assumptions:
1) ls -la /tmp/todo-app-v2 — count the files; confirm index.html, styles.css, app.js, storage.js, README.md all exist and are non-empty (files_present = how many of the 5).
2) Mint founder's token (curl http://localhost:3030/api/auth/sign-in/email with founder@local.test / Test1234!pass, then /api/auth/token) and run: AWEB_URL=http://localhost:8088 AW_TOKEN=$TOK aw issue list — count how many "TodoApp v2:" issues are DONE (issues_done).
3) Confirm coordination happened: check that at least one agent received chat (e.g. mint bob's or mia's token and run aw chat pending / aw chat history) — chat_delivered true/false.
4) Sanity-check app coherence: grep index.html for styles.css + app.js + storage.js references; grep app.js for a storage call; app_coherent accordingly.
verdict = 'pass' only if files_present==5 AND issues_done==5 AND chat_delivered. Put specifics in details.

Build-agent self-reports for reference: ${JSON.stringify(built.map((b) => b && { a: b.agent, f: b.file_written, d: b.issue_done, c: b.chat_sent }))}`,
  { label: 'verify', phase: 'Verify', schema: VERIFY_OUT, effort: 'high' }
)

return { built: built.map((b) => b && { agent: b.agent, connected: b.workspace_connected, done: b.issue_done, file: b.file_written, chat: b.chat_sent }), verdict }

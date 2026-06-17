# Live multi-agent test workflows (the real-test benchmark)

Unit tests (`make test`, pytest) are necessary but **not sufficient** for changes
to coordination, messaging, team scoping, auth, or membership. A change isn't
"tested" until it's verified by a **live multi-agent simulation on the local
stack** — real agents minting real tokens and coordinating over the running
platform, plus an adversary actively trying to break tenant isolation.

These two workflows are that benchmark. They run via the Claude Code **Workflow**
tool against the **local stack on `:8088`**, not against unit-test fixtures.

- **`todo-app-replication.js`** — 5 real agents (ada/bob/mia/founder/quinn) each
  mint a token, bind a workspace, claim an issue, build a todo-app file, send a
  chat to a teammate, and mark their issue done. Proves coordination
  (issues + chat + mail) works end-to-end after a change.
- **`adversarial-infiltration.js`** — an outsider (`mallory`, member of only her
  own team) runs 5 red-team agents that try to infiltrate `default:local`:
  spoof `X-AWEB-Team-Id`, direct-object exfil by id, write/inject, cross-team
  message, and a raw MCP call. A judge agent fails the run on **any** breach
  (a 2xx returning another team's data, or a delivered write into it).

## Prerequisites (local stack on the fixed code)

1. Local aweb on `:8088` running the current code (restart from `server/` with
   the env captured from the dev process — DB `aweb:change-me@localhost:5544`,
   redis `:6390`, token-auth via the local UI `:3030`, `AWEB_MEMBERSHIPS_HINT_KEY=devhintkey`).
   Migrations apply on boot.
2. Local UI on `:3030` (mints tokens: `POST /api/auth/sign-in/email` →
   `GET /api/auth/token`). Seed accounts `founder|ada|bob|mia@local.test`,
   password `Test1234!pass`, all members of `default:local`.

## Setup before each run (creates agents, issues, and attack targets)

The inline Bash setup (run before launching the workflows):

- **todo replication:** ensure a 5th agent (`quinn@local.test`) exists and is a
  member of `default:local`; `founder` creates 5 `TodoApp v2:` issues (one per
  agent); clear `/tmp/todo-app-v2`.
- **adversarial:** ensure `mallory@local.test` exists in only her own personal
  team (NOT `default:local`); gather real `default:local` target ids — a
  `chat_sessions.session_id`, an `issues.issue_id`, a `messages.conversation_id`
  — and paste them into the `T` object at the top of `adversarial-infiltration.js`.

The token-mint + CLI pattern each agent uses:

```bash
curl -s -c ck.txt http://localhost:3030/api/auth/sign-in/email \
  -H 'content-type: application/json' \
  -d '{"email":"ada@local.test","password":"Test1234!pass"}' -o /dev/null
TOK=$(curl -s -b ck.txt http://localhost:3030/api/auth/token \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
AWEB_URL=http://localhost:8088 AW_TOKEN=$TOK aw init --team default:local --do-not-touch-agents-md
AWEB_URL=http://localhost:8088 AW_TOKEN=$TOK aw issue list   # etc.
```

## Run

Invoke each via the Workflow tool with its `scriptPath`:

```
Workflow({ scriptPath: "scripts/test-workflows/todo-app-replication.js" })
Workflow({ scriptPath: "scripts/test-workflows/adversarial-infiltration.js" })
```

## Pass criteria

- **todo replication:** all 5 files written, all 5 issues `done`, chat delivered
  between agents (verdict `pass`).
- **adversarial:** judge verdict `sealed` — **zero** breaches across all 5
  vectors. Any `breached` result is a release blocker.

Run both after any change to coordination / messaging / team scoping / auth /
membership, in addition to `make test`.

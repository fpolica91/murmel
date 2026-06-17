# Agent Instructions

<!-- AWEB:START -->
## aweb Coordination Rules

This project uses `aw` for coordination.

## Start Here

```bash
aw workspace status
aw work ready
aw mail inbox
aw roles show
```

## Shared Rules

- Use `aw` for coordination work
- Treat `.aw/workspace.yaml` as the repo-local coordination identity for this worktree
- Default to mail for non-blocking coordination: `aw mail send --to <agent> --body "..."`
- Use chat when you need a synchronous answer: `aw chat pending`, `aw chat send-and-wait <agent> "..."`
- Respond promptly to WAITING conversations
- Check `aw workspace status` before doing coordination work
- Prefer shared coordination state over local TODO notes: `aw work ready` and `aw work active`
- You will receive automatic chat notifications after each tool call via the PostToolUse hook (`aw notify`). Respond promptly when notified.

## Mail

```bash
aw mail send --to <alias> --body "message"
aw mail send --to <alias> --subject "API design" --body "message"
aw mail inbox
```

## Chat

```bash
aw chat send-and-wait <alias> "question" --start-conversation
aw chat send-and-wait <alias> "response"
aw chat send-and-leave <alias> "thanks, got it"
aw chat pending
aw chat open <alias>
aw chat history <alias>
aw chat extend-wait <alias> "need more time"
```

## Identity

Never run `aw` from another workspace or worktree when doing coordination work.

`aw` derives coordination context from `.aw/workspace.yaml` in the current worktree. Running `aw` from another repo or worktree can impersonate that workspace's agent, causing:

- Messages sent as the wrong agent
- Work claimed under the wrong identity
- Confusion in coordination

## Teamwork

You are part of a team working toward a shared goal. Optimize for the project outcome, not your individual activity.

- Help teammates when they're blocked
- Escalate blockers early rather than spinning alone
- Keep changes small and reviewable so others can build on them
<!-- AWEB:END -->

## Branches and code reviews

NEVER make work in progress or temp branches. You have been assigned a worktree and a branch, ALWAYS stay there and work there. If you are in main, stay in main; main is the combined shared branch.

Whenever you finish a task make sure that:

- You stand back and review the code;
- You merge your branch to main;
- You merge main back to your branch.

This is VERY important. It is impossible to keep many agents coordinated if they do not keep their branches in sync with main.

## Database migrations

awid uses a single consolidated migration file
(`awid/src/awid_service/migrations/001_registry.sql`). pgdbm hashes every
applied migration and refuses to boot when the bundled file's checksum
disagrees with the row in `schema_migrations`. So:

- **Every additive schema change is a NEW ordered file** —
  `002_<name>.sql`, `003_<name>.sql`, ...
- **Never edit the existing `001_registry.sql` for schema changes.**
  Comment/whitespace fixes are fine. Anything that alters DDL is not.
- **Editing 001 in place forces a destructive dump-restore cutover.**
  This already happened once: the aala epic added
  `team_certificates.certificate TEXT` by editing 001, which forced
  the awid prod 0.3.1→0.5.1 cutover on 2026-04-25 (see
  `ai.aweb/docs/decisions.md`). Recovery escape hatch is
  `awid/scripts/prod_db_reset.py` + Makefile targets `awid-prod-*`,
  but the cost of needing it is real downtime.

If you genuinely need to fold changes back into a fresh consolidated
001 (e.g. another consolidation pass), that is a planned cutover with
coordination — not a quiet edit. Escalate to coord-aweb (John) or
coord-awid (Goto) before touching the file.

<!-- The sections below are guidance for Claude Code (claude.ai/code).
     CLAUDE.md is a symlink to this file. -->

## Repository Architecture

aweb is a coordination platform for AI coding agents, split into four
deployable products plus shared packaging. Identity lives in `awid`;
coordination state lives in `aweb`. The split is the central design
fact: `awid` never holds mail/chat/tasks, and `aweb` never issues
certificates.

- **`server/`** — the `aweb` coordination server. FastAPI + PostgreSQL +
  Redis (Python ≥3.12). Owns mail, chat, tasks, work discovery, roles,
  instructions, locks, contacts, presence. Exposes a REST API *and* mounts
  a Streamable HTTP MCP endpoint at `/mcp/`. Code layout under
  `server/src/aweb/`: `routes/` (REST handlers), `coordination/` (the
  domain services behind those routes), `mcp/` (MCP server, auth, signing,
  and the `tools/` agents call), `messaging/` (v2 encrypted message
  routing), `federation/` (cross-server mail/chat), `migrations/`.
  Authentication is by **bearer token (Better Auth JWT)** — the token
  carries team membership. (The legacy team-certificate path was removed in
  the token-only pivot; some federation/back-compat header handling remains.)
- **`awid/`** — the public identity registry service (`awid/src/awid_service/`).
  Owns DIDs, namespaces, addresses, teams, and certificate-issuance records.
  Also FastAPI + Postgres. Migrations are ordered SQL files (see the
  Database migrations rule above — this is the one place that bites).
- **`cli/go/`** — the `aw` CLI and Go client library. `cmd/aw` is the CLI
  entrypoint; `cmd/aweb-a2a-gw` is the A2A gateway binary. `a2a/`, `a2agw/`,
  and `awid/` are protocol/client packages; `internal/conformance/` holds
  the A2A conformance suite. A workspace is a local `.aw/` directory binding
  one directory to one team (`.aw/workspace.yaml` is the coordination
  identity). Auth is the cached bearer token at `~/.aw/token` (from
  `aw login`) or `AW_TOKEN`; `aw init` is token-only (no team certificate).
- **`channel/`** (+ **`channel-core/`**) — TypeScript Claude Code integration
  that pushes coordination events into a running agent session so it wakes on
  incoming mail/chat. Shipped as an npm package and a Claude Code plugin
  (`channel/.claude-plugin/`); the two versions are kept in lockstep.
- **`packages/`**, **`skills/`**, **`resource-packs/`**, **`pi-extension/`** —
  published skill bundles, agent skills, shared role/instruction packs, and the
  Pi editor integration.

The end-to-end OSS user journey is exercised by
`scripts/e2e-oss-user-journey.sh` (and `e2e-oss-federation.sh`,
`e2e-a2a-gateway-docker.sh`).

## Build, Test, Run

All orchestration is in the root `Makefile`. Run `make help` for the full
list. Each sub-project also has its own Makefile / package scripts.

Tests (per product):

```bash
make test            # server + awid + cli + channel
make test-server     # cd server && uv run pytest -q
make test-awid       # cd awid   && uv run pytest -q
make test-cli        # cd cli/go && go test ./...
make test-channel    # cd channel && npm test (vitest)
make test-a2a        # A2A conformance + gateway + awid lookup gates
make test-e2e        # full OSS journey (requires Docker)
```

Run a single test:

```bash
cd server && uv run pytest path/to/test_x.py::test_name -q     # Python (server/awid)
cd cli/go && go test ./coordination/... -run TestName -count=1 # Go
cd channel && npx vitest run test/some.test.ts                 # TypeScript
```

Build / format / run locally:

```bash
make build                         # builds the aw CLI (cli/go && make build)
cd cli/go && make fmt              # gofmt -w . (Go formatting)
cd server && cp .env.example .env && docker compose up --build -d  # full stack
make selfhost-up / selfhost-down / selfhost-logs                   # OSS stack (aweb+awid)
```

Python projects use **uv** (not pip/poetry). The Makefile pins
`UV_CACHE_DIR=/tmp/uv-cache` and `PYTHONPYCACHEPREFIX=/tmp/pycache` for
reproducible runs. `server` tests add both `src` and `../awid/src` to the
path, so server tests can import awid.

## Testing benchmark: live multi-agent harness (REQUIRED for coordination/tenancy/security)

`make test` / pytest are **necessary but not sufficient**. For any change to
coordination, messaging, **team scoping / tenant isolation**, auth, or
membership, the change is not "tested" until it is verified by a **live
multi-agent simulation on the local stack** (`:8088`) — real agents minting real
tokens and coordinating over the running platform, plus an adversary actively
trying to break isolation. A unit test only counts toward this bar if it
literally drives that live flow; an in-process assertion does not.

Two benchmark workflows live in **`scripts/test-workflows/`** (run via the
Workflow tool with `scriptPath`; see that README for the local-stack setup,
seed accounts, and the token-mint pattern):

- **`todo-app-replication.js`** — 5 real agents claim issues, build a todo app,
  and coordinate over chat/mail. Pass = all files written, all issues `done`,
  chat delivered. Proves coordination still works after a change.
- **`adversarial-infiltration.js`** — an outsider runs red-team agents that try
  to infiltrate another team (spoof `X-AWEB-Team-Id`, direct-object exfil by id,
  inject, cross-team message, raw MCP). Pass = judge verdict `sealed` (**zero**
  breaches). Any breach is a release blocker.

Run **both** (in addition to `make test`) before claiming a coordination,
messaging, tenancy, or auth change is done.

## Releases

`make ship` is the canonical pre-tag-push gate — it runs `release-all-check`
plus the awid build-check and the e2e/federation journeys. **Do not
substitute `make test`**; it is a strict subset that misses packaging and
integration regressions (the Makefile comments document past releases that
shipped on `make test` alone). Each product tags independently
(`server-v*`, `aw-v*`, `awid-v*`, `channel-v*`, `a2a-gw-v*`, `skills-v*`);
CI publishes on the pushed tag. Version is the source of truth in each
product's `pyproject.toml` / `package.json`; `CLI_VERSION` tracks
`SERVER_VERSION`.

# Project dimension on team memory — design

**Date:** 2026-06-22
**Status:** Approved (brainstorm) → ready for implementation plan
**Scope:** server (aweb) + Go CLI (`murmel`); UI is a deferred follow-up.

## Problem

Murmel memory is **team-scoped**: a memory row is
`(memory_id, team_id, title, body_md, tags[], created_by_alias, assignee_alias, …)`
and the hard boundary is `team_id`. There is **no project/repo dimension**.

A team typically works across **multiple repos** (one team bound to many
workspaces, one per repo). Today an agent in repo A saving a memory *is* already
visible to an agent in repo B via `memory_search` — cross-project sharing
technically works — but it is a **flat soup**: a memory does not know which repo
it is about, so the knowledge base cannot be filtered or primed per-project, and
the only structure available is free-form tags. As AI agents move faster and
touch more repos, the team needs cross-project work to stay legible.

## Goal

Give every memory a **project** (= the repo it pertains to), so the team
knowledge base is **filterable and primable per-project** — *without ever hiding
cross-project notes*. `project` is an organizational facet, never an access
boundary. `team_id` remains the only hard boundary.

Non-goals (YAGNI — explicitly out of scope for this spec):
- No project→repos grouping registry (a project = exactly one repo).
- No change/activity feed (memory stays a knowledge base, not a diff stream).
- No new push/notification channel (we reuse the existing `prime` surface).
- No per-project ACLs (project is a facet, not permissions).

## Key decisions (from brainstorm)

1. **Unit of project = one git repo.**
2. **Project key = `canonical_origin`** — the canonicalized git remote
   (`init_token.go:125`: `canonicalizeGitOrigin(discoverRepoOrigin(workingDir))`),
   e.g. `github.com/awebai/aweb`. This is machine/path/folder-independent and
   normalizes ssh-vs-https and `.git` — so different clone paths or folder names
   on different machines resolve to the **same** project, as long as `origin`
   agrees.
3. **Auto-derived, with explicit override (Approach C).** The repo is stamped
   automatically from the workspace; an optional explicit arg overrides it.
4. **Soft facet, not a wall.** Search and prime stay cross-project by default;
   `project` only *narrows* when asked, and *weights* the prime.

## Design

### 1. Data model

New migration `022_memory_project.sql`:

```sql
ALTER TABLE {{tables.memories}} ADD COLUMN IF NOT EXISTS project TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_team_project
    ON {{tables.memories}} (team_id, project, updated_at DESC);
```

- `project` is nullable. **NULL = team-global** (no repo binding / unknown) —
  such a memory is visible in every project's search and prime. This is the
  correct default for existing rows (no backfill needed) and for non-workspace
  callers.
- Add `"022_memory_project.sql"` to the hardcoded list in
  `server/tests/test_package_data.py`.

### 2. Stamping the project

**Transport:** a request header `X-AWEB-Project: <canonical_origin>`.

- **`murmel mcp-serve`** reads `canonical_origin` from `.murmel/workspace.yaml`
  and attaches the header on every proxied MCP request — the same point where it
  already injects the active team and a fresh token.
- **`murmel memory` REST commands** (save/search/list) attach the same header so
  the CLI path matches the MCP path.

**Server resolution (on `memory_save` / create):** project =
`explicit arg` → else `X-AWEB-Project` header → else `NULL`.

- `team_auth_deps.TeamIdentity` gains an optional `project: str | None` read from
  the header in `get_team_identity` (soft, best-effort — *not* validated against
  anything; it is a facet).
- The MCP `memory_save` tool gains an optional `project` argument (the override).

**Trust model:** the header is a **facet, never an ACL**. It is client-supplied
(`mcp-serve` sends it), so it is not trusted for isolation. Forging it can only
**mislabel a note within the caller's own team** — there is no cross-team reach,
because `team_id` is still derived from the validated bearer token. The
adversarial isolation gate must confirm this.

### 3. Search + prime (the cross-project-preserving part)

- **`list_memories` / `memory_search`** gain an optional `project` filter
  parameter. **Default = no filter = all team memories** (cross-project stays the
  default — this is the "share across projects" requirement). When `project` is
  supplied, narrow to `project = $x OR project IS NULL` (that repo plus team
  globals).
- **`prime_memories`** (embedded in `workspace_status`) becomes project-aware:
  return the caller's **current-project** recent notes first (current project
  read from the `X-AWEB-Project` header), then a tail of cross-project/global
  recents. An agent starting in repo B is primed on B *and* gets a glimpse of
  sibling-repo activity. The cross-project tail is what preserves shared
  awareness.
- **Memory views** (REST `MemoryView`, MCP dicts, CLI rows, UI cards) include
  `project` so every note shows which repo it came from.

### 4. Components that change

**Server (`server/src/aweb/`):**
- `migrations/aweb/022_memory_project.sql` — new.
- `coordination/routes/memories.py` — `MemoryView` + column list + `create_*` +
  `list_memories` (project filter) + the row→view mapper all carry `project`.
- `mcp/tools/memory.py` — `memory_save` accepts optional `project`;
  `prime_memories` becomes project-aware (takes the caller's project, orders
  current-first + tail); `memory_search` accepts a `project` filter; the
  snippet/render helpers surface `project`.
- `mcp/server.py` — update `memory_save` / `memory_search` tool signatures +
  descriptions.
- `team_auth_deps.py` — `TeamIdentity.project` (optional) read from
  `X-AWEB-Project`.
- `tests/test_package_data.py` — add the migration to the list.

**CLI (`cli/go/`):**
- `mcp-serve` — attach `X-AWEB-Project` from the workspace `canonical_origin`.
- `murmel memory` save/search/list — attach the header, add a `--project` flag
  (override + filter), render the repo column.

**UI (`ui/`) — DEFERRED follow-up (not blocking):**
- Project facet chips + filter on the memory page; show repo per note.

### 5. Edge cases

- **No git remote / header absent** → `project = NULL` → team-global memory
  (visible everywhere). The CLI already refuses to init without an origin unless
  `--repo-origin` is given (`workspace.go:581`), so a declared origin still flows
  through.
- **Forks** (`awebai/aweb` vs `fpolica91/aweb`) → different origins → different
  projects by default; the explicit `project` override pins a shared label when a
  team deliberately spans forks.
- **Monorepo** → one origin = one project; finer granularity via the override if
  ever needed.
- **Override precedence** → explicit arg > header > NULL.

### 6. Testing

- **Mechanics (live REST + MCP):** header present → `project` stamped; explicit
  override arg → override wins; no header → NULL.
- **Facet:** no filter → all projects returned; `project` filter → scoped to that
  repo + globals; prime → current-project-first ordering with a cross-project
  tail.
- **Live multi-agent (the bar for tenancy/coordination changes):** two workspaces
  bound to the *same team* but *different repos* — agent in repo A saves a memory
  → agent in repo B sees it in unfiltered `memory_search` **and** in the prime
  tail; a `--project`/filter narrows to one repo.
- **Adversarial isolation gate:** a forged/mismatched `X-AWEB-Project` cannot
  read or write another team's memory (team_id remains the only hard boundary);
  verdict must be `sealed`.

## Rollout

Additive and backward-compatible: NULL `project` = today's behavior, so old
memories and non-workspace callers keep working unchanged. Ships server-first
(migration + facet), then the CLI header/flag, then (later) the UI facet.

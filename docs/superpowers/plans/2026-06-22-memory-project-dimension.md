# Project Dimension on Team Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every team memory an optional `project` (= the workspace's git `canonical_origin`) so the knowledge base is filterable and primable per-repo, while search/prime stay cross-project by default.

**Architecture:** Additive `project` column on `memories` (NULL = team-global). The repo is carried on requests via an `X-AWEB-Project` header that `murmel mcp-serve` stamps from the workspace `canonical_origin`; the server records it on `memory_save` (explicit arg > header > NULL) and uses it as a *soft facet* in `list`/`search`/`prime`. `team_id` remains the only hard boundary — the header is never trusted for isolation.

**Tech Stack:** Python 3.12 (FastAPI, pgdbm, pytest, `uv`); Go (`murmel` CLI); Postgres.

**Spec:** `docs/superpowers/specs/2026-06-22-memory-project-dimension-design.md`

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `server/src/aweb/migrations/aweb/022_memory_project.sql` | `project` column + index | Create |
| `server/tests/test_package_data.py` | migration-list assertion | Modify (`:50-73`) |
| `server/src/aweb/coordination/routes/memories.py` | service + REST: carry/filter `project` | Modify |
| `server/src/aweb/mcp/auth.py` | `AuthContext.project`, read header in middleware | Modify |
| `server/src/aweb/mcp/tools/memory.py` | `memory_save` project, project-aware `prime`/`search` | Modify |
| `server/src/aweb/mcp/server.py` | tool signatures for `memory_save`/`memory_search` | Modify |
| `server/tests/test_memory_project.py` | new behavior tests | Create |
| `cli/go/cmd/aw/mcp_serve.go` | stamp `X-AWEB-Project` from `canonical_origin` | Modify (`:108-143`) |
| `cli/go/cmd/aw/memory.go` (or the existing memory cmd file) | `--project` flag + header + render | Modify |

Conventions to follow (already in the codebase):
- SQL templated tables: `{{tables.memories}}`. Migrations are ordered, additive, **never edit an existing file** (see root `CLAUDE.md`).
- Service functions in `memories.py` are the single team-scope chokepoint; MCP tools and REST both call them.
- DB tests use the `aweb_cloud_db` fixture: `await aweb_cloud_db.aweb_db.execute(...)` / `.fetch_one(...)`. Run with `uv` from `server/`.

---

## Task 1: Migration — add `project` column

**Files:**
- Create: `server/src/aweb/migrations/aweb/022_memory_project.sql`
- Modify: `server/tests/test_package_data.py:71`

- [ ] **Step 1: Write the migration**

Create `server/src/aweb/migrations/aweb/022_memory_project.sql`:

```sql
-- Per-repo facet on team memory. project = the workspace's canonical git origin
-- (e.g. github.com/awebai/aweb). NULL = team-global (no repo binding / unknown):
-- such a memory is visible in every project's search + prime. Additive; no
-- backfill -- existing rows stay NULL (team-global), which is the correct default.
-- project is an ORGANIZATIONAL FACET, never an access boundary; team_id remains
-- the only hard tenant boundary.

ALTER TABLE {{tables.memories}} ADD COLUMN IF NOT EXISTS project TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_team_project
    ON {{tables.memories}} (team_id, project, updated_at DESC);
```

- [ ] **Step 2: Add the file to the packaged-migration assertion**

In `server/tests/test_package_data.py`, the `sql_files == [...]` list (ends at line 71 with `"021_external_refs.sql",`). Add the new entry:

```python
        "021_external_refs.sql",
        "022_memory_project.sql",
    ]
```

- [ ] **Step 3: Run the packaging test (verifies the migration is seen)**

Run: `cd server && UV_CACHE_DIR=/tmp/uv-cache uv run pytest tests/test_package_data.py::test_canonical_chain_starts_with_reset_baseline_then_forward_migrations -q`
Expected: PASS (`1 passed`).

- [ ] **Step 4: Commit**

```bash
git add server/src/aweb/migrations/aweb/022_memory_project.sql server/tests/test_package_data.py
git commit -m "feat(memory): migration 022 — project column on memories"
```

---

## Task 2: Service layer — store and filter `project`

**Files:**
- Modify: `server/src/aweb/coordination/routes/memories.py`
- Test: `server/tests/test_memory_project.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_memory_project.py`:

```python
import pytest

from aweb.coordination.routes.memories import create_memory, list_memories

TEAM = "backend:acme.com"


async def _seed_team(db):
    await db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, 'acme.com', 'Backend', 'did:key:team')
        ON CONFLICT (team_id) DO NOTHING
        """,
        TEAM,
    )


@pytest.mark.asyncio
async def test_create_memory_stores_project(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    m = await create_memory(db, team_id=TEAM, title="A", project="github.com/acme/api")
    assert m.project == "github.com/acme/api"


@pytest.mark.asyncio
async def test_create_memory_defaults_project_null(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    m = await create_memory(db, team_id=TEAM, title="B")
    assert m.project is None


@pytest.mark.asyncio
async def test_list_default_is_cross_project(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await create_memory(db, team_id=TEAM, title="api-note", project="github.com/acme/api")
    await create_memory(db, team_id=TEAM, title="web-note", project="github.com/acme/web")
    titles = {m.title for m in await list_memories(db, team_id=TEAM, limit=50)}
    assert {"api-note", "web-note"} <= titles  # no filter -> all projects


@pytest.mark.asyncio
async def test_list_project_filter_includes_globals(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await create_memory(db, team_id=TEAM, title="api-only", project="github.com/acme/api")
    await create_memory(db, team_id=TEAM, title="web-only", project="github.com/acme/web")
    await create_memory(db, team_id=TEAM, title="global-note")  # project NULL
    titles = {
        m.title
        for m in await list_memories(db, team_id=TEAM, project="github.com/acme/api", limit=50)
    }
    assert "api-only" in titles
    assert "global-note" in titles      # NULL globals always visible
    assert "web-only" not in titles     # other repo filtered out
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && UV_CACHE_DIR=/tmp/uv-cache uv run pytest tests/test_memory_project.py -q`
Expected: FAIL (`create_memory() got an unexpected keyword argument 'project'`).

- [ ] **Step 3: Add `project` to the columns + view**

In `server/src/aweb/coordination/routes/memories.py`:

Replace the `_COLUMNS` constant (lines 36-39):

```python
_COLUMNS = (
    "memory_id, team_id, title, body_md, tags, project, "
    "created_by_alias, assignee_alias, created_at, updated_at"
)
```

Add `project` to `MemoryView` (after the `tags` field, line 47):

```python
class MemoryView(BaseModel):
    memory_id: str
    team_id: str
    title: str
    body_md: str
    tags: List[str]
    project: Optional[str] = None
    created_by_alias: Optional[str] = None
    assignee_alias: Optional[str] = None
    created_at: datetime
    updated_at: datetime
```

Add `project` to `_row_to_view` (after the `tags=` line, ~line 109):

```python
def _row_to_view(row) -> MemoryView:
    return MemoryView(
        memory_id=str(row["memory_id"]),
        team_id=str(row["team_id"]),
        title=row["title"],
        body_md=row["body_md"],
        tags=list(row["tags"] or []),
        project=row["project"],
        created_by_alias=row["created_by_alias"],
        assignee_alias=row["assignee_alias"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
```

- [ ] **Step 4: Add the `project` param to `create_memory`**

Replace the `create_memory` signature + INSERT (lines 179-206):

```python
async def create_memory(
    db: AsyncDatabaseManager,
    *,
    team_id: str,
    title: str,
    body_md: str = "",
    tags: Optional[Sequence[str]] = None,
    project: Optional[str] = None,
    assignee_alias: Optional[str] = None,
    created_by_alias: Optional[str] = None,
) -> MemoryView:
    title = _validate_title(title)
    body_md = body_md or ""
    if len(body_md) > _MAX_BODY:
        raise ValueError(f"body exceeds {_MAX_BODY} characters")
    tag_list = _clean_tags(tags)
    row = await db.fetch_one(
        f"INSERT INTO {{{{tables.memories}}}} "
        "(team_id, title, body_md, tags, project, created_by_alias, assignee_alias) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7) "
        f"RETURNING {_COLUMNS}",
        team_id,
        title,
        body_md,
        tag_list,
        (project or None),
        created_by_alias,
        (assignee_alias or None),
    )
    return _row_to_view(row)
```

- [ ] **Step 5: Add the `project` filter to `list_memories`**

In `list_memories`, after the `assignee_alias` clause block (lines 143-145), add a `project` parameter and clause. Change the signature (line 117-125) to add `project`:

```python
async def list_memories(
    db: AsyncDatabaseManager,
    *,
    team_id: str,
    q: Optional[str] = None,
    tags: Optional[Sequence[str]] = None,
    assignee_alias: Optional[str] = None,
    project: Optional[str] = None,
    limit: int = 50,
) -> List[MemoryView]:
```

And after the `if assignee_alias:` block (after line 145), insert:

```python
    if project:
        params.append(project)
        # Project narrows to that repo PLUS team-global (NULL) notes.
        clauses.append(f"(project = ${len(params)} OR project IS NULL)")
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && UV_CACHE_DIR=/tmp/uv-cache uv run pytest tests/test_memory_project.py -q`
Expected: PASS (`4 passed`).

- [ ] **Step 7: Commit**

```bash
git add server/src/aweb/coordination/routes/memories.py server/tests/test_memory_project.py
git commit -m "feat(memory): service stores + filters project (soft facet)"
```

---

## Task 3: MCP auth — carry `project` from the `X-AWEB-Project` header

**Files:**
- Modify: `server/src/aweb/mcp/auth.py`

- [ ] **Step 1: Add `project` to `AuthContext`**

In `server/src/aweb/mcp/auth.py`, add a field to the `AuthContext` dataclass (after `workspace_id`, line 40):

```python
    workspace_id: str | None = None
    project: str | None = None
    trusted_proxy: bool = False
```

- [ ] **Step 2: Read the header in both auth paths**

Near the top of `auth.py` where `TEAM_ID_HEADER` is imported/defined, add a constant:

```python
PROJECT_HEADER = "X-AWEB-Project"
```

In `_resolve_token_auth`, the `AuthContext(...)` constructed at line 176 — add `project=request.headers.get(PROJECT_HEADER)`:

```python
        return AuthContext(
            team_id=team_id,
            ...
            workspace_id=None,
            project=request.headers.get(PROJECT_HEADER),
            ...
        )
```

In `_resolve_proxy_auth`, the `AuthContext(...)` at line 266 — add the same line (the proxy path also has the `request`; thread it through if not already available, mirroring how `workspace_id` is set there):

```python
            project=request.headers.get(PROJECT_HEADER),
```

(If `_resolve_proxy_auth` does not currently receive `request`, pass it from `_resolve_auth`; `workspace_id` resolution there shows the existing request access pattern.)

- [ ] **Step 3: Verify it imports cleanly**

Run: `cd server && PYTHONPATH=src:../awid/src .venv/bin/python -c "from aweb.mcp.auth import AuthContext; print(AuthContext.__dataclass_fields__['project'].type)"`
Expected: prints `str | None` (no import error).

- [ ] **Step 4: Commit**

```bash
git add server/src/aweb/mcp/auth.py
git commit -m "feat(memory): MCP AuthContext carries project from X-AWEB-Project header"
```

---

## Task 4: MCP tools — project-aware save / search / prime

**Files:**
- Modify: `server/src/aweb/mcp/tools/memory.py`
- Modify: `server/src/aweb/mcp/server.py`
- Test: `server/tests/test_memory_project.py` (extend)

- [ ] **Step 1: Write the failing tests (prime ordering + render)**

Append to `server/tests/test_memory_project.py`:

```python
from aweb.mcp.tools.memory import memory_to_xml, prime_memories


@pytest.mark.asyncio
async def test_prime_current_project_first(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await create_memory(db, team_id=TEAM, title="api-1", project="github.com/acme/api")
    await create_memory(db, team_id=TEAM, title="web-1", project="github.com/acme/web")
    primed = await prime_memories(db, team_id=TEAM, project="github.com/acme/web", limit=6)
    titles = [p["title"] for p in primed]
    assert titles[0] == "web-1"          # current project surfaces first
    assert "api-1" in titles             # sibling repos still present (the tail)
    assert primed[0]["project"] == "github.com/acme/web"


@pytest.mark.asyncio
async def test_memory_xml_includes_project(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    m = await create_memory(db, team_id=TEAM, title="X", project="github.com/acme/api")
    assert 'project="github.com/acme/api"' in memory_to_xml(m)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && UV_CACHE_DIR=/tmp/uv-cache uv run pytest tests/test_memory_project.py -k "prime_current or xml_includes" -q`
Expected: FAIL (`prime_memories() got an unexpected keyword argument 'project'`).

- [ ] **Step 3: Render `project` in the memory XML**

In `server/src/aweb/mcp/tools/memory.py`, in `memory_to_xml` after the `tags` attribute (after line 52):

```python
    if m.tags:
        attrs.append(f"tags={quoteattr(','.join(m.tags))}")
    if m.project:
        attrs.append(f"project={quoteattr(m.project)}")
```

- [ ] **Step 4: Make `prime_memories` project-aware**

Replace `prime_memories` (lines 78-109) with:

```python
async def prime_memories(
    aweb_db,
    *,
    team_id: str,
    alias: str | None = None,
    project: str | None = None,
    limit: int = 6,
) -> list[dict]:
    """The session-start priming set. When ``project`` is set, the caller's
    current-repo notes are surfaced FIRST, then a tail of cross-project/global
    recents (shared awareness across the team's repos). Best-effort: returns
    ``[]`` rather than raising, so priming never breaks startup."""
    try:
        ordered: list[MemoryView] = []
        seen: set[str] = set()

        def _add(mems: list[MemoryView]) -> None:
            for m in mems:
                if m.memory_id not in seen:
                    seen.add(m.memory_id)
                    ordered.append(m)

        if project:
            _add(await list_memories(aweb_db, team_id=team_id, project=project, limit=limit))
        _add(await list_memories(aweb_db, team_id=team_id, limit=limit))
        if alias:
            _add(await list_memories(aweb_db, team_id=team_id, assignee_alias=alias, limit=limit))

        return [
            {
                "id": m.memory_id,
                "title": m.title,
                "tags": list(m.tags or []),
                "project": m.project,
                "updated": m.updated_at.date().isoformat() if m.updated_at else None,
                "private_to": m.assignee_alias or None,
                "snippet": _snippet(m.body_md or ""),
            }
            for m in ordered[:limit]
        ]
    except Exception:
        return []
```

- [ ] **Step 5: Add `project` to `memory_search` and `memory_save`**

Replace `memory_search` (lines 112-132) signature + call to pass `project`:

```python
async def memory_search(
    db_infra,
    *,
    q: str = "",
    tags: str = "",
    assignee_alias: str = "",
    project: str = "",
    limit: int = 20,
) -> str:
    """Search the team knowledge base (full-text over title+body, tag-filtered).
    Empty query returns the most recent notes. Pass ``project`` (a repo origin
    like github.com/acme/api) to narrow to one repo plus team-global notes;
    omit it to search across ALL of the team's repos. Returns ``<memories>``."""
    auth, error = require_team_context()
    if auth is None:
        return _NO_TEAM
    try:
        memories = await list_memories(
            db_infra.get_manager("aweb"),
            team_id=auth.team_id,
            q=q or None,
            tags=_split_tags(tags),
            assignee_alias=assignee_alias or None,
            project=(project or getattr(auth, "project", None)) or None,
            limit=limit,
        )
    except ValueError as exc:
        return _error_xml(str(exc))
    return memories_to_xml(memories)
```

Replace `memory_save` (lines 135-161) to resolve project (explicit arg > header):

```python
async def memory_save(
    db_infra,
    *,
    title: str,
    body_md: str = "",
    tags: str = "",
    project: str = "",
    assignee_alias: str = "",
) -> str:
    """Save a note to the team knowledge base. The author byline is filled from
    the authenticated agent. ``project`` defaults to your current repo (stamped
    from the workspace); pass it explicitly only to file a note about a DIFFERENT
    repo. Set assignee_alias to scope a note to one agent. Returns the saved
    ``<memory>`` element."""
    auth, error = require_team_context()
    if auth is None:
        return _NO_TEAM
    resolved_project = (project or getattr(auth, "project", None)) or None
    try:
        memory = await create_memory(
            db_infra.get_manager("aweb"),
            team_id=auth.team_id,
            title=title,
            body_md=body_md,
            tags=_split_tags(tags),
            project=resolved_project,
            assignee_alias=assignee_alias or None,
            created_by_alias=getattr(auth, "alias", None),
        )
    except ValueError as exc:
        return _error_xml(str(exc))
    return memory_to_xml(memory)
```

- [ ] **Step 6: Wire `project` into the `workspace_status` prime call**

In `server/src/aweb/mcp/tools/workspace.py`, find the `prime_memories(...)` call inside `workspace_status` and pass the caller's project (read from the same auth context the tool already uses, e.g. `getattr(auth, "project", None)`):

```python
    memory_prime = await prime_memories(
        aweb_db, team_id=team_id, alias=alias, project=getattr(auth, "project", None)
    )
```

(Use whatever local the function already holds for the auth context; if it only has `team_id`/`alias`, fetch the project via `require_team_context()` like the other tools.)

- [ ] **Step 7: Update the MCP tool registrations**

In `server/src/aweb/mcp/server.py`, update the registered `memory_save` and `memory_search` wrappers to accept and forward `project` (mirror the existing param-passing for those tools, adding `project: str = ""`). Example for `memory_save`:

```python
    @mcp.tool(name="memory_save", description="Save a team-memory note. project defaults to your current repo; pass it only to file about a different repo. ...")
    async def memory_save(title: str, body_md: str = "", tags: str = "", project: str = "", assignee_alias: str = "") -> str:
        return await _memory_save_impl(db_infra, title=title, body_md=body_md, tags=tags, project=project, assignee_alias=assignee_alias)
```

And `memory_search` gains `project: str = ""` forwarded the same way.

- [ ] **Step 8: Run the full memory test file**

Run: `cd server && UV_CACHE_DIR=/tmp/uv-cache uv run pytest tests/test_memory_project.py -q`
Expected: PASS (`6 passed`).

- [ ] **Step 9: Commit**

```bash
git add server/src/aweb/mcp/tools/memory.py server/src/aweb/mcp/tools/workspace.py server/src/aweb/mcp/server.py server/tests/test_memory_project.py
git commit -m "feat(memory): project-aware memory_save/search/prime over MCP"
```

---

## Task 5: REST — expose the `project` filter + stamp on create

**Files:**
- Modify: `server/src/aweb/coordination/routes/memories.py`

- [ ] **Step 1: Add `project` to the REST list query + create request**

In `list_memories_endpoint` (line 273), add a query param and forward it:

```python
@memories_router.get("")
async def list_memories_endpoint(
    request: Request,
    q: Optional[str] = Query(None, description="Full-text search over title+body"),
    tag: Optional[str] = Query(None, description="Comma-separated tags; ANY match"),
    assignee_alias: Optional[str] = Query(None),
    project: Optional[str] = Query(None, description="Filter to one repo origin (plus team-global notes)"),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> ListMemoriesResponse:
    tags = [t.strip() for t in tag.split(",") if t.strip()] if tag else None
    try:
        memories = await list_memories(
            db.get_manager("aweb"),
            team_id=identity.team_id,
            q=q,
            tags=tags,
            assignee_alias=assignee_alias,
            project=project,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return ListMemoriesResponse(memories=memories)
```

Add `project` to `CreateMemoryRequest` (line 54) and stamp it (explicit body field > `X-AWEB-Project` header) in `create_memory_endpoint` (line 298):

```python
class CreateMemoryRequest(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE)
    body_md: str = Field(default="", max_length=_MAX_BODY)
    tags: List[str] = Field(default_factory=list)
    project: Optional[str] = None
    assignee_alias: Optional[str] = None
```

```python
    memory = await create_memory(
        db.get_manager("aweb"),
        team_id=identity.team_id,
        title=payload.title,
        body_md=payload.body_md,
        tags=payload.tags,
        project=payload.project or request.headers.get("X-AWEB-Project"),
        assignee_alias=payload.assignee_alias,
        created_by_alias=identity.alias,
    )
```

- [ ] **Step 2: Live REST smoke (server running on :8088)**

Run (against the local stack, with a founder token in `$FT`):

```bash
curl -s -X POST localhost:8088/v1/memories -H "Authorization: Bearer $FT" \
  -H "X-AWEB-Team-Id: default:local" -H "X-AWEB-Project: github.com/acme/api" \
  -H "content-type: application/json" -d '{"title":"rest-proj"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['project'])"
```
Expected: prints `github.com/acme/api` (header stamped).

```bash
curl -s "localhost:8088/v1/memories?project=github.com/acme/api" -H "Authorization: Bearer $FT" \
  -H "X-AWEB-Team-Id: default:local" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['memories']))"
```
Expected: ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add server/src/aweb/coordination/routes/memories.py
git commit -m "feat(memory): REST project filter + X-AWEB-Project stamp on create"
```

---

## Task 6: CLI — `mcp-serve` stamps `X-AWEB-Project`

**Files:**
- Modify: `cli/go/cmd/aw/mcp_serve.go`

- [ ] **Step 1: Thread `canonical_origin` to the forwarder**

In `cli/go/cmd/aw/mcp_serve.go`, the resolver at lines 95-120 returns `(baseURL, teamID, error)`. Extend it to also return the workspace's `CanonicalOrigin`, and thread that value to `forwardMCPMessage` alongside `teamID`. The `workspace` local already carries it (`workspace.CanonicalOrigin`).

Add the header in `forwardMCPMessage` after the team header (line 139):

```go
	if teamID != "" {
		req.Header.Set("X-AWEB-Team-Id", teamID)
	}
	if project != "" {
		req.Header.Set("X-AWEB-Project", project)
	}
```

(Add a `project string` parameter to `forwardMCPMessage` and pass `strings.TrimSpace(workspace.CanonicalOrigin)` from the caller. If `workspace` is nil or the origin is empty, pass `""` — the server then records NULL = team-global.)

- [ ] **Step 2: Build the CLI**

Run: `cd cli/go && go build ./...`
Expected: no output (success).

- [ ] **Step 3: Gofmt**

Run: `cd cli/go && gofmt -w cmd/aw/mcp_serve.go`
Expected: no diff errors.

- [ ] **Step 4: Live end-to-end (the real proof)**

With the local stack up and a workspace bound (its `.murmel/workspace.yaml` has a `canonical_origin`), point a `murmel mcp-serve` at it and call `memory_save` with no `project` arg, then confirm the saved note's `project` equals the workspace origin:

```bash
# build + run mcp-serve against :8088 from a bound workspace dir, call memory_save,
# then: curl the REST list and assert the note's project == canonical_origin.
```
Expected: the note carries the workspace's `canonical_origin` without any explicit arg.

- [ ] **Step 5: Commit**

```bash
git add cli/go/cmd/aw/mcp_serve.go
git commit -m "feat(cli): mcp-serve stamps X-AWEB-Project from workspace canonical_origin"
```

---

## Task 7: CLI — `murmel memory` `--project` flag + render

**Files:**
- Modify: the existing `murmel memory` command file (`cli/go/cmd/aw/memory*.go`; locate with `grep -rl "memory" cli/go/cmd/aw/*.go | xargs grep -l "cobra.Command"`).

- [ ] **Step 1: Add `--project` to save + list/search**

- `murmel memory save`: add a `--project` string flag; when set, send it as the `X-AWEB-Project` header (override) on the REST create; when unset, the CLI sends the workspace `canonical_origin` as the header (matching `mcp-serve`).
- `murmel memory list` / `search`: add a `--project` flag → `?project=<origin>` query param.
- Render a `repo` column/line per memory from the response `project` field (empty shown as `—`).

- [ ] **Step 2: Build + fmt**

Run: `cd cli/go && go build ./... && gofmt -w cmd/aw/`
Expected: success, no diff errors.

- [ ] **Step 3: Live check**

Run `murmel memory save --project github.com/acme/api "note"` then `murmel memory list --project github.com/acme/api` against the local stack; confirm the note appears with its repo shown and that an unrelated-repo filter excludes it.

- [ ] **Step 4: Commit**

```bash
git add cli/go/cmd/aw/
git commit -m "feat(cli): murmel memory --project flag + repo column"
```

---

## Task 8: Verification — live multi-agent + adversarial gate

**Files:** none (harness run).

- [ ] **Step 1: Cross-project sharing, live**

Two workspaces bound to the **same team** but **different `canonical_origin`s**. Agent in repo A: `memory_save` a note (no explicit project). Agent in repo B:
- unfiltered `memory_search` **returns** A's note (cross-project default), and
- `workspace_status` prime shows B's own notes first with A's note in the tail, and
- `memory_search project=<A's origin>` narrows to A (+ globals).

Expected: all three hold.

- [ ] **Step 2: Adversarial isolation gate**

Run the adversarial harness (`scripts/test-workflows/adversarial-infiltration.js`) after refreshing its targets. Add/confirm a vector where the attacker sends a forged `X-AWEB-Project` for the victim team.
Expected: judge verdict `sealed` — a forged project header never reads or writes another team's memory (`team_id` remains the only hard boundary).

- [ ] **Step 3: Full server test suite**

Run: `cd server && UV_CACHE_DIR=/tmp/uv-cache uv run pytest -q`
Expected: PASS (no regressions).

- [ ] **Step 4: Sync branch ↔ main** (per root `CLAUDE.md`)

```bash
git push aweb-private feature/simple-auth-ui:main
git branch -f main feature/simple-auth-ui
```

---

## Self-review (completed by plan author)

- **Spec coverage:** §1 data model → Task 1; §2 stamping (header + precedence) → Tasks 3, 5, 6; §3 search/prime soft facet → Tasks 2, 4; §4 components → Tasks 2-7; §5 edge cases (NULL global, override precedence) → Tasks 2/4/5 tests; §6 testing → Tasks 2/4/8. UI is the spec's deferred item — intentionally not in this plan.
- **Placeholder scan:** Tasks 6 and 7 (Go) describe the change against exact line anchors rather than full rewrites, because the surrounding `mcp_serve.go` plumbing (threading the new return value) is mechanical; each has a concrete build + live-proof step. All Python steps carry complete code.
- **Type consistency:** `project: Optional[str]` everywhere (service, view, request); MCP tool args are `project: str = ""` (flat-string convention) resolved to `None`; `prime_memories(..., project=...)` and the dict key `"project"` match across Task 4 and its tests; `X-AWEB-Project` header name identical in server (`PROJECT_HEADER`), REST, and CLI.

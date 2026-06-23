"""MCP tools for team shared memory.

Agents are the primary users of this surface: read the team's accumulated
knowledge on session start (``memory_search``) and write what they learn
(``memory_save``) so it carries to future sessions. All tools delegate to the
team-scoped service functions in ``aweb.coordination.routes.memories`` -- the
team_id and author byline come from the authenticated context, never the args.

Output is the Claude Code XML memory format: each note renders as a ``<memory>``
element whose metadata is attributes (id/title/author/tags/updated, plus
``private`` when scoped to one agent) and whose markdown body is the element
content. ``memory_search`` wraps the set in ``<memories>``. This is what the
agent ingests as memory; the REST surface (for the human UI) stays JSON.
"""

from __future__ import annotations

from xml.sax.saxutils import escape, quoteattr

from aweb.coordination.routes.memories import (
    MemoryView,
    create_memory,
    delete_memory,
    get_memory,
    list_memories,
    update_memory,
)
from aweb.mcp.tools._common import require_team_context

_NO_TEAM = "<error>This tool requires team context. Provide a valid team token.</error>"


def _split_tags(tags: str) -> list[str]:
    """MCP tool args are flat strings; tags arrive comma-separated."""
    if not tags:
        return []
    return [t.strip() for t in tags.split(",") if t.strip()]


def _error_xml(message: str) -> str:
    return f"<error>{escape(message)}</error>"


def memory_to_xml(m: MemoryView) -> str:
    """Render one memory as a ``<memory>`` element: metadata as attributes, the
    markdown body as verbatim (XML-escaped) element content. The body is NOT
    re-indented so code-block indentation in the note survives intact."""
    attrs = [f"id={quoteattr(m.memory_id)}", f"title={quoteattr(m.title)}"]
    if m.created_by_alias:
        attrs.append(f"author={quoteattr(m.created_by_alias)}")
    if m.tags:
        attrs.append(f"tags={quoteattr(','.join(m.tags))}")
    if m.assignee_alias:
        # Per-agent scope; surfaced so the reader knows it's not team-general.
        attrs.append(f"private={quoteattr(m.assignee_alias)}")
    if m.project:
        attrs.append(f"project={quoteattr(m.project)}")
    updated = m.updated_at.date().isoformat() if m.updated_at else ""
    if updated:
        attrs.append(f"updated={quoteattr(updated)}")
    body = escape(m.body_md or "")
    return f"<memory {' '.join(attrs)}>\n{body}\n</memory>"


def memories_to_xml(mems: list[MemoryView]) -> str:
    """Wrap a result set in ``<memories count="N">``. Empty set is explicit so an
    agent's session-start read gets a clear "nothing yet" signal."""
    if not mems:
        return '<memories count="0"></memories>'
    inner = "\n".join(memory_to_xml(m) for m in mems)
    return f'<memories count="{len(mems)}">\n{inner}\n</memories>'


def _snippet(body: str, limit: int = 180) -> str:
    """First line / first ``limit`` chars of a note body, for compact priming."""
    text = " ".join((body or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


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
            # Cross-project by DEFAULT — only narrow when a project is explicitly
            # passed. (Unlike memory_save, which auto-stamps from the workspace
            # header, search must not silently scope to the current repo.)
            project=project or None,
            limit=limit,
        )
    except ValueError as exc:
        return _error_xml(str(exc))
    return memories_to_xml(memories)


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


async def memory_get(db_infra, *, memory_id: str) -> str:
    """Fetch one team memory by id. Returns a ``<memory>`` element."""
    auth, error = require_team_context()
    if auth is None:
        return _NO_TEAM
    memory = await get_memory(
        db_infra.get_manager("aweb"), team_id=auth.team_id, memory_id=memory_id
    )
    if memory is None:
        return _error_xml("Memory not found")
    return memory_to_xml(memory)


async def memory_update(
    db_infra,
    *,
    memory_id: str,
    title: str = "",
    body_md: str = "",
    tags: str = "",
) -> str:
    """Revise a team memory's title, body, and/or tags. Empty args are left
    unchanged (mirrors the flat-string MCP convention). Returns the updated
    note as a ``<memory>`` element."""
    auth, error = require_team_context()
    if auth is None:
        return _NO_TEAM
    try:
        memory = await update_memory(
            db_infra.get_manager("aweb"),
            team_id=auth.team_id,
            memory_id=memory_id,
            title=title or None,
            body_md=body_md or None,
            tags=_split_tags(tags) if tags else None,
        )
    except ValueError as exc:
        return _error_xml(str(exc))
    if memory is None:
        return _error_xml("Memory not found")
    return memory_to_xml(memory)


async def memory_delete(db_infra, *, memory_id: str) -> str:
    """Delete a team memory by id."""
    auth, error = require_team_context()
    if auth is None:
        return _NO_TEAM
    deleted = await delete_memory(
        db_infra.get_manager("aweb"), team_id=auth.team_id, memory_id=memory_id
    )
    if not deleted:
        return _error_xml("Memory not found")
    return f"<deleted id={quoteattr(memory_id)}/>"

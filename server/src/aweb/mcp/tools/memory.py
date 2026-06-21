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
    aweb_db, *, team_id: str, alias: str | None = None, limit: int = 6
) -> list[dict]:
    """The session-start priming set: the most recent team notes plus any scoped
    to ``alias``, as compact dicts (``id/title/tags/updated/snippet``). Embedded
    in ``workspace_status`` so an agent is auto-primed with team knowledge on the
    first call it makes — no separate ``memory_search`` required. Best-effort:
    returns ``[]`` rather than raising, so priming never breaks startup."""
    try:
        recent = await list_memories(aweb_db, team_id=team_id, limit=limit)
        seen = {m.memory_id for m in recent}
        mine: list[MemoryView] = []
        if alias:
            for m in await list_memories(
                aweb_db, team_id=team_id, assignee_alias=alias, limit=limit
            ):
                if m.memory_id not in seen:
                    mine.append(m)
        merged = (recent + mine)[:limit]
        return [
            {
                "id": m.memory_id,
                "title": m.title,
                "tags": list(m.tags or []),
                "updated": m.updated_at.date().isoformat() if m.updated_at else None,
                "private_to": m.assignee_alias or None,
                "snippet": _snippet(m.body_md or ""),
            }
            for m in merged
        ]
    except Exception:
        return []


async def memory_search(
    db_infra, *, q: str = "", tags: str = "", assignee_alias: str = "", limit: int = 20
) -> str:
    """Search the team knowledge base (full-text over title+body, tag-filtered).
    Empty query returns the most recent notes -- the session-start reading set.
    Returns a ``<memories>`` XML block."""
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
    assignee_alias: str = "",
) -> str:
    """Save a note to the team knowledge base. The author byline is filled from
    the authenticated agent; set assignee_alias to scope a note to one agent.
    Returns the saved note as a ``<memory>`` element."""
    auth, error = require_team_context()
    if auth is None:
        return _NO_TEAM
    try:
        memory = await create_memory(
            db_infra.get_manager("aweb"),
            team_id=auth.team_id,
            title=title,
            body_md=body_md,
            tags=_split_tags(tags),
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

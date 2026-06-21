"""Data-access helpers for the work hierarchy: Epic -> Story -> Issue.

Additive alongside ``tasks_service``; mirrors its patterns (async helpers that
take the shared ``db`` router, resolve the ``aweb`` manager, and return plain
JSON-able dicts). Issues are the floor of the hierarchy and may attach to an
epic and/or a story (both nullable).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from ..service_errors import NotFoundError, ValidationError

_UNSET = object()

ISSUE_STATUSES = (
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "deferred",
)
ASSIGNEE_TYPES = ("human", "agent")


async def _resolve_participant_directory(
    db, *, team_id: str, aliases: list[str]
) -> dict[str, dict[str, str]]:
    """Look up ``alias -> {kind, display_name}`` from the participant directory.

    ``kind`` is authoritative from ``agents.agent_type`` ("human" iff
    ``agent_type='human'``, else "agent"). ``display_name`` is ``human_name``
    for humans (falling back to alias), else alias. Aliases not found are simply
    absent; callers default unresolved authors/assignees to "agent" and never
    error (legacy rows / deleted participants must not break the view).
    """
    wanted = [a for a in {(a or "").strip() for a in aliases} if a]
    if not wanted:
        return {}
    aweb_db = db.get_manager("aweb")
    rows = await aweb_db.fetch_all(
        """
        SELECT alias, human_name, agent_type
        FROM {{tables.agents}}
        WHERE team_id = $1 AND alias = ANY($2::text[]) AND deleted_at IS NULL
        """,
        team_id,
        wanted,
    )
    directory: dict[str, dict[str, str]] = {}
    for row in rows:
        alias = (row.get("alias") or "").strip()
        if not alias:
            continue
        kind = "human" if (row.get("agent_type") or "agent") == "human" else "agent"
        human_name = (row.get("human_name") or "").strip()
        display_name = human_name if (kind == "human" and human_name) else alias
        directory[alias] = {"kind": kind, "display_name": display_name}
    return directory


def _coerce_uuid(value: str | UUID, *, label: str) -> UUID:
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (ValueError, TypeError) as exc:
        raise ValidationError(f"Invalid {label}") from exc


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


# ---------------------------------------------------------------------------
# Epics
# ---------------------------------------------------------------------------


def _epic_view(row: Any) -> dict[str, Any]:
    return {
        "epic_id": str(row["epic_id"]),
        "team_id": row["team_id"],
        "title": row["title"],
        "status": row["status"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row.get("updated_at")),
    }


async def create_epic(
    db,
    *,
    team_id: str,
    title: str,
    status: str = "open",
) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    row = await aweb_db.fetch_one(
        """
        INSERT INTO {{tables.epics}} (team_id, title, status)
        VALUES ($1, $2, $3)
        RETURNING epic_id, team_id, title, status, created_at, updated_at
        """,
        team_id,
        title,
        status,
    )
    return _epic_view(row)


async def get_epic(db, *, team_id: str, epic_id: str | UUID) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(epic_id, label="epic_id")
    row = await aweb_db.fetch_one(
        """
        SELECT epic_id, team_id, title, status, created_at, updated_at
        FROM {{tables.epics}}
        WHERE epic_id = $1 AND team_id = $2
        """,
        resolved,
        team_id,
    )
    if not row:
        raise NotFoundError("Epic not found")
    return _epic_view(row)


async def list_epics(
    db,
    *,
    team_id: str,
    status: str | None = None,
) -> list[dict[str, Any]]:
    aweb_db = db.get_manager("aweb")
    conditions = ["team_id = $1"]
    params: list[Any] = [team_id]
    idx = 2

    if status is not None:
        conditions.append(f"status = ${idx}")
        params.append(status)
        idx += 1

    rows = await aweb_db.fetch_all(
        f"""
        SELECT epic_id, team_id, title, status, created_at, updated_at
        FROM {{{{tables.epics}}}}
        WHERE {' AND '.join(conditions)}
        ORDER BY created_at ASC
        """,
        *params,
    )
    return [_epic_view(r) for r in rows]


async def update_epic(
    db,
    *,
    team_id: str,
    epic_id: str | UUID,
    title: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(epic_id, label="epic_id")
    now = datetime.now(timezone.utc)

    sets: list[str] = ["updated_at = $3"]
    params: list[Any] = [resolved, team_id, now]
    idx = 4

    if title is not None:
        sets.append(f"title = ${idx}")
        params.append(title)
        idx += 1
    if status is not None:
        sets.append(f"status = ${idx}")
        params.append(status)
        idx += 1

    row = await aweb_db.fetch_one(
        f"""
        UPDATE {{{{tables.epics}}}}
        SET {', '.join(sets)}
        WHERE epic_id = $1 AND team_id = $2
        RETURNING epic_id, team_id, title, status, created_at, updated_at
        """,
        *params,
    )
    if not row:
        raise NotFoundError("Epic not found")
    return _epic_view(row)


# ---------------------------------------------------------------------------
# Stories
# ---------------------------------------------------------------------------


def _story_view(row: Any) -> dict[str, Any]:
    return {
        "story_id": str(row["story_id"]),
        "epic_id": str(row["epic_id"]) if row["epic_id"] else None,
        "team_id": row["team_id"],
        "title": row["title"],
        "status": row["status"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row.get("updated_at")),
    }


async def create_story(
    db,
    *,
    team_id: str,
    title: str,
    epic_id: str | UUID | None = None,
    status: str = "open",
) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    resolved_epic_id: UUID | None = None
    if epic_id is not None:
        resolved_epic_id = _coerce_uuid(epic_id, label="epic_id")
        # Ensure the epic exists in this team (also raises NotFoundError).
        await get_epic(db, team_id=team_id, epic_id=resolved_epic_id)

    row = await aweb_db.fetch_one(
        """
        INSERT INTO {{tables.stories}} (team_id, epic_id, title, status)
        VALUES ($1, $2, $3, $4)
        RETURNING story_id, epic_id, team_id, title, status, created_at, updated_at
        """,
        team_id,
        resolved_epic_id,
        title,
        status,
    )
    return _story_view(row)


async def get_story(db, *, team_id: str, story_id: str | UUID) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(story_id, label="story_id")
    row = await aweb_db.fetch_one(
        """
        SELECT story_id, epic_id, team_id, title, status, created_at, updated_at
        FROM {{tables.stories}}
        WHERE story_id = $1 AND team_id = $2
        """,
        resolved,
        team_id,
    )
    if not row:
        raise NotFoundError("Story not found")
    return _story_view(row)


async def list_stories(
    db,
    *,
    team_id: str,
    status: str | None = None,
    epic_id: str | UUID | None = None,
) -> list[dict[str, Any]]:
    aweb_db = db.get_manager("aweb")
    conditions = ["team_id = $1"]
    params: list[Any] = [team_id]
    idx = 2

    if status is not None:
        conditions.append(f"status = ${idx}")
        params.append(status)
        idx += 1
    if epic_id is not None:
        conditions.append(f"epic_id = ${idx}")
        params.append(_coerce_uuid(epic_id, label="epic_id"))
        idx += 1

    rows = await aweb_db.fetch_all(
        f"""
        SELECT story_id, epic_id, team_id, title, status, created_at, updated_at
        FROM {{{{tables.stories}}}}
        WHERE {' AND '.join(conditions)}
        ORDER BY created_at ASC
        """,
        *params,
    )
    return [_story_view(r) for r in rows]


async def update_story(
    db,
    *,
    team_id: str,
    story_id: str | UUID,
    title: str | None = None,
    status: str | None = None,
    epic_id: str | UUID | None | object = _UNSET,
) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(story_id, label="story_id")
    now = datetime.now(timezone.utc)

    sets: list[str] = ["updated_at = $3"]
    params: list[Any] = [resolved, team_id, now]
    idx = 4

    if title is not None:
        sets.append(f"title = ${idx}")
        params.append(title)
        idx += 1
    if status is not None:
        sets.append(f"status = ${idx}")
        params.append(status)
        idx += 1
    if epic_id is not _UNSET:
        resolved_epic_id: UUID | None = None
        if epic_id is not None:
            resolved_epic_id = _coerce_uuid(epic_id, label="epic_id")
            await get_epic(db, team_id=team_id, epic_id=resolved_epic_id)
        sets.append(f"epic_id = ${idx}")
        params.append(resolved_epic_id)
        idx += 1

    row = await aweb_db.fetch_one(
        f"""
        UPDATE {{{{tables.stories}}}}
        SET {', '.join(sets)}
        WHERE story_id = $1 AND team_id = $2
        RETURNING story_id, epic_id, team_id, title, status, created_at, updated_at
        """,
        *params,
    )
    if not row:
        raise NotFoundError("Story not found")
    return _story_view(row)


# ---------------------------------------------------------------------------
# Issues (the floor)
# ---------------------------------------------------------------------------


def _issue_view(row: Any) -> dict[str, Any]:
    return {
        "issue_id": str(row["issue_id"]),
        "team_id": row["team_id"],
        "epic_id": str(row["epic_id"]) if row["epic_id"] else None,
        "story_id": str(row["story_id"]) if row["story_id"] else None,
        "title": row["title"],
        "description": row["description"],
        "status": row["status"],
        "assignee_type": row["assignee_type"],
        "assignee_id": row["assignee_id"],
        "pinned": bool(row.get("pinned") or False),
        # Derived dependency-graph signal; present where _ISSUE_COLS is selected.
        "is_blocked": bool(row.get("is_blocked") or False),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row.get("updated_at")),
        # Present on list queries (correlated subquery); 0 elsewhere.
        "comment_count": int(row.get("comment_count") or 0),
    }


def _validate_assignee(assignee_type: str | None) -> None:
    if assignee_type is not None and assignee_type not in ASSIGNEE_TYPES:
        raise ValidationError(
            f"assignee_type must be one of {', '.join(ASSIGNEE_TYPES)}"
        )


async def create_issue(
    db,
    *,
    team_id: str,
    title: str,
    description: str = "",
    status: str = "todo",
    epic_id: str | UUID | None = None,
    story_id: str | UUID | None = None,
    assignee_type: str | None = None,
    assignee_id: str | None = None,
) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")

    if status not in ISSUE_STATUSES:
        raise ValidationError(f"status must be one of {', '.join(ISSUE_STATUSES)}")
    _validate_assignee(assignee_type)

    resolved_epic_id: UUID | None = None
    if epic_id is not None:
        resolved_epic_id = _coerce_uuid(epic_id, label="epic_id")
        await get_epic(db, team_id=team_id, epic_id=resolved_epic_id)

    resolved_story_id: UUID | None = None
    if story_id is not None:
        resolved_story_id = _coerce_uuid(story_id, label="story_id")
        await get_story(db, team_id=team_id, story_id=resolved_story_id)

    row = await aweb_db.fetch_one(
        """
        INSERT INTO {{tables.issues}}
            (team_id, epic_id, story_id, title, description, status,
             assignee_type, assignee_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING issue_id, team_id, epic_id, story_id, title, description,
                  status, assignee_type, assignee_id, pinned, created_at, updated_at
        """,
        team_id,
        resolved_epic_id,
        resolved_story_id,
        title,
        description,
        status,
        assignee_type,
        assignee_id,
    )
    return _issue_view(row)


async def get_issue(db, *, team_id: str, issue_id: str | UUID) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(issue_id, label="issue_id")
    row = await aweb_db.fetch_one(
        """
        SELECT issue_id, team_id, epic_id, story_id, title, description,
               status, assignee_type, assignee_id, pinned,
               compacted_summary, compaction_level, compacted_at,
               created_at, updated_at
        FROM {{tables.issues}}
        WHERE issue_id = $1 AND team_id = $2
        """,
        resolved,
        team_id,
    )
    if not row:
        raise NotFoundError("Issue not found")
    view = _issue_view(row)
    # Compaction digest of the older thread (present only on get_issue).
    view["compacted_summary"] = row.get("compacted_summary") or None
    view["compaction_level"] = int(row.get("compaction_level") or 0)
    view["compacted_at"] = _iso(row.get("compacted_at")) if row.get("compacted_at") else None
    # Resolve assignee kind + display name from the participant directory so the
    # UI renders the assignee without a second lookup. Falls back to the stored
    # assignee_type / assignee_id when the assignee alias does not resolve.
    assignee_id = view.get("assignee_id")
    if assignee_id:
        directory = await _resolve_participant_directory(
            db, team_id=team_id, aliases=[assignee_id]
        )
        entry = directory.get(str(assignee_id).strip())
        view["assignee_kind"] = (entry or {}).get("kind") or view.get("assignee_type")
        view["assignee_display_name"] = (entry or {}).get("display_name") or assignee_id
    else:
        view["assignee_kind"] = view.get("assignee_type")
        view["assignee_display_name"] = None
    # Surface dependency neighbours so the detail view (and issues_get) can show
    # what blocks this issue and what it blocks, without a second round-trip.
    deps = await _issue_dependencies(db, team_id=team_id, issue_id=resolved)
    view["blocked_by"] = deps["blocked_by"]
    view["blocks"] = deps["blocks"]
    # Single-issue SELECT can't carry the correlated is_blocked column; derive it
    # from the blockers we just loaded (any not-done 'blocks' edge).
    view["is_blocked"] = any(
        d.get("status") != "done"
        for d in deps["blocked_by"]
        if d.get("dep_type", "blocks") == "blocks"
    )
    return view


async def list_issues(
    db,
    *,
    team_id: str,
    status: str | None = None,
    assignee_type: str | None = None,
    assignee_id: str | None = None,
    epic_id: str | UUID | None = None,
    story_id: str | UUID | None = None,
) -> list[dict[str, Any]]:
    aweb_db = db.get_manager("aweb")
    conditions = ["team_id = $1"]
    params: list[Any] = [team_id]
    idx = 2

    if status is not None:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            conditions.append(f"status = ${idx}")
            params.append(statuses[0])
        else:
            conditions.append(f"status = ANY(${idx})")
            params.append(statuses)
        idx += 1
    if assignee_type is not None:
        conditions.append(f"assignee_type = ${idx}")
        params.append(assignee_type)
        idx += 1
    if assignee_id is not None:
        conditions.append(f"assignee_id = ${idx}")
        params.append(assignee_id)
        idx += 1
    if epic_id is not None:
        conditions.append(f"epic_id = ${idx}")
        params.append(_coerce_uuid(epic_id, label="epic_id"))
        idx += 1
    if story_id is not None:
        conditions.append(f"story_id = ${idx}")
        params.append(_coerce_uuid(story_id, label="story_id"))
        idx += 1

    rows = await aweb_db.fetch_all(
        f"""
        SELECT i.issue_id, i.team_id, i.epic_id, i.story_id, i.title, i.description,
               i.status, i.assignee_type, i.assignee_id, i.pinned,
               i.created_at, i.updated_at,
               {_BLOCKED_PREDICATE.strip()} AS is_blocked,
               (SELECT COUNT(*) FROM {{{{tables.issue_comments}}}} c
                WHERE c.issue_id = i.issue_id) AS comment_count
        FROM {{{{tables.issues}}}} i
        WHERE {' AND '.join(conditions)}
        ORDER BY i.pinned DESC, i.created_at ASC
        """,
        *params,
    )
    return [_issue_view(r) for r in rows]


async def update_issue(
    db,
    *,
    team_id: str,
    issue_id: str | UUID,
    title: str | None = None,
    description: str | None = None,
    status: str | None = None,
    epic_id: str | UUID | None | object = _UNSET,
    story_id: str | UUID | None | object = _UNSET,
    assignee_type: str | None | object = _UNSET,
    assignee_id: str | None | object = _UNSET,
    pinned: bool | None = None,
) -> dict[str, Any]:
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(issue_id, label="issue_id")
    now = datetime.now(timezone.utc)

    if status is not None and status not in ISSUE_STATUSES:
        raise ValidationError(f"status must be one of {', '.join(ISSUE_STATUSES)}")
    if assignee_type is not _UNSET and assignee_type is not None:
        _validate_assignee(str(assignee_type))

    sets: list[str] = ["updated_at = $3"]
    params: list[Any] = [resolved, team_id, now]
    idx = 4

    if title is not None:
        sets.append(f"title = ${idx}")
        params.append(title)
        idx += 1
    if description is not None:
        sets.append(f"description = ${idx}")
        params.append(description)
        idx += 1
    if status is not None:
        sets.append(f"status = ${idx}")
        params.append(status)
        idx += 1
    if epic_id is not _UNSET:
        resolved_epic_id: UUID | None = None
        if epic_id is not None:
            resolved_epic_id = _coerce_uuid(epic_id, label="epic_id")
            await get_epic(db, team_id=team_id, epic_id=resolved_epic_id)
        sets.append(f"epic_id = ${idx}")
        params.append(resolved_epic_id)
        idx += 1
    if story_id is not _UNSET:
        resolved_story_id: UUID | None = None
        if story_id is not None:
            resolved_story_id = _coerce_uuid(story_id, label="story_id")
            await get_story(db, team_id=team_id, story_id=resolved_story_id)
        sets.append(f"story_id = ${idx}")
        params.append(resolved_story_id)
        idx += 1
    if assignee_type is not _UNSET:
        sets.append(f"assignee_type = ${idx}")
        params.append(assignee_type)
        idx += 1
    if assignee_id is not _UNSET:
        sets.append(f"assignee_id = ${idx}")
        params.append(assignee_id)
        idx += 1
    if pinned is not None:
        sets.append(f"pinned = ${idx}")
        params.append(bool(pinned))
        idx += 1

    row = await aweb_db.fetch_one(
        f"""
        UPDATE {{{{tables.issues}}}}
        SET {', '.join(sets)}
        WHERE issue_id = $1 AND team_id = $2
        RETURNING issue_id, team_id, epic_id, story_id, title, description,
                  status, assignee_type, assignee_id, pinned, created_at, updated_at
        """,
        *params,
    )
    if not row:
        raise NotFoundError("Issue not found")
    return _issue_view(row)


async def claim_issue(
    db,
    *,
    team_id: str,
    issue_id: str | UUID,
    assignee_type: str,
    assignee_id: str,
    set_in_progress: bool = True,
) -> dict[str, Any]:
    """Assign an issue to an actor (the ``issues_claim`` MCP-tool primitive).

    Sets ``assignee_type``/``assignee_id`` and, by default, moves status to
    ``in_progress``.
    """
    _validate_assignee(assignee_type)
    if not assignee_id:
        raise ValidationError("assignee_id is required to claim an issue")

    return await update_issue(
        db,
        team_id=team_id,
        issue_id=issue_id,
        status="in_progress" if set_in_progress else None,
        assignee_type=assignee_type,
        assignee_id=assignee_id,
    )


# ---------------------------------------------------------------------------
# Comments (issue activity thread)
# ---------------------------------------------------------------------------


async def add_issue_comment(
    db, *, team_id: str, issue_id: str | UUID, author: str, body: str
) -> dict[str, Any]:
    """Append a comment to an issue's thread. Validates the issue exists in the
    team first (raises NotFoundError otherwise)."""
    await get_issue(db, team_id=team_id, issue_id=issue_id)
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(issue_id, label="issue_id")
    row = await aweb_db.fetch_one(
        """
        INSERT INTO {{tables.issue_comments}} (issue_id, team_id, author, body)
        VALUES ($1, $2, $3, $4)
        RETURNING comment_id, issue_id, author, body, compacted, created_at
        """,
        resolved,
        team_id,
        author,
        body,
    )
    return _comment_view(row)


async def list_issue_comments(
    db, *, team_id: str, issue_id: str | UUID, include_compacted: bool = False
) -> list[dict[str, Any]]:
    """List an issue's comments oldest-first. By default only the live tail —
    comments folded into the compaction digest are hidden unless
    ``include_compacted`` is set. Validates the issue exists."""
    await get_issue(db, team_id=team_id, issue_id=issue_id)
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(issue_id, label="issue_id")
    compacted_filter = "" if include_compacted else " AND compacted = FALSE"
    rows = await aweb_db.fetch_all(
        f"""
        SELECT comment_id, issue_id, author, body, compacted, created_at
        FROM {{{{tables.issue_comments}}}}
        WHERE issue_id = $1 AND team_id = $2{compacted_filter}
        ORDER BY created_at ASC
        """,
        resolved,
        team_id,
    )
    comments = [_comment_view(r) for r in rows]
    # Authoritative author kind (human vs agent) resolved from the participant
    # directory by author alias. Legacy / unresolved authors default to "agent"
    # so the view never errors.
    directory = await _resolve_participant_directory(
        db, team_id=team_id, aliases=[c["author"] for c in comments]
    )
    for comment in comments:
        entry = directory.get((comment["author"] or "").strip())
        comment["author_kind"] = (entry or {}).get("kind") or "agent"
    return comments


def _comment_view(row: Any) -> dict[str, Any]:
    return {
        "comment_id": str(row["comment_id"]),
        "issue_id": str(row["issue_id"]),
        "author": row["author"],
        "body": row["body"],
        "compacted": bool(row.get("compacted") or False),
        "created_at": _iso(row["created_at"]),
    }


# -- Issue dependencies (ready vs blocked work) --


DEPENDENCY_TYPES = ("blocks", "related", "discovered_from")


async def add_issue_dependency(
    db,
    *,
    team_id: str,
    issue_id: str | UUID,
    depends_on_id: str | UUID,
    dep_type: str = "blocks",
) -> dict[str, Any]:
    """Record a typed edge from ``issue_id`` to ``depends_on_id``.

    ``dep_type`` is ``blocks`` (hard dependency — gates the ready queue),
    ``related`` (soft link), or ``discovered_from`` (spun off while working the
    other). Rejects self-dependencies; only ``blocks`` edges are cycle-guarded
    (related/discovered_from carry no ordering, so a loop is harmless). Both
    issues must exist in the team. Re-adding a pair updates its type.
    """
    if dep_type not in DEPENDENCY_TYPES:
        raise ValidationError(
            f"dep_type must be one of {', '.join(DEPENDENCY_TYPES)}"
        )
    iid = _coerce_uuid(issue_id, label="issue_id")
    did = _coerce_uuid(depends_on_id, label="depends_on_id")
    if iid == did:
        raise ValidationError("An issue cannot depend on itself")
    # Both endpoints must be real issues in this team (raises NotFoundError).
    await get_issue(db, team_id=team_id, issue_id=iid)
    await get_issue(db, team_id=team_id, issue_id=did)

    aweb_db = db.get_manager("aweb")
    if dep_type == "blocks":
        # Cycle guard (blocks only): if depends_on already (transitively) reaches
        # issue via blocks edges, the new edge would close a loop.
        cycle = await aweb_db.fetch_one(
            """
            WITH RECURSIVE reach AS (
                SELECT depends_on_id AS id
                FROM {{tables.issue_dependencies}}
                WHERE issue_id = $2 AND dep_type = 'blocks'
                UNION ALL
                SELECT d.depends_on_id
                FROM {{tables.issue_dependencies}} d
                JOIN reach r ON d.issue_id = r.id
                WHERE d.dep_type = 'blocks'
            )
            SELECT 1 FROM reach WHERE id = $1
            """,
            iid,
            did,
        )
        if cycle:
            raise ValidationError("Dependency would create a cycle")

    await aweb_db.execute(
        """
        INSERT INTO {{tables.issue_dependencies}} (issue_id, depends_on_id, team_id, dep_type)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (issue_id, depends_on_id) DO UPDATE SET dep_type = EXCLUDED.dep_type
        """,
        iid,
        did,
        team_id,
        dep_type,
    )
    return {"issue_id": str(iid), "depends_on_id": str(did), "dep_type": dep_type}


async def remove_issue_dependency(
    db, *, team_id: str, issue_id: str | UUID, depends_on_id: str | UUID
) -> dict[str, Any]:
    """Remove a dependency edge."""
    iid = _coerce_uuid(issue_id, label="issue_id")
    did = _coerce_uuid(depends_on_id, label="depends_on_id")
    aweb_db = db.get_manager("aweb")
    await aweb_db.execute(
        """
        DELETE FROM {{tables.issue_dependencies}}
        WHERE issue_id = $1 AND depends_on_id = $2 AND team_id = $3
        """,
        iid,
        did,
        team_id,
    )
    return {"issue_id": str(iid), "removed_depends_on_id": str(did)}


# An issue is BLOCKED when it has a dependency on an issue that is not yet done.
_BLOCKED_PREDICATE = """
    EXISTS (
        SELECT 1
        FROM {{tables.issue_dependencies}} d
        JOIN {{tables.issues}} blocker ON blocker.issue_id = d.depends_on_id
        WHERE d.issue_id = i.issue_id
          AND d.dep_type = 'blocks'
          AND blocker.status != 'done'
    )
"""

_ISSUE_COLS = (
    "i.issue_id, i.team_id, i.epic_id, i.story_id, i.title, i.description, "
    "i.status, i.assignee_type, i.assignee_id, i.pinned, i.created_at, i.updated_at, "
    # Derived: has at least one not-done 'blocks' dependency. Distinct from an
    # explicit status='blocked'; the UI treats either as blocked.
    + _BLOCKED_PREDICATE.strip()
    + " AS is_blocked"
)


async def list_ready_issues(db, *, team_id: str) -> list[dict[str, Any]]:
    """Unassigned ``todo`` issues whose dependencies are all done (claimable work)."""
    aweb_db = db.get_manager("aweb")
    rows = await aweb_db.fetch_all(
        "SELECT "
        + _ISSUE_COLS
        + " FROM {{tables.issues}} i"
        + " WHERE i.team_id = $1 AND i.status = 'todo' AND i.assignee_id IS NULL"
        + " AND NOT "
        + _BLOCKED_PREDICATE
        + " ORDER BY i.created_at",
        team_id,
    )
    return [_issue_view(r) for r in rows]


async def list_blocked_issues(db, *, team_id: str) -> list[dict[str, Any]]:
    """Open issues held up by at least one not-done dependency."""
    aweb_db = db.get_manager("aweb")
    rows = await aweb_db.fetch_all(
        "SELECT "
        + _ISSUE_COLS
        + " FROM {{tables.issues}} i"
        + " WHERE i.team_id = $1 AND i.status IN ('todo', 'in_progress', 'in_review')"
        + " AND "
        + _BLOCKED_PREDICATE
        + " ORDER BY i.created_at",
        team_id,
    )
    return [_issue_view(r) for r in rows]


async def get_issue_dependencies(
    db, *, team_id: str, issue_id: str | UUID
) -> dict[str, Any]:
    """Return an issue's dependency neighbours, team-scoped on every join.

    ``blocked_by`` are issues THIS issue depends on (the things holding it up);
    ``blocks`` are issues that depend on THIS one. Each entry is
    ``{"issue_id", "title", "status"}``. Both the dependency edge and the joined
    issue must belong to ``team_id`` — a cross-team edge or issue is never
    surfaced. Validates the issue exists in the team first."""
    await get_issue(db, team_id=team_id, issue_id=issue_id)
    return await _issue_dependencies(db, team_id=team_id, issue_id=issue_id)


async def _issue_dependencies(
    db, *, team_id: str, issue_id: str | UUID
) -> dict[str, Any]:
    """Fetch dependency neighbours without re-validating the issue.

    Split out so ``get_issue`` (which already loaded + validated the row) can
    embed dependencies without recursing through ``get_issue_dependencies`` ->
    ``get_issue``."""
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(issue_id, label="issue_id")

    blocked_by_rows = await aweb_db.fetch_all(
        """
        SELECT other.issue_id, other.title, other.status, d.dep_type
        FROM {{tables.issue_dependencies}} d
        JOIN {{tables.issues}} other ON other.issue_id = d.depends_on_id
        WHERE d.issue_id = $1 AND d.team_id = $2 AND other.team_id = $2
        ORDER BY other.created_at
        """,
        resolved,
        team_id,
    )
    blocks_rows = await aweb_db.fetch_all(
        """
        SELECT other.issue_id, other.title, other.status, d.dep_type
        FROM {{tables.issue_dependencies}} d
        JOIN {{tables.issues}} other ON other.issue_id = d.issue_id
        WHERE d.depends_on_id = $1 AND d.team_id = $2 AND other.team_id = $2
        ORDER BY other.created_at
        """,
        resolved,
        team_id,
    )

    def _dep_view(row: Any) -> dict[str, Any]:
        return {
            "issue_id": str(row["issue_id"]),
            "title": row["title"],
            "status": row["status"],
            "dep_type": row.get("dep_type") or "blocks",
        }

    return {
        "blocked_by": [_dep_view(r) for r in blocked_by_rows],
        "blocks": [_dep_view(r) for r in blocks_rows],
    }

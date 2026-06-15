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

ISSUE_STATUSES = ("todo", "in_progress", "in_review", "done")
ASSIGNEE_TYPES = ("human", "agent")


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
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row.get("updated_at")),
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
                  status, assignee_type, assignee_id, created_at, updated_at
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
               status, assignee_type, assignee_id, created_at, updated_at
        FROM {{tables.issues}}
        WHERE issue_id = $1 AND team_id = $2
        """,
        resolved,
        team_id,
    )
    if not row:
        raise NotFoundError("Issue not found")
    return _issue_view(row)


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
        SELECT issue_id, team_id, epic_id, story_id, title, description,
               status, assignee_type, assignee_id, created_at, updated_at
        FROM {{{{tables.issues}}}}
        WHERE {' AND '.join(conditions)}
        ORDER BY created_at ASC
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

    row = await aweb_db.fetch_one(
        f"""
        UPDATE {{{{tables.issues}}}}
        SET {', '.join(sets)}
        WHERE issue_id = $1 AND team_id = $2
        RETURNING issue_id, team_id, epic_id, story_id, title, description,
                  status, assignee_type, assignee_id, created_at, updated_at
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
        RETURNING comment_id, issue_id, author, body, created_at
        """,
        resolved,
        team_id,
        author,
        body,
    )
    return _comment_view(row)


async def list_issue_comments(
    db, *, team_id: str, issue_id: str | UUID
) -> list[dict[str, Any]]:
    """List an issue's comments oldest-first. Validates the issue exists."""
    await get_issue(db, team_id=team_id, issue_id=issue_id)
    aweb_db = db.get_manager("aweb")
    resolved = _coerce_uuid(issue_id, label="issue_id")
    rows = await aweb_db.fetch_all(
        """
        SELECT comment_id, issue_id, author, body, created_at
        FROM {{tables.issue_comments}}
        WHERE issue_id = $1 AND team_id = $2
        ORDER BY created_at ASC
        """,
        resolved,
        team_id,
    )
    return [_comment_view(r) for r in rows]


def _comment_view(row: Any) -> dict[str, Any]:
    return {
        "comment_id": str(row["comment_id"]),
        "issue_id": str(row["issue_id"]),
        "author": row["author"],
        "body": row["body"],
        "created_at": _iso(row["created_at"]),
    }

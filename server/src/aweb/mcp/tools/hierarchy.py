"""MCP tools for the work hierarchy: Epic -> Story -> Issue.

Additive alongside ``tasks`` tools; mirrors their patterns. These tools expose
issues (the floor of the hierarchy) over MCP. Issues may attach to an epic
and/or a story (both nullable) and use the lifecycle statuses
``todo``/``in_progress``/``in_review``/``done``.
"""

from __future__ import annotations

import json

import os as _os

from aweb.coordination.compaction import compact_issue
from aweb.integrations.linear_pull import LinearError, pull_linear
from aweb.coordination.hierarchy import (
    add_issue_comment,
    add_issue_dependency,
    claim_issue,
    create_epic,
    create_issue,
    create_story,
    get_issue,
    get_issue_dependencies,
    list_epics,
    list_issue_comments,
    list_issues,
    list_stories,
    remove_issue_dependency,
    update_issue,
)
from aweb.mcp.tools._common import require_team_context
from aweb.service_errors import ConflictError, NotFoundError, ValidationError


async def issues_create(
    db_infra,
    *,
    title: str,
    description: str = "",
    status: str = "todo",
    epic_id: str = "",
    story_id: str = "",
    assignee_type: str = "",
    assignee_id: str = "",
) -> str:
    """Create an issue in the authenticated team."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context. Provide a valid team token."})
    try:
        result = await create_issue(
            db_infra,
            team_id=auth.team_id,
            title=title,
            description=description,
            status=status,
            epic_id=epic_id or None,
            story_id=story_id or None,
            assignee_type=assignee_type or None,
            assignee_id=assignee_id or None,
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(result)


async def issues_list(
    db_infra,
    *,
    status: str = "",
    assignee_type: str = "",
    assignee_id: str = "",
    epic_id: str = "",
    story_id: str = "",
) -> str:
    """List issues in the authenticated team."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context. Provide a valid team token."})
    try:
        issues = await list_issues(
            db_infra,
            team_id=auth.team_id,
            status=status or None,
            assignee_type=assignee_type or None,
            assignee_id=assignee_id or None,
            epic_id=epic_id or None,
            story_id=story_id or None,
        )
    except ValidationError as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps({"issues": issues})


async def issues_get(db_infra, *, issue_id: str) -> str:
    """Get an issue by UUID."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context. Provide a valid team token."})
    try:
        issue = await get_issue(db_infra, team_id=auth.team_id, issue_id=issue_id)
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(issue)


async def issues_dependencies(db_infra, *, issue_id: str) -> str:
    """Get an issue's dependency neighbours (what blocks it and what it blocks)."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context. Provide a valid team token."})
    try:
        result = await get_issue_dependencies(
            db_infra, team_id=auth.team_id, issue_id=issue_id
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps({"issue_id": issue_id, **result})


async def issues_claim(
    db_infra,
    *,
    issue_id: str,
    assignee_type: str = "agent",
    assignee_id: str = "",
) -> str:
    """Claim an issue for the authenticated actor (defaults to the agent alias)."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context. Provide a valid team token."})
    try:
        issue = await claim_issue(
            db_infra,
            team_id=auth.team_id,
            issue_id=issue_id,
            assignee_type=assignee_type or "agent",
            assignee_id=assignee_id or auth.alias,
        )
    except (ConflictError, NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(issue)


async def issues_update_status(db_infra, *, issue_id: str, status: str) -> str:
    """Update the status of an issue in the authenticated team.

    Valid statuses: todo, in_progress, in_review, done, blocked (you are
    explicitly stuck — distinct from a not-done dependency), deferred (snoozed;
    skipped by work_ready)."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context. Provide a valid team token."})
    try:
        issue = await update_issue(
            db_infra,
            team_id=auth.team_id,
            issue_id=issue_id,
            status=status,
        )
    except (ConflictError, NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(issue)


async def issues_comment_add(db_infra, *, issue_id: str, body: str) -> str:
    """Post a comment to an issue's thread (the human<->agent discussion
    surface). The author is the authenticated agent/user."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    try:
        result = await add_issue_comment(
            db_infra,
            team_id=auth.team_id,
            issue_id=issue_id,
            author=getattr(auth, "alias", "") or "agent",
            body=body,
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(result)


async def issues_comments_list(db_infra, *, issue_id: str) -> str:
    """List an issue's comments, oldest first."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    try:
        result = await list_issue_comments(
            db_infra, team_id=auth.team_id, issue_id=issue_id
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps({"issue_id": issue_id, "comments": result})


async def epics_create(db_infra, *, title: str, status: str = "open") -> str:
    """Create an epic (top of the Epic -> Story -> Issue hierarchy)."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    try:
        result = await create_epic(db_infra, team_id=auth.team_id, title=title, status=status)
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(result)


async def epics_list(db_infra, *, status: str = "") -> str:
    """List epics in the authenticated team."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    result = await list_epics(db_infra, team_id=auth.team_id, status=status or None)
    return json.dumps({"team_id": auth.team_id, "epics": result})


async def stories_create(
    db_infra, *, title: str, epic_id: str = "", status: str = "open"
) -> str:
    """Create a story, optionally under an epic."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    try:
        result = await create_story(
            db_infra, team_id=auth.team_id, title=title, epic_id=epic_id or None, status=status
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(result)


async def stories_list(db_infra, *, epic_id: str = "", status: str = "") -> str:
    """List stories in the authenticated team, optionally filtered by epic."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    result = await list_stories(
        db_infra, team_id=auth.team_id, status=status or None, epic_id=epic_id or None
    )
    return json.dumps({"team_id": auth.team_id, "stories": result})


async def issues_add_dependency(
    db_infra, *, issue_id: str, depends_on_id: str, dep_type: str = "blocks"
) -> str:
    """Add a typed edge from ``issue_id`` to ``depends_on_id``.

    ``dep_type``: ``blocks`` (default — hard dependency; ``issue_id`` is withheld
    from ``work_ready`` until ``depends_on_id`` is ``done``), ``related`` (soft
    link, no gating), or ``discovered_from`` (this issue was spun off while
    working the other). Rejects self-dependencies; ``blocks`` edges are
    cycle-guarded."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    try:
        result = await add_issue_dependency(
            db_infra,
            team_id=auth.team_id,
            issue_id=issue_id,
            depends_on_id=depends_on_id,
            dep_type=dep_type,
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(result)


async def issues_compact(db_infra, *, issue_id: str, summary: str) -> str:
    """Compact a long issue thread. YOU write ``summary`` — a tight digest of the
    older discussion, merging the existing digest from ``issues_get`` if any
    (preserve decisions, facts, owners, open questions). The server then folds
    the older comments behind your digest and keeps the recent tail verbatim, so
    picking the issue up later loads the digest instead of the whole history.
    Read the thread (``issues_comments_list``) before summarizing. Pinned issues
    and short threads are no-ops. Non-destructive — comments are flagged, not
    deleted."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    try:
        result = await compact_issue(
            db_infra, team_id=auth.team_id, issue_id=issue_id, summary=summary
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(result)


async def linear_pull(db_infra, *, linear_team_key: str = "") -> str:
    """Pull issues from Linear into the authenticated team (one-way, idempotent:
    re-pull updates, never duplicates). Optionally pass a Linear team key (e.g.
    "ENG") to import just that team. Imported issues land unassigned and carry
    their Linear identifier. Requires LINEAR_API_KEY configured on the server."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    api_key = (_os.getenv("LINEAR_API_KEY") or "").strip()
    if not api_key:
        return json.dumps({"error": "LINEAR_API_KEY is not configured; Linear pull is disabled."})
    try:
        result = await pull_linear(
            db_infra,
            team_id=auth.team_id,
            api_key=api_key,
            linear_team_key=linear_team_key or None,
        )
    except LinearError as exc:
        return json.dumps({"error": str(exc)})
    return json.dumps(result)


async def issues_remove_dependency(db_infra, *, issue_id: str, depends_on_id: str) -> str:
    """Remove a dependency edge between two issues."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    try:
        result = await remove_issue_dependency(
            db_infra,
            team_id=auth.team_id,
            issue_id=issue_id,
            depends_on_id=depends_on_id,
        )
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(result)

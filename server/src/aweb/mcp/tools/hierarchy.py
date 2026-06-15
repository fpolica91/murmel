"""MCP tools for the work hierarchy: Epic -> Story -> Issue.

Additive alongside ``tasks`` tools; mirrors their patterns. These tools expose
issues (the floor of the hierarchy) over MCP. Issues may attach to an epic
and/or a story (both nullable) and use the lifecycle statuses
``todo``/``in_progress``/``in_review``/``done``.
"""

from __future__ import annotations

import json

from aweb.coordination.hierarchy import (
    add_issue_comment,
    claim_issue,
    create_issue,
    get_issue,
    list_issue_comments,
    list_issues,
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
        return error or json.dumps({"error": "This tool requires team context. Use a team certificate."})
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
        return error or json.dumps({"error": "This tool requires team context. Use a team certificate."})
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
        return error or json.dumps({"error": "This tool requires team context. Use a team certificate."})
    try:
        issue = await get_issue(db_infra, team_id=auth.team_id, issue_id=issue_id)
    except (NotFoundError, ValidationError) as exc:
        return json.dumps({"error": exc.detail})
    return json.dumps(issue)


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
        return error or json.dumps({"error": "This tool requires team context. Use a team certificate."})
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
    """Update the status of an issue in the authenticated team."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context. Use a team certificate."})
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

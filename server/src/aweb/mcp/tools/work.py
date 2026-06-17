"""MCP tools for coordination-aware work discovery (over the issues model)."""

from __future__ import annotations

import json
import logging

from aweb.coordination.hierarchy import list_issues
from aweb.mcp.tools._common import require_team_context

logger = logging.getLogger(__name__)


async def work_ready(db_infra) -> str:
    """List ready issues: status=todo and not yet assigned to anyone."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    issues = await list_issues(db_infra, team_id=auth.team_id, status="todo")
    items = [issue for issue in issues if not issue.get("assignee_id")]
    return json.dumps({"kind": "ready", "issues": items})


async def work_active(db_infra) -> str:
    """List active in-progress issues across the team."""
    auth, error = require_team_context()
    if auth is None:
        return error or json.dumps({"error": "This tool requires team context."})
    issues = await list_issues(db_infra, team_id=auth.team_id, status="in_progress")
    return json.dumps({"kind": "active", "issues": issues})

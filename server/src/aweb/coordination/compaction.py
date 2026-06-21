"""Agent-driven compaction for long-standing issue threads.

As a long-lived issue accrues a large comment thread, the coordinating agent —
which is itself an LLM — summarizes the older discussion into a tight digest and
calls ``compact_issue`` with that digest. The server does only the bookkeeping:
it stores the digest on the issue and flags the folded comments ``compacted``
(kept in the table, hidden from the default thread view — condensation, not
deletion). Picking the issue up then loads the digest + the recent verbatim tail
instead of the whole history.

Murmel makes NO LLM call here and holds no model key: the agent produces the
summary (same pattern as ``memory_save``), so we never run a model over the
team's data and never carry that cost. Pinned issues (migration 019) are never
compacted.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID
from typing import Any

from ..service_errors import NotFoundError, ValidationError
from .hierarchy import get_issue, list_issue_comments, _coerce_uuid

logger = logging.getLogger("aweb.compaction")

# Keep this many most-recent comments verbatim; everything older is foldable.
KEEP_RECENT = 6
# Don't fold unless at least this many comments would be condensed.
MIN_FOLD = 3
# Guardrail on the agent-supplied digest.
MAX_SUMMARY_CHARS = 16384


async def compact_issue(
    db,
    *,
    team_id: str,
    issue_id: str | UUID,
    summary: str,
    keep_recent: int = KEEP_RECENT,
) -> dict[str, Any]:
    """Fold an issue's older comments behind an agent-supplied ``summary``.

    ``summary`` is the agent's digest of the older thread (merging any prior
    digest from ``get_issue``); it REPLACES the issue's ``compacted_summary``.
    Skips pinned issues and no-ops when there isn't enough old history to fold.
    The digest update + comment flagging run in one transaction. New comments
    only ever land in the recent tail, so a fold can't race past unsummarized
    content. Returns a result summary.
    """
    summary = (summary or "").strip()
    if not summary:
        raise ValidationError("summary is required (the agent's thread digest)")
    if len(summary) > MAX_SUMMARY_CHARS:
        raise ValidationError(
            f"summary too long ({len(summary)} > {MAX_SUMMARY_CHARS} chars)"
        )

    issue = await get_issue(db, team_id=team_id, issue_id=issue_id)
    if issue.get("pinned"):
        return {"compacted": False, "reason": "issue is pinned", "folded": 0}

    resolved = _coerce_uuid(issue_id, label="issue_id")
    comments = await list_issue_comments(
        db, team_id=team_id, issue_id=resolved, include_compacted=False
    )
    foldable = comments[: max(0, len(comments) - keep_recent)]
    if len(foldable) < MIN_FOLD:
        return {
            "compacted": False,
            "reason": f"only {len(foldable)} foldable comment(s); need {MIN_FOLD}",
            "folded": 0,
        }

    fold_ids = [_coerce_uuid(c["comment_id"], label="comment_id") for c in foldable]
    now = datetime.now(timezone.utc)

    aweb_db = db.get_manager("aweb")
    async with aweb_db.transaction() as tx:
        await tx.execute(
            """
            UPDATE {{tables.issues}}
            SET compacted_summary = $3,
                compaction_level = compaction_level + 1,
                compacted_at = $4
            WHERE issue_id = $1 AND team_id = $2
            """,
            resolved,
            team_id,
            summary,
            now,
        )
        await tx.execute(
            """
            UPDATE {{tables.issue_comments}}
            SET compacted = TRUE
            WHERE issue_id = $1 AND team_id = $2 AND comment_id = ANY($3::uuid[])
            """,
            resolved,
            team_id,
            fold_ids,
        )

    logger.info(
        "issue_compacted",
        extra={"issue_id": str(resolved), "folded": len(fold_ids)},
    )
    return {
        "compacted": True,
        "folded": len(fold_ids),
        "kept_recent": len(comments) - len(foldable),
        "compaction_level": int(issue.get("compaction_level") or 0) + 1,
        "summary_chars": len(summary),
    }


__all__ = ["compact_issue", "NotFoundError", "ValidationError"]

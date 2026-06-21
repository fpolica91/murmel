"""Pull Linear issues into a Murmel team's work model (one-way, idempotent).

Each Linear issue maps to a Murmel issue, matched on
``(team_id, external_system='linear', external_ref=<linear id>)`` so a re-pull
UPDATES in place and never duplicates. Linear workflow-state *types* map to
Murmel statuses via ``DEFAULT_STATE_MAP``.

MVP scope: imports title + status + a description carrying the Linear
identifier; issues land UNASSIGNED (Linear assignees are Linear users; bridging
them to Murmel agents/humans is a deliberate follow-up). Native Murmel issues
(``external_ref IS NULL``) are never touched.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .linear_client import LinearClient, LinearError

logger = logging.getLogger("aweb.integrations.linear")

EXTERNAL_SYSTEM = "linear"

# Linear state.type -> Murmel status. Linear types: triage, backlog, unstarted,
# started, completed, canceled. Murmel: todo, in_progress, in_review, done,
# blocked, deferred.
DEFAULT_STATE_MAP: dict[str, str] = {
    "triage": "todo",
    "backlog": "todo",
    "unstarted": "todo",
    "started": "in_progress",
    "completed": "done",
    "canceled": "deferred",
}


def _map_status(linear_state: Optional[dict[str, Any]], state_map: dict[str, str]) -> str:
    stype = ((linear_state or {}).get("type") or "").strip().lower()
    return state_map.get(stype, "todo")


def _description(issue: dict[str, Any]) -> str:
    ident = (issue.get("identifier") or "").strip()
    body = (issue.get("description") or "").strip()
    header = f"Imported from Linear {ident}".strip()
    return f"{header}\n\n{body}".strip() if body else header


async def pull_linear(
    db,
    *,
    team_id: str,
    api_key: str,
    linear_team_key: Optional[str] = None,
    state_map: Optional[dict[str, str]] = None,
    transport=None,
) -> dict[str, Any]:
    """Fetch Linear issues and upsert them into ``team_id``. Returns counts."""
    smap = state_map or DEFAULT_STATE_MAP
    client = LinearClient(api_key, transport=transport)
    issues = await client.fetch_all_issues(team_key=linear_team_key)

    aweb_db = db.get_manager("aweb")
    created = 0
    updated = 0
    skipped = 0
    for issue in issues:
        ext_ref = issue.get("id")
        title = (issue.get("title") or "").strip()
        if not ext_ref or not title:
            skipped += 1
            continue
        status = _map_status(issue.get("state"), smap)
        description = _description(issue)

        existing = await aweb_db.fetch_one(
            """
            SELECT issue_id FROM {{tables.issues}}
            WHERE team_id = $1 AND external_system = $2 AND external_ref = $3
            """,
            team_id,
            EXTERNAL_SYSTEM,
            ext_ref,
        )
        if existing:
            await aweb_db.execute(
                """
                UPDATE {{tables.issues}}
                SET title = $4, status = $5, description = $6, updated_at = NOW()
                WHERE issue_id = $1 AND team_id = $2 AND external_ref = $3
                """,
                existing["issue_id"],
                team_id,
                ext_ref,
                title,
                status,
                description,
            )
            updated += 1
        else:
            await aweb_db.execute(
                """
                INSERT INTO {{tables.issues}}
                    (team_id, title, description, status, external_system, external_ref)
                VALUES ($1, $2, $3, $4, $5, $6)
                """,
                team_id,
                title,
                description,
                status,
                EXTERNAL_SYSTEM,
                ext_ref,
            )
            created += 1

    # NOTE: 'created'/'updated' are reserved LogRecord attributes — prefix to
    # avoid a "cannot overwrite LogRecord" crash.
    logger.info(
        "linear_pull",
        extra={
            "team": team_id,
            "n_created": created,
            "n_updated": updated,
            "n_skipped": skipped,
        },
    )
    return {
        "source": "linear",
        "linear_team_key": linear_team_key,
        "fetched": len(issues),
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }


__all__ = ["pull_linear", "DEFAULT_STATE_MAP", "EXTERNAL_SYSTEM", "LinearError"]

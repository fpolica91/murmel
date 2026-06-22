"""Receive-only, source-agnostic issue import into a team's work model.

Murmel does NOT fetch from or hold keys for any external tracker — the agent
does that with its own access and pushes already-fetched, already-mapped issues
here. This just upserts them idempotently, matched on
``(team_id, external_system, external_ref)`` (migration 021), so a re-import
UPDATES in place and never duplicates. Status must be a Murmel status; the
caller maps from the source system before importing.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from aweb.coordination.hierarchy import ISSUE_STATUSES

logger = logging.getLogger("aweb.integrations.import")

_TITLE_MAX = 500
_DESC_MAX = 16384
_DEFAULT_STATUS = "todo"


class ImportError_(ValueError):
    """Invalid import payload."""


def _clean_status(status: Optional[str]) -> str:
    s = (status or "").strip().lower()
    return s if s in ISSUE_STATUSES else _DEFAULT_STATUS


async def import_issues(
    db,
    *,
    team_id: str,
    external_system: str,
    issues: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Upsert externally-sourced issues into ``team_id``. Returns counts."""
    system = (external_system or "").strip().lower()
    if not system:
        raise ImportError_("external_system is required")

    aweb_db = db.get_manager("aweb")
    created = updated = skipped = 0
    for item in issues:
        ext_ref = str(item.get("external_ref") or "").strip()
        title = str(item.get("title") or "").strip()[:_TITLE_MAX]
        if not ext_ref or not title:
            skipped += 1
            continue
        status = _clean_status(item.get("status"))
        description = str(item.get("description") or "").strip()[:_DESC_MAX]

        existing = await aweb_db.fetch_one(
            """
            SELECT issue_id FROM {{tables.issues}}
            WHERE team_id = $1 AND external_system = $2 AND external_ref = $3
            """,
            team_id,
            system,
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
                system,
                ext_ref,
            )
            created += 1

    logger.info(
        "issue_import",
        extra={
            "team": team_id,
            "external_system": system,
            "n_created": created,
            "n_updated": updated,
            "n_skipped": skipped,
        },
    )
    return {
        "external_system": system,
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }


__all__ = ["import_issues", "ImportError_"]

-- Richer work graph: two more issue statuses, a pinned flag, and typed
-- dependency edges. Additive forward migration (never edit the baseline).
--
--  * status gains 'blocked' (an agent is explicitly stuck — distinct from the
--    DERIVED is_blocked computed from incomplete blocker deps) and 'deferred'
--    (snoozed; excluded from the ready queue).
--  * issues.pinned marks an issue as important — kept out of future memory
--    compaction/decay and surfaced first in the UI.
--  * issue_dependencies.dep_type makes the edge meaning explicit: 'blocks' (the
--    existing hard dependency), 'related' (soft link), 'discovered_from' (this
--    issue was spun off while working another).

-- ── issues.status: widen the CHECK to include blocked + deferred ──────────
ALTER TABLE {{tables.issues}} DROP CONSTRAINT IF EXISTS issues_status_check;
ALTER TABLE {{tables.issues}}
    ADD CONSTRAINT issues_status_check
    CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'blocked', 'deferred'));

-- ── issues.pinned ─────────────────────────────────────────────────────────
ALTER TABLE {{tables.issues}}
    ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- ── issue_dependencies.dep_type ───────────────────────────────────────────
ALTER TABLE {{tables.issue_dependencies}}
    ADD COLUMN IF NOT EXISTS dep_type TEXT NOT NULL DEFAULT 'blocks';

ALTER TABLE {{tables.issue_dependencies}}
    DROP CONSTRAINT IF EXISTS issue_dependencies_dep_type_check;
ALTER TABLE {{tables.issue_dependencies}}
    ADD CONSTRAINT issue_dependencies_dep_type_check
    CHECK (dep_type IN ('blocks', 'related', 'discovered_from'));

CREATE INDEX IF NOT EXISTS idx_issues_team_pinned
    ON {{tables.issues}} (team_id, pinned) WHERE pinned = TRUE;

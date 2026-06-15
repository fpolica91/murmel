-- 010_backfill_tasks_to_issues.sql
-- Migrate the legacy `tasks` table into the work-hierarchy `issues` table.
--
-- ADDITIVE + IDEMPOTENT. The legacy `tasks` table is left untouched (it stays
-- for compat); this migration only adds a provenance column on `issues` and
-- backfills one issue per (non-deleted) task.
--
-- Provenance: issues.source_task_id records which task an issue was created
-- from. A partial UNIQUE index guarantees a given task maps to at most one
-- issue, which also makes the INSERT safe to re-run (the WHERE NOT EXISTS guard
-- skips tasks that already have a backfilled issue).
--
-- Status mapping (tasks -> issues):
--   open        -> todo
--   in_progress -> in_progress
--   closed      -> done
-- Issues have an extra 'in_review' state with no task equivalent, so it is
-- never produced by the backfill. Any unexpected/unknown task status falls
-- back to 'todo' so the issues CHECK constraint can never be violated.
--
-- Assignee mapping: tasks.assignee_alias always resolves to an agent alias
-- (see coordination/tasks_service.py::_resolve_assignee_alias), so a present
-- alias becomes assignee_type='agent' with assignee_id=<alias>. NULL alias
-- leaves both issue assignee columns NULL.

-- ---------------------------------------------------------------------------
-- 1. Provenance column + uniqueness guard
-- ---------------------------------------------------------------------------
ALTER TABLE {{tables.issues}}
    ADD COLUMN IF NOT EXISTS source_task_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_issues_source_task_id
    ON {{tables.issues}} (source_task_id)
    WHERE source_task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Backfill one issue per live task
-- ---------------------------------------------------------------------------
INSERT INTO {{tables.issues}}
    (team_id, title, description, status, assignee_type, assignee_id,
     source_task_id, created_at, updated_at)
SELECT
    t.team_id,
    t.title,
    t.description,
    CASE t.status
        WHEN 'open'        THEN 'todo'
        WHEN 'in_progress' THEN 'in_progress'
        WHEN 'closed'      THEN 'done'
        ELSE 'todo'
    END AS status,
    CASE WHEN t.assignee_alias IS NOT NULL THEN 'agent' END AS assignee_type,
    t.assignee_alias AS assignee_id,
    t.task_id AS source_task_id,
    t.created_at,
    COALESCE(t.updated_at, t.created_at) AS updated_at
FROM {{tables.tasks}} t
WHERE t.deleted_at IS NULL
  AND NOT EXISTS (
        SELECT 1
        FROM {{tables.issues}} i
        WHERE i.source_task_id = t.task_id
  );

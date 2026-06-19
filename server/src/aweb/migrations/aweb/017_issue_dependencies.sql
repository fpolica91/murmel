-- 017_issue_dependencies.sql
-- Issue dependencies: an issue can depend on (be blocked by) other issues.
-- Ported from the upstream task_dependencies feature onto our issues model so
-- work_ready stops handing out blocked work. An edge (issue_id -> depends_on_id)
-- means issue_id is BLOCKED until depends_on_id reaches status = 'done'.
-- Cycle prevention lives in the service layer (add_issue_dependency).

CREATE TABLE IF NOT EXISTS {{tables.issue_dependencies}} (
    issue_id        UUID NOT NULL REFERENCES {{tables.issues}}(issue_id)
                    ON DELETE CASCADE,
    depends_on_id   UUID NOT NULL REFERENCES {{tables.issues}}(issue_id)
                    ON DELETE CASCADE,
    team_id         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (issue_id, depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_dependencies_depends_on
    ON {{tables.issue_dependencies}} (depends_on_id);
CREATE INDEX IF NOT EXISTS idx_issue_dependencies_team
    ON {{tables.issue_dependencies}} (team_id);

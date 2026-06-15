-- 011_issue_comments.sql
-- Comments / activity thread on work-hierarchy issues. The collaboration
-- surface where a human and an agent discuss an issue: an agent posts progress,
-- a human replies. Mirrors the existing task_comments shape.

CREATE TABLE IF NOT EXISTS {{tables.issue_comments}} (
    comment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID NOT NULL REFERENCES {{tables.issues}}(issue_id)
                    ON DELETE CASCADE,
    team_id         TEXT NOT NULL,
    author          TEXT NOT NULL,
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue
    ON {{tables.issue_comments}} (issue_id, created_at);

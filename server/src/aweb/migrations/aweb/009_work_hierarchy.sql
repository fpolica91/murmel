-- 004_work_hierarchy.sql
-- Work hierarchy: Epic -> Story -> Issue (Issue is the floor).
--
-- Additive alongside the existing `tasks` table (which stays for compat).
-- Epics group stories; stories group issues; issues are the unit of work and
-- may attach directly to an epic and/or a story (both nullable). All three are
-- team-scoped.

-- ---------------------------------------------------------------------------
-- Epics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{tables.epics}} (
    epic_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         TEXT NOT NULL,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_epics_team
    ON {{tables.epics}} (team_id);

CREATE INDEX IF NOT EXISTS idx_epics_team_status
    ON {{tables.epics}} (team_id, status);

-- ---------------------------------------------------------------------------
-- Stories: belong to an epic
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{tables.stories}} (
    story_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    epic_id         UUID REFERENCES {{tables.epics}}(epic_id) ON DELETE CASCADE,
    team_id         TEXT NOT NULL,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stories_team
    ON {{tables.stories}} (team_id);

CREATE INDEX IF NOT EXISTS idx_stories_team_status
    ON {{tables.stories}} (team_id, status);

CREATE INDEX IF NOT EXISTS idx_stories_epic
    ON {{tables.stories}} (epic_id);

-- ---------------------------------------------------------------------------
-- Issues: the floor of the hierarchy. May attach to an epic and/or a story.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{tables.issues}} (
    issue_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         TEXT NOT NULL,
    epic_id         UUID REFERENCES {{tables.epics}}(epic_id) ON DELETE SET NULL,
    story_id        UUID REFERENCES {{tables.stories}}(story_id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
    assignee_type   TEXT
                    CHECK (assignee_type IS NULL OR assignee_type IN ('human', 'agent')),
    assignee_id     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_team
    ON {{tables.issues}} (team_id);

CREATE INDEX IF NOT EXISTS idx_issues_team_status
    ON {{tables.issues}} (team_id, status);

CREATE INDEX IF NOT EXISTS idx_issues_epic
    ON {{tables.issues}} (epic_id);

CREATE INDEX IF NOT EXISTS idx_issues_story
    ON {{tables.issues}} (story_id);

CREATE INDEX IF NOT EXISTS idx_issues_team_assignee
    ON {{tables.issues}} (team_id, assignee_type, assignee_id);

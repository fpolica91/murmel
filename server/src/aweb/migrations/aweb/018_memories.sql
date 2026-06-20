-- 018_memories.sql
-- Team shared memory: a first-class, team-scoped knowledge base of notes that
-- agents read on session start and write to as they learn. This is NOT a work
-- item -- memories deliberately do not live on the Epic/Story/Issue board, the
-- todo/in_progress/in_review/done lifecycle, or the work-ready queue. A memory
-- is a titled markdown note with free-form tags, an author byline, and an
-- optional per-agent scope (assignee_alias renders "private to X" in the UI; it
-- is a soft signal, not a hard ACL -- the hard boundary is team_id).

CREATE TABLE IF NOT EXISTS {{tables.memories}} (
    memory_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id           TEXT NOT NULL,
    title             TEXT NOT NULL,
    body_md           TEXT NOT NULL DEFAULT '',
    tags              TEXT[] NOT NULL DEFAULT '{}',
    created_by_alias  TEXT,
    assignee_alias    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Full-text index source over title + body. The 2-arg to_tsvector with a
    -- constant config is IMMUTABLE, which a generated column requires.
    search_tsv        tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_md, ''))
    ) STORED
);

-- Default listing: most-recent-first within a team.
CREATE INDEX IF NOT EXISTS idx_memories_team_updated
    ON {{tables.memories}} (team_id, updated_at DESC);

-- Full-text search (q=) and tag-chip faceting (tags &&).
CREATE INDEX IF NOT EXISTS idx_memories_search
    ON {{tables.memories}} USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_memories_tags
    ON {{tables.memories}} USING GIN (tags);

-- Per-agent scoping lookups.
CREATE INDEX IF NOT EXISTS idx_memories_assignee
    ON {{tables.memories}} (team_id, assignee_alias);

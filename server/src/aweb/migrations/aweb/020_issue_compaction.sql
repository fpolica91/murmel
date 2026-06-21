-- Issue thread compaction for long-standing work. As a long-lived issue
-- accumulates a large comment thread, old comments are AI-summarized (Haiku)
-- into a running digest on the issue, and the folded comments are flagged
-- `compacted` (kept in the table, hidden from the default thread view — this is
-- condensation, not deletion). An agent picking the issue up loads the digest +
-- the recent verbatim tail instead of the whole history. Pinned issues
-- (019) are never compacted.

ALTER TABLE {{tables.issue_comments}}
    ADD COLUMN IF NOT EXISTS compacted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE {{tables.issues}}
    ADD COLUMN IF NOT EXISTS compacted_summary TEXT;
ALTER TABLE {{tables.issues}}
    ADD COLUMN IF NOT EXISTS compaction_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE {{tables.issues}}
    ADD COLUMN IF NOT EXISTS compacted_at TIMESTAMPTZ;

-- Fast "recent, non-compacted" tail lookups per issue.
CREATE INDEX IF NOT EXISTS idx_issue_comments_active
    ON {{tables.issue_comments}} (issue_id, created_at)
    WHERE compacted = FALSE;

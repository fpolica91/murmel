-- Per-repo facet on team memory. project = the workspace's canonical git origin
-- (e.g. github.com/awebai/aweb). NULL = team-global (no repo binding / unknown):
-- such a memory is visible in every project's search + prime. Additive; no
-- backfill -- existing rows stay NULL (team-global), which is the correct default.
-- project is an ORGANIZATIONAL FACET, never an access boundary; team_id remains
-- the only hard tenant boundary.

ALTER TABLE {{tables.memories}} ADD COLUMN IF NOT EXISTS project TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_team_project
    ON {{tables.memories}} (team_id, project, updated_at DESC);

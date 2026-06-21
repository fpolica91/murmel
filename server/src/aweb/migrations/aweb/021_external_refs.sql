-- External tracker references on issues, so an imported issue (e.g. from Linear)
-- can be matched on re-pull and updated in place rather than duplicated. NULL
-- for natively-created issues. Additive forward migration.

ALTER TABLE {{tables.issues}}
    ADD COLUMN IF NOT EXISTS external_system TEXT;
ALTER TABLE {{tables.issues}}
    ADD COLUMN IF NOT EXISTS external_ref TEXT;

-- One Murmel issue per (team, external system, external id). NULL external_ref
-- (native issues) is unconstrained — Postgres treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_issues_external_ref
    ON {{tables.issues}} (team_id, external_system, external_ref)
    WHERE external_ref IS NOT NULL;

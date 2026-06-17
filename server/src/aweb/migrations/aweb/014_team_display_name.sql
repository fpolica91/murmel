-- 014_team_display_name.sql
-- Mutable, user-facing team name. `team_id` stays the immutable PK (foreign-keyed
-- by memberships, agents, issues, chats, keys), so renaming a team edits this
-- column, NOT the id. The dashboard shows display_name and falls back to the
-- team_id/team_name when it is NULL. Backfill existing teams from team_name.
ALTER TABLE {{tables.teams}}
    ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE {{tables.teams}}
SET display_name = team_name
WHERE display_name IS NULL;

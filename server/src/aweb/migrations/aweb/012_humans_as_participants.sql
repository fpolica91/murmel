-- 012_humans_as_participants.sql
-- Humans as first-class participants. The agents table is the participant /
-- identity directory; a human becomes a first-class chat/comment/assignee
-- participant by having a row here with agent_type='human'. This migration is
-- additive and idempotent (safe to re-run):
--
--   1. Backfill a human participant row for every active membership that lacks
--      one, so existing humans show up immediately in the roster / pickers. The
--      row is keyed by the deterministic synthetic did_key 'did:key:jwt-<sub>'
--      (the same key the runtime upsert in identity_auth_deps uses), so the two
--      reconcile: on the human's next request the runtime upsert refreshes
--      alias / human_name / address from the verified name claim.
--   2. Add a (team_id, agent_type) index for fast directory listing.
--
-- No column DDL: agent_type and human_name already exist (001_initial.sql).
-- The unique index idx_agents_active_alias is (team_id, alias) WHERE deleted_at
-- IS NULL, so the backfill must not collide with an existing alias for the
-- team; on collision we suffix the subject with a short hash of (subject) to
-- keep the unique index happy. The runtime upsert keyed on did_key remains the
-- source of truth and reconciles the human's real alias on next auth.

INSERT INTO {{tables.agents}} (team_id, did_key, alias, human_name, agent_type, identity_scope, address)
SELECT
    m.team_id,
    'did:key:jwt-' || m.subject AS did_key,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM {{tables.agents}} c
            WHERE c.team_id = m.team_id
              AND c.alias = m.subject
              AND c.deleted_at IS NULL
        )
        THEN m.subject || '-' || substr(md5(m.subject), 1, 8)
        ELSE m.subject
    END AS alias,
    '' AS human_name,
    'human' AS agent_type,
    'local' AS identity_scope,
    m.team_id || '/' || (
        CASE
            WHEN EXISTS (
                SELECT 1 FROM {{tables.agents}} c
                WHERE c.team_id = m.team_id
                  AND c.alias = m.subject
                  AND c.deleted_at IS NULL
            )
            THEN m.subject || '-' || substr(md5(m.subject), 1, 8)
            ELSE m.subject
        END
    ) AS address
FROM {{tables.memberships}} m
WHERE m.status = 'active'
  AND NOT EXISTS (
        SELECT 1 FROM {{tables.agents}} a
        WHERE a.team_id = m.team_id
          AND a.did_key = 'did:key:jwt-' || m.subject
          AND a.deleted_at IS NULL
    )
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_agents_team_type
    ON {{tables.agents}} (team_id, agent_type)
    WHERE deleted_at IS NULL;

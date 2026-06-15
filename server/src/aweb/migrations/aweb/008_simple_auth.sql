-- 003_simple_auth.sql
-- Token-based auth foundation: team membership as data (not certificates)
-- and a JTI revocation denylist for killing rogue tokens.
--
-- Replaces the team-certificate model for human/agent access. A member is
-- identified by the `sub` claim of a Better-Auth-issued JWT (verified by the
-- server via JWKS); this table answers "which teams + role does that subject
-- have." Cert auth remains available (additive) until the E4 cutover.

-- ---------------------------------------------------------------------------
-- Memberships: subject (JWT `sub`) -> team + role
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{tables.memberships}} (
    subject         TEXT NOT NULL,
    team_id         TEXT NOT NULL REFERENCES {{tables.teams}}(team_id)
                    ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member',
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subject, team_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_team_active
    ON {{tables.memberships}} (team_id)
    WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Revoked tokens: JTI denylist. Short-lived tokens + this list = fast
-- revocation. Rows are GC'd after `expires_at` (token can't be replayed once
-- naturally expired).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS {{tables.revoked_tokens}} (
    jti             TEXT PRIMARY KEY,
    subject         TEXT,
    revoked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expiry
    ON {{tables.revoked_tokens}} (expires_at);

-- 015_invitations.sql
-- Team invitations: an owner/admin invites an email to a team; the invitee
-- accepts via a link carrying the random token, which adds a membership row
-- (many-to-many, so it never replaces the invitee's own/other teams). The token
-- is the secret; rows expire and can be revoked. team_id FKs teams so a deleted
-- team cleans up its invites.
CREATE TABLE IF NOT EXISTS {{tables.invitations}} (
    token       TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES {{tables.teams}}(team_id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'revoked')),
    invited_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

-- Fast lookup of a subject's pending invites by email (case-insensitive) and a
-- team's invite list.
CREATE INDEX IF NOT EXISTS idx_invitations_email
    ON {{tables.invitations}} (lower(email))
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_invitations_team
    ON {{tables.invitations}} (team_id);

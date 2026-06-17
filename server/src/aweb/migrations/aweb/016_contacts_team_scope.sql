-- 016_contacts_team_scope.sql
-- Team-scope contacts. A contact (and the delivery-authorization allowlist it
-- backs) was keyed only by owner_did, but a token caller's synthetic DID
-- (did:key:jwt-<sub>) is the same across every team they belong to — so a
-- contact added in team A bled into team B. We add team_id (NOT NULL, '' = the
-- global/cross-org bucket used by did:aw identities and legacy rows) and
-- repartition identity-contact uniqueness per team, so the same address can be
-- a contact in two different teams independently.
ALTER TABLE {{tables.contacts}}
    ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT '';

ALTER TABLE {{tables.contacts}}
    DROP CONSTRAINT IF EXISTS contacts_owner_did_contact_address_key;

ALTER TABLE {{tables.contacts}}
    ADD CONSTRAINT contacts_owner_team_address_key
    UNIQUE (owner_did, team_id, contact_address);

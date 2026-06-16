-- 013_federation_server_key.sql
-- Single-row table holding this server's long-lived Ed25519 federation
-- signing key (Option A.2 server-vouched delivery assertions).
--
-- The key is generated once at lifespan startup (ensure_server_key) and shared
-- across replicas of the same server. The `id boolean PRIMARY KEY DEFAULT TRUE
-- CHECK (id)` guard enforces at most one row so every replica converges on the
-- same key via INSERT ... ON CONFLICT (id) DO NOTHING + re-read.
CREATE TABLE IF NOT EXISTS {{tables.federation_server_key}} (
    id          boolean PRIMARY KEY DEFAULT TRUE CHECK (id),
    private_key bytea       NOT NULL,
    public_did  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Unzeen 0018: Discovery for /tokens (FEATURES.md 9, API.md v0.12), schema as proposed in
-- adapters/src/intel/discovery-pg.ts (PROPOSED_DISCOVERY_SQL). (0016 is reserved for the chat.)
-- Public data only: fresh tokens of the launchpads found by the indexer on its own tick, never
-- from a user request. No user, request or anon key anywhere. Written by the indexer
-- (infra/indexer-role.sql), read by the API for GET /api/tokens?source=discovery (same list for
-- everyone). `pool` / `config` are indexer bookkeeping and never served.
CREATE TABLE intel_discovery (
    network        TEXT        NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    mint           TEXT        NOT NULL,
    venue          TEXT        NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc')),
    created_at     TIMESTAMPTZ NOT NULL,
    name           TEXT        NULL CHECK (char_length(name) <= 64),
    symbol         TEXT        NULL CHECK (char_length(symbol) <= 64),
    status         TEXT        NOT NULL CHECK (status IN ('curve', 'graduated')),
    price_sol      NUMERIC     NOT NULL CHECK (price_sol >= 0),
    market_cap_sol NUMERIC     NOT NULL CHECK (market_cap_sol >= 0),
    progress_pct   NUMERIC(5,2) NULL CHECK (progress_pct BETWEEN 0 AND 100),
    as_of          TIMESTAMPTZ NOT NULL,
    pool           TEXT        NULL,
    config         TEXT        NULL,
    PRIMARY KEY (network, mint)
);
CREATE INDEX intel_discovery_recent ON intel_discovery (network, created_at DESC);

-- ---------------------------------------------------------------- relayer_jobs: consolidate
-- A `consolidate` of an empty leg vault is `confirmed` with out_token_amount = 0 and no tx
-- (no signature). Replace the unnamed CHECK (status <> 'confirmed' OR signature IS NOT NULL).
DO $$
DECLARE c text;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'relayer_jobs'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%confirmed%signature IS NOT NULL%'
    LOOP
        EXECUTE format('ALTER TABLE relayer_jobs DROP CONSTRAINT %I', c);
    END LOOP;
END $$;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_confirmed_signature
    CHECK (status <> 'confirmed' OR signature IS NOT NULL OR op = 'consolidate');

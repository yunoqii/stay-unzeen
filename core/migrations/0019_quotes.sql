-- Unzeen 0019: pairs not quoted in SOL (API.md v0.13, RELAYER.md v8, lead/owner decisions 13.10).
-- New amounts are NUMERIC(78,0) (base units of any SPL token fit; strings in the API).

-- ---------------------------------------------------------------- venues
-- + raydium-launchlab (LaunchLab: own platform "unzeen", bonk.fun, stonk.fun), + bags (reserved).
-- Unnamed CHECKs listing the venues are replaced wherever they allowed 'meteora-dbc'
-- (fair-launch launches and orders stay pump.fun-only on purpose).
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT c.conrelid::regclass AS tbl, c.conname
               FROM pg_constraint c
              WHERE c.contype = 'c'
                AND c.conrelid::regclass::text IN ('relayer_jobs', 'tokens', 'trades', 'intel_tokens',
                                                  'market_trades', 'intel_discovery', 'launch_curves',
                                                  'creator_fee_sweeps')
                AND pg_get_constraintdef(c.oid) LIKE '%venue%meteora-dbc%'
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
END $$;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags'));
ALTER TABLE tokens ADD CONSTRAINT tokens_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags'));
ALTER TABLE trades ADD CONSTRAINT trades_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags'));
ALTER TABLE intel_tokens ADD CONSTRAINT intel_tokens_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags'));
ALTER TABLE market_trades ADD CONSTRAINT market_trades_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags'));
ALTER TABLE intel_discovery ADD CONSTRAINT intel_discovery_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags'));
ALTER TABLE launch_curves ADD CONSTRAINT launch_curves_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags'));
ALTER TABLE creator_fee_sweeps ADD CONSTRAINT creator_fee_sweeps_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags'));

-- ---------------------------------------------------------------- relayer_jobs: fund_quote
ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_op_check;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_op_check
    CHECK (op IN ('buy', 'sell', 'create', 'transfer', 'fair_create', 'attest', 'fund_vaults', 'consolidate',
                  'fund_quote'));
ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_confirmed_signature;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_confirmed_signature
    CHECK (status <> 'confirmed' OR signature IS NOT NULL OR op IN ('consolidate', 'fund_quote'));
DROP INDEX IF EXISTS relayer_jobs_unsettled_internal_idx;
CREATE INDEX relayer_jobs_unsettled_internal_idx ON relayer_jobs (id)
    WHERE op IN ('consolidate', 'fund_vaults', 'fund_quote') AND settled_at IS NULL;

-- Fact of a non-SOL pair job (adapters a756224): quote units moved by the tx. ZEC-pair jobs leave
-- out_lamports NULL (core values them at its own ZEC rate); USDC/USD1 jobs fill both.
ALTER TABLE relayer_jobs
    ADD COLUMN out_quote_mint   TEXT,
    ADD COLUMN out_quote_amount NUMERIC(78,0) CHECK (out_quote_amount >= 0);

-- ---------------------------------------------------------------- public market data
ALTER TABLE trades
    ADD COLUMN quote_mint   TEXT,                                            -- NULL = SOL pair
    ADD COLUMN quote_amount NUMERIC(78,0) CHECK (quote_amount >= 0);         -- base units of quote_mint
ALTER TABLE tokens
    ADD COLUMN quote_mint  TEXT,                                             -- NULL = SOL pair
    ADD COLUMN price_quote NUMERIC CHECK (price_quote >= 0),                 -- quote per 1 whole token
    ADD COLUMN platform    TEXT CHECK (platform IN ('unzeen', 'bonk', 'stonk'));

-- ---------------------------------------------------------------- ledger
-- Quote pair of an action (NULL = SOL); scrubbed with the other per-action details.
ALTER TABLE actions ADD COLUMN quote_mint TEXT;

-- Creator fees collected in a quote token (core credits them from v0.14 on).
ALTER TABLE creator_fee_sweeps
    ADD COLUMN quote_mint   TEXT,
    ADD COLUMN quote_amount NUMERIC(78,0) CHECK (quote_amount >= 0);

-- ---------------------------------------------------------------- pool quote assets
-- Written by core at start (its registry); the relayer reads it for the Verify vault snapshot.
CREATE TABLE pool_quotes (
    network  TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    mint     TEXT NOT NULL,
    quote    TEXT NOT NULL CHECK (quote IN ('USDC', 'USD1', 'ZEC')),
    decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
    bridged  BOOLEAN NOT NULL,
    PRIMARY KEY (network, mint)
);

-- Quote stock of the pool (relayer, every ~5 min with pool_sol_inventory).
CREATE TABLE pool_quote_inventory (
    network        TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    quote_mint     TEXT NOT NULL,
    vault_amount   NUMERIC(78,0) NOT NULL CHECK (vault_amount >= 0),     -- Σ on all vaults
    reserve_amount NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (reserve_amount >= 0),  -- on the rebalance address
    vault_count    INTEGER NOT NULL CHECK (vault_count >= 0),
    slot           BIGINT NOT NULL CHECK (slot >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (network, quote_mint)
);

-- Quote assets of a Verify snapshot (frozen at build: list, bridged / counted flags, dust).
ALTER TABLE verify_snapshots ADD COLUMN quote_assets JSONB;

-- ---------------------------------------------------------------- rebalance target
ALTER TABLE pool_rebalances
    ADD COLUMN target TEXT NOT NULL DEFAULT 'sol' CHECK (target IN ('sol', 'zec_spl'));
DROP INDEX pool_rebalances_one_live;
CREATE UNIQUE INDEX pool_rebalances_one_live ON pool_rebalances (network, target)
    WHERE status IN ('planned', 'quoted', 'sending', 'deposited', 'distributing', 'attention');
-- ZEC SPL rebalances distribute through fund_quote jobs (one per vault), not fund_vaults.
ALTER TABLE pool_rebalances ADD COLUMN fund_quote_jobs BIGINT[];

-- Unzeen 0026: Robinhood Chain stage 0 (API.md v0.18, RELAYER.md v12, docs/analysis/robinhood-chain.md).
--
-- 1. Token amounts and quote amounts (lamports today, wei on Robinhood Chain) become NUMERIC(78,0):
--    an ERC-20 with 18 decimals and a 1e9 supply is 1e27 base units (> BIGINT 9.2e18), and ETH
--    in wei passes BIGINT at 9.2 ETH. Zatoshis (≤ 2.1e15), gas drops / network fees, slots,
--    block heights and rates (lamports|wei per ZEC ≤ ~5e17 today) stay BIGINT. Verify leaves stay
--    u64 (Verify v1/v2 wire format; per-key token pieces of an 18-decimal token need Verify v3).
--    Values are unchanged (BIGINT → NUMERIC is exact); CHECKs and column grants survive.
-- 2. Chain as a parameter: venue `pons` (Pons V2, Robinhood Chain), networks `hood` (chain 4663)
--    and `hood-testnet` (46630), Verify chain ids 0111 / 0212. Nothing schedules hood work yet.

-- ---------------------------------------------------------------- 1. amounts
ALTER TABLE relayer_jobs
    ALTER COLUMN lamports_in      TYPE NUMERIC(78,0),
    ALTER COLUMN token_amount     TYPE NUMERIC(78,0),
    ALTER COLUMN min_out          TYPE NUMERIC(78,0),
    ALTER COLUMN out_token_amount TYPE NUMERIC(78,0),
    ALTER COLUMN out_lamports     TYPE NUMERIC(78,0),
    ALTER COLUMN out_creator_fee  TYPE NUMERIC(78,0);

ALTER TABLE actions
    ALTER COLUMN token_hold TYPE NUMERIC(78,0),
    ALTER COLUMN gain_est   TYPE NUMERIC(78,0);

ALTER TABLE token_balances
    ALTER COLUMN available TYPE NUMERIC(78,0),
    ALTER COLUMN held      TYPE NUMERIC(78,0);
ALTER TABLE token_ops
    ALTER COLUMN delta_available TYPE NUMERIC(78,0),
    ALTER COLUMN delta_held      TYPE NUMERIC(78,0);

ALTER TABLE trades
    ALTER COLUMN token_amount TYPE NUMERIC(78,0),
    ALTER COLUMN sol_amount   TYPE NUMERIC(78,0);
ALTER TABLE market_trades
    ALTER COLUMN token_amount TYPE NUMERIC(78,0),
    ALTER COLUMN sol_amount   TYPE NUMERIC(78,0);

ALTER TABLE creator_tokens
    ALTER COLUMN locked_amount       TYPE NUMERIC(78,0),
    ALTER COLUMN launch_fee_lamports TYPE NUMERIC(78,0),
    ALTER COLUMN launch_fee_left     TYPE NUMERIC(78,0);

ALTER TABLE launch_curves
    ALTER COLUMN virtual_sol_lamports   TYPE NUMERIC(78,0),
    ALTER COLUMN virtual_token_reserves TYPE NUMERIC(78,0),
    ALTER COLUMN real_token_reserves    TYPE NUMERIC(78,0),
    ALTER COLUMN token_total_supply     TYPE NUMERIC(78,0);

ALTER TABLE fl_launches
    ALTER COLUMN total_e     TYPE NUMERIC(78,0),
    ALTER COLUMN lamports_in TYPE NUMERIC(78,0);
ALTER TABLE fl_bids
    ALTER COLUMN e_lamports TYPE NUMERIC(78,0),
    ALTER COLUMN tokens     TYPE NUMERIC(78,0);

-- zat (limit_buy) or token base units (sell orders)
ALTER TABLE orders ALTER COLUMN amount TYPE NUMERIC(78,0);

ALTER TABLE creator_fee_sweeps
    ALTER COLUMN lamports      TYPE NUMERIC(78,0),
    ALTER COLUMN pool_lamports TYPE NUMERIC(78,0);
ALTER TABLE creator_claimable
    ALTER COLUMN lamports         TYPE NUMERIC(78,0),
    ALTER COLUMN claimed_lamports TYPE NUMERIC(78,0);

ALTER TABLE pool_sol_inventory
    ALTER COLUMN vault_lamports     TYPE NUMERIC(78,0),
    ALTER COLUMN rebalance_lamports TYPE NUMERIC(78,0);
ALTER TABLE pool_rebalances
    ALTER COLUMN amount_out_quote TYPE NUMERIC(78,0),
    ALTER COLUMN min_amount_out   TYPE NUMERIC(78,0),
    ALTER COLUMN amount_out       TYPE NUMERIC(78,0);

-- Verify: native balance of a pool address (wei on hood) and the gas of queued withdrawals.
ALTER TABLE verify_vaults ALTER COLUMN lamports TYPE NUMERIC(78,0);
ALTER TABLE verify_snapshots ALTER COLUMN committed_lamports TYPE NUMERIC(78,0);

-- ---------------------------------------------------------------- 2. venue `pons`
DO $$
DECLARE t text; c text;
BEGIN
    -- Per table via a search_path regclass (as in 0018/0019): never touches other schemas.
    FOREACH t IN ARRAY ARRAY['relayer_jobs', 'tokens', 'trades', 'intel_tokens', 'market_trades',
                             'intel_discovery', 'launch_curves', 'creator_fee_sweeps', 'intel_creates']
    LOOP
        FOR c IN SELECT conname FROM pg_constraint
                  WHERE conrelid = to_regclass(t) AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%venue%bags%'
        LOOP
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
        END LOOP;
    END LOOP;
END $$;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE tokens ADD CONSTRAINT tokens_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE trades ADD CONSTRAINT trades_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE intel_tokens ADD CONSTRAINT intel_tokens_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE market_trades ADD CONSTRAINT market_trades_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE intel_discovery ADD CONSTRAINT intel_discovery_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE launch_curves ADD CONSTRAINT launch_curves_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE creator_fee_sweeps ADD CONSTRAINT creator_fee_sweeps_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags', 'pons'));
ALTER TABLE intel_creates ADD CONSTRAINT intel_creates_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags', 'pons'));

-- ---------------------------------------------------------------- 2. networks `hood`, `hood-testnet`
DO $$
DECLARE t text; c text;
BEGIN
    FOREACH t IN ARRAY ARRAY['mint_vaults', 'relayer_jobs', 'relayer_vault_usage', 'relayer_creator_counter',
                             'launch_curves', 'fl_launches', 'creator_fee_sweeps', 'verify_snapshots',
                             'pool_sol_inventory', 'pool_rebalances', 'stats_snapshots', 'pool_quotes',
                             'pool_quote_inventory', 'intel_discovery', 'intel_creates']
    LOOP
        CONTINUE WHEN to_regclass(t) IS NULL;
        FOR c IN SELECT conname FROM pg_constraint
                  WHERE conrelid = to_regclass(t) AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%network%devnet%mainnet-beta%'
        LOOP
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c);
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (network IN '
                           '(''devnet'', ''mainnet-beta'', ''hood'', ''hood-testnet''))', t, c);
        END LOOP;
    END LOOP;
END $$;

DO $$
DECLARE c text;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = to_regclass('verify_snapshots') AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%chain_id%0202%'
    LOOP
        EXECUTE format('ALTER TABLE verify_snapshots DROP CONSTRAINT %I', c);
    END LOOP;
END $$;
ALTER TABLE verify_snapshots ADD CONSTRAINT verify_snapshots_chain_id_check
    CHECK (chain_id IN ('0202', '0101', '0212', '0111'));

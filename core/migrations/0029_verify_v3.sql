-- Unzeen 0029: Verify v3 and the Robinhood Chain rebalance (API.md v0.20, RELAYER.md v14).
--
-- Verify v3 (Robinhood Chain snapshots; Solana keeps v2): leaf values are u128 (an 18-decimal
-- ERC-20 balance of one key passes u64 at 18.4 whole tokens), assets of ERC-20 tokens are
-- `0x…` addresses (32-byte id = 12 zero bytes ‖ address). Existing rows are unchanged.
ALTER TABLE verify_leaves ALTER COLUMN value TYPE NUMERIC(78,0);
ALTER TABLE verify_snapshots DROP CONSTRAINT IF EXISTS verify_snapshots_digest_version_check;
ALTER TABLE verify_snapshots ADD CONSTRAINT verify_snapshots_digest_version_check
    CHECK (digest_version IN (1, 2, 3));

-- Rebalance ZEC → ETH (hood instance): 1Click delivers native ETH to the pool's rebalance
-- address on Robinhood Chain; distribution to vaults is the same `fund_vaults` job.
DO $$
DECLARE c text;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = to_regclass('pool_rebalances') AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%target%zec_spl%'
    LOOP
        EXECUTE format('ALTER TABLE pool_rebalances DROP CONSTRAINT %I', c);
    END LOOP;
END $$;
ALTER TABLE pool_rebalances ADD CONSTRAINT pool_rebalances_target_check
    CHECK (target IN ('sol', 'zec_spl', 'eth'));

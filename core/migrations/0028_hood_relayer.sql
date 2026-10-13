-- Unzeen 0028: Robinhood Chain relayer contract (RELAYER.md v13, adapters `src/evm/relayer/`).
--
-- relayer_launches: the hood relayer's crash-safe record of a launch in flight (which pool
-- creator index it used, from which block to look for the TokenLaunched event). Public-chain
-- facts only, no anon keys, no actions. DDL as proposed by adapters (PROPOSED_RELAYER_LAUNCHES_SQL);
-- the grant lives in infra/relayer-role.sql like every relayer grant.
CREATE TABLE relayer_launches (
    job_id        BIGINT PRIMARY KEY REFERENCES relayer_jobs (id) ON DELETE CASCADE,
    network       TEXT NOT NULL CHECK (network IN ('hood', 'hood-testnet')),
    creator_index INTEGER NOT NULL CHECK (creator_index >= 0),
    from_block    BIGINT NOT NULL CHECK (from_block >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- transfer_native (reserved, hood): withdrawal of the chain's native coin (ETH) to `dest`,
-- amount in `lamports_in` (wei). Core does not queue it yet (no product flow decided).
ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_op_check;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_op_check
    CHECK (op IN ('buy', 'sell', 'create', 'transfer', 'fair_create', 'attest', 'fund_vaults', 'consolidate',
                  'fund_quote', 'transfer_native'));

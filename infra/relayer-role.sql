-- Least-privilege Postgres role for the TS relayer (docs/RELAYER.md).
-- The relayer sees the job queue, mint -> vault pins and public market data only: no
-- balances, actions, deposits, payouts, journals or creator rights, and NOT relayer_jobs.action_id.
--
-- Idempotent: creates the role once, (re)applies grants every run. Run after core has applied
-- its migrations (the API or scanner does that at start), and again after new migrations:
--   docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
--     psql -v ON_ERROR_STOP=1 -U unzeen -d unzeen -v pw="'<RELAYER_DB_PASSWORD>'" < infra/relayer-role.sql
-- Then give the relayer DATABASE_URL_RELAYER=postgres://unzeen_relayer:<pw>@127.0.0.1:55432/unzeen
-- (never the owner's DATABASE_URL).

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unzeen_relayer') AS need_role \gset
\if :need_role
CREATE ROLE unzeen_relayer LOGIN PASSWORD :pw;
\endif

-- Nothing by default: drop anything granted earlier, then grant exactly the contract.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM unzeen_relayer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM unzeen_relayer;
GRANT CONNECT ON DATABASE unzeen TO unzeen_relayer;
GRANT USAGE ON SCHEMA public TO unzeen_relayer;

-- Queue: read jobs, update only relayer-owned columns (no INSERT/DELETE).
-- Column-level SELECT: action_id (the only link to a user) is NOT readable by the relayer.
GRANT SELECT (id, part, op, venue, mint, lamports_in, token_amount, min_out, meta, dest,
              gas_lamports, network, status, not_before, attempts, claimed_by, claimed_at,
              lease_until, signature, last_valid_block_height, vault, slot, out_mint,
              out_token_amount, out_lamports, network_fee, error_code, error_message,
              settled_at, created_at, updated_at, exec_mode,
              mint_secret, out_memo,   -- 0008: fair_create / attest
              out_sig,                 -- 0009: operator signature of attest
              out_block_time,          -- 0012: block time of attest
              out_creator_fee,         -- 0013: exact creator fee of a create / fair_create tx
              bundle_legs,             -- 0017: fair-launch v2 legs [{sig, vault}]
              out_quote_mint, out_quote_amount) -- 0019: quote units of a non-SOL pair job
    ON relayer_jobs TO unzeen_relayer;
-- not_before: backoff only; a trigger (0003) refuses to move it earlier.
GRANT UPDATE (status, attempts, claimed_by, claimed_at, lease_until, not_before, signature,
              last_valid_block_height, vault, slot, out_mint, out_token_amount,
              out_lamports, network_fee, error_code, error_message, updated_at, out_memo, out_sig, out_block_time,
              out_creator_fee, bundle_legs, out_quote_mint, out_quote_amount)
    ON relayer_jobs TO unzeen_relayer;

-- mint -> vault pinning (0003): the relayer owns it (re-pin = UPDATE of vault only).
GRANT SELECT, INSERT, UPDATE (vault) ON mint_vaults TO unzeen_relayer;
-- Relayer state (0004): vault rotation and the fresh-creator counter.
GRANT SELECT, INSERT, UPDATE ON relayer_vault_usage, relayer_creator_counter TO unzeen_relayer;

-- Launch curve of the network (0008): written from the venue's on-chain config.
GRANT SELECT, INSERT, UPDATE ON launch_curves TO unzeen_relayer;

-- Verify (0009): freeze check, vault balance snapshot and vault signatures. No access to
-- trees, leaves or any user balance.
GRANT SELECT (id, network, chain_id, status, freeze_until, assets_done_at,
              min_slot),               -- 0014: read vaults at finalized with minContextSlot >= min_slot
      UPDATE (solana_slot, assets_done_at)
    ON verify_snapshots TO unzeen_relayer;
GRANT SELECT, INSERT ON verify_vaults TO unzeen_relayer;

-- Creator-fee sweeps (0010), as proposed in adapters/src/relayer/fee-sweeper.ts
-- (PROPOSED_FEE_SWEEPS_GRANTS). credited_at belongs to core.
GRANT SELECT (id, network, venue, kind, mint, authority, signature, last_valid_block_height,
              status, lamports, slot, swept_at, created_at,
              quote_mint, quote_amount)           -- 0019: fees collected in a quote token
    ON creator_fee_sweeps TO unzeen_relayer;
GRANT INSERT (network, venue, kind, mint, authority, signature, last_valid_block_height, quote_mint)
    ON creator_fee_sweeps TO unzeen_relayer;
GRANT UPDATE (status, lamports, slot, swept_at, quote_amount) ON creator_fee_sweeps TO unzeen_relayer;
GRANT USAGE ON SEQUENCE creator_fee_sweeps_id_seq TO unzeen_relayer;

-- Rebalance (0015, RELAYER v7): the relayer writes the pool's SOL inventory (vault totals and
-- the rebalance address); core reads it to trigger a ZEC->SOL rebalance. The journal
-- pool_rebalances is core-only. fund_vaults jobs use the relayer_jobs grants above.
GRANT SELECT, INSERT, UPDATE ON pool_sol_inventory TO unzeen_relayer;
-- Non-SOL pairs (0019, RELAYER v8): quote mints of the pool (core writes) and the quote stock.
GRANT SELECT ON pool_quotes TO unzeen_relayer;
GRANT SELECT, INSERT, UPDATE ON pool_quote_inventory TO unzeen_relayer;

-- Robinhood Chain relayer (0028, RELAYER v13): launches in flight (public-chain facts only).
GRANT SELECT, INSERT, DELETE ON relayer_launches TO unzeen_relayer;

-- Public market data.
GRANT SELECT, INSERT, UPDATE ON tokens TO unzeen_relayer;
GRANT SELECT, INSERT ON trades TO unzeen_relayer;
GRANT USAGE ON SEQUENCE trades_id_seq TO unzeen_relayer;

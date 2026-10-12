-- Least-privilege Postgres role for the TS relayer (docs/RELAYER.md).
-- The relayer sees the job queue and public market data only: no balances, actions,
-- deposits, journals or creator rights.
--
-- Run once, after core has applied its migrations:
--   docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
--     psql -U unzeen -d unzeen -v pw="'<RELAYER_DB_PASSWORD>'" < infra/relayer-role.sql
-- Then give the relayer DATABASE_URL=postgres://unzeen_relayer:<pw>@127.0.0.1:55432/unzeen

CREATE ROLE unzeen_relayer LOGIN PASSWORD :pw;
GRANT CONNECT ON DATABASE unzeen TO unzeen_relayer;
GRANT USAGE ON SCHEMA public TO unzeen_relayer;

-- Queue: read jobs, update only relayer-owned columns (no INSERT/DELETE).
-- Column-level SELECT: action_id (the only link to a user) is NOT readable by the relayer.
GRANT SELECT (id, part, op, venue, mint, lamports_in, token_amount, min_out, meta, dest,
              gas_lamports, network, status, not_before, attempts, claimed_by, claimed_at,
              lease_until, signature, last_valid_block_height, vault, slot, out_mint,
              out_token_amount, out_lamports, network_fee, error_code, error_message,
              settled_at, created_at, updated_at)
    ON relayer_jobs TO unzeen_relayer;
GRANT UPDATE (status, attempts, claimed_by, claimed_at, lease_until, signature,
              last_valid_block_height, vault, slot, out_mint, out_token_amount,
              out_lamports, network_fee, error_code, error_message, updated_at)
    ON relayer_jobs TO unzeen_relayer;

-- Public market data.
GRANT SELECT, INSERT, UPDATE ON tokens TO unzeen_relayer;
GRANT SELECT, INSERT ON trades TO unzeen_relayer;
GRANT USAGE ON SEQUENCE trades_id_seq TO unzeen_relayer;

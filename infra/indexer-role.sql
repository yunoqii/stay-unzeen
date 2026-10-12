-- Least-privilege Postgres role for the token indexer (docs/INTEL.md).
-- The indexer writes token-intel snapshots only. It sees public market data read-only and
-- NOTHING of the ledger: no anon keys, balances, actions, deposits, creator rights, payouts,
-- journals or the relayer queue. It can never write `tokens` / `trades` (rule: searched mints
-- must not appear in the public GET /api/tokens).
--
-- Idempotent: creates the role once, (re)applies grants every run. Run after core has applied
-- its migrations (0007+), and again after new migrations:
--   docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
--     psql -v ON_ERROR_STOP=1 -U unzeen -d unzeen -v pw="'<INDEXER_DB_PASSWORD>'" < infra/indexer-role.sql
-- Then give the indexer DATABASE_URL_INDEXER=postgres://unzeen_indexer:<pw>@127.0.0.1:55432/unzeen
-- (never DATABASE_URL or DATABASE_URL_RELAYER).

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unzeen_indexer') AS need_role \gset
\if :need_role
CREATE ROLE unzeen_indexer LOGIN PASSWORD :pw;
\endif

-- Nothing by default: drop anything granted earlier, then grant exactly the contract.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM unzeen_indexer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM unzeen_indexer;
GRANT CONNECT ON DATABASE unzeen TO unzeen_indexer;
GRANT USAGE ON SCHEMA public TO unzeen_indexer;

-- CA queue: core inserts, the indexer drains on its tick.
GRANT SELECT, DELETE ON intel_requests TO unzeen_indexer;
-- Warm set: core pins pool tokens; the indexer only sets the 7-day expiry of batch mints.
GRANT SELECT ON intel_warm TO unzeen_indexer;
GRANT INSERT (mint, expires_at), UPDATE (expires_at) ON intel_warm TO unzeen_indexer;
-- Snapshots, token cards, subscriptions, schedule: owned by the indexer.
GRANT SELECT, INSERT, UPDATE, DELETE ON token_safety, intel_tokens, intel_subscriptions, intel_meta
    TO unzeen_indexer;
-- Full trade feed (written only with UNZEEN_INTEL_FULL_TRADES=1).
GRANT SELECT, INSERT, UPDATE (tags) ON market_trades TO unzeen_indexer;
GRANT USAGE ON SEQUENCE market_trades_id_seq TO unzeen_indexer;

-- Public market data and the public vault list: read-only.
GRANT SELECT ON tokens, trades, mint_vaults, relayer_vault_usage TO unzeen_indexer;

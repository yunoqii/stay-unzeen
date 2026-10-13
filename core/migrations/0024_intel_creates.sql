-- Unzeen 0024: dev history index of the token indexer (adapters ac24ed8, `intel/dev-index.ts`)
-- and the index for GET /api/tokens/:mint/trades?filter=dev.
--
-- Public on-chain data only: who created which launchpad token (any creator, not only the
-- pool's), when, and the indexer's rug heuristic. No anon keys, nothing of the ledger.
-- Retention: 90 days (core janitor, `warm_sync`).
CREATE TABLE intel_creates (
    network        TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    mint           TEXT NOT NULL,
    venue          TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab', 'bags')),
    creator        TEXT NOT NULL,
    slot           BIGINT NOT NULL CHECK (slot >= 0),
    created_at     TIMESTAMPTZ NOT NULL,          -- block time of the create tx
    signature      TEXT NOT NULL,
    rug            BOOLEAN,                       -- NULL until checked
    rug_checked_at TIMESTAMPTZ,
    PRIMARY KEY (network, mint)
);
CREATE INDEX intel_creates_creator_idx ON intel_creates (network, creator, created_at DESC);

-- filter=dev: trades of the token's creator on this mint.
CREATE INDEX market_trades_mint_trader_idx ON market_trades (mint, trader);

-- Unzeen 0007: token intel (docs/INTEL.md) and creator rules of Unzeen launches (API v0.5).
--
-- Token intel tables hold PUBLIC Solana data only (no anon keys, no IPs, no request times
-- finer than a minute). The indexer role (infra/indexer-role.sql) sees only these tables and
-- read-only public market data.

-- ---------------------------------------------------------------- CA request queue
-- Cold mints asked via GET /api/tokens/:mint[/safety]. core inserts, the indexer drains it on
-- its fixed tick. Nothing tells a request from a decoy after processing.
CREATE TABLE intel_requests (
    mint      TEXT PRIMARY KEY,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now())
);

-- ---------------------------------------------------------------- warm set
-- pinned/hot: core (tokens of the pool). expires_at: indexer (every mint of a tick batch,
-- requested or decoy, lives 7 days). No column says why a mint is here.
CREATE TABLE intel_warm (
    mint       TEXT PRIMARY KEY,
    pinned     BOOLEAN NOT NULL DEFAULT FALSE,
    hot        BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    CHECK (pinned OR expires_at IS NOT NULL)
);

-- ---------------------------------------------------------------- safety snapshots
CREATE TABLE token_safety (
    mint    TEXT PRIMARY KEY,
    -- Minute of the indexer tick that produced the snapshot (never a request time).
    as_of   TIMESTAMPTZ NOT NULL CHECK (as_of = date_trunc('minute', as_of)),
    -- The mint account does not exist / is not an SPL Token or Token-2022 mint -> 404.
    missing BOOLEAN NOT NULL DEFAULT FALSE,
    -- TokenSafety fields except mint / asOf / unzeen (docs/INTEL.md).
    data    JSONB,
    CHECK (missing OR data IS NOT NULL)
);

-- Token card for mints that are NOT in `tokens` (never listed by GET /api/tokens).
CREATE TABLE intel_tokens (
    mint           TEXT PRIMARY KEY,
    venue          TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter')),
    symbol         TEXT NOT NULL,
    name           TEXT NOT NULL,
    image          TEXT,
    decimals       SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
    status         TEXT NOT NULL DEFAULT 'curve' CHECK (status IN ('curve', 'graduated')),
    price_sol      NUMERIC NOT NULL DEFAULT 0 CHECK (price_sol >= 0),
    market_cap_sol NUMERIC NOT NULL DEFAULT 0 CHECK (market_cap_sol >= 0),
    created_at     TIMESTAMPTZ NOT NULL,
    as_of          TIMESTAMPTZ NOT NULL CHECK (as_of = date_trunc('minute', as_of))
);

-- Indexer-private state: accountSubscribe targets of hot warm mints.
CREATE TABLE intel_subscriptions (
    account TEXT PRIMARY KEY,
    mint    TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('pump_curve', 'dbc_pool', 'pumpswap_pool')),
    since   TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now())
);
CREATE INDEX intel_subscriptions_mint_idx ON intel_subscriptions (mint);

-- Full per-mint trade feed (behind UNZEEN_INTEL_FULL_TRADES). Public on-chain trades only.
CREATE TABLE market_trades (
    id           BIGSERIAL PRIMARY KEY,
    mint         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('buy', 'sell')),
    venue        TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter')),
    symbol       TEXT NOT NULL,
    trader       TEXT NOT NULL,
    unzeen       BOOLEAN NOT NULL DEFAULT FALSE,
    tags         TEXT[] NOT NULL DEFAULT '{}'
                 CHECK (tags <@ ARRAY['whale', 'dev', 'sniper']::TEXT[]),
    token_amount BIGINT NOT NULL CHECK (token_amount >= 0),
    sol_amount   BIGINT NOT NULL CHECK (sol_amount >= 0),
    decimals     SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
    signature    TEXT NOT NULL,
    ix           SMALLINT NOT NULL DEFAULT 0,
    slot         BIGINT,
    ts           TIMESTAMPTZ NOT NULL,
    UNIQUE (signature, ix),
    -- T1: pool vault trades are never tagged as the dev's.
    CHECK (NOT (unzeen AND 'dev' = ANY (tags)))
);
CREATE INDEX market_trades_mint_idx ON market_trades (mint, id DESC);

-- Tick schedule published by the indexer (next_tick_at, last_tick_at: unix ms).
CREATE TABLE intel_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- creator rules (core only)
-- Lock of the creator's initial-buy tokens: sell / withdraw_token must leave at least
-- locked_amount available until locked_until (rounded UP to the hour). Cleared by the janitor.
ALTER TABLE creator_tokens
    ADD COLUMN locked_amount BIGINT NOT NULL DEFAULT 0 CHECK (locked_amount >= 0),
    ADD COLUMN locked_until  TIMESTAMPTZ;

-- Upper-bound token estimate of a creator's queued buy (creator cap). Set only for buys of
-- a creator of that mint, cleared at settlement and by the D1 scrub.
ALTER TABLE actions
    ADD COLUMN gain_mint TEXT,
    ADD COLUMN gain_est  BIGINT CHECK (gain_est >= 0);
CREATE INDEX actions_gain_idx ON actions (anon_pubkey, gain_mint) WHERE gain_mint IS NOT NULL;

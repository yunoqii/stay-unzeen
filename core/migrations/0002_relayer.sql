-- Unzeen 0002: relayer queue, public market data (feed/tokens), token holdings, payouts.
-- Contract with the TS relayer: docs/RELAYER.md. All amounts are integers in base units:
-- zatoshis (ZEC), lamports (SOL), token base units.
--
-- Privacy boundary: tables the relayer reads/writes (relayer_jobs, trades, tokens) carry NO
-- anon_pubkey. The only link to a user is relayer_jobs.action_id, which core detaches
-- (sets NULL) 24 h after the job was settled.

-- ---------------------------------------------------------------- actions: quote used
ALTER TABLE actions
    ADD COLUMN amount_zat            BIGINT NOT NULL DEFAULT 0 CHECK (amount_zat >= 0),
    ADD COLUMN fee_zat               BIGINT NOT NULL DEFAULT 0 CHECK (fee_zat >= 0),
    -- ZEC->SOL rate fixed at submission: lamports per 1 ZEC (1e8 zat), after spread.
    ADD COLUMN rate_lamports_per_zec BIGINT CHECK (rate_lamports_per_zec > 0),
    ADD COLUMN rate_source           TEXT,
    ADD COLUMN rate_ts               TIMESTAMPTZ,
    -- Token hold of sell / withdraw_token (base units), released or spent on settlement.
    ADD COLUMN token_mint            TEXT,
    ADD COLUMN token_hold            BIGINT NOT NULL DEFAULT 0 CHECK (token_hold >= 0),
    -- Fill summary, filled by core on settlement (shown only to the owner).
    ADD COLUMN fill                  JSONB;

ALTER TABLE ledger_ops DROP CONSTRAINT ledger_ops_kind_check;
ALTER TABLE ledger_ops ADD CONSTRAINT ledger_ops_kind_check
    CHECK (kind IN ('deposit_credit', 'hold', 'settle', 'release', 'refund', 'sell_credit'));

-- ---------------------------------------------------------------- token holdings (core only)
CREATE TABLE token_balances (
    anon_pubkey BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    mint        TEXT NOT NULL,
    available   BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
    held        BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (anon_pubkey, mint)
);

CREATE TABLE token_ops (
    id              BIGSERIAL PRIMARY KEY,
    anon_pubkey     BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    mint            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('buy_credit', 'hold', 'spend', 'release')),
    delta_available BIGINT NOT NULL,
    delta_held      BIGINT NOT NULL,
    action_id       BYTEA REFERENCES actions (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX token_ops_pk_idx ON token_ops (anon_pubkey, id);

-- Creator rights of tokens launched through Unzeen (core only; never exposed publicly).
CREATE TABLE creator_tokens (
    mint        TEXT PRIMARY KEY,
    anon_pubkey BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- relayer queue
CREATE TABLE relayer_jobs (
    id              BIGSERIAL PRIMARY KEY,
    -- Link to the action (core side). NULL after the 24 h detach. No anon_pubkey here, ever.
    action_id       BYTEA REFERENCES actions (id) ON DELETE SET NULL,
    part            SMALLINT NOT NULL DEFAULT 0 CHECK (part >= 0),
    op              TEXT NOT NULL CHECK (op IN ('buy', 'sell', 'create', 'transfer')),
    venue           TEXT CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter')),
    mint            TEXT,                 -- NULL for create (result goes to out_mint)
    -- Inputs (by op, see docs/RELAYER.md):
    lamports_in     BIGINT CHECK (lamports_in >= 0),    -- buy; create initial buy (0 = none)
    token_amount    BIGINT CHECK (token_amount > 0),    -- sell; transfer
    min_out         BIGINT CHECK (min_out >= 0),        -- buy: min tokens; sell: min lamports
    meta            JSONB,                -- create: {"name","symbol","image"?}
    dest            TEXT,                 -- transfer: fresh Solana address of the recipient
    gas_lamports    BIGINT CHECK (gas_lamports >= 0),   -- transfer: SOL drop for the recipient's fees
    network         TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    -- Lifecycle: queued -> claimed -> sent -> confirmed | failed (core then sets settled_at).
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'claimed', 'sent', 'confirmed', 'failed')),
    not_before      TIMESTAMPTZ NOT NULL DEFAULT now(),   -- execution jitter / delay
    attempts        INTEGER NOT NULL DEFAULT 0,
    claimed_by      TEXT,
    claimed_at      TIMESTAMPTZ,
    lease_until     TIMESTAMPTZ,
    -- Relayer results:
    signature       TEXT,                 -- written BEFORE broadcast (status 'sent')
    last_valid_block_height BIGINT,       -- of the blockhash used by `signature`
    vault           TEXT,                 -- public vault address that signed (relayer bookkeeping)
    slot            BIGINT,
    out_mint        TEXT,                 -- create: the new mint
    out_token_amount BIGINT CHECK (out_token_amount >= 0),  -- tokens received (buy/create) or sent (sell/transfer)
    out_lamports    BIGINT CHECK (out_lamports >= 0),       -- lamports paid (buy/create) or received (sell)
    network_fee     BIGINT CHECK (network_fee >= 0),
    error_code      TEXT CHECK (error_code IN ('slippage', 'graduated', 'pool_liquidity',
                        'venue_unavailable', 'not_found', 'bad_request', 'internal')),
    error_message   TEXT,                 -- developer text, no user data
    settled_at      TIMESTAMPTZ,          -- core: ledger closed for this job
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (action_id, part),
    CHECK (status <> 'confirmed' OR signature IS NOT NULL),
    CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE INDEX relayer_jobs_ready_idx ON relayer_jobs (not_before) WHERE status = 'queued';
CREATE INDEX relayer_jobs_inflight_idx ON relayer_jobs (lease_until) WHERE status IN ('claimed', 'sent');
CREATE INDEX relayer_jobs_unsettled_idx ON relayer_jobs (id)
    WHERE status IN ('confirmed', 'failed') AND settled_at IS NULL;

-- ---------------------------------------------------------------- public market data
-- Written by the relayer (and later an indexer). Everything here is already public on Solana.
CREATE TABLE tokens (
    mint           TEXT PRIMARY KEY,
    venue          TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter')),
    symbol         TEXT NOT NULL,
    name           TEXT NOT NULL,
    image          TEXT,                  -- URL served by us (re-encoded), never the user's original
    decimals       SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
    status         TEXT NOT NULL DEFAULT 'curve' CHECK (status IN ('curve', 'graduated')),
    price_sol      NUMERIC NOT NULL DEFAULT 0 CHECK (price_sol >= 0),       -- SOL per 1 whole token
    market_cap_sol NUMERIC NOT NULL DEFAULT 0 CHECK (market_cap_sol >= 0),  -- SOL
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tokens_created_idx ON tokens (created_at DESC);

CREATE TABLE trades (
    id           BIGSERIAL PRIMARY KEY,   -- FeedEvent.id (decimal string)
    kind         TEXT NOT NULL CHECK (kind IN ('buy', 'sell', 'create')),
    venue        TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc', 'jupiter')),
    mint         TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    token_amount BIGINT NOT NULL CHECK (token_amount >= 0),   -- base units
    sol_amount   BIGINT NOT NULL CHECK (sol_amount >= 0),     -- lamports
    decimals     SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
    signature    TEXT NOT NULL,
    slot         BIGINT,
    ts           TIMESTAMPTZ NOT NULL,    -- block time
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (signature, kind, mint)
);
CREATE INDEX trades_mint_idx ON trades (mint, id DESC);
CREATE INDEX trades_mint_ts_idx ON trades (mint, ts);

-- ---------------------------------------------------------------- ZEC payouts (core only)
-- withdraw_zec: executed by core (pool wallet), not the TS relayer. to_ua is deleted once
-- the payout is final.
CREATE TABLE zec_payouts (
    id          BIGSERIAL PRIMARY KEY,
    action_id   BYTEA NOT NULL UNIQUE REFERENCES actions (id),
    to_ua       TEXT,
    amount_zat  BIGINT NOT NULL CHECK (amount_zat > 0),
    status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'confirmed', 'failed')),
    not_before  TIMESTAMPTZ NOT NULL DEFAULT now(),
    error_code  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX zec_payouts_ready_idx ON zec_payouts (not_before) WHERE status = 'queued';

-- ---------------------------------------------------------------- pool metadata
-- Public facts about the pool published by the scanner at start (e.g. 'pool_ua').
CREATE TABLE pool_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- DepositInfo.id
-- Stable random id shown only to the owner (never note_ref, never derived from the tx).
ALTER TABLE deposits ADD COLUMN public_id BYTEA NOT NULL
    DEFAULT decode(replace(gen_random_uuid()::text, '-', ''), 'hex')
    CHECK (length(public_id) = 16);

-- ---------------------------------------------------------------- N5: coarse time next to anon keys
-- Exact times and block heights next to anon_pubkey let a leaked ledger be joined with
-- on-chain data (Ironwood traffic is thin). Rows that carry an anon key keep only the UTC
-- day; attributed deposits keep no mined_height. Ordering within a day is by id.
CREATE FUNCTION unzeen_day_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.created_at := date_trunc('day', NEW.created_at, 'UTC');
    RETURN NEW;
END $$;

CREATE FUNCTION unzeen_day_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := date_trunc('day', NEW.updated_at, 'UTC');
    RETURN NEW;
END $$;

CREATE FUNCTION unzeen_day_both() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.created_at := date_trunc('day', NEW.created_at, 'UTC');
    NEW.updated_at := date_trunc('day', NEW.updated_at, 'UTC');
    RETURN NEW;
END $$;

CREATE FUNCTION unzeen_deposit_coarse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.anon_pubkey IS NOT NULL THEN
        NEW.mined_height := NULL;
        NEW.created_at := date_trunc('day', NEW.created_at, 'UTC');
        NEW.updated_at := date_trunc('day', NEW.updated_at, 'UTC');
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER ledger_ops_coarse BEFORE INSERT OR UPDATE ON ledger_ops
    FOR EACH ROW EXECUTE FUNCTION unzeen_day_created();
CREATE TRIGGER token_ops_coarse BEFORE INSERT OR UPDATE ON token_ops
    FOR EACH ROW EXECUTE FUNCTION unzeen_day_created();
CREATE TRIGGER creator_tokens_coarse BEFORE INSERT OR UPDATE ON creator_tokens
    FOR EACH ROW EXECUTE FUNCTION unzeen_day_created();
CREATE TRIGGER balances_coarse BEFORE INSERT OR UPDATE ON balances
    FOR EACH ROW EXECUTE FUNCTION unzeen_day_updated();
CREATE TRIGGER token_balances_coarse BEFORE INSERT OR UPDATE ON token_balances
    FOR EACH ROW EXECUTE FUNCTION unzeen_day_updated();
CREATE TRIGGER actions_coarse BEFORE INSERT OR UPDATE ON actions
    FOR EACH ROW EXECUTE FUNCTION unzeen_day_both();
CREATE TRIGGER deposits_coarse BEFORE INSERT OR UPDATE ON deposits
    FOR EACH ROW EXECUTE FUNCTION unzeen_deposit_coarse();

-- Backfill rows written before this migration (the triggers fire on these updates).
UPDATE ledger_ops SET created_at = created_at;
UPDATE balances SET updated_at = updated_at;
UPDATE actions SET updated_at = updated_at;
UPDATE deposits SET updated_at = updated_at WHERE anon_pubkey IS NOT NULL;

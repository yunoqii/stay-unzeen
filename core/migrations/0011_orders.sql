-- Unzeen 0011: private limit / take-profit / stop-loss orders (API.md v0.8, INTEL.md v2,
-- spec docs/analysis/orders.md).
--
-- Privacy: an order is an intention next to an anon key. It lives while open (TTL <= 72 h);
-- 24 h after closing amount/price/mint/slippage/action link are erased, after 48 h the row is
-- deleted. No public metric of orders exists anywhere.

-- Price from the indexer tick (public market data): every pinned mint, every tick.
CREATE TABLE intel_prices (
    mint           TEXT PRIMARY KEY,
    price_sol      NUMERIC NOT NULL CHECK (price_sol > 0),   -- SOL per 1 whole token
    status         TEXT NOT NULL DEFAULT 'curve' CHECK (status IN ('curve', 'graduated')),
    tick_at        BIGINT NOT NULL,                          -- unix ms of the indexer tick
    prev_price_sol NUMERIC,
    prev_tick_at   BIGINT
);

CREATE TABLE orders (
    id                BYTEA PRIMARY KEY CHECK (length(id) = 16),   -- = the order_create action id
    anon_pubkey       BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    venue             TEXT NOT NULL CHECK (venue IN ('pumpfun')),
    mint              TEXT,                                      -- NULL after the 24 h scrub
    kind              TEXT NOT NULL CHECK (kind IN ('limit_buy', 'limit_sell', 'take_profit', 'stop_loss')),
    trigger_price_sol NUMERIC CHECK (trigger_price_sol > 0),
    amount            BIGINT NOT NULL CHECK (amount >= 0),       -- zat (limit_buy) or token base units
    slippage_bps      INTEGER CHECK (slippage_bps BETWEEN 50 AND 5000),
    exec_mode         TEXT NOT NULL CHECK (exec_mode IN ('delayed', 'max')),
    expires_at        TIMESTAMPTZ NOT NULL CHECK (expires_at = date_trunc('hour', expires_at)),
    status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'triggered', 'filled', 'cancelled', 'expired', 'failed')),
    error             TEXT,
    sl_armed_tick     BIGINT,                                    -- stop_loss: tick where the condition first held
    last_tick         BIGINT,                                    -- last evaluated indexer tick
    action_id         BYTEA REFERENCES actions (id) ON DELETE SET NULL,   -- buy/sell created on trigger
    created_at        TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now()),
    closed_at         TIMESTAMPTZ
);
CREATE INDEX orders_open_idx ON orders (mint) WHERE status = 'open';
CREATE INDEX orders_owner_idx ON orders (anon_pubkey, created_at DESC);

CREATE FUNCTION unzeen_order_coarse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.created_at := date_trunc('minute', NEW.created_at);
    NEW.closed_at := date_trunc('hour', NEW.closed_at);
    RETURN NEW;
END $$;
CREATE TRIGGER orders_coarse BEFORE INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION unzeen_order_coarse();

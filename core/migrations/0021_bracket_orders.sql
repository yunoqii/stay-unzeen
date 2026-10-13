-- Unzeen 0021: bracket orders (TP + SL on one token hold, OCO) and re-arm after slippage
-- (API.md v0.15).
--
-- A bracket is ONE `orders` row with two legs: `trigger_price_sol` is the take-profit leg,
-- `sl_price_sol` the stop-loss leg. One hold, one row: firing a leg moves the whole row to
-- `triggered` in the same transaction that creates the trade, so the other leg is gone.
--
-- Privacy (D1): `sl_price_sol`, `sl_slippage_bps` and `leg` are erased together with the
-- other order details 24 h after closing (orders_janitor); the row is deleted after 48 h.

ALTER TABLE orders DROP CONSTRAINT orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check
    CHECK (kind IN ('limit_buy', 'limit_sell', 'take_profit', 'stop_loss', 'bracket'));

ALTER TABLE orders
    ADD COLUMN sl_price_sol    NUMERIC CHECK (sl_price_sol > 0),
    ADD COLUMN sl_slippage_bps INTEGER CHECK (sl_slippage_bps BETWEEN 50 AND 5000),
    ADD COLUMN leg             TEXT CHECK (leg IN ('tp', 'sl')),           -- bracket: the leg that fired
    ADD COLUMN rearm           BOOLEAN NOT NULL DEFAULT FALSE,            -- back to open after slippage
    ADD COLUMN rearms          SMALLINT NOT NULL DEFAULT 0 CHECK (rearms BETWEEN 0 AND 3);

ALTER TABLE orders ADD CONSTRAINT orders_bracket_legs_check CHECK (
    (sl_price_sol IS NULL AND sl_slippage_bps IS NULL AND leg IS NULL) OR kind = 'bracket');
ALTER TABLE orders ADD CONSTRAINT orders_bracket_order_check CHECK (
    sl_price_sol IS NULL OR trigger_price_sol IS NULL OR sl_price_sol < trigger_price_sol);
-- A live bracket always has both legs (only the 24 h scrub, which also NULLs mint, removes them).
ALTER TABLE orders ADD CONSTRAINT orders_bracket_live_check CHECK (
    kind <> 'bracket' OR mint IS NULL OR (sl_price_sol IS NOT NULL AND sl_slippage_bps IS NOT NULL));

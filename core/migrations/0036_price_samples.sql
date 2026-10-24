-- Unzeen 0036: price samples of discovery candidates (public chain data, core's own timer).
-- The token page's chart for mints that are not pool tokens and have no trade feed: one row per
-- candidate and discovery metrics pass (as_of = minute). Kept 24 hours. Owner role only.
CREATE TABLE price_samples (
    mint      TEXT NOT NULL,
    tick_at   BIGINT NOT NULL CHECK (tick_at > 0),          -- unix ms of the metrics pass
    price_sol NUMERIC NOT NULL CHECK (price_sol > 0),
    PRIMARY KEY (mint, tick_at)
);
CREATE INDEX price_samples_tick_idx ON price_samples (tick_at);

-- Unzeen 0035: trading comfort (API v0.28): Pulse, curve progress with ETA, per-token curve state.
-- Public chain data only, written on the indexer's own tick or core's own timer; nothing here
-- depends on a user request, nothing names a user, a request or an anon key.

-- Price pass (INTEL v4): curve progress and the token's curve state on every tick.
-- `curve`: {"virtualSol","virtualTokens","feeBps","buyFee","buyLimitLamports"?,"sellLimitTokens"?}
-- (API.md TokenCurve without asOf: that is tick_at). The indexer role already has INSERT/UPDATE
-- on the whole table (infra/indexer-role.sql), no grant change.
ALTER TABLE intel_prices
    ADD COLUMN progress_pct NUMERIC(5,2) CHECK (progress_pct BETWEEN 0 AND 100),
    ADD COLUMN curve JSONB CHECK (curve IS NULL OR jsonb_typeof(curve) = 'object');

-- Discovery of Raydium LaunchLab creates (mainnet stream).
ALTER TABLE intel_discovery DROP CONSTRAINT IF EXISTS intel_discovery_venue_check;
ALTER TABLE intel_discovery ADD CONSTRAINT intel_discovery_venue_check
    CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab'));

-- Curve progress per indexer tick (core samples intel_prices / intel_discovery on its timer),
-- for ETA by pace. Kept 30 minutes. Owner role only.
CREATE TABLE curve_progress (
    mint     TEXT NOT NULL,
    tick_at  BIGINT NOT NULL CHECK (tick_at > 0),          -- unix ms of the indexer tick
    progress NUMERIC(5,2) NOT NULL CHECK (progress BETWEEN 0 AND 100),
    PRIMARY KEY (mint, tick_at)
);

-- First tick on which core saw a mint graduated (Pulse "Graduated"). Kept 7 days. Owner only.
CREATE TABLE curve_graduations (
    mint         TEXT PRIMARY KEY,
    graduated_at TIMESTAMPTZ NOT NULL CHECK (graduated_at = date_trunc('minute', graduated_at))
);

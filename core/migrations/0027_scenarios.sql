-- Unzeen 0027: scenarios (API.md v0.19, spec docs/analysis/scenarios.md, owner decisions 13.10).
--
-- A scenario is an intention held by the operator while it is active (≤ 72 h, 7 days without
-- withdrawals). Core only: the relayer and the indexer have NO access to these tables. Every step
-- becomes an ordinary action (`actions` + `relayer_jobs`) through the same path as a manual one.
--
-- Privacy (D1): `created_at` minute-coarse, `closed_at` / `expires_at` hour-coarse; 24 h after
-- closing `plan`, `state`, `error` and the step ↔ action/order links are erased, after 48 h the
-- rows are deleted. Sealed fields (withdrawal addresses, launch meta, bid ciphertexts, chat text)
-- live encrypted with K_scn (outside the DB) in `scenario_sealed` until their step is queued or
-- the plan closes. Amounts inside `plan` / `state` are decimal strings (u128).

CREATE TABLE scenarios (
    id          BYTEA PRIMARY KEY CHECK (length(id) = 16),     -- = id of the scenario_create receipt
    anon_pubkey BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    network     TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta', 'hood', 'hood-testnet')),
    plan        JSONB,                                         -- echo form (sealed fields masked); NULL after the scrub
    status      TEXT NOT NULL CHECK (status IN ('waiting_start', 'active', 'done', 'failed', 'cancelled', 'expired')),
    cursor      SMALLINT NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    -- ready: the step at `cursor` runs at next_at; waiting: a wait/trigger of that step until next_at;
    -- in_flight: its action is queued (settlement decides).
    phase       TEXT NOT NULL DEFAULT 'ready' CHECK (phase IN ('ready', 'waiting', 'in_flight')),
    runs        SMALLINT NOT NULL DEFAULT 0 CHECK (runs BETWEEN 0 AND 40),
    attempt     SMALLINT NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
    state       JSONB NOT NULL DEFAULT '{}',                   -- step outputs, repeat counters, step statuses
    next_at     TIMESTAMPTZ,
    armed_at    TIMESTAMPTZ,
    last_tick   BIGINT,
    armed_tick  BIGINT,
    expires_at  TIMESTAMPTZ NOT NULL CHECK (expires_at = date_trunc('hour', expires_at)),
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', now()),
    closed_at   TIMESTAMPTZ
);
CREATE INDEX scenarios_due_idx ON scenarios (next_at) WHERE status = 'active';
CREATE INDEX scenarios_owner_idx ON scenarios (anon_pubkey, created_at DESC);

CREATE TABLE scenario_runs (
    scenario_id BYTEA NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
    seq         SMALLINT NOT NULL CHECK (seq BETWEEN 0 AND 255),
    step        SMALLINT NOT NULL,
    attempt     SMALLINT NOT NULL DEFAULT 0,
    status      TEXT NOT NULL CHECK (status IN ('queued', 'done', 'failed')),
    action_id   BYTEA,                                         -- NULL after the 24 h scrub
    order_id    BYTEA,
    error       TEXT,
    PRIMARY KEY (scenario_id, seq)
);

CREATE TABLE scenario_sealed (
    scenario_id BYTEA NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
    step        SMALLINT NOT NULL,
    blob        BYTEA NOT NULL,                                -- nonce(12) ‖ ChaCha20-Poly1305(K_scn, AAD = id ‖ step)
    PRIMARY KEY (scenario_id, step)
);

CREATE FUNCTION unzeen_scenario_coarse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.created_at := date_trunc('minute', NEW.created_at);
    NEW.closed_at := date_trunc('hour', NEW.closed_at);
    RETURN NEW;
END $$;
CREATE TRIGGER scenarios_coarse BEFORE INSERT OR UPDATE ON scenarios
    FOR EACH ROW EXECUTE FUNCTION unzeen_scenario_coarse();

-- Unzeen 0008: fair-launch (API.md v0.6, RELAYER.md v3, spec docs/analysis/fair-launch.md).
-- Internal until 28.10 23:59 UTC.
--
-- Privacy: fl_bids holds anon keys and (after reveal) amounts; ciphertexts are deleted at reveal
-- and never published; rows of finished launches are deleted after 48 h (janitor). The relayer
-- role has NO access to fl_* tables. Times next to anon keys are hour-coarse.

-- ---------------------------------------------------------------- relayer jobs: new ops
-- fair_create: one atomic create+buy of a fair launch with a mint keypair fixed by core
--              (mint_secret, same on every attempt: a retry can never create a second mint).
-- attest:      SPL Memo tx with meta.memo (commitment root hex) signed by the pool's
--              attestation key; the relayer writes the memo read back from the confirmed tx.
ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_op_check;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_op_check
    CHECK (op IN ('buy', 'sell', 'create', 'transfer', 'fair_create', 'attest'));
ALTER TABLE relayer_jobs
    -- fair_create: Solana keypair of the new mint, 64 bytes (secret seed 32 || public key 32).
    -- Erased by core when the job is settled.
    ADD COLUMN mint_secret BYTEA CHECK (mint_secret IS NULL OR length(mint_secret) = 64),
    -- attest: memo data (UTF-8) as read from the confirmed tx.
    ADD COLUMN out_memo TEXT;

-- ---------------------------------------------------------------- launch curve of the network
-- Written by the relayer from the venue's on-chain config (pump.fun Global via the SDK); core
-- derives caps from it (devnet 1 SOL vs mainnet 30 SOL virtual reserves: never hardcode).
CREATE TABLE launch_curves (
    network                TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    venue                  TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc')),
    virtual_sol_lamports   BIGINT NOT NULL CHECK (virtual_sol_lamports > 0),
    virtual_token_reserves BIGINT NOT NULL CHECK (virtual_token_reserves > 0),
    real_token_reserves    BIGINT NOT NULL CHECK (real_token_reserves > 0),
    token_total_supply     BIGINT NOT NULL CHECK (token_total_supply > 0),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (network, venue)
);

-- ---------------------------------------------------------------- launches (core only)
CREATE TABLE fl_launches (
    id               BYTEA PRIMARY KEY CHECK (length(id) = 16),
    network          TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    -- Creator rights (cap/lock). Erased 48 h after the launch is final.
    creator_pubkey   BYTEA CHECK (creator_pubkey IS NULL OR length(creator_pubkey) = 32),
    create_action_id BYTEA UNIQUE REFERENCES actions (id) ON DELETE SET NULL,
    venue            TEXT NOT NULL CHECK (venue IN ('pumpfun')),
    meta             JSONB NOT NULL,       -- {"name","symbol","image"?}; image dropped once the job is settled
    window_secs      INTEGER NOT NULL CHECK (window_secs > 0),
    published_at     TIMESTAMPTZ NOT NULL, -- epoch boundary, not the request time
    close_at         TIMESTAMPTZ NOT NULL,
    round            BIGINT NOT NULL CHECK (round > 0),
    round_time       TIMESTAMPTZ NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                         'open', 'closed', 'revealing', 'executing', 'launched', 'failed', 'cancelled')),
    failure          TEXT CHECK (failure IN ('no_bids', 'drand_unavailable', 'venue_unavailable', 'tx_failed')),
    commitment_root  BYTEA CHECK (commitment_root IS NULL OR length(commitment_root) = 32),
    attest_job_id    BIGINT REFERENCES relayer_jobs (id),
    attestation      JSONB,                -- {"solanaTx","slot","signer","matches"}
    beacon_sig       BYTEA CHECK (beacon_sig IS NULL OR length(beacon_sig) = 48),
    next_try_at      TIMESTAMPTZ,          -- reveal retry schedule
    rate_lamports_per_zec BIGINT CHECK (rate_lamports_per_zec > 0),
    total_e          BIGINT,               -- E: Σ effective lamports
    lamports_in      BIGINT,               -- D10(E), sent to the relayer
    oversubscribed   BOOLEAN,
    valid_bids       INTEGER,
    job_id           BIGINT REFERENCES relayer_jobs (id),
    result           JSONB,                -- FairLaunch.result
    finished_at      TIMESTAMPTZ,          -- hour-coarse; janitor clock
    created_at       TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', now()),
    CHECK (close_at < round_time)
);
CREATE INDEX fl_launches_status_idx ON fl_launches (status, close_at);
CREATE INDEX fl_launches_creator_idx ON fl_launches (creator_pubkey) WHERE creator_pubkey IS NOT NULL;

-- ---------------------------------------------------------------- sealed bids (core only)
CREATE TABLE fl_bids (
    id           BIGSERIAL PRIMARY KEY,
    launch_id    BYTEA NOT NULL REFERENCES fl_launches (id) ON DELETE CASCADE,
    anon_pubkey  BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    action_id    BYTEA REFERENCES actions (id) ON DELETE SET NULL,
    hold_zat     BIGINT NOT NULL CHECK (hold_zat > 0),
    ciphertext   TEXT,                    -- NULL after reveal / cancel; never published
    leaf         BYTEA CHECK (leaf IS NULL OR length(leaf) = 32),
    proof        JSONB,                   -- ["hex", ...] from the commitment tree
    status       TEXT NOT NULL DEFAULT 'sealed' CHECK (status IN (
                     'sealed', 'cancelled', 'invalid', 'revealed', 'settled', 'released')),
    amount_zat   BIGINT CHECK (amount_zat >= 0),
    e_lamports   BIGINT CHECK (e_lamports >= 0),
    tokens       BIGINT CHECK (tokens >= 0),
    charge_zat   BIGINT CHECK (charge_zat >= 0),
    released_zat BIGINT CHECK (released_zat >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', now())
);
CREATE UNIQUE INDEX fl_bids_one_sealed_idx ON fl_bids (launch_id, anon_pubkey) WHERE status = 'sealed';
CREATE INDEX fl_bids_owner_idx ON fl_bids (anon_pubkey, id DESC);
CREATE INDEX fl_bids_launch_idx ON fl_bids (launch_id);

CREATE FUNCTION unzeen_hour_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.created_at := date_trunc('hour', NEW.created_at);
    RETURN NEW;
END $$;
CREATE TRIGGER fl_bids_coarse BEFORE INSERT OR UPDATE ON fl_bids
    FOR EACH ROW EXECUTE FUNCTION unzeen_hour_created();
CREATE TRIGGER fl_launches_coarse BEFORE INSERT OR UPDATE ON fl_launches
    FOR EACH ROW EXECUTE FUNCTION unzeen_hour_created();

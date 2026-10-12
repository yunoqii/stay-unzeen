-- Unzeen private ledger. All amounts are zatoshis (1 ZEC = 1e8). Keys are raw bytes.
--
-- Privacy: no txids are stored. A shielded note is identified by
-- note_ref = HMAC-SHA256(k, txid || pool || action_index), k derived from the pool's
-- viewing key, so a leak of this database alone does not map balances to on-chain txs.

-- Per anon key. available = spendable now; held = reserved by queued actions.
CREATE TABLE balances (
    anon_pubkey   BYTEA PRIMARY KEY CHECK (length(anon_pubkey) = 32),
    available_zat BIGINT NOT NULL DEFAULT 0 CHECK (available_zat >= 0),
    held_zat      BIGINT NOT NULL DEFAULT 0 CHECK (held_zat >= 0),
    -- Set when a credited deposit disappears in a reorg: no new holds until reviewed.
    frozen        BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per incoming shielded note (idempotency key = note_ref = (txid, pool, action)).
CREATE TABLE deposits (
    id            BIGSERIAL PRIMARY KEY,
    note_ref      BYTEA NOT NULL UNIQUE CHECK (length(note_ref) = 32),
    amount_zat    BIGINT NOT NULL CHECK (amount_zat >= 0),
    mined_height  INTEGER,
    status        TEXT NOT NULL CHECK (status IN (
                      'seen',            -- mined, < K confirmations
                      'confirmed',       -- >= K confirmations, memo not fetched yet
                      'credited',        -- added to anon_pubkey's balance
                      'refund_pending',  -- expired, signed, has a refund target; payout not implemented yet
                      'frozen',          -- bad signature / unreadable memo / non-deposit op: manual review
                      'dust')),          -- below MIN_DEPOSIT_ZAT: kept by the pool, not credited
    reason        TEXT,
    anon_pubkey   BYTEA CHECK (anon_pubkey IS NULL OR length(anon_pubkey) = 32),
    op            SMALLINT,          -- always 5 (deposit) in memo v1
    credited_zat  BIGINT NOT NULL DEFAULT 0 CHECK (credited_zat >= 0),
    -- A final deposit whose note became unmined after a reorg (alert, balance frozen).
    reorged       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deposits_status_idx ON deposits (status);

-- Signed API actions (POST /api/actions). (anon_pubkey, nonce) is the HTTP nonce, so
-- inserting the action and consuming the nonce is one statement in one transaction.
CREATE TABLE actions (
    id           BYTEA PRIMARY KEY CHECK (length(id) = 16),   -- 128-bit random
    anon_pubkey  BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    nonce        BYTEA NOT NULL CHECK (length(nonce) = 16),
    request_hash BYTEA NOT NULL CHECK (length(request_hash) = 32),
    kind         TEXT NOT NULL,
    hold_zat     BIGINT NOT NULL DEFAULT 0 CHECK (hold_zat >= 0),
    status       TEXT NOT NULL CHECK (status IN ('queued', 'executed', 'failed')),
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (anon_pubkey, nonce)
);

-- Nonces of signed requests that are not actions (signed GETs). Kept until expires_at.
CREATE TABLE api_nonces (
    anon_pubkey BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    nonce       BYTEA NOT NULL CHECK (length(nonce) = 16),
    expires_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (anon_pubkey, nonce)
);
CREATE INDEX api_nonces_expiry_idx ON api_nonces (expires_at);

-- Append-only journal of every balance change.
CREATE TABLE ledger_ops (
    id              BIGSERIAL PRIMARY KEY,
    anon_pubkey     BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    kind            TEXT NOT NULL CHECK (kind IN ('deposit_credit', 'hold', 'settle', 'release')),
    delta_available BIGINT NOT NULL,
    delta_held      BIGINT NOT NULL,
    deposit_id      BIGINT REFERENCES deposits (id),
    action_id       BYTEA REFERENCES actions (id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_ops_pk_idx ON ledger_ops (anon_pubkey, id);

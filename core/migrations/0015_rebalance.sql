-- Unzeen 0015: automatic pool rebalance ZEC -> SOL through NEAR Intents 1Click (RELAYER.md v7).
--
-- Pool-level only: nothing here references anon keys, actions, deposits or payouts. The lot is a
-- fixed env value, the schedule is driven by the pool's SOL inventory with a random delay, so no
-- row can be tied to a user's deposit or trade.
--
-- Flow (core/scanner `serve --rebalance`): planned -> quoted -> sending -> deposited ->
-- distributing -> done. Terminal: done | dry_run | cancelled | expired | failed | refunded.
-- `attention` = needs the operator (1Click FAILED / INCOMPLETE_DEPOSIT, distribution keeps
-- failing); it blocks new rebalances until `unzeen-scanner rebalance close`.

-- ---------------------------------------------------------------- SOL inventory (relayer)
-- Written by the relayer every ~5 min (RELAYER v7): Σ lamports of all vaults, how many vaults,
-- lamports on the rebalance address (not yet distributed), at one `confirmed` slot.
CREATE TABLE pool_sol_inventory (
    network             TEXT PRIMARY KEY CHECK (network IN ('devnet', 'mainnet-beta')),
    vault_lamports      BIGINT NOT NULL CHECK (vault_lamports >= 0),
    vault_count         INTEGER NOT NULL CHECK (vault_count >= 0),
    rebalance_lamports  BIGINT NOT NULL DEFAULT 0 CHECK (rebalance_lamports >= 0),
    slot                BIGINT NOT NULL CHECK (slot >= 0),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- rebalance journal (core)
CREATE TABLE pool_rebalances (
    id               BIGSERIAL PRIMARY KEY,
    network          TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    status           TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
                         'planned', 'quoted', 'sending', 'deposited', 'distributing', 'attention',
                         'done', 'dry_run', 'cancelled', 'expired', 'failed', 'refunded')),
    dry_run          BOOLEAN NOT NULL,
    forced           BOOLEAN NOT NULL DEFAULT false,  -- operator `rebalance plan --force`
    lot_zat          BIGINT NOT NULL CHECK (lot_zat > 0),
    not_before       TIMESTAMPTZ NOT NULL,           -- random delay after the trigger
    -- Quote (1Click). The deposit address is used for exactly one tx (UNIQUE, never reused).
    deposit_address  TEXT UNIQUE,
    quote            JSONB,                          -- full 1Click response incl. its signature
    quoted_at        TIMESTAMPTZ,
    quote_deadline   TIMESTAMPTZ,
    amount_out_quote BIGINT CHECK (amount_out_quote >= 0),   -- lamports
    min_amount_out   BIGINT CHECK (min_amount_out >= 0),     -- lamports
    -- Zcash tx (Ironwood -> transparent deposit address). txid written BEFORE broadcast.
    txid             BYTEA UNIQUE CHECK (txid IS NULL OR length(txid) = 32),
    expiry_height    INTEGER,
    mined_height     INTEGER,
    submitted_at     TIMESTAMPTZ,                    -- /v0/deposit/submit done (best effort)
    -- 1Click execution.
    oc_status        TEXT,
    polled_at        TIMESTAMPTZ,
    amount_out       BIGINT CHECK (amount_out >= 0), -- lamports actually delivered (SUCCESS)
    dest_tx          TEXT,                           -- Solana tx of the delivery (public)
    -- Distribution rebalance address -> vaults (relayer_jobs op 'fund_vaults').
    fund_job_id      BIGINT REFERENCES relayer_jobs (id) ON DELETE SET NULL,
    fund_attempts    INTEGER NOT NULL DEFAULT 0,
    error_code       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ,
    CHECK (status <> 'sending' OR (txid IS NOT NULL AND deposit_address IS NOT NULL)),
    CHECK (status NOT IN ('quoted', 'sending', 'deposited') OR deposit_address IS NOT NULL)
);
-- At most one live rebalance per network (single flight).
CREATE UNIQUE INDEX pool_rebalances_one_live ON pool_rebalances (network)
    WHERE status IN ('planned', 'quoted', 'sending', 'deposited', 'distributing', 'attention');
CREATE INDEX pool_rebalances_recent ON pool_rebalances (network, created_at);

-- ---------------------------------------------------------------- relayer op 'fund_vaults'
-- fund_vaults: one tx from the pool's rebalance address spreading `lamports_in` over the vaults
-- (RELAYER v7). action_id NULL; core settles it (scanner rebalance step).
ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_op_check;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_op_check
    CHECK (op IN ('buy', 'sell', 'create', 'transfer', 'fair_create', 'attest', 'fund_vaults'));

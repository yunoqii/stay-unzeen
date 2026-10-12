-- Unzeen 0010: creator-fee sweeps (relayer) and creator claimable (core). API.md v0.7, RELAYER.md v4.
--
-- creator_fee_sweeps: schema taken AS IS from adapters/src/relayer/fee-sweeper.ts
-- (PROPOSED_FEE_SWEEPS_SQL). Its grants (PROPOSED_FEE_SWEEPS_GRANTS) live in
-- infra/relayer-role.sql like every other relayer grant (the role may not exist where
-- migrations run, e.g. CI).
CREATE TABLE creator_fee_sweeps (
    id                      BIGSERIAL PRIMARY KEY,
    network                 TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    venue                   TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc')),
    kind                    TEXT NOT NULL CHECK (kind IN ('creator', 'partner')),
    mint                    TEXT NOT NULL,
    authority               TEXT NOT NULL,
    signature               TEXT NOT NULL UNIQUE,      -- written BEFORE broadcast
    last_valid_block_height BIGINT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'confirmed', 'failed')),
    lamports                BIGINT CHECK (lamports >= 0),  -- set on 'confirmed': SOL that reached the pool vault
    slot                    BIGINT,
    swept_at                TIMESTAMPTZ,               -- block time of the landed tx
    credited_at             TIMESTAMPTZ,               -- core: credited to the creator's balance
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'confirmed' OR (lamports IS NOT NULL AND slot IS NOT NULL))
);
CREATE INDEX creator_fee_sweeps_pending_idx ON creator_fee_sweeps (network) WHERE status = 'sent';
CREATE INDEX creator_fee_sweeps_credit_idx ON creator_fee_sweeps (network, mint)
    WHERE status = 'confirmed' AND kind = 'creator' AND credited_at IS NULL;

-- Creator fees credited to the creator's anon key, in lamports, until `claim` converts them to
-- ZEC (ledger-only). Core only; never visible to the relayer.
CREATE TABLE creator_claimable (
    anon_pubkey BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    mint        TEXT NOT NULL,
    lamports    BIGINT NOT NULL DEFAULT 0 CHECK (lamports >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (anon_pubkey, mint)
);
CREATE TRIGGER creator_claimable_coarse BEFORE INSERT OR UPDATE ON creator_claimable
    FOR EACH ROW EXECUTE FUNCTION unzeen_day_updated();

ALTER TABLE ledger_ops DROP CONSTRAINT ledger_ops_kind_check;
ALTER TABLE ledger_ops ADD CONSTRAINT ledger_ops_kind_check
    CHECK (kind IN ('deposit_credit', 'hold', 'settle', 'release', 'refund', 'sell_credit', 'fee_credit'));

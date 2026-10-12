-- Unzeen 0003: ZEC payout executor, mint -> vault pinning, relayer backoff, deposit source flag.
-- Contract changes are listed in docs/RELAYER.md ("Changelog v2") and docs/API.md (v0.4).

-- ---------------------------------------------------------------- ZEC payouts (core only)
-- The executor (scanner `serve --payouts`) batches ready payouts into one shielded tx.
-- txid is written BEFORE broadcast and cleared (with to_ua) once the payout is confirmed.
ALTER TABLE zec_payouts
    ADD COLUMN txid     BYTEA CHECK (txid IS NULL OR length(txid) = 32),
    ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zec_payouts DROP CONSTRAINT zec_payouts_status_check;
ALTER TABLE zec_payouts ADD CONSTRAINT zec_payouts_status_check
    CHECK (status IN ('queued', 'sent', 'confirmed', 'failed'));
ALTER TABLE zec_payouts ADD CONSTRAINT zec_payouts_sent_has_txid
    CHECK (status <> 'sent' OR txid IS NOT NULL);
CREATE INDEX zec_payouts_inflight_idx ON zec_payouts (txid) WHERE status = 'sent';

-- ---------------------------------------------------------------- deposits: non-private source (D3)
-- TRUE if the deposit tx had transparent inputs or moved value out of Sapling / legacy
-- Orchard (turnstile): its amount is public on chain. No addresses are stored.
ALTER TABLE deposits ADD COLUMN public_source BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------- mint -> vault pinning (D4)
-- The pool holds each mint's position on ONE vault (shared pool inventory): every buy, sell
-- and token withdrawal of that mint goes through it. Public data only (vaults are public via
-- Verify); no anon keys, no action ids. Written by the relayer on the first buy/create.
CREATE TABLE mint_vaults (
    network    TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    mint       TEXT NOT NULL,
    vault      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('day', now(), 'UTC'),
    PRIMARY KEY (network, mint)
);
CREATE INDEX mint_vaults_vault_idx ON mint_vaults (network, vault);

-- ---------------------------------------------------------------- relayer backoff (not_before)
-- The relayer may push a job back (venue down, RPC 429) by raising not_before, never lower it:
-- execution earlier than core's epoch would break timing privacy (H8/D2). Core may lower it
-- only when coarsening times of settled jobs (settled_at IS NOT NULL).
CREATE FUNCTION unzeen_not_before_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.not_before < OLD.not_before AND NEW.settled_at IS NULL THEN
        RAISE EXCEPTION 'not_before may only increase' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER relayer_jobs_not_before_monotonic BEFORE UPDATE OF not_before ON relayer_jobs
    FOR EACH ROW EXECUTE FUNCTION unzeen_not_before_monotonic();

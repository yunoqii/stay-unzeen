-- Unzeen 0012: fair-launch review fixes (docs/analysis/review-fair-launch.md).
-- F2: block time of attest txs (unix seconds, from the landed tx) to prove the root was
--     anchored before the drand round.
ALTER TABLE relayer_jobs ADD COLUMN out_block_time BIGINT;
-- F13: the bid set no longer matches the published root (code bug / manual DB change):
--      the launch fails with everything released, the operator is alerted.
ALTER TABLE fl_launches DROP CONSTRAINT fl_launches_failure_check;
ALTER TABLE fl_launches ADD CONSTRAINT fl_launches_failure_check
    CHECK (failure IN ('no_bids', 'drand_unavailable', 'venue_unavailable', 'tx_failed', 'internal'));
-- Verify: re-anchor built snapshots whose attest job failed (e.g. no SOL on the key).
ALTER TABLE verify_snapshots
    ADD COLUMN anchor_attempts INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN anchor_retry_at TIMESTAMPTZ;

-- Unzeen 0017: fair-launch v2 (Jito bundle across vaults, mainnet) — RELAYER.md v7.
-- (0016 is reserved for the chat spec.)
--
-- bundle_legs: [{"sig","vault"}] of the NON-create legs (1..4 entries) of a fair_create bundle.
--   Written by the relayer BEFORE the bundle is sent (with status 'sent'), and again at
--   'confirmed' with exactly the legs that landed (also when they were rediscovered on chain).
--   Core erases it at settle (with mint_secret).
-- consolidate: internal job created by core when a fair_create with landed legs is settled:
--   move ALL tokens of `mint` from the leg vault meta.from to `dest` (the mint's vault A, D4).
--   action_id NULL, no feed rows; core settles it and re-queues a failed one.
ALTER TABLE relayer_jobs ADD COLUMN bundle_legs JSONB
    CHECK (bundle_legs IS NULL OR (jsonb_typeof(bundle_legs) = 'array'
                                   AND jsonb_array_length(bundle_legs) BETWEEN 1 AND 4));

ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_op_check;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_op_check
    CHECK (op IN ('buy', 'sell', 'create', 'transfer', 'fair_create', 'attest', 'fund_vaults', 'consolidate'));

CREATE INDEX relayer_jobs_unsettled_internal_idx ON relayer_jobs (id)
    WHERE op IN ('consolidate', 'fund_vaults') AND settled_at IS NULL;

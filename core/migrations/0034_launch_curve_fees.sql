-- Unzeen 0034: `launch_curves.fee_tiers` — the venue's trade fee as the relayer reads it from
-- chain with the reserves (pump.fun: FeeConfig market-cap tiers of protocol + creator fee bps,
-- else Global feeBasisPoints + creatorFeeBasisPoints). JSON array, thresholds ascending:
-- [{"marketCapLamports": "0", "bps": 125}, …]. NULL: core uses its configured fallback.
ALTER TABLE launch_curves ADD COLUMN fee_tiers JSONB
    CHECK (fee_tiers IS NULL OR (jsonb_typeof(fee_tiers) = 'array' AND jsonb_array_length(fee_tiers) BETWEEN 1 AND 32));

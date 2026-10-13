-- Unzeen 0014: Verify demo-robustness and creator fees in the ZEC tree (review-day8, API.md v0.10).

-- E2: the relayer reads vault balances at finalized with minContextSlot = min_slot (the highest
-- slot of a trade already counted by the ledger), retrying until finalized catches up.
ALTER TABLE verify_snapshots ADD COLUMN min_slot BIGINT CHECK (min_slot >= 0);

-- E5: creator fees (claimable lamports) are part of the creator's ZEC leaf, converted at this
-- buy-side rate (lamports per ZEC; rounding up). Published with the snapshot.
ALTER TABLE verify_snapshots ADD COLUMN rate_lamports_per_zec_buy BIGINT CHECK (rate_lamports_per_zec_buy > 0);

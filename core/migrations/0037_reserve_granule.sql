-- Unzeen 0037: the attested ZEC reserve is floored to 0.001 ZEC (protocol RESERVE_GRANULE_ZAT,
-- the ZEC liabilities tree granule) instead of 0.01 ZEC. Older snapshots (multiples of 0.01)
-- still satisfy the new check.
ALTER TABLE verify_snapshots DROP CONSTRAINT IF EXISTS verify_snapshots_zec_reserve_zat_check;
ALTER TABLE verify_snapshots ADD CONSTRAINT verify_snapshots_zec_reserve_zat_check
    CHECK (zec_reserve_zat IS NULL OR zec_reserve_zat % 100000 = 0);

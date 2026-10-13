-- Unzeen 0020: creator fees of non-SOL pairs (API.md v0.14, RELAYER.md v9).
-- ZEC-pair fees arrive in ZEC SPL (8 decimals = zat) and are owed 1:1 in zat; USDC/USD1 fees are
-- booked in lamports (pool-A equivalent written by the sweeper), like SOL pairs.

-- Claimable creator fees in zat (ZEC pairs), next to the lamport ones.
ALTER TABLE creator_claimable
    ADD COLUMN zat         BIGINT NOT NULL DEFAULT 0 CHECK (zat >= 0),
    ADD COLUMN claimed_zat BIGINT NOT NULL DEFAULT 0 CHECK (claimed_zat >= 0);

-- Launch-tx creator fee of a ZEC-pair launch, in ZEC SPL units (= zat); withheld from the first
-- ZEC sweeps of the mint. The lamport columns stay for SOL/USDC/USD1 launches.
ALTER TABLE creator_tokens
    ADD COLUMN launch_fee_zat      BIGINT NOT NULL DEFAULT 0 CHECK (launch_fee_zat >= 0),
    ADD COLUMN launch_fee_zat_left BIGINT NOT NULL DEFAULT 0 CHECK (launch_fee_zat_left >= 0),
    ADD CONSTRAINT creator_tokens_launch_fee_zat_left CHECK (launch_fee_zat_left <= launch_fee_zat);

-- ZEC launches settled under 0019 stored ZEC SPL units in the lamport columns: move them.
UPDATE creator_tokens ct
   SET launch_fee_zat = ct.launch_fee_lamports, launch_fee_zat_left = ct.launch_fee_left,
       launch_fee_lamports = 0, launch_fee_left = 0
  FROM tokens t
 WHERE t.mint = ct.mint AND t.quote_mint = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS'
   AND ct.launch_fee_lamports > 0;

-- Pool's part of a quote sweep (quote base units), as pool_lamports is for SOL sweeps.
ALTER TABLE creator_fee_sweeps
    ADD COLUMN pool_quote_amount NUMERIC(78,0) CHECK (pool_quote_amount >= 0);

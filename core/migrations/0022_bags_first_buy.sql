-- Unzeen 0022: Bags launches (API.md v0.16, RELAYER.md v10).
--
-- A Bags create tx is built and pre-signed by Bags' API and carries NO first buy (its buy would
-- be the launch wallet's). The user's first buy is a second job of the same `create` action:
-- op `buy`, part 1, inserted with status `held` (the relayer never claims it: it only takes
-- `queued`). Core releases it (`mint` = the create's `out_mint`, status `queued`) once the create
-- job is confirmed, or fails it with the create's error code. The relayer buys through the vault
-- pinned to the mint at create (mint_vaults), like any buy. Not atomic: someone can buy first.
--
-- `bags` is already in every venue CHECK since 0019.

ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_status_check;
ALTER TABLE relayer_jobs ADD CONSTRAINT relayer_jobs_status_check
    CHECK (status IN ('held', 'queued', 'claimed', 'sent', 'confirmed', 'failed'));

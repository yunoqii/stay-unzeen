-- Unzeen 0023 (final audit A2): payouts above the mainnet cap (UNZEEN_MAX_PAYOUT_ZAT) never
-- block the queue: they are filtered out in SQL until an operator approves them with
-- `unzeen-scanner payout approve <id>` (`payout list-held` shows them, without recipients).
ALTER TABLE zec_payouts ADD COLUMN approved BOOLEAN NOT NULL DEFAULT FALSE;

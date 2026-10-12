-- Unzeen 0005: execution mode of a job (API.md v0.4 "exec"). Read by the relayer.
--   now     : not_before = submission time; relayer sends at once with a priority fee
--             (Helius getPriorityFeeEstimate) and, on mainnet, a Jito tip.
--   delayed : epoch of 30-60 s (core sets not_before), random order inside the epoch.
--   max     : epoch of 5-15 min.
ALTER TABLE relayer_jobs
    ADD COLUMN exec_mode TEXT NOT NULL DEFAULT 'delayed' CHECK (exec_mode IN ('now', 'delayed', 'max'));

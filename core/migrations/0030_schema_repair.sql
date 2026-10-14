-- Unzeen 0030: repair databases where 0012 ran before its last edit (verify re-anchor columns
-- were added to the file afterwards, so such databases never got them; verify pass failed with
-- SQLSTATE 42703). No-op on databases that already have them.
ALTER TABLE verify_snapshots
    ADD COLUMN IF NOT EXISTS anchor_attempts INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS anchor_retry_at TIMESTAMPTZ;

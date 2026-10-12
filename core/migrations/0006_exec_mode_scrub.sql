-- Unzeen 0006: R-core-4. exec_mode is erased (NULL) when a job is settled, like other
-- per-action details; only unsettled jobs carry it.
ALTER TABLE relayer_jobs ALTER COLUMN exec_mode DROP NOT NULL;

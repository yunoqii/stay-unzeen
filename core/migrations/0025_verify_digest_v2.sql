-- Unzeen 0025 (API v0.17): the Verify digest also commits to the snapshot's quoteAssets
-- (rootsDigest v2, core/protocol::verify::roots_digest_v2). Snapshots built before keep v1.
ALTER TABLE verify_snapshots ADD COLUMN digest_version SMALLINT NOT NULL DEFAULT 1
    CHECK (digest_version IN (1, 2));

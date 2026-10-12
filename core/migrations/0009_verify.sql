-- Unzeen 0009: Verify (API.md v0.7, RELAYER.md v4, spec docs/analysis/verify.md).
--
-- Kept forever (public history): verify_snapshots, verify_trees, verify_vaults.
-- Kept 48 h (janitor): verify_nodes (tree paths), verify_leaves (piece <-> anon key binding).
-- The relayer sees only what it needs to freeze and to write vault balances/signatures.

-- attest jobs (fair-launch roots and Verify roots): detached ed25519 signature by the
-- attestation key over the 32 bytes hex-decoded from meta.memo, base58. Written by the relayer.
ALTER TABLE relayer_jobs ADD COLUMN out_sig TEXT;

CREATE TABLE verify_snapshots (
    id             SERIAL PRIMARY KEY,
    network        TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    chain_id       TEXT NOT NULL CHECK (chain_id IN ('0202', '0101')),
    kind           TEXT NOT NULL CHECK (kind IN ('daily', 'manual')),
    -- freezing: relayer takes no new jobs, core waits for in-flight work to settle
    -- collecting: relayer writes vault balances (one finalized slot) and vault signatures
    -- built: trees, digest, anchor job queued; skipped: not consistent in time (retried later)
    status         TEXT NOT NULL DEFAULT 'freezing'
                   CHECK (status IN ('freezing', 'collecting', 'built', 'skipped')),
    freeze_until   TIMESTAMPTZ NOT NULL,
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    skip_reason    TEXT,
    taken_at       TIMESTAMPTZ CHECK (taken_at IS NULL OR taken_at = date_trunc('minute', taken_at)),
    -- relayer:
    solana_slot    BIGINT,
    assets_done_at TIMESTAMPTZ,
    -- core, at build:
    zcash_height   INTEGER,
    zec_reserve_zat BIGINT CHECK (zec_reserve_zat IS NULL OR zec_reserve_zat % 1000000 = 0),
    leaves         INTEGER,
    roots_digest   BYTEA CHECK (roots_digest IS NULL OR length(roots_digest) = 32),
    committed_lamports BIGINT,
    rate_lamports_per_zec_sell BIGINT,
    attest_job_id  BIGINT REFERENCES relayer_jobs (id),
    anchor         JSONB,   -- {"solanaTx","slot","matches"}
    operator       JSONB    -- {"pubkey","sig"}: attestation key, ed25519 over roots_digest
);
CREATE INDEX verify_snapshots_status_idx ON verify_snapshots (network, status, id DESC);

CREATE TABLE verify_vaults (
    snapshot_id INTEGER NOT NULL REFERENCES verify_snapshots (id),
    address     TEXT NOT NULL,
    lamports    BIGINT NOT NULL CHECK (lamports >= 0),
    tokens      JSONB NOT NULL DEFAULT '[]',   -- [{"mint","amount"}], base units as strings
    sig         TEXT NOT NULL,                 -- base58 ed25519 of the vault message
    PRIMARY KEY (snapshot_id, address)
);

CREATE TABLE verify_trees (
    snapshot_id INTEGER NOT NULL REFERENCES verify_snapshots (id),
    asset       TEXT NOT NULL,                 -- 'ZEC' or base58 mint
    decimals    SMALLINT NOT NULL,
    granule     BIGINT NOT NULL CHECK (granule > 0),
    root        BYTEA NOT NULL CHECK (length(root) = 32),
    sum         TEXT NOT NULL,                 -- u128 decimal
    PRIMARY KEY (snapshot_id, asset)
);

CREATE TABLE verify_nodes (
    snapshot_id INTEGER NOT NULL REFERENCES verify_snapshots (id),
    asset       TEXT NOT NULL,
    level       SMALLINT NOT NULL,
    idx         INTEGER NOT NULL,
    hash        BYTEA NOT NULL,
    sum         TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, asset, level, idx)
);

CREATE TABLE verify_leaves (
    snapshot_id INTEGER NOT NULL REFERENCES verify_snapshots (id),
    asset       TEXT NOT NULL,
    anon_pubkey BYTEA NOT NULL CHECK (length(anon_pubkey) = 32),
    piece       SMALLINT NOT NULL,
    leaf_idx    INTEGER NOT NULL,
    value       BIGINT NOT NULL CHECK (value >= 0),
    blind       BYTEA NOT NULL CHECK (length(blind) = 32),
    PRIMARY KEY (snapshot_id, asset, leaf_idx)
);
CREATE INDEX verify_leaves_owner_idx ON verify_leaves (snapshot_id, anon_pubkey);

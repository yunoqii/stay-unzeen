-- Unzeen 0004: relayer state in Postgres (vault rotation, fresh-creator counter), so several
-- relayer processes cannot hand the same creator to two launches (review-day3 L-10).
-- Public/operational data only: no anon keys, no action ids.

CREATE TABLE relayer_vault_usage (
    network      TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    vault        TEXT NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (network, vault)
);

-- Next derivation index of the fresh creator address per network. Seeded by the operator
-- from the relayer's old file counter (docs/RELAYER.md, "Migration of relayer state").
CREATE TABLE relayer_creator_counter (
    network    TEXT PRIMARY KEY CHECK (network IN ('devnet', 'mainnet-beta')),
    next_index INTEGER NOT NULL CHECK (next_index >= 0)
);

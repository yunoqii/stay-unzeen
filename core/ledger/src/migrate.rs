//! Minimal forward-only SQL migrations from `core/migrations/` (embedded at build time).

use deadpool_postgres::Client;

/// (version, name, sql) — append only; never edit an applied migration.
const MIGRATIONS: &[(i32, &str, &str)] = &[
    (1, "0001_ledger", include_str!("../../migrations/0001_ledger.sql")),
    (2, "0002_relayer", include_str!("../../migrations/0002_relayer.sql")),
    (
        3,
        "0003_payouts_epochs",
        include_str!("../../migrations/0003_payouts_epochs.sql"),
    ),
    (
        4,
        "0004_relayer_state",
        include_str!("../../migrations/0004_relayer_state.sql"),
    ),
    (5, "0005_exec_mode", include_str!("../../migrations/0005_exec_mode.sql")),
    (
        6,
        "0006_exec_mode_scrub",
        include_str!("../../migrations/0006_exec_mode_scrub.sql"),
    ),
    (7, "0007_intel", include_str!("../../migrations/0007_intel.sql")),
    (
        8,
        "0008_fair_launch",
        include_str!("../../migrations/0008_fair_launch.sql"),
    ),
    (9, "0009_verify", include_str!("../../migrations/0009_verify.sql")),
    (
        10,
        "0010_creator_fees",
        include_str!("../../migrations/0010_creator_fees.sql"),
    ),
    (11, "0011_orders", include_str!("../../migrations/0011_orders.sql")),
    (
        12,
        "0012_fair_review",
        include_str!("../../migrations/0012_fair_review.sql"),
    ),
    (
        13,
        "0013_creator_stats",
        include_str!("../../migrations/0013_creator_stats.sql"),
    ),
    (
        14,
        "0014_verify_review",
        include_str!("../../migrations/0014_verify_review.sql"),
    ),
    (
        15,
        "0015_rebalance",
        include_str!("../../migrations/0015_rebalance.sql"),
    ),
    // 16 lands after 17/18 on databases that already ran those: versions are checked one by
    // one and 0016 does not depend on 0017/0018.
    (16, "0016_chat", include_str!("../../migrations/0016_chat.sql")),
    (
        17,
        "0017_fair_bundle",
        include_str!("../../migrations/0017_fair_bundle.sql"),
    ),
    (
        18,
        "0018_discovery",
        include_str!("../../migrations/0018_discovery.sql"),
    ),
    (19, "0019_quotes", include_str!("../../migrations/0019_quotes.sql")),
    (
        20,
        "0020_quote_fees",
        include_str!("../../migrations/0020_quote_fees.sql"),
    ),
    (
        21,
        "0021_bracket_orders",
        include_str!("../../migrations/0021_bracket_orders.sql"),
    ),
    (
        22,
        "0022_bags_first_buy",
        include_str!("../../migrations/0022_bags_first_buy.sql"),
    ),
    (
        23,
        "0023_payout_review",
        include_str!("../../migrations/0023_payout_review.sql"),
    ),
    (
        24,
        "0024_intel_creates",
        include_str!("../../migrations/0024_intel_creates.sql"),
    ),
    (
        25,
        "0025_verify_digest_v2",
        include_str!("../../migrations/0025_verify_digest_v2.sql"),
    ),
    (
        26,
        "0026_amounts_numeric",
        include_str!("../../migrations/0026_amounts_numeric.sql"),
    ),
    (
        27,
        "0027_scenarios",
        include_str!("../../migrations/0027_scenarios.sql"),
    ),
    (
        28,
        "0028_hood_relayer",
        include_str!("../../migrations/0028_hood_relayer.sql"),
    ),
    (
        29,
        "0029_verify_v3",
        include_str!("../../migrations/0029_verify_v3.sql"),
    ),
];

/// Arbitrary constant for `pg_advisory_xact_lock` so concurrent starters serialize.
const LOCK_KEY: i64 = 0x756e_7a65_656e_0001;

pub async fn run(c: &mut Client) -> Result<(), tokio_postgres::Error> {
    let tx = c.transaction().await?;
    tx.execute("SELECT pg_advisory_xact_lock($1)", &[&LOCK_KEY]).await?;
    tx.batch_execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    )
    .await?;
    for (version, name, sql) in MIGRATIONS {
        let done = tx
            .query_opt("SELECT 1 FROM schema_migrations WHERE version = $1", &[version])
            .await?
            .is_some();
        if !done {
            tx.batch_execute(sql).await?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
                &[version, name],
            )
            .await?;
            tracing::info!(version, name, "applied migration");
        }
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    /// Every `core/migrations/*.sql` file is registered, once, under its number (a file that is
    /// not in [`super::MIGRATIONS`] would silently never run).
    #[test]
    fn every_migration_file_is_registered() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../migrations");
        let mut files: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.ends_with(".sql"))
            .map(|n| n.trim_end_matches(".sql").to_string())
            .collect();
        files.sort();
        let mut names: Vec<String> = super::MIGRATIONS.iter().map(|m| m.1.to_string()).collect();
        names.sort();
        assert_eq!(files, names);
        for (v, n, _) in super::MIGRATIONS {
            assert_eq!(n[..4].parse::<i32>().unwrap(), *v, "{n}");
        }
    }
}

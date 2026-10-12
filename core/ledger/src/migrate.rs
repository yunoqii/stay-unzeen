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

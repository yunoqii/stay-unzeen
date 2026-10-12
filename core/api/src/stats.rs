//! `GET /api/stats` (API.md v0.9): the latest daily snapshot, never a live aggregate (H6).

use std::time::Duration;

use axum::{extract::State, response::Response};

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    market::public,
};

/// Public, same for everyone. 404 until the first snapshot exists.
pub async fn stats(State(st): State<AppState>) -> ApiResult<Response> {
    let v = st
        .ledger
        .stats_latest(st.cfg.cluster)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(public(v, 3600))
}

/// Daily snapshot right after 00:00 UTC (when `UNZEEN_STATS_DAILY` is on). Checks once a
/// minute; the content depends only on data before the cut-off, not on when it runs.
pub async fn scheduler_loop(st: AppState) {
    if !st.cfg.stats.daily {
        return;
    }
    let mut every = tokio::time::interval(Duration::from_secs(60));
    loop {
        every.tick().await;
        match st.ledger.stats_due(st.cfg.cluster).await {
            Ok(true) => match st.ledger.stats_snapshot(st.cfg.cluster, &st.cfg.stats.params).await {
                Ok(day) => tracing::info!(day, "stats snapshot built (daily)"),
                Err(e) => tracing::warn!(error = %e, "stats snapshot failed"),
            },
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "stats schedule check failed"),
        }
    }
}

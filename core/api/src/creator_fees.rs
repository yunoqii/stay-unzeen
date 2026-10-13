//! Creator fees (API.md v0.7): `claim` (ledger-only) and the epoch-timed crediting of sweeps.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use unzeen_ledger::RateUsed;

use crate::{
    AppState,
    actions::any_address,
    error::{ApiError, ApiResult},
    rate::apply_spread,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    #[allow(dead_code)]
    op: String,
    mint: Option<String>,
}

/// `{"op":"claim","mint"?}`: claimable lamports → ZEC balance at the sell rate.
pub async fn claim(st: &AppState, raw: Value, pk: &[u8; 32], nonce: &[u8; 16], hash: &[u8; 32]) -> ApiResult<Value> {
    let c: Claim = serde_json::from_value(raw).map_err(|_| ApiError::bad_request("invalid action body"))?;
    let mint = c.mint.as_deref().map(|m| any_address(m, "mint")).transpose()?;
    let r = st
        .rate
        .get()
        .await
        .map_err(|_| ApiError::venue_unavailable("ZEC/SOL rate unavailable, retry later"))?;
    let spread = if r.stale {
        st.cfg.rate.spread_bps.saturating_mul(2)
    } else {
        st.cfg.rate.spread_bps
    };
    let used = RateUsed {
        lamports_per_zec: apply_spread(r.lamports_per_zec, spread, false),
        source: r.source.into(),
        ts_ms: r.ts_ms,
    };
    let rec = st
        .ledger
        .claim(pk, nonce, hash, mint.as_deref(), &used)
        .await
        .map_err(|e| match e {
            unzeen_ledger::LedgerError::BelowMinimum => {
                ApiError::below_minimum("nothing to claim, or less than PoolInfo.minClaimZat")
            }
            e => e.into(),
        })?;
    Ok(json!({
        "id": hex::encode(rec.id),
        "status": rec.status,
        "rate": { "lamportsPerZec": used.lamports_per_zec.to_string(), "source": used.source, "ts": used.ts_ms },
    }))
}

/// Credit landed creator sweeps on the Delayed epoch schedule (30–60 s boundaries that do not
/// depend on when a sweep landed).
pub async fn credit_loop(st: AppState) {
    loop {
        let wait = st.epochs.delay(false);
        tokio::time::sleep(Duration::from_secs_f64(wait.max(1.0))).await;
        match st.ledger.credit_fee_sweeps(st.cfg.cluster).await {
            Ok(r) if r.credited + r.pool_revenue > 0 => {
                tracing::info!(
                    credited = r.credited,
                    pool_revenue = r.pool_revenue,
                    "creator fee sweeps processed"
                )
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "creator fee crediting failed"),
        }
    }
}

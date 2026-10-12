//! `GET /api/creator` (API.md v0.9, signed): the anonymous creator cabinet.
//!
//! T1: answered only to the creator's own key, padded to a multiple of 4096 bytes (a key with
//! no launches gets the same size as one with a few). Nothing here is published anywhere else.

use axum::{
    extract::State,
    http::{HeaderMap, Method, Uri},
    response::Response,
};
use serde_json::{Value, json};
use unzeen_ledger::creator::CreatorTokenRow;

use crate::{AppState, auth, error::ApiResult, padded};

pub const BUCKET: usize = 4096;

pub async fn cabinet(State(st): State<AppState>, method: Method, uri: Uri, headers: HeaderMap) -> ApiResult<Response> {
    let a = auth::verify(&st, &method, &uri, &headers, b"", true).await?;
    let rows = st.ledger.creator_cabinet(&a.pubkey).await?;
    let l = &st.cfg.launch;
    let tokens: Vec<Value> = rows
        .iter()
        .map(|r| token_json(r, l.cap_bps, st.ledger.creator_rules().cap_tokens))
        .collect();
    Ok(padded(json!({ "tokens": tokens }), BUCKET))
}

/// `CreatorToken` (API.md v0.9).
pub fn token_json(r: &CreatorTokenRow, cap_bps: u64, cap_tokens: u64) -> Value {
    let safety = r.safety.as_ref();
    let market = safety.and_then(|s| s.get("market"));
    // Snapshot of the indexer first (tick-fresh), then the token row.
    let status = market
        .and_then(|m| m.get("status"))
        .and_then(Value::as_str)
        .filter(|s| matches!(*s, "curve" | "graduated"))
        .or(r.status.as_deref())
        .unwrap_or("curve");
    let mut v = json!({
        "mint": r.mint,
        "symbol": r.symbol.as_deref().unwrap_or(""),
        "name": r.name.as_deref().unwrap_or(""),
        "decimals": r.decimals.unwrap_or(6),
        "venue": r.venue.as_deref().unwrap_or("pumpfun"),
        "status": status,
        "createdAt": r.created_at_ms,
        "fees": {
            "claimableLamports": r.claimable.to_string(),
            "claimedLamports": r.claimed.to_string(),
        },
        "volumeLamports": r.volume_lamports.to_string(),
        "trades": r.trades,
        "holders": Value::Null,
        "lock": {
            "lockedAmount": r.locked_amount.to_string(),
            "until": r.locked_until_ms,
        },
        "cap": {
            "capBps": cap_bps,
            "capTokens": cap_tokens.to_string(),
            "positionTokens": r.position.to_string(),
        },
    });
    if let Some(img) = &r.image {
        v["image"] = json!(img);
    }
    if status == "curve"
        && let Some(p) = market.and_then(|m| m.get("curveProgressPct")).and_then(Value::as_str)
    {
        v["curveProgressPct"] = json!(p);
    }
    if let Some(n) = safety
        .and_then(|s| s.get("holders"))
        .and_then(|h| h.get("count"))
        .and_then(Value::as_u64)
    {
        v["holders"] = json!(n);
        if let Some(t) = r.safety_as_of_ms {
            v["holdersAsOf"] = json!(t);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> CreatorTokenRow {
        CreatorTokenRow {
            mint: "M".into(),
            symbol: Some("S".into()),
            name: Some("N".into()),
            image: None,
            decimals: Some(6),
            venue: Some("pumpfun".into()),
            status: Some("curve".into()),
            created_at_ms: Some(1),
            claimable: 7,
            claimed: 3,
            volume_lamports: 100,
            trades: 2,
            locked_amount: 0,
            locked_until_ms: None,
            position: 5,
            safety: None,
            safety_as_of_ms: None,
        }
    }

    #[test]
    fn without_snapshot() {
        let v = token_json(&row(), 500, 50);
        assert_eq!(v["holders"], Value::Null);
        assert!(v.get("holdersAsOf").is_none() && v.get("curveProgressPct").is_none());
        assert_eq!(v["fees"], json!({"claimableLamports": "7", "claimedLamports": "3"}));
        assert_eq!(v["lock"], json!({"lockedAmount": "0", "until": null}));
        assert_eq!(
            v["cap"],
            json!({"capBps": 500, "capTokens": "50", "positionTokens": "5"})
        );
    }

    #[test]
    fn snapshot_status_holders_progress() {
        let mut r = row();
        r.safety = Some(json!({"market": {"status": "curve", "curveProgressPct": "12.5"}, "holders": {"count": 42}}));
        r.safety_as_of_ms = Some(60_000);
        let v = token_json(&r, 500, 50);
        assert_eq!(
            (v["holders"].clone(), v["holdersAsOf"].clone()),
            (json!(42), json!(60_000))
        );
        assert_eq!(v["curveProgressPct"], "12.5");
        // Graduated in the snapshot wins over the stale token row; no curve progress then.
        r.safety = Some(json!({"market": {"status": "graduated", "curveProgressPct": "100"}}));
        let v = token_json(&r, 500, 50);
        assert_eq!(v["status"], "graduated");
        assert!(v.get("curveProgressPct").is_none());
    }
}

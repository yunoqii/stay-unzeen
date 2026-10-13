//! Verify (API.md v0.7): public snapshots and root history, signed owner proof (padded to
//! 16 KiB), and the snapshot scheduler (daily 00:00 UTC on mainnet, manual command on devnet).
//!
//! Logs: snapshot ids and step names only — never keys, balances or proof contents.

use std::time::Duration;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Uri, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use unzeen_ledger::verify::{SnapshotRow, Step, VerifyRates};

use crate::{
    AppState, auth,
    error::{ApiError, ApiResult},
    padded,
    rate::apply_spread,
};

fn public(v: Value, max_age: u32) -> Response {
    let mut r = Json(v).into_response();
    if let Ok(h) = HeaderValue::from_str(&format!("public, max-age={max_age}")) {
        r.headers_mut().insert(header::CACHE_CONTROL, h);
    }
    r
}

fn summary_json(id: i32, taken_at_ms: u64, digest: &[u8], anchor: &Option<Value>) -> Value {
    let mut v = json!({ "id": id, "takenAt": taken_at_ms, "rootsDigest": hex::encode(digest) });
    if let Some(a) = anchor {
        v["anchor"] = a.clone();
    }
    v
}

pub fn snapshot_json(s: &SnapshotRow) -> Value {
    let mut v = summary_json(s.id, s.taken_at_ms, &s.roots_digest, &s.anchor);
    v["chainId"] = json!(s.chain_id);
    v["leaves"] = json!(s.leaves);
    v["solanaSlot"] = json!(s.solana_slot);
    v["zcashHeight"] = json!(s.zcash_height);
    if let Some(o) = &s.operator {
        v["operator"] = o.clone();
    }
    v["trees"] = s
        .trees
        .iter()
        .map(|(asset, dec, g, root, sum)| {
            json!({ "asset": asset, "decimals": dec, "granule": g.to_string(), "root": hex::encode(root), "sum": sum })
        })
        .collect::<Vec<_>>()
        .into();
    v["vaults"] = s
        .vaults
        .iter()
        .map(|(address, sig, lamports, tokens)| {
            json!({ "address": address, "sig": sig, "lamports": lamports.to_string(), "tokens": tokens })
        })
        .collect::<Vec<_>>()
        .into();
    v["committedLamports"] = json!(s.committed_lamports.to_string());
    // v0.17: absent = 1. With 2 the digest covers quoteAssets (absent list = empty).
    if s.digest_version >= 2 {
        v["digestVersion"] = json!(s.digest_version);
    }
    if let Some(q) = &s.quote_assets
        && q.as_array().is_some_and(|a| !a.is_empty())
    {
        v["quoteAssets"] = q.clone();
    }
    if let Some(r) = s.rate_sell {
        v["rateLamportsPerZecSell"] = json!(r.to_string());
    }
    if let Some(r) = s.rate_buy {
        v["rateLamportsPerZecBuy"] = json!(r.to_string());
    }
    v["zecReserve"] = json!({
        "amountZat": s.zec_reserve_zat.to_string(),
        "height": s.zcash_height,
        "attested": true,
    });
    v
}

/// `GET /api/verify` — latest built snapshot.
pub async fn latest(State(st): State<AppState>) -> ApiResult<Response> {
    let s = st
        .ledger
        .verify_snapshot(st.cfg.cluster, None)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(public(snapshot_json(&s), 300))
}

/// `GET /api/verify/:id`.
pub async fn one(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let id: i32 = id.parse().ok().filter(|i| *i > 0).ok_or_else(ApiError::not_found)?;
    let s = st
        .ledger
        .verify_snapshot(st.cfg.cluster, Some(id))
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(public(snapshot_json(&s), 300))
}

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    before: Option<String>,
    limit: Option<String>,
}

/// `GET /api/verify/snapshots?before=&limit=` — root history, newest first.
pub async fn history(State(st): State<AppState>, Query(q): Query<HistoryQuery>) -> ApiResult<Response> {
    let before = match q.before.as_deref() {
        None => None,
        Some(b) => Some(
            b.parse::<i32>()
                .ok()
                .filter(|b| *b > 0)
                .ok_or_else(|| ApiError::bad_request("before: snapshot id"))?,
        ),
    };
    let limit = match q.limit.as_deref() {
        None => 30,
        Some(l) => l
            .parse::<i64>()
            .ok()
            .filter(|l| (1..=30).contains(l))
            .ok_or_else(|| ApiError::bad_request("limit: 1..30"))?,
    };
    let rows = st.ledger.verify_list(st.cfg.cluster, before, limit).await?;
    let v: Vec<Value> = rows.iter().map(|(id, t, d, a)| summary_json(*id, *t, d, a)).collect();
    Ok(public(Value::Array(v), 60))
}

#[derive(Debug, Deserialize)]
pub struct ProofQuery {
    snapshot: Option<String>,
}

/// `GET /api/verify/proof[?snapshot=]` (signed): the owner's pieces and paths, padded.
pub async fn proof(
    State(st): State<AppState>,
    Query(q): Query<ProofQuery>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let a = auth::verify(&st, &method, &uri, &headers, b"", true).await?;
    st.verify_limit.check(&a.pubkey).map_err(ApiError::rate_limited)?;
    let snapshot = match q.snapshot.as_deref() {
        None => None,
        Some(s) => Some(s.parse::<i32>().map_err(|_| ApiError::not_found())?),
    };
    let p = st
        .ledger
        .verify_proof(st.cfg.cluster, &a.pubkey, snapshot)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let proofs: Vec<Value> = p
        .proofs
        .iter()
        .map(|ap| {
            json!({
                "asset": ap.asset,
                "decimals": ap.decimals,
                "pieces": ap.pieces.iter().map(|pc| json!({
                    "piece": pc.piece,
                    "leafIndex": pc.leaf_idx,
                    "value": pc.value.to_string(),
                    "blind": hex::encode(&pc.blind),
                    "path": pc.path.iter().map(|(h, s)| json!({ "hash": hex::encode(h), "sum": s })).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let v = json!({ "snapshotId": p.snapshot_id, "proofs": proofs, "truncated": p.truncated });
    Ok(padded(v, st.cfg.verify.proof_bucket))
}

/// One scheduler pass: daily request (when enabled), advance the snapshot, settle attestations.
pub async fn tick(st: &AppState) -> ApiResult<Option<Step>> {
    let net = st.cfg.cluster;
    let t = st.cfg.verify.timing;
    if st.cfg.verify.daily
        && st.ledger.verify_daily_due(net).await?
        && let Some(id) = st
            .ledger
            .verify_request(net, &st.cfg.policy.chain.to_hex(), "daily", t)
            .await?
    {
        tracing::info!(id, "verify snapshot requested (daily)");
    }
    let rates = match st.rate.get().await {
        Ok(r) => VerifyRates {
            sell: Some(apply_spread(r.lamports_per_zec, st.cfg.rate.spread_bps, false)),
            buy: Some(apply_spread(r.lamports_per_zec, st.cfg.rate.spread_bps, true)),
        },
        Err(_) => VerifyRates::default(),
    };
    let step = st.ledger.verify_step(net, t, rates).await?;
    match &step {
        Step::Built(id) => tracing::info!(id, "verify snapshot built; anchor queued"),
        Step::Skipped(id, why) => tracing::warn!(id, why, "verify snapshot skipped (will retry)"),
        Step::Collecting(id) => tracing::info!(id, "verify snapshot: relayer collecting vault balances"),
        _ => {}
    }
    // Failed anchors (e.g. the attestation key had no SOL): retry every 10 min, ≤ 12 jobs.
    let n = st.ledger.verify_reanchor(net, 600.0, 12).await?;
    if n > 0 {
        tracing::warn!(n, "verify anchor re-queued after a failed attest");
    }
    Ok(Some(step))
}

pub async fn scheduler_loop(st: AppState) {
    let mut every = tokio::time::interval(Duration::from_secs(1));
    loop {
        every.tick().await;
        if let Err(e) = tick(&st).await {
            tracing::warn!(code = e.code, "verify pass failed");
        }
    }
}

/// E14: attestations (fair-launch roots and Verify anchors) and early operator signatures
/// (E10) run in their own loop, so a failing Verify tick never blocks them.
pub async fn attest_loop(st: AppState) {
    let mut every = tokio::time::interval(Duration::from_secs(1));
    loop {
        every.tick().await;
        if let Err(e) = st.ledger.settle_attestations().await {
            tracing::warn!(error = e.kind(), "attestation settle failed");
        }
        match st.ledger.publish_operator_sigs().await {
            Ok(n) if n > 0 => tracing::info!(n, "verify operator signature published"),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = e.kind(), "operator signature pass failed"),
        }
    }
}

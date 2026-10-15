//! Fair launch (API.md v0.6): `fl_*` actions, `GET /api/launches[/:id]`, portfolio blocks,
//! `PoolInfo.fairLaunch`, the drand client and the close/reveal/settle scheduler.
//! Internal until 28.10 23:59 UTC.
//!
//! Flag off (`UNZEEN_FAIR_LAUNCH` ≠ 1): routes answer like unknown paths (404), `fl_*` like an
//! unknown op (400 "invalid action body"), no portfolio/pool fields, no scheduler.
//!
//! Logs: counts and error kinds only — never a launch id together with a key or an amount.

use std::time::Duration;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use unzeen_fair::drand::{self as fdrand, CiphertextError, VerifiedBeacon};
use unzeen_ledger::fair::{CurveRow, LaunchRow, NewFairLaunch, RevealOutcome, RevealParams};

use crate::{
    AppState,
    actions::{Meta, check_meta, parse_amount},
    error::{ApiError, ApiResult},
    rate::{apply_spread, lamports_to_zat_ceil, now_ms},
};

pub const VENUE: &str = "pumpfun";

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum FlAction {
    FlCreate {
        venue: String,
        meta: Meta,
        #[serde(rename = "windowSecs")]
        window_secs: u32,
    },
    FlBid {
        #[serde(rename = "launchId")]
        launch_id: String,
        #[serde(rename = "holdZat")]
        hold_zat: String,
        ciphertext: String,
    },
    FlCancel {
        #[serde(rename = "launchId")]
        launch_id: String,
    },
    FlCancelLaunch {
        #[serde(rename = "launchId")]
        launch_id: String,
    },
}

pub fn is_fl_op(v: &Value) -> bool {
    v.get("op")
        .and_then(Value::as_str)
        .is_some_and(|o| o.starts_with("fl_"))
}

fn bad_ciphertext(m: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "bad_ciphertext", m)
}

pub fn launch_id(s: &str) -> ApiResult<[u8; 16]> {
    (s.len() == 32 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
        .then(|| hex::decode(s).ok())
        .flatten()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("launchId: 32 lowercase hex"))
}

// ------------------------------------------------------------------ curve of the network

/// Fresh-curve parameters for fair launch: the network's on-chain config written by the relayer
/// (`launch_curves`), or env values only when set explicitly. Never the built-in defaults.
pub async fn fair_curve(st: &AppState) -> ApiResult<Option<CurveRow>> {
    if let Some(c) = st.ledger.launch_curve(st.cfg.cluster, VENUE).await? {
        return Ok(Some(c));
    }
    let l = &st.cfg.launch;
    Ok(l.curve_from_env.then_some(CurveRow {
        virtual_sol: l.virtual_sol_lamports,
        virtual_tokens: l.virtual_token_reserves,
        real_tokens: l.virtual_token_reserves,
        total_supply: l.total_supply,
    }))
}

/// (max total lamports, creator max lamports) on a curve.
pub fn caps(st: &AppState, c: &CurveRow) -> (u128, u128) {
    let supply = c.total_supply;
    let total_tokens = supply.saturating_mul(st.cfg.fair.max_total_bps as u128) / 10_000;
    // Never past graduation (real reserves), whatever the bps says.
    let total_tokens = total_tokens.min(c.real_tokens.saturating_sub(1));
    let max_total = unzeen_fair::alloc::curve_max_lamports(c.virtual_sol, c.virtual_tokens, total_tokens);
    let creator = if st.cfg.launch.cap_bps == 0 {
        max_total
    } else {
        let cap = supply.saturating_mul(st.cfg.launch.cap_bps as u128) / 10_000;
        unzeen_fair::alloc::curve_max_lamports(c.virtual_sol, c.virtual_tokens, cap).min(max_total)
    };
    (max_total, creator)
}

// ------------------------------------------------------------------ PoolInfo

pub async fn pool_block(st: &AppState) -> ApiResult<Option<Value>> {
    if !st.cfg.fair.enabled {
        return Ok(None);
    }
    let f = &st.cfg.fair;
    let caps = fair_curve(st).await?.map(|c| caps(st, &c));
    Ok(Some(json!({
        "windowsSecs": f.windows_secs,
        "holdTiersZat": f.hold_tiers_zat.iter().map(u64::to_string).collect::<Vec<_>>(),
        "maxTotalBps": f.max_total_bps,
        "maxTotalLamports": caps.map(|c| c.0.to_string()),
        "creatorMaxLamports": caps.map(|c| c.1.to_string()),
        "minBidsForCount": f.min_bids_for_count,
        "drand": {
            "chainHash": fdrand::QUICKNET_CHAIN_HASH_HEX,
            "publicKey": fdrand::QUICKNET_PUBLIC_KEY_HEX,
            "genesis": fdrand::QUICKNET_GENESIS,
            "period": fdrand::QUICKNET_PERIOD,
            "scheme": fdrand::QUICKNET_SCHEME,
        },
    })))
}

// ------------------------------------------------------------------ actions

/// Handle a signed `fl_*` action (feature enabled). Returns the receipt JSON (unpadded).
pub async fn submit(
    st: &AppState,
    raw: Value,
    pk: &[u8; 32],
    nonce: &[u8; 16],
    request_hash: &[u8; 32],
) -> ApiResult<Value> {
    let a: FlAction = serde_json::from_value(raw).map_err(|_| ApiError::bad_request("invalid action body"))?;
    let net = st.cfg.cluster;
    match a {
        FlAction::FlCreate {
            venue,
            meta,
            window_secs,
        } => {
            if venue != VENUE {
                return Err(ApiError::bad_request("venue: fair launch supports pumpfun only"));
            }
            check_meta(&meta)?;
            if !st.cfg.fair.windows_secs.contains(&window_secs) {
                return Err(ApiError::bad_request(
                    "windowSecs: one of PoolInfo.fairLaunch.windowsSecs",
                ));
            }
            if !st.cfg.create_enabled || !st.cfg.venues.iter().any(|v| v == VENUE) {
                return Err(ApiError::venue_unavailable("launches are not available yet"));
            }
            if fair_curve(st).await?.is_none() {
                return Err(ApiError::venue_unavailable("launch curve of this network unknown yet"));
            }
            // Publication on the next Delayed epoch boundary, not at the request time.
            let now = now_ms();
            let published = now + (st.epochs.delay(false) * 1000.0) as u64;
            let close = published + u64::from(window_secs) * 1000;
            let round = fdrand::reveal_round(close);
            let mut m = json!({ "name": meta.name.trim(), "symbol": meta.symbol });
            if let Some(img) = meta.image {
                m["image"] = json!(img);
            }
            let l = NewFairLaunch {
                id: rand::random(),
                network: net.into(),
                venue: VENUE.into(),
                meta: m,
                window_secs,
                published_at_ms: published,
                close_at_ms: close,
                round,
                round_time_ms: fdrand::round_time_ms(round),
            };
            let r = st
                .ledger
                .fl_create(pk, nonce, request_hash, st.cfg.fees.create_fee_zat, &l)
                .await?;
            let mut v = json!({ "id": hex::encode(r.receipt.id), "status": r.receipt.status });
            if let Some(id) = r.launch_id {
                v["launchId"] = json!(hex::encode(id));
            }
            Ok(v)
        }
        FlAction::FlBid {
            launch_id: lid,
            hold_zat,
            ciphertext,
        } => {
            let id = launch_id(&lid)?;
            let hold = parse_amount(&hold_zat, "holdZat")?;
            if !st.cfg.fair.hold_tiers_zat.contains(&hold) {
                return Err(ApiError::bad_request(
                    "holdZat: one of PoolInfo.fairLaunch.holdTiersZat",
                ));
            }
            let round = fdrand::header_round(&ciphertext).map_err(|e| match e {
                CiphertextError::TooLarge => bad_ciphertext("ciphertext larger than 1024 bytes"),
                CiphertextError::Chain => bad_ciphertext("ciphertext is not for drand quicknet"),
                _ => bad_ciphertext("ciphertext: age armor with a tlock stanza expected"),
            })?;
            let target = st
                .ledger
                .fl_bid_target(net, &id, pk)
                .await?
                .ok_or_else(ApiError::not_found)?;
            if round != target.round {
                return Err(bad_ciphertext("ciphertext is encrypted to another round"));
            }
            if target.is_creator && st.cfg.launch.cap_bps > 0 {
                // UX guard; the reveal trims the creator's bid anyway (spec §4).
                if let (Some(c), Ok(r)) = (fair_curve(st).await?, st.rate.get().await) {
                    let applied = apply_spread(r.lamports_per_zec, st.cfg.rate.spread_bps, true);
                    let cap_zat = lamports_to_zat_ceil(caps(st, &c).1, applied);
                    let tiers = &st.cfg.fair.hold_tiers_zat;
                    let allowed = tiers
                        .iter()
                        .copied()
                        .find(|t| *t >= cap_zat)
                        .unwrap_or(tiers[tiers.len() - 1]);
                    if hold > allowed {
                        return Err(ApiError::creator_cap());
                    }
                }
            }
            let r = st
                .ledger
                .fl_bid(pk, nonce, request_hash, net, &id, hold, &ciphertext, round)
                .await?;
            Ok(json!({ "id": hex::encode(r.id), "status": r.status }))
        }
        FlAction::FlCancel { launch_id: lid } => {
            let id = launch_id(&lid)?;
            let r = st.ledger.fl_cancel(pk, nonce, request_hash, net, &id).await?;
            Ok(json!({ "id": hex::encode(r.id), "status": r.status }))
        }
        FlAction::FlCancelLaunch { launch_id: lid } => {
            let id = launch_id(&lid)?;
            let r = st.ledger.fl_cancel_launch(pk, nonce, request_hash, net, &id).await?;
            Ok(json!({ "id": hex::encode(r.id), "status": r.status }))
        }
    }
}

// ------------------------------------------------------------------ public reads

pub fn launch_json(st: &AppState, l: &LaunchRow) -> Value {
    let mut v = json!({
        "id": hex::encode(l.id),
        "venue": l.venue,
        "meta": { "name": l.name, "symbol": l.symbol },
        "status": l.status,
        "publishedAt": l.published_at_ms,
        "closeAt": l.close_at_ms,
        "drand": { "round": l.round, "roundTime": l.round_time_ms },
        "rules": rules(st),
    });
    if let Some(sig) = &l.beacon_sig {
        v["drand"]["signature"] = json!(hex::encode(sig));
    }
    if let Some(root) = &l.root {
        v["commitment"] = json!({ "root": hex::encode(root) });
        if let Some(a) = &l.attestation {
            v["commitment"]["attestation"] = a.clone();
        }
    }
    if l.status == "launched"
        && let Some(r) = &l.result
    {
        let mut r = r.clone();
        let n = r.get("bids").and_then(Value::as_u64).unwrap_or(0);
        let min = u64::from(st.cfg.fair.min_bids_for_count);
        r["bids"] = if n >= min { json!(n) } else { json!(format!("<{min}")) };
        v["result"] = r;
    }
    if let Some(f) = &l.failure {
        v["failure"] = json!(f);
    }
    v
}

pub fn rules(st: &AppState) -> Vec<String> {
    let mut r = vec!["fair_launch_sealed_bids".to_string()];
    r.extend(crate::launch::rule_ids(
        st.cfg.launch.lock_secs,
        st.cfg.launch.cap_bps,
        false,
    ));
    r
}

fn public(v: Value) -> Response {
    let mut r = Json(v).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=5"));
    r
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    status: Option<String>,
    limit: Option<String>,
}

const STATUSES: [&str; 7] = [
    "open",
    "closed",
    "revealing",
    "executing",
    "launched",
    "failed",
    "cancelled",
];

pub async fn list(State(st): State<AppState>, Query(q): Query<ListQuery>) -> ApiResult<Response> {
    if !st.cfg.fair.enabled {
        return Err(ApiError::not_found());
    }
    if let Some(s) = q.status.as_deref()
        && !STATUSES.contains(&s)
    {
        return Err(ApiError::bad_request("status: unknown"));
    }
    let limit = match q.limit.as_deref() {
        None => 50,
        Some(s) => s
            .parse::<i64>()
            .ok()
            .filter(|l| (1..=100).contains(l))
            .ok_or_else(|| ApiError::bad_request("limit: 1..100"))?,
    };
    let rows = st
        .ledger
        .fl_public(st.cfg.cluster, None, q.status.as_deref(), limit)
        .await?;
    Ok(public(Value::Array(rows.iter().map(|l| launch_json(&st, l)).collect())))
}

pub async fn one(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    if !st.cfg.fair.enabled {
        return Err(ApiError::not_found());
    }
    let id = launch_id(&id).map_err(|_| ApiError::not_found())?;
    let rows = st.ledger.fl_public(st.cfg.cluster, Some(&id), None, 1).await?;
    let Some(l) = rows.first() else {
        // v0.25 (devnet run 15.10, B4): before publication the creator, who alone holds the
        // random id, gets `scheduled` with no other field (no meta, no publication time); the
        // launch is still absent from `GET /api/launches`. Not cached: it flips to the full
        // launch at the boundary.
        if st.ledger.fl_is_scheduled(st.cfg.cluster, &id).await? {
            let mut r = Json(json!({ "id": hex::encode(id), "status": "scheduled" })).into_response();
            r.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return Ok(r);
        }
        return Err(ApiError::not_found());
    };
    Ok(public(launch_json(&st, l)))
}

/// `Portfolio.fairBids` and `Portfolio.fairLaunches` (feature enabled only).
pub async fn portfolio(st: &AppState, pk: &[u8; 32]) -> ApiResult<Option<(Value, Value)>> {
    if !st.cfg.fair.enabled {
        return Ok(None);
    }
    let bids = st.ledger.fl_owner_bids(st.cfg.cluster, pk).await?;
    let launches = st.ledger.fl_owner_launches(st.cfg.cluster, pk).await?;
    let bids: Vec<Value> = bids
        .iter()
        .map(|b| {
            let mut v = json!({
                "launchId": hex::encode(b.launch_id),
                "holdZat": b.hold_zat.to_string(),
                "status": b.status,
            });
            if let Some(a) = b.amount_zat {
                v["amountZat"] = json!(a.to_string());
            }
            if b.status == "settled" {
                if let Some(t) = b.tokens {
                    v["tokenAmount"] = json!(t.to_string());
                }
                if let Some(c) = b.charge_zat {
                    v["chargedZat"] = json!(c.to_string());
                }
            }
            if let Some(r) = b.released_zat {
                v["releasedZat"] = json!(r.to_string());
            }
            if let (Some(leaf), Some(path)) = (&b.leaf, &b.proof) {
                v["proof"] = json!({ "leaf": hex::encode(leaf), "path": path });
            }
            v
        })
        .collect();
    let launches: Vec<Value> = launches
        .iter()
        .map(|l| {
            json!({
                "launchId": hex::encode(l.launch_id),
                "status": l.status,
                "publishedAt": l.published_at_ms,
                "closeAt": l.close_at_ms,
            })
        })
        .collect();
    Ok(Some((Value::Array(bids), Value::Array(launches))))
}

// ------------------------------------------------------------------ drand client

pub enum Fetch {
    Beacon(VerifiedBeacon),
    /// 425: the round is not published yet.
    TooEarly,
    /// No relay gave a beacon whose signature verifies.
    Unavailable,
}

pub struct Drand {
    urls: Vec<String>,
    http: reqwest::Client,
}

/// Whole fetch (all relays in parallel) is bounded by this (review F5).
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(3);

enum RelayAnswer {
    Beacon(VerifiedBeacon),
    TooEarly,
    Nothing,
}

impl Drand {
    pub fn new(urls: Vec<String>) -> Self {
        Self {
            urls,
            http: reqwest::Client::builder()
                .timeout(FETCH_TIMEOUT)
                .user_agent("unzeen")
                .build()
                .expect("reqwest client"),
        }
    }

    async fn one(&self, base: &str, round: u64) -> RelayAnswer {
        let url = format!("{base}/{}/public/{round}", fdrand::QUICKNET_CHAIN_HASH_HEX);
        let Ok(res) = self.http.get(url).send().await else {
            return RelayAnswer::Nothing;
        };
        if res.status().as_u16() == 425 {
            return RelayAnswer::TooEarly;
        }
        if !res.status().is_success() {
            return RelayAnswer::Nothing;
        }
        let Ok(v) = res.json::<Value>().await else {
            return RelayAnswer::Nothing;
        };
        if v.get("round").and_then(Value::as_u64) != Some(round) {
            return RelayAnswer::Nothing;
        }
        let Some(sig) = v
            .get("signature")
            .and_then(Value::as_str)
            .and_then(fdrand::signature_from_hex)
        else {
            return RelayAnswer::Nothing;
        };
        match fdrand::verify_beacon(round, &sig) {
            Ok(b) => RelayAnswer::Beacon(b),
            Err(_) => {
                tracing::warn!("drand relay returned a beacon that does not verify; skipped");
                RelayAnswer::Nothing
            }
        }
    }

    /// Beacon of `round`: all relays in parallel, the first VERIFIED one wins (the signature of a
    /// round is unique, one valid source suffices). Bounded by [`FETCH_TIMEOUT`].
    pub async fn fetch(&self, round: u64) -> Fetch {
        use futures_util::StreamExt;
        let mut pending: futures_util::stream::FuturesUnordered<_> =
            self.urls.iter().map(|u| self.one(u, round)).collect();
        let mut early = false;
        let race = async {
            while let Some(a) = pending.next().await {
                match a {
                    RelayAnswer::Beacon(b) => return Some(b),
                    RelayAnswer::TooEarly => early = true,
                    RelayAnswer::Nothing => {}
                }
            }
            None
        };
        match tokio::time::timeout(FETCH_TIMEOUT, race).await {
            Ok(Some(b)) => Fetch::Beacon(b),
            _ if early => Fetch::TooEarly,
            _ => Fetch::Unavailable,
        }
    }
}

// ------------------------------------------------------------------ scheduler

/// Reveal one launch. Errors stay with this launch (review F5).
async fn reveal_one(st: &AppState, t: &unzeen_ledger::fair::RevealTask) -> ApiResult<()> {
    let late_ms = now_ms().saturating_sub(t.round_time_ms);
    let f = &st.cfg.fair;
    let beacon = match st.drand.fetch(t.round).await {
        Fetch::Beacon(b) => b,
        // No verified beacon (not yet / relays down): retry, give up after drand_give_up_secs.
        other => {
            if late_ms > f.drand_give_up_secs * 1000 {
                st.ledger.fl_fail(&t.id, "drand_unavailable").await?;
                tracing::warn!("fair launch failed: drand unavailable");
            } else {
                let secs = match other {
                    Fetch::TooEarly => 1.0,
                    _ if late_ms < 600_000 => 3.0,
                    _ => 60.0,
                };
                st.ledger.fl_retry_later(&t.id, secs).await?;
            }
            return Ok(());
        }
    };
    let curve = fair_curve(st).await?;
    let rate = st.rate.get().await.ok();
    let (Some(curve), Some(r)) = (curve, rate) else {
        if late_ms > f.rate_give_up_secs * 1000 {
            st.ledger.fl_fail(&t.id, "venue_unavailable").await?;
            tracing::warn!("fair launch failed: no rate or curve");
        } else {
            st.ledger.fl_retry_later(&t.id, 5.0).await?;
        }
        return Ok(());
    };
    let Some(inputs) = st.ledger.fl_reveal_inputs(&t.id).await? else {
        return Ok(());
    };
    // F6: decryption + validation in a blocking thread, before any row lock.
    let b2 = beacon.clone();
    let judged = tokio::task::spawn_blocking(move || unzeen_ledger::fair::judge_bids(&inputs, &b2))
        .await
        .map_err(|_| ApiError::internal())?;
    let spread = if r.stale {
        st.cfg.rate.spread_bps.saturating_mul(2)
    } else {
        st.cfg.rate.spread_bps
    };
    let (max_total, creator_max) = caps(st, &curve);
    let sk = unzeen_protocol::SigningKey::from_bytes(&rand::random());
    let mut mint_secret = [0u8; 64];
    mint_secret[..32].copy_from_slice(&sk.to_bytes());
    mint_secret[32..].copy_from_slice(&sk.verifying_key().to_bytes());
    let p = RevealParams {
        rate: apply_spread(r.lamports_per_zec, spread, true),
        max_total_lamports: max_total,
        creator_max_lamports: creator_max,
        curve,
        fee_bound_bps: f.fee_bound_bps,
        slippage_bps: f.slippage_bps,
        shave: (rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64,
        mint_secret,
    };
    // F8: no counts in logs (the line time ≈ the public round time of this launch).
    match st.ledger.fl_reveal(&judged, &beacon, &p).await? {
        RevealOutcome::Executing { .. } => tracing::info!("fair launch revealed, job queued"),
        RevealOutcome::NoBids { .. } => tracing::info!("fair launch failed: no valid bids"),
        RevealOutcome::Mismatch => tracing::error!(
            "ALERT: a fair launch bid set does not match its commitment root; launch failed, funds released"
        ),
        RevealOutcome::Skipped => {}
    }
    Ok(())
}

/// Reveal pass: each launch on its own; one failure does not stop the others.
pub async fn reveal_pass(st: &AppState) {
    match st.ledger.fl_reveal_due(st.cfg.cluster).await {
        Ok(tasks) => {
            for t in tasks {
                if let Err(e) = reveal_one(st, &t).await {
                    tracing::warn!(code = e.code, "fair launch reveal step failed");
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, "fair launch reveal query failed"),
    }
}

/// Close (root + attest job) and settle, independent of reveals (review F5: a slow drand
/// never delays the commitment of another launch).
pub async fn housekeeping_pass(st: &AppState) {
    match st.ledger.fl_close_due(st.cfg.cluster).await {
        Ok(n) if n > 0 => tracing::info!("fair launch window closed, commitment queued"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "fair launch close failed"),
    }
    if let Err(e) = st.ledger.fl_settle_ready().await {
        tracing::warn!(error = %e, "fair launch settle failed");
    }
}

pub async fn scheduler_loop(st: AppState) {
    let s2 = st.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(1));
        loop {
            every.tick().await;
            housekeeping_pass(&s2).await;
        }
    });
    let mut every = tokio::time::interval(Duration::from_secs(1));
    loop {
        every.tick().await;
        reveal_pass(&st).await;
    }
}

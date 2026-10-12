//! Unzeen API server (docs/API.md v0.3).
//!
//! Privacy rules enforced here:
//! - no request logging with IPs, paths with parameters, headers or bodies (only the matched
//!   route template and status at DEBUG);
//! - `X-Forwarded-For` / `X-Real-IP` are never read;
//! - rate limits are in memory, keyed by a per-process keyed hash;
//! - signed responses are `Cache-Control: no-store`, no cookies anywhere.

pub mod actions;
pub mod auth;
pub mod config;
pub mod error;
pub mod limit;
pub mod market;
pub mod rate;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, MatchedPath, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Semaphore, broadcast};
use unzeen_ledger::Ledger;

use crate::{
    config::Config,
    error::{ApiError, ApiResult},
    limit::Limiter,
    rate::RateProvider,
};

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub cfg: Config,
    pub ledger: Ledger,
    pub rate: Arc<RateProvider>,
    pub ip_limit: Limiter,
    pub key_limit: Limiter,
    pub feed_tx: broadcast::Sender<Arc<market::FeedMsg>>,
    pub ws_slots: Arc<Semaphore>,
    pub epochs: actions::Epochs,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(cfg: Config, ledger: Ledger) -> Self {
        let l = cfg.limits;
        let (feed_tx, _) = broadcast::channel(1024);
        Self(Arc::new(Inner {
            rate: RateProvider::new(cfg.rate.clone()),
            ip_limit: Limiter::new(l.ip_per_sec, l.ip_burst),
            key_limit: Limiter::new(l.key_per_min / 60.0, l.key_burst),
            ws_slots: Arc::new(Semaphore::new(l.max_ws)),
            epochs: actions::Epochs::new(&cfg.exec),
            feed_tx,
            cfg,
            ledger,
        }))
    }
}

/// 1 MiB covers `create` with a 512 KiB base64 image.
const BODY_LIMIT: usize = 1024 * 1024;

pub fn router(st: AppState) -> Router {
    let mut r = Router::new()
        .route("/api/pool", get(pool))
        .route("/api/portfolio", get(portfolio))
        .route("/api/actions", post(submit_action))
        .route("/api/actions/{id}", get(action_status))
        .route("/api/feed", get(market::feed))
        .route("/api/tokens", get(market::tokens))
        .route("/api/tokens/{mint}", get(market::token))
        .route("/api/tokens/{mint}/trades", get(market::trades))
        .route("/api/tokens/{mint}/candles", get(market::candles))
        .route("/ws/feed", get(market::ws_feed))
        .route("/media/{name}", get(media))
        .fallback(|| async { ApiError::not_found() })
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(st.clone(), guard));
    if !st.cfg.cors_origins.is_empty() {
        use tower_http::cors::{AllowOrigin, CorsLayer};
        let origins: Vec<HeaderValue> = st
            .cfg
            .cors_origins
            .iter()
            .filter_map(|o| HeaderValue::from_str(o).ok())
            .collect();
        r = r.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::HeaderName::from_static("x-unzeen-pubkey"),
                    header::HeaderName::from_static("x-unzeen-nonce"),
                    header::HeaderName::from_static("x-unzeen-ts"),
                    header::HeaderName::from_static("x-unzeen-sig"),
                ])
                .max_age(Duration::from_secs(600)),
        );
    }
    r.with_state(st)
}

/// `GET /media/<sha40>.<ext>`: token images and metadata JSON published by the relayer
/// (`$UNZEEN_HOME/<cluster>/media`, content-addressed). Exact names only: no listing, no
/// path traversal, nothing logged beyond the route template. Public, immutable.
pub fn media_name_ok(name: &str) -> Option<&'static str> {
    let (stem, ext) = name.split_once('.')?;
    if stem.len() != 40 || !stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    match ext {
        "png" => Some("image/png"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "json" => Some("application/json"),
        _ => None,
    }
}

async fn media(State(st): State<AppState>, Path(name): Path<String>) -> Response {
    let Some(mime) = media_name_ok(&name) else {
        return ApiError::not_found().into_response();
    };
    match tokio::fs::read(st.cfg.media_dir.join(&name)).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CONTENT_SECURITY_POLICY, "default-src 'none'; sandbox"),
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => ApiError::not_found().into_response(),
    }
}

/// Per-peer rate limit + DEBUG-level access line without IP, params or headers.
async fn guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    if let Some(ip) = peer
        && let Err(secs) = st.ip_limit.check(&ip)
    {
        return ApiError::rate_limited(secs).into_response();
    }
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or("-", |m| m.as_str())
        .to_string();
    let method = req.method().clone();
    let t = Instant::now();
    let mut res = next.run(req).await;
    res.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    res.headers_mut()
        .insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    tracing::debug!(%method, route, status = res.status().as_u16(), ms = t.elapsed().as_millis() as u64, "req");
    res
}

/// R-core-6: signed responses are padded with a `pad` string to the next multiple of
/// `bucket` bytes, so their size does not tell an observer what happened (an action queued vs
/// executed, how many holdings).
fn padded(mut v: Value, bucket: usize) -> Response {
    let len = serde_json::to_vec(&v).map_or(0, |b| b.len());
    // `,"pad":""` adds 9 bytes (object is never empty here).
    let total = (len + 9).div_ceil(bucket).max(1) * bucket;
    v["pad"] = json!(" ".repeat(total - len - 9));
    no_store(v)
}

fn no_store(v: Value) -> Response {
    let mut r = Json(v).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

// ------------------------------------------------------------------ GET /api/pool

async fn pool(State(st): State<AppState>) -> ApiResult<Response> {
    let address = match &st.cfg.pool_address {
        Some(a) => a.clone(),
        None => {
            if let Some(n) = st.ledger.pool_meta("network").await?
                && n != st.cfg.network
            {
                tracing::error!("pool_meta network differs from UNZEEN_NETWORK; refusing to publish the pool address");
                return Err(ApiError::internal());
            }
            st.ledger.pool_meta("pool_ua").await?.ok_or_else(|| {
                ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "internal",
                    "pool address not published yet (run the scanner `serve`)",
                )
            })?
        }
    };
    let p = &st.cfg.policy;
    let mut r = Json(json!({
        "address": address,
        "network": st.cfg.network,
        "chainId": p.chain.to_hex(),
        "minDepositZat": p.min_deposit_zat.to_string(),
        "minActionZat": p.min_action_zat.to_string(),
        "confirmations": p.confirmations,
        "fees": {
            "createFeeZat": st.cfg.fees.create_fee_zat.to_string(),
            "withdrawZecFeeZat": st.cfg.fees.withdraw_zec_fee_zat.to_string(),
            "withdrawTokenGasLamports": st.cfg.fees.withdraw_token_gas_lamports.to_string(),
            "withdrawTokenCostLamports": st.cfg.fees.withdraw_token_cost_lamports.to_string(),
            "nowFeeZat": st.cfg.fees.now_fee_zat.to_string(),
        },
        "createEnabled": st.cfg.create_enabled,
    }))
    .into_response();
    // Public rate from the timer cache (D14): never triggers a 1Click request.
    if let Ok(rate) = st.rate.get().await {
        let spread = if rate.stale {
            st.cfg.rate.spread_bps.saturating_mul(2)
        } else {
            st.cfg.rate.spread_bps
        };
        let body = r.into_body();
        let bytes = axum::body::to_bytes(body, 64 * 1024)
            .await
            .map_err(|_| ApiError::internal())?;
        let mut v: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::internal())?;
        v["rate"] = json!({
            "lamportsPerZec": rate.lamports_per_zec.to_string(),
            "lamportsPerZecBuy": rate::apply_spread(rate.lamports_per_zec, spread, true).to_string(),
            "lamportsPerZecSell": rate::apply_spread(rate.lamports_per_zec, spread, false).to_string(),
            "spreadBps": spread,
            "source": rate.source,
            "ts": rate.ts_ms,
        });
        r = Json(v).into_response();
    }
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=15"));
    Ok(r)
}

// ------------------------------------------------------------------ GET /api/portfolio

async fn portfolio(State(st): State<AppState>, method: Method, uri: Uri, headers: HeaderMap) -> ApiResult<Response> {
    let a = auth::verify(&st, &method, &uri, &headers, b"", true).await?;
    let b = st.ledger.balance(&a.pubkey).await?;
    let holdings = st.ledger.token_holdings(&a.pubkey).await?;
    let deposits = st.ledger.recent_deposits(&a.pubkey, 20).await?;
    let actions = st.ledger.recent_actions(&a.pubkey, 20).await?;
    let (avail, held, frozen) = b.map_or((0, 0, false), |b| (b.available_zat, b.held_zat, b.frozen));
    let v = json!({
        "zecBalance": avail.to_string(),
        "zecHeld": held.to_string(),
        "frozen": frozen,
        "holdings": holdings.iter().map(|h| json!({
            "mint": h.mint,
            "amount": h.available.to_string(),
            "held": h.held.to_string(),
        })).collect::<Vec<_>>(),
        "claimable": [],
        "deposits": deposits.iter().map(|d| json!({
            "id": hex::encode(d.id),
            "amountZat": d.amount_zat.to_string(),
            "status": d.status,
            "ts": d.ts_ms,
            "publicSource": d.public_source,
        })).collect::<Vec<_>>(),
        "actions": actions.iter().map(|x| {
            let mut o = action_json(&x.view);
            o["id"] = json!(hex::encode(x.id));
            o["kind"] = json!(x.kind);
            o
        }).collect::<Vec<_>>(),
    });
    Ok(padded(v, 4096))
}

// ------------------------------------------------------------------ actions

/// `ActionStatus` (API.md) of an owner view.
fn action_json(v: &unzeen_ledger::ActionView) -> Value {
    let mut out = json!({ "status": v.status });
    if let Some(tx) = &v.solana_tx {
        out["solanaTx"] = json!(tx);
    }
    if let Some(e) = &v.error {
        out["error"] = json!(e);
    }
    if v.rate.is_some() {
        out["rate"] = rate_json(&v.rate);
    }
    if let Some(f) = &v.fill {
        out["fill"] = f.clone();
    }
    out
}

fn rate_json(r: &Option<unzeen_ledger::RateUsed>) -> Value {
    match r {
        Some(r) => json!({
            "lamportsPerZec": r.lamports_per_zec.to_string(),
            "source": r.source,
            "ts": r.ts_ms,
        }),
        None => Value::Null,
    }
}

async fn submit_action(
    State(st): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let a = auth::verify(&st, &method, &uri, &headers, &body, false).await?;
    if !st.cfg.actions_enabled {
        return Err(ApiError::venue_unavailable("actions are disabled on this network"));
    }
    // Parse exactly the bytes that were signed. R-core-6: a top-level `pad` string (size
    // padding by the client) is accepted and ignored.
    let mut raw: Value = serde_json::from_slice(&body).map_err(|_| ApiError::bad_request("invalid action body"))?;
    if let Some(obj) = raw.as_object_mut()
        && let Some(p) = obj.remove("pad")
        && p.as_str().is_none_or(|s| s.len() > 8192)
    {
        return Err(ApiError::bad_request("pad: string up to 8192 bytes"));
    }
    let parsed: actions::SignedAction =
        serde_json::from_value(raw).map_err(|_| ApiError::bad_request("invalid action body"))?;
    let new = actions::build(&st, parsed).await?;
    let request_hash: [u8; 32] = Sha256::digest(&body).into();
    let receipt = st.ledger.submit(&a.pubkey, &a.nonce, &request_hash, &new).await?;
    let mut v = json!({ "id": hex::encode(receipt.id), "status": receipt.status });
    if receipt.rate.is_some() {
        v["rate"] = rate_json(&receipt.rate);
    }
    Ok(padded(v, 1024))
}

async fn action_status(
    State(st): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let a = auth::verify(&st, &method, &uri, &headers, b"", true).await?;
    let id: [u8; 16] = (id.len() == 32 && id.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
        .then(|| hex::decode(&id).ok())
        .flatten()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(ApiError::not_found)?;
    let v = st
        .ledger
        .action_view(&a.pubkey, &id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let out = action_json(&v);
    Ok(padded(out, 1024))
}

// ------------------------------------------------------------------ background tasks

/// Settler (1 s), market poller (1 s), janitor (60 s) and rate refresh (30–60 s). Errors are logged by kind only.
pub fn spawn_background(st: &AppState) {
    let s = st.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            if let Err(e) = s.ledger.settle_ready(50).await {
                tracing::warn!(error = %e, "settlement pass failed");
            }
        }
    });
    let s = st.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Err(e) = s.ledger.purge_api_nonces().await {
                tracing::warn!(error = %e, "nonce purge failed");
            }
            match s.ledger.janitor().await {
                Ok(r) => tracing::debug!(
                    detached = r.detached,
                    scrubbed = r.scrubbed,
                    journal_deleted = r.journal_deleted,
                    payouts_deleted = r.payouts_deleted,
                    "janitor"
                ),
                Err(e) => tracing::warn!(error = %e, "janitor failed"),
            }
        }
    });
    let s = st.clone();
    tokio::spawn(market::poll_trades(s));
    // D14: ZEC/SOL quote on a timer, never on demand.
    tokio::spawn(st.rate.clone().refresh_loop());
}

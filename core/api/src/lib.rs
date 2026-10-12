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
    }))
    .into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=60"));
    Ok(r)
}

// ------------------------------------------------------------------ GET /api/portfolio

async fn portfolio(State(st): State<AppState>, method: Method, uri: Uri, headers: HeaderMap) -> ApiResult<Response> {
    let a = auth::verify(&st, &method, &uri, &headers, b"", true).await?;
    let b = st.ledger.balance(&a.pubkey).await?;
    let holdings = st.ledger.token_holdings(&a.pubkey).await?;
    let deposits = st.ledger.recent_deposits(&a.pubkey, 20).await?;
    let (avail, held, frozen) = b.map_or((0, 0, false), |b| (b.available_zat, b.held_zat, b.frozen));
    Ok(no_store(json!({
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
        })).collect::<Vec<_>>(),
    })))
}

// ------------------------------------------------------------------ actions

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
    // Parse exactly the bytes that were signed.
    let parsed: actions::SignedAction =
        serde_json::from_slice(&body).map_err(|_| ApiError::bad_request("invalid action body"))?;
    let new = actions::build(&st, parsed).await?;
    let request_hash: [u8; 32] = Sha256::digest(&body).into();
    let receipt = st.ledger.submit(&a.pubkey, &a.nonce, &request_hash, &new).await?;
    let mut v = json!({ "id": hex::encode(receipt.id), "status": receipt.status });
    if receipt.rate.is_some() {
        v["rate"] = rate_json(&receipt.rate);
    }
    Ok(no_store(v))
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
    let mut out = json!({ "status": v.status });
    if let Some(tx) = v.solana_tx {
        out["solanaTx"] = json!(tx);
    }
    if let Some(e) = v.error {
        out["error"] = json!(e);
    }
    if v.rate.is_some() {
        out["rate"] = rate_json(&v.rate);
    }
    if let Some(f) = v.fill {
        out["fill"] = f;
    }
    Ok(no_store(out))
}

// ------------------------------------------------------------------ background tasks

/// Settler (1 s), market poller (1 s) and janitor (60 s). Errors are logged by kind only.
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
            if let Err(e) = s.ledger.detach_old_jobs().await {
                tracing::warn!(error = %e, "job detach failed");
            }
        }
    });
    let s = st.clone();
    tokio::spawn(market::poll_trades(s));
}

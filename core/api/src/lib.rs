//! Unzeen API server (docs/API.md v0.5).
//!
//! Privacy rules enforced here:
//! - no request logging with IPs, paths with parameters, headers or bodies (only the matched
//!   route template and status at DEBUG);
//! - `X-Forwarded-For` / `X-Real-IP` are never read;
//! - rate limits are in memory, keyed by a per-process keyed hash;
//! - signed responses are `Cache-Control: no-store`, no cookies anywhere.

pub mod actions;
pub mod auth;
pub mod chat;
pub mod config;
pub mod creator;
pub mod creator_fees;
pub mod error;
pub mod fair;
pub mod intel;
pub mod launch;
pub mod limit;
pub mod market;
pub mod orders;
pub mod rate;
pub mod rates;
pub mod scenarios;
pub mod stats;
pub mod verify;

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
    /// v0.18 `GET /api/rates`: display-only prices from a background timer.
    pub public_rates: Arc<rates::PublicRates>,
    pub ip_limit: Limiter,
    pub key_limit: Limiter,
    pub feed_tx: broadcast::Sender<Arc<market::FeedMsg>>,
    pub ws_slots: Arc<Semaphore>,
    pub epochs: actions::Epochs,
    pub drand: fair::Drand,
    /// `GET /api/verify/proof`: 10/min per key.
    pub verify_limit: Limiter,
    /// Chat ops per key (API v0.12): 1/10 s, 20/h, 100/day.
    pub chat_limit: chat::ChatLimiter,
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
            public_rates: rates::PublicRates::new(&cfg.rate.oneclick_url),
            ip_limit: Limiter::new(l.ip_per_sec, l.ip_burst),
            key_limit: Limiter::new(l.key_per_min / 60.0, l.key_burst),
            ws_slots: Arc::new(Semaphore::new(l.max_ws)),
            epochs: actions::Epochs::new(&cfg.exec),
            drand: fair::Drand::new(cfg.fair.drand_urls.clone()),
            verify_limit: Limiter::new(10.0 / 60.0, 10.0),
            chat_limit: chat::ChatLimiter::default(),
            feed_tx,
            ledger: ledger.with_creator_rules(cfg.launch.rules()),
            cfg,
        }))
    }
}

/// 1 MiB covers `create` with a 512 KiB base64 image.
const BODY_LIMIT: usize = 1024 * 1024;

pub fn router(st: AppState) -> Router {
    let mut r = Router::new()
        .route("/api/pool", get(pool))
        .route("/api/rates", get(rates::rates))
        .route("/api/portfolio", get(portfolio))
        .route("/api/actions", post(submit_action))
        .route("/api/actions/{id}", get(action_status))
        .route("/api/feed", get(market::feed))
        .route("/api/tokens", get(market::tokens))
        .route("/api/tokens/{mint}", get(market::token))
        .route("/api/tokens/{mint}/trades", get(market::trades))
        .route("/api/tokens/{mint}/candles", get(market::candles))
        .route("/api/tokens/{mint}/safety", get(intel::safety))
        .route("/api/tokens/{mint}/chat", get(chat::page))
        .route("/api/verify", get(verify::latest))
        .route("/api/verify/snapshots", get(verify::history))
        .route("/api/verify/proof", get(verify::proof))
        .route("/api/verify/{id}", get(verify::one))
        .route("/api/stats", get(stats::stats))
        .route("/api/creator", get(creator::cabinet))
        .route("/ws/feed", get(market::ws_feed))
        .route("/media/{name}", get(media))
        .fallback(|| async { ApiError::not_found() })
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(st.clone(), guard));
    // F1: fair-launch routes exist only with the flag on; otherwise every method/encoding of
    // /api/launches* answers exactly like an unknown path.
    if st.cfg.fair.enabled {
        r = r.merge(
            Router::new()
                .route("/api/launches", get(fair::list))
                .route("/api/launches/{id}", get(fair::one))
                .layer(DefaultBodyLimit::max(BODY_LIMIT))
                .layer(middleware::from_fn_with_state(st.clone(), guard)),
        );
    }
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
/// Fixed size of `GET /api/portfolio` (API v0.19): 64 KiB.
pub const PORTFOLIO_BYTES: usize = 65_536;

pub(crate) fn padded(mut v: Value, bucket: usize) -> Response {
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
    let mut by_venue = serde_json::Map::new();
    for v in st.cfg.venues.iter().filter(|v| v.as_str() != "jupiter") {
        by_venue.insert(v.clone(), json!(max_initial_buy_for(&st, v).await?.to_string()));
    }
    // v0.17: ZEC-pair creates, per venue with an enabled ZEC pair (ZEC SPL units = zat,
    // stepped down to ZEC_UNITS_STEP like the check in `create`).
    let mut zec_by_venue = serde_json::Map::new();
    let zec_step = actions::ZEC_UNITS_STEP;
    for v in st.cfg.venues.iter() {
        if st.cfg.quotes.for_venue("ZEC", v).is_some() {
            let m = max_initial_buy_zec_units(&st);
            zec_by_venue.insert(v.clone(), json!((m - m % zec_step).to_string()));
        }
    }
    let mut r = Json(json!({
        "address": address,
        "network": st.cfg.network,
        "chainId": p.chain.to_hex(),
        "chain": chain_block(p.chain),
        "minDepositZat": p.min_deposit_zat.to_string(),
        "minActionZat": p.min_action_zat.to_string(),
        "minClaimZat": st.cfg.launch.min_claim_zat.to_string(),
        "confirmations": p.confirmations,
        "fees": {
            "createFeeZat": st.cfg.fees.create_fee_zat.to_string(),
            "withdrawZecFeeZat": st.cfg.fees.withdraw_zec_fee_zat.to_string(),
            "withdrawTokenGasLamports": st.cfg.fees.withdraw_token_gas_lamports.to_string(),
            "withdrawTokenCostLamports": st.cfg.fees.withdraw_token_cost_lamports.to_string(),
            "nowFeeZat": st.cfg.fees.now_fee_zat.to_string(),
        },
        "createEnabled": st.cfg.create_enabled,
        "orders": orders::pool_block(),
        "features": { "fullTrades": st.cfg.intel.full_trades },
        "launchRules": {
            "lockSecs": st.cfg.launch.lock_secs,
            "capBps": st.cfg.launch.cap_bps,
            "maxInitialBuyLamports": max_initial_buy(&st).await?.to_string(),
            "maxInitialBuyLamportsByVenue": by_venue,
            "maxInitialBuyZecUnitsByVenue": zec_by_venue,
        },
    }));
    r.0["venues"] = venues_block(&st);
    // v0.13: enabled non-SOL pairs (venues limited to the enabled ones).
    r.0["quotes"] = Value::Array(
        st.cfg
            .quotes
            .list
            .iter()
            .filter_map(|q| {
                let venues: Vec<&str> = q
                    .venues
                    .iter()
                    .copied()
                    .filter(|v| st.cfg.venues.iter().any(|e| e == v))
                    .collect();
                if venues.is_empty() {
                    return None;
                }
                let mut v = json!({
                    "quote": q.quote, "mint": q.mint, "decimals": q.decimals, "bridged": q.bridged, "venues": venues,
                });
                if q.is_zec() {
                    v["spreadBps"] = json!(st.cfg.quotes.zec_spread_bps);
                }
                Some(v)
            })
            .collect(),
    );
    if st.cfg.intel.discovery {
        r.0["features"]["discovery"] = json!(true);
    }
    // v0.12: absent keys = disabled.
    if st.cfg.chat.enabled {
        r.0["features"]["chat"] = json!(true);
        r.0["chat"] = chat::pool_block(&st);
    }
    if st.cfg.chat.noop {
        r.0["features"]["noop"] = json!(true);
    }
    if st.cfg.scenarios.enabled {
        r.0["features"]["scenarios"] = json!(true);
        r.0["scenarios"] = scenarios::ops::pool_block(&st);
    }
    // Flag off: no "fair" anywhere in the public PoolInfo (absent key = disabled).
    if let Some(fl) = fair::pool_block(&st).await? {
        r.0["features"]["fairLaunch"] = json!(true);
        r.0["fairLaunch"] = fl;
    }
    let mut r = r.into_response();
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

/// Largest `create` initial buy (lamports, after D10 rounding) within the creator cap.
pub fn max_initial_buy_lamports(l: &config::LaunchConfig) -> u128 {
    if l.cap_bps == 0 {
        return 0;
    }
    l.curve().max_lamports_within(l.cap_tokens())
}

/// v0.18 `PoolInfo.chain`: the chain this origin trades on (one origin = one `chainId`).
pub fn chain_block(c: unzeen_protocol::ChainId) -> Value {
    let mut v = json!({
        "id": c.trade.chain(),
        "network": c.trade.network(),
        "mainnet": c.trade.is_mainnet(),
    });
    match c.trade {
        unzeen_protocol::TradeNet::Solana(_) => {
            v["native"] = json!({ "symbol": "SOL", "decimals": 9 });
        }
        unzeen_protocol::TradeNet::Hood(h) => {
            v["native"] = json!({ "symbol": "ETH", "decimals": 18 });
            v["evmChainId"] = json!(h.evm_chain_id());
        }
    }
    v
}

/// v0.16 `PoolInfo.venues`: every enabled venue with what the pool can do there right now.
pub fn venues_block(st: &AppState) -> Value {
    let mainnet = st.cfg.cluster == "mainnet-beta";
    let mut seen = std::collections::HashSet::new();
    Value::Array(
        st.cfg
            .venues
            .iter()
            .map(String::as_str)
            .filter(|v| actions::VENUES.contains(v) && seen.insert(*v))
            .map(|v| {
                let trade = st.cfg.actions_enabled && (mainnet || !actions::mainnet_only(v));
                let create = trade && st.cfg.create_enabled && v != "jupiter";
                let mut quotes: Vec<&str> = Vec::new();
                if create {
                    quotes.push("SOL");
                    for q in &st.cfg.quotes.list {
                        if q.venues.contains(&v) && !quotes.contains(&q.quote) {
                            quotes.push(q.quote);
                        }
                    }
                }
                json!({
                    "venue": v,
                    "trade": trade,
                    "create": create,
                    "quotes": quotes,
                    "atomicFirstBuy": v != "bags",
                    "creatorFees": !matches!(v, "bags" | "jupiter"),
                    "mainnetOnly": actions::mainnet_only(v),
                })
            })
            .collect(),
    )
}

/// Launch curve of `venue` for the creator rules: the network's curve written by the relayer
/// (`launch_curves`, v0.6) or, until then, the pump.fun curve from env. Returns (curve, total
/// supply, own row of this venue).
pub async fn rules_curve(st: &AppState, venue: &str) -> ApiResult<(launch::Curve, u128, bool)> {
    let row = match st.ledger.launch_curve(st.cfg.cluster, venue).await? {
        Some(c) => Some((c, true)),
        None => st
            .ledger
            .launch_curve(st.cfg.cluster, fair::VENUE)
            .await?
            .map(|c| (c, false)),
    };
    Ok(match row {
        Some((c, own)) => (
            launch::Curve {
                virtual_sol: c.virtual_sol,
                virtual_tokens: c.virtual_tokens,
            },
            c.total_supply,
            own,
        ),
        None => (st.cfg.launch.curve(), st.cfg.launch.total_supply, venue == fair::VENUE),
    })
}

/// Meteora DBC without its own curve row: its config is pump.fun-equivalent but charges 1 %
/// instead of ~1.25 %, so 5 % of supply becomes ~5.013 %. Narrow the cap by 5/5.013.
const DBC_CAP_NUM: u128 = 9_974;
const DBC_CAP_DEN: u128 = 10_000;

/// Max initial buy of `create` (native units in D10 steps of the chain: 0.001 SOL / 0.0001 ETH)
/// within the creator cap on `venue`.
pub async fn max_initial_buy_for(st: &AppState, venue: &str) -> ApiResult<u128> {
    let l = &st.cfg.launch;
    if l.cap_bps == 0 {
        return Ok(0);
    }
    let step = u128::from(rate::buy_step(st.cfg.policy.chain.trade));
    let (curve, supply, own) = rules_curve(st, venue).await?;
    let cap = supply.saturating_mul(l.cap_bps as u128) / 10_000;
    let mut x = curve.max_units_within(cap, step);
    if venue == "meteora-dbc" && !own {
        x = unzeen_fair::alloc::mul_div(x, DBC_CAP_NUM, DBC_CAP_DEN).unwrap_or(x);
        x -= x % step;
    }
    Ok(x)
}

/// Max initial buy of a ZEC-pair `create` in ZEC SPL units (= zat) within the creator cap:
/// ZEC curve of pump.fun / LaunchLab (same token reserves, ZEC virtual reserves). Not stepped.
pub fn max_initial_buy_zec_units(st: &AppState) -> u64 {
    let l = &st.cfg.launch;
    if l.cap_bps == 0 {
        return 0;
    }
    let curve = launch::Curve {
        virtual_sol: u128::from(st.cfg.quotes.zec_virtual_units),
        virtual_tokens: l.virtual_token_reserves,
    };
    let cap = l.total_supply.saturating_mul(l.cap_bps as u128) / 10_000;
    u64::try_from(curve.max_lamports_within(cap)).unwrap_or(u64::MAX)
}

/// `PoolInfo.launchRules.maxInitialBuyLamports` (pump.fun, the default launch venue).
pub async fn max_initial_buy(st: &AppState) -> ApiResult<u128> {
    max_initial_buy_for(st, fair::VENUE).await
}

// ------------------------------------------------------------------ GET /api/portfolio

async fn portfolio(State(st): State<AppState>, method: Method, uri: Uri, headers: HeaderMap) -> ApiResult<Response> {
    let a = auth::verify(&st, &method, &uri, &headers, b"", true).await?;
    let b = st.ledger.balance(&a.pubkey).await?;
    let holdings = st.ledger.token_holdings(&a.pubkey).await?;
    let deposits = st.ledger.recent_deposits(&a.pubkey, 20).await?;
    let actions = st.ledger.recent_actions(&a.pubkey, 20).await?;
    let fl = fair::portfolio(&st, &a.pubkey).await?;
    let claimable = st.ledger.claimable(&a.pubkey).await?;
    let own_orders = st.ledger.owner_orders(&a.pubkey).await?;
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
        "orders": own_orders.iter().map(orders::order_json).collect::<Vec<_>>(),
        "claimable": claimable.iter().map(|(m, l, z)| json!({ "mint": m, "solAmount": l.to_string(), "zecAmount": z.to_string() })).collect::<Vec<_>>(),
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
    let mut v = v;
    if let Some((bids, launches)) = fl {
        v["fairBids"] = bids;
        v["fairLaunches"] = launches;
    }
    if st.cfg.scenarios.enabled {
        let own = st.ledger.owner_scenarios(&a.pubkey).await?;
        v["scenarios"] = own.iter().map(scenarios::ops::scenario_json).collect::<Vec<_>>().into();
    }
    // Same size for every key (review-scenarios п. 10): one fixed bucket sized for the largest
    // lists the server returns (5 scenarios × 12 steps, 20 actions with fills, 20 orders, 20
    // deposits, fair-launch bids with proofs, ~50 holdings). Only a key with many more holdings
    // goes to the next multiple.
    Ok(padded(v, PORTFOLIO_BYTES))
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
        // v0.5: the execution minute is stored with the fill (erased with it after 24–48 h)
        // and shown at the top level.
        let mut f = f.clone();
        if let Some(t) = f.as_object_mut().and_then(|o| o.remove("executedAt"))
            && v.status == "executed"
        {
            out["executedAt"] = t;
        }
        out["fill"] = f;
    }
    out
}

fn rate_json(r: &Option<unzeen_ledger::RateUsed>) -> Value {
    match r {
        // v0.13: ZEC SPL pair (1:1 parity): units of ZEC SPL per ZEC, no lamports.
        Some(r) if r.source == "parity" => json!({
            "quote": "ZEC",
            "quotePerZec": r.lamports_per_zec.to_string(),
            "source": r.source,
            "ts": r.ts_ms,
        }),
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
        && p.as_str().is_none_or(|s| s.len() > 16_384)
    {
        // v0.19: up to 16 KiB so a scenario plan pads to a constant size.
        return Err(ApiError::bad_request("pad: string up to 16384 bytes"));
    }
    let request_hash: [u8; 32] = Sha256::digest(&body).into();
    if chat::is_chat_op(&raw) {
        let n = unzeen_ledger::NonceCtx {
            pk: a.pubkey,
            nonce: a.nonce,
            request_hash,
            ts_ms: a.ts_ms,
        };
        return Ok(chat::submit(&st, raw, body.len(), n).await);
    }
    if raw.get("op").and_then(Value::as_str) == Some("claim") {
        let v = creator_fees::claim(&st, raw, &a.pubkey, &a.nonce, &request_hash).await?;
        return Ok(padded(v, 1024));
    }
    if scenarios::ops::is_scenario_op(&raw) {
        // Flag off: exactly what an unknown op gets.
        if !st.cfg.scenarios.enabled {
            return Err(ApiError::bad_request("invalid action body"));
        }
        let v = scenarios::ops::submit(&st, raw, &a.pubkey, &a.nonce, &request_hash).await?;
        return Ok(padded(v, 1024));
    }
    if orders::is_order_op(&raw) {
        let v = orders::submit(&st, raw, &a.pubkey, &a.nonce, &request_hash).await?;
        return Ok(padded(v, 1024));
    }
    if fair::is_fl_op(&raw) {
        // Flag off: exactly what an unknown op gets.
        if !st.cfg.fair.enabled {
            return Err(ApiError::bad_request("invalid action body"));
        }
        let v = fair::submit(&st, raw, &a.pubkey, &a.nonce, &request_hash).await?;
        return Ok(padded(v, 1024));
    }
    let parsed: actions::SignedAction =
        serde_json::from_value(raw).map_err(|_| ApiError::bad_request("invalid action body"))?;
    let new = actions::build(&st, &a.pubkey, parsed).await?;
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
    let mut out = action_json(&v);
    // v0.17: parts of a token withdrawal (sizes, start times, state), owner only. Five parts
    // still fit the 1024-byte bucket.
    let parts = st.ledger.withdraw_parts(&a.pubkey, &id).await?;
    if !parts.is_empty() {
        out["parts"] = parts
            .iter()
            .map(|p| json!({ "amount": p.amount.to_string(), "notBefore": p.not_before_ms, "status": p.status }))
            .collect::<Vec<_>>()
            .into();
    }
    Ok(padded(out, 1024))
}

// ------------------------------------------------------------------ quote stock (v0.13)

/// RELAYER v8 `fund_quote` schedule for lamport-booked quotes (USDC/USD1): a round every
/// 45–90 min (random), vaults in random order, 20–120 s between jobs. Pool level only: the
/// schedule never depends on trades. ZEC SPL stock is refilled after ZEC → ZEC SPL rebalances
/// (scanner), not here.
pub async fn quote_stock_loop(st: AppState) {
    fn uni(lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * ((rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64)
    }
    loop {
        tokio::time::sleep(Duration::from_secs_f64(uni(45.0 * 60.0, 90.0 * 60.0))).await;
        let quotes: Vec<&'static str> = st
            .cfg
            .quotes
            .list
            .iter()
            .filter(|q| !q.is_zec() && q.venues.iter().any(|v| st.cfg.venues.iter().any(|e| e == v)))
            .map(|q| q.mint)
            .collect();
        if quotes.is_empty() {
            continue;
        }
        let mut vaults = match st.ledger.pool_vaults(st.cfg.cluster).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "quote stock round: vault list failed");
                continue;
            }
        };
        for i in (1..vaults.len()).rev() {
            let j = (rand::random::<u64>() % (i as u64 + 1)) as usize;
            vaults.swap(i, j);
        }
        let (mut at, mut queued) = (0.0, 0usize);
        for v in &vaults {
            for q in &quotes {
                at += uni(20.0, 120.0);
                match st.ledger.queue_fund_quote(st.cfg.cluster, v, q, at).await {
                    Ok(Some(_)) => queued += 1,
                    Ok(None) => {}
                    Err(e) => tracing::warn!(error = %e, "fund_quote enqueue failed"),
                }
            }
        }
        tracing::info!(jobs = queued, "quote stock round queued");
    }
}

// ------------------------------------------------------------------ background tasks

/// Settler (1 s), market poller (1 s), janitor (60 s) and rate refresh (30–60 s). Errors are logged by kind only.
pub fn spawn_background(st: &AppState) {
    let s = st.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            // v0.16: Bags first buys wait (`held`) for their launch.
            if let Err(e) = s.ledger.release_held_jobs().await {
                tracing::warn!(error = %e, "held job release failed");
            }
            if let Err(e) = s.ledger.settle_ready(50).await {
                tracing::warn!(error = %e, "settlement pass failed");
            }
            // v0.13: quote stock jobs are pool-internal: just close them.
            if let Err(e) = s.ledger.settle_fund_quotes().await {
                tracing::warn!(error = %e, "fund_quote settlement failed");
            }
            // Fair-launch v2: internal `consolidate` jobs (RELAYER v7).
            match s.ledger.settle_consolidations().await {
                Ok((_, 0)) => {}
                Ok((_, n)) => tracing::warn!(
                    jobs = n,
                    "ALERT: token consolidation to the mint's vault gave up; operator needed"
                ),
                Err(e) => tracing::warn!(error = %e, "consolidation settlement failed"),
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
            if let Err(e) = s.ledger.orders_janitor().await {
                tracing::warn!(error = %e, "orders janitor failed");
            }
            if let Err(e) = s.ledger.scenarios_janitor().await {
                tracing::warn!(error = %e, "scenarios janitor failed");
            }
            if let Err(e) = s.ledger.verify_janitor().await {
                tracing::warn!(error = %e, "verify janitor failed");
            }
            if let Err(e) = s.ledger.fl_janitor().await {
                tracing::warn!(error = %e, "fair-launch janitor failed");
            }
            match s.ledger.janitor().await {
                Ok(r) => tracing::debug!(
                    detached = r.detached,
                    unlocked = r.unlocked,
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
    tokio::spawn(intel::warm_sync_loop(st.clone()));
    if st.cfg.fair.enabled {
        tokio::spawn(fair::scheduler_loop(st.clone()));
    }
    tokio::spawn(verify::scheduler_loop(st.clone()));
    tokio::spawn(verify::attest_loop(st.clone()));
    tokio::spawn(creator_fees::credit_loop(st.clone()));
    tokio::spawn(stats::scheduler_loop(st.clone()));
    tokio::spawn(orders::evaluator_loop(st.clone()));
    tokio::spawn(quote_stock_loop(st.clone()));
    if st.cfg.chat.enabled {
        tokio::spawn(chat::publisher_loop(st.clone()));
        tokio::spawn(chat::janitor_loop(st.clone()));
    }
    // D14: ZEC/SOL quote on a timer, never on demand.
    tokio::spawn(st.rate.clone().refresh_loop());
    tokio::spawn(st.public_rates.clone().refresh_loop());
    if st.cfg.scenarios.enabled {
        tokio::spawn(scenarios::exec::run(st.clone()));
    }
}

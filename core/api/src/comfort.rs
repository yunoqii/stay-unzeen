//! Trading comfort (API v0.28): Pulse, curve progress with an ETA by pace, the token's curve
//! state for impact estimates, and Jupiter quotes for graduated tokens.
//!
//! Privacy: everything here is public chain data, gathered on the indexer's tick and on core's
//! own timers. Pulse is built by a background timer (never by a request) and every client gets
//! the same bytes. `GET /api/quote` asks Jupiter only for a rounded-up amount, shares one cached
//! answer per (mint, side, amount bucket) with everybody for 10 s and logs nothing of it. No
//! list of what a user watches ever reaches the server.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::sync::{RwLock, broadcast, broadcast::error::RecvError};
use unzeen_ledger::curve::{TokenCurve, parse_fee_tiers, parse_token_curve, tier_bps};

use crate::{
    AppState,
    actions::any_address,
    config::JupiterQuoteConfig,
    error::{ApiError, ApiResult},
    intel::{media_url_ok, safety_json},
    market::{client, db},
    rate::now_ms,
};

/// `curve_progress` samples are kept this long (ETA windows are ≤ 1 h).
const SAMPLE_RETENTION_MS: i64 = 3_600_000;
/// Minimum span of the ETA window, ms.
const ETA_MIN_SPAN_MS: i64 = 120_000;
/// An ETA beyond this is not published.
const ETA_MAX_SECS: i64 = 7 * 86_400;
/// Pulse column size.
pub const PULSE_COLUMN: usize = 30;
/// "New": created at most this long ago.
const NEW_MAX_AGE_MS: i64 = 6 * 3_600_000;
/// "Graduated": left the curve at most this long ago.
const GRADUATED_MAX_AGE_MS: i64 = 24 * 3_600_000;
/// Pulse rebuild period.
const PULSE_PERIOD: Duration = Duration::from_secs(3);

// ------------------------------------------------------------------ ETA (pure)

/// Progress "12.34" → hundredths of a percent (0..=10 000).
pub fn progress_x100(s: &str) -> Option<u32> {
    let (i, f) = s.split_once('.').unwrap_or((s, ""));
    // Up to 4 decimals (safety snapshots), truncated to hundredths.
    if i.is_empty() || i.len() > 3 || f.len() > 4 || !i.bytes().chain(f.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let f2 = format!("{:0<2}", &f[..f.len().min(2)]);
    if f.len() > 2 && i == "100" && f.bytes().any(|b| b != b'0') {
        return None;
    }
    let v = i.parse::<u32>().ok()? * 100 + f2.parse::<u32>().ok()?;
    (v <= 10_000).then_some(v)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Eta {
    /// Seconds to 100 % at the window's pace, rounded up to 10 s.
    pub secs: i64,
    /// Pace, hundredths of a percentage point per minute (floor).
    pub rate_x100_per_min: i64,
    pub samples: usize,
}

impl Eta {
    pub fn json(&self) -> Value {
        let r = self.rate_x100_per_min;
        json!({
            "secs": self.secs,
            "ratePctPerMin": format!("{}.{:02}", r / 100, r % 100),
            "samples": self.samples,
        })
    }
}

/// ETA by pace over the last `window_ms` of indexer ticks `(tick_ms, progress_x100)` (any
/// order). Needs ≥ 2 ticks spanning ≥ 120 s, the last tick not older than the window at
/// `now_ms`, and a positive pace; `None` otherwise or beyond 7 days.
pub fn eta(samples: &[(i64, u32)], now_ms: i64, window_ms: i64) -> Option<Eta> {
    let last = samples.iter().max_by_key(|s| s.0)?;
    if last.0 < now_ms - window_ms || last.1 >= 10_000 {
        return None;
    }
    let win: Vec<&(i64, u32)> = samples.iter().filter(|s| s.0 >= last.0 - window_ms).collect();
    let first = win.iter().min_by_key(|s| s.0)?;
    let span = last.0 - first.0;
    let gained = i64::from(last.1) - i64::from(first.1);
    if win.len() < 2 || span < ETA_MIN_SPAN_MS || gained <= 0 {
        return None;
    }
    let left = 10_000 - i64::from(last.1);
    // secs = left · span / gained / 1000, up to 10 s.
    // ms = ceil(left · span / gained); secs = ceil(ms / 10 000) · 10.
    let (num, den) = (i128::from(left) * i128::from(span), i128::from(gained));
    let ms = (num + den - 1) / den;
    let secs = i64::try_from((ms + 9_999) / 10_000 * 10).ok()?;
    if secs > ETA_MAX_SECS {
        return None;
    }
    Some(Eta {
        secs,
        rate_x100_per_min: gained * 60_000 / span,
        samples: win.len(),
    })
}

// ------------------------------------------------------------------ sampler

/// Every 20 s: copy the indexer's newest curve progress into `curve_progress` (one row per
/// mint and tick), note first-seen graduations of mints seen on the curve, drop old rows.
/// Public data only, on core's own timer.
pub async fn progress_loop(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(20));
    loop {
        tick.tick().await;
        if let Err(e) = sample(&st).await {
            tracing::warn!(code = e.code, "curve progress sampling failed");
        }
    }
}

pub async fn sample(st: &AppState) -> ApiResult<()> {
    let c = client(st).await?;
    let now = now_ms() as i64;
    c.execute(
        "INSERT INTO curve_progress (mint, tick_at, progress)
         SELECT mint, tick_at, progress_pct FROM intel_prices
          WHERE status = 'curve' AND progress_pct IS NOT NULL
         UNION ALL
         SELECT d.mint, (extract(epoch FROM d.as_of) * 1000)::bigint, d.progress_pct FROM intel_discovery d
          WHERE d.network = $1 AND d.status = 'curve' AND d.progress_pct IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM intel_prices p WHERE p.mint = d.mint AND p.progress_pct IS NOT NULL)
         ON CONFLICT DO NOTHING",
        &[&st.cfg.cluster],
    )
    .await
    .map_err(db)?;
    // Graduated, and seen on the curve within the retention: the first time we see it.
    c.execute(
        "INSERT INTO curve_graduations (mint, graduated_at)
         SELECT x.mint, date_trunc('minute', now()) FROM (
             SELECT mint FROM intel_prices WHERE status = 'graduated'
             UNION SELECT mint FROM intel_discovery WHERE network = $1 AND status = 'graduated'
             UNION SELECT mint FROM tokens WHERE status = 'graduated') x
         WHERE EXISTS (SELECT 1 FROM curve_progress c WHERE c.mint = x.mint)
         ON CONFLICT DO NOTHING",
        &[&st.cfg.cluster],
    )
    .await
    .map_err(db)?;
    c.execute(
        "DELETE FROM curve_progress WHERE tick_at < $1",
        &[&(now - SAMPLE_RETENTION_MS)],
    )
    .await
    .map_err(db)?;
    c.execute(
        "DELETE FROM curve_graduations WHERE graduated_at < now() - interval '7 days'",
        &[],
    )
    .await
    .map_err(db)?;
    sync_pool_prices(st, &c, now).await?;
    Ok(())
}

/// Solana: `tokens.price_sol` is written by the relayer after the pool's own trades only, so
/// trades by anyone else on the venue left it stale (devnet 18.10–23.10; on mainnet a bot buy
/// between create and the next pool buy makes the UI's 1 % minOut unreachable). Copy the
/// indexer's newer tick price (public chain data, on core's own timer, never per request) into
/// `tokens` when it differs; `market_cap_sol` scales with it (same supply). Only fresh ticks
/// (≤ `TOKEN_CURVE_MAX_AGE_MS`) newer than the last write, same status, SOL pairs only (ZEC
/// pairs are priced by `value_zec_pair`). Robinhood Chain has no indexer: untouched.
pub async fn sync_pool_prices(
    st: &AppState,
    c: &unzeen_ledger::deadpool_postgres::Object,
    now_ms: i64,
) -> ApiResult<u64> {
    if crate::actions::is_hood(st) {
        return Ok(0);
    }
    c.execute(
        "UPDATE tokens t
            SET market_cap_sol = CASE WHEN t.price_sol > 0
                                      THEN round(t.market_cap_sol * p.price_sol / t.price_sol, 9)
                                      ELSE t.market_cap_sol END,
                price_sol = p.price_sol
           FROM intel_prices p
          WHERE p.mint = t.mint AND t.quote_mint IS NULL AND p.status = t.status AND p.price_sol > 0
            AND p.tick_at >= $1
            AND p.tick_at > COALESCE((extract(epoch FROM t.price_at) * 1000)::bigint, 0)
            AND p.price_sol IS DISTINCT FROM t.price_sol",
        &[&(now_ms - unzeen_ledger::curve::TOKEN_CURVE_MAX_AGE_MS)],
    )
    .await
    .map_err(db)
}

// ------------------------------------------------------------------ token extras

/// v0.28 fields of a token: curve progress from the price tick, ETA, the token's curve state.
#[derive(Default, Clone, Debug)]
pub struct Extras {
    pub progress: Option<String>,
    pub eta: Option<Eta>,
    pub curve: Option<Value>,
}

impl Extras {
    /// Put the fields into a `Token` JSON object (only for tokens on the curve).
    pub fn apply(&self, v: &mut Value) {
        if v["status"] != "curve" {
            return;
        }
        if let Some(p) = &self.progress {
            v["curveProgressPct"] = json!(p);
        }
        if let Some(e) = &self.eta {
            v["eta"] = e.json();
        }
        if let Some(c) = &self.curve {
            v["curve"] = c.clone();
        }
    }
}

/// ETA of each mint from `curve_progress`.
pub async fn etas(
    c: &unzeen_ledger::deadpool_postgres::Object,
    mints: &[String],
    window_secs: u32,
) -> ApiResult<HashMap<String, Eta>> {
    if mints.is_empty() {
        return Ok(HashMap::new());
    }
    let now = now_ms() as i64;
    let window = i64::from(window_secs) * 1000;
    let rows = c
        .query(
            "SELECT mint, tick_at, trim_scale(progress)::text FROM curve_progress
              WHERE mint = ANY($1) AND tick_at >= $2 ORDER BY mint, tick_at",
            &[&mints, &(now - 2 * window)],
        )
        .await
        .map_err(db)?;
    let mut by: HashMap<String, Vec<(i64, u32)>> = HashMap::new();
    for r in &rows {
        if let Some(p) = progress_x100(&r.get::<_, String>(2)) {
            by.entry(r.get(0)).or_default().push((r.get(1), p));
        }
    }
    Ok(by
        .into_iter()
        .filter_map(|(m, s)| eta(&s, now, window).map(|e| (m, e)))
        .collect())
}

/// Extras for a set of mints (pool tokens / indexer cards): progress and curve state from a
/// fresh price tick, ETA from the sampled history. pump.fun curve fees: the FeeConfig tier
/// (`launch_curves.fee_tiers`), else the configured fee — the same as core's estimates.
pub async fn extras(st: &AppState, mints: &[String]) -> ApiResult<HashMap<String, Extras>> {
    let mut out: HashMap<String, Extras> = HashMap::new();
    if mints.is_empty() || crate::actions::is_hood(st) {
        return Ok(out);
    }
    let c = client(st).await?;
    let now = now_ms() as i64;
    let rows = c
        .query(
            "SELECT p.mint, trim_scale(p.progress_pct)::text, p.curve, p.tick_at,
                    EXISTS (SELECT 1 FROM tokens t WHERE t.mint = p.mint AND t.quote_mint IS NOT NULL)
               FROM intel_prices p WHERE p.mint = ANY($1) AND p.status = 'curve'",
            &[&mints],
        )
        .await
        .map_err(db)?;
    let tiers_row = c
        .query_opt(
            "SELECT fee_tiers, token_total_supply FROM launch_curves WHERE network = $1 AND venue = 'pumpfun'",
            &[&st.cfg.cluster],
        )
        .await
        .map_err(db)?;
    let tiers = tiers_row
        .as_ref()
        .and_then(|r| r.get::<_, Option<Value>>(0))
        .and_then(|v| parse_fee_tiers(&v));
    let supply = tiers_row
        .as_ref()
        .and_then(|r| r.get::<_, Option<unzeen_ledger::Num>>(1))
        .and_then(|n| n.to_u128().ok())
        .unwrap_or(0);
    let pump_fee = crate::actions::trade_fee_bps(st, "pumpfun");
    for r in &rows {
        let e = out.entry(r.get(0)).or_default();
        e.progress = r.get::<_, Option<String>>(1).filter(|p| progress_x100(p).is_some());
        let tick: i64 = r.get(3);
        let pair: bool = r.get(4);
        if pair || tick < now - unzeen_ledger::curve::TOKEN_CURVE_MAX_AGE_MS {
            continue;
        }
        if let Some(mut tc) = r.get::<_, Option<Value>>(2).as_ref().and_then(parse_token_curve) {
            resolve_pump_fee(&mut tc, tiers.as_deref(), supply, pump_fee);
            e.curve = Some(tc.to_json(tick));
        }
    }
    for (m, eta) in etas(&c, mints, st.cfg.comfort.eta_window_secs).await? {
        out.entry(m).or_default().eta = Some(eta);
    }
    Ok(out)
}

/// pump.fun curve states carry no fee: the tier of their market cap (as core's estimates).
pub fn resolve_pump_fee(
    tc: &mut TokenCurve,
    tiers: Option<&[unzeen_ledger::curve::FeeTier]>,
    supply: u128,
    fallback: u32,
) {
    if tc.fee_bps.is_none() {
        let cap = unzeen_fair::alloc::mul_div(tc.virtual_sol, supply, tc.virtual_tokens).unwrap_or(0);
        tc.fee_bps = Some(tiers.and_then(|t| tier_bps(t, cap)).unwrap_or(fallback));
    }
}

// ------------------------------------------------------------------ Pulse

pub struct PulseCache {
    body: RwLock<Option<Arc<str>>>,
    pub tx: broadcast::Sender<Arc<str>>,
}

impl Default for PulseCache {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            body: RwLock::new(None),
            tx,
        }
    }
}

impl PulseCache {
    pub async fn get(&self) -> Option<Arc<str>> {
        self.body.read().await.clone()
    }
    /// Store a new body; broadcast it only when it changed.
    pub async fn put(&self, s: String) {
        let mut b = self.body.write().await;
        if b.as_deref() == Some(s.as_str()) {
            return;
        }
        let a: Arc<str> = Arc::from(s);
        *b = Some(a.clone());
        let _ = self.tx.send(a);
    }
}

/// Rebuild Pulse every 3 s (own timer).
pub async fn pulse_loop(st: AppState) {
    let mut tick = tokio::time::interval(PULSE_PERIOD);
    loop {
        tick.tick().await;
        match build_pulse(&st).await {
            Ok(v) => st.pulse.put(v.to_string()).await,
            Err(e) => tracing::warn!(code = e.code, "pulse build failed"),
        }
    }
}

/// One candidate row of Pulse.
#[derive(Clone, Debug)]
pub struct PulseRow {
    pub card: Value,
    pub status: String,
    pub progress: Option<u32>,
    pub created_ms: i64,
    pub graduated_ms: Option<i64>,
    pub as_of: i64,
}

/// Column of a row at `now` (None: not in Pulse).
pub fn column(r: &PulseRow, now: i64, graduating_x100: u32) -> Option<&'static str> {
    if r.status == "graduated" {
        let at = r.graduated_ms.unwrap_or(r.created_ms);
        return (at >= now - GRADUATED_MAX_AGE_MS).then_some("graduated");
    }
    if r.progress.is_some_and(|p| p >= graduating_x100) {
        return Some("graduating");
    }
    (r.created_ms >= now - NEW_MAX_AGE_MS).then_some("new")
}

/// Sort and cut the three columns.
pub fn columns(rows: Vec<PulseRow>, now: i64, graduating_pct: u32) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let thr = graduating_pct * 100;
    let (mut n, mut g, mut d) = (Vec::new(), Vec::new(), Vec::new());
    for r in rows {
        match column(&r, now, thr) {
            Some("new") => n.push(r),
            Some("graduating") => g.push(r),
            Some("graduated") => d.push(r),
            _ => {}
        }
    }
    n.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    g.sort_by(|a, b| b.progress.cmp(&a.progress).then(b.created_ms.cmp(&a.created_ms)));
    d.sort_by(|a, b| {
        b.graduated_ms
            .unwrap_or(b.created_ms)
            .cmp(&a.graduated_ms.unwrap_or(a.created_ms))
    });
    let cut = |v: Vec<PulseRow>| v.into_iter().take(PULSE_COLUMN).map(|r| r.card).collect::<Vec<_>>();
    (cut(n), cut(g), cut(d))
}

const PULSE_COLS: &str = "mint, symbol, name, image, venue, status, decimals, price, cap, created_ms,
     quote_mint, progress, as_of, pool, launch, safety, safety_as_of";

pub async fn build_pulse(st: &AppState) -> ApiResult<Value> {
    let c = client(st).await?;
    let mut sql = format!(
        "SELECT {PULSE_COLS} FROM (
           SELECT t.mint, t.symbol, t.name, t.image, t.venue,
                  CASE WHEN t.status = 'graduated' OR p.status = 'graduated' THEN 'graduated' ELSE 'curve' END AS status,
                  t.decimals, trim_scale(t.price_sol)::text AS price, trim_scale(t.market_cap_sol)::text AS cap,
                  (extract(epoch FROM t.created_at) * 1000)::bigint AS created_ms, t.quote_mint,
                  COALESCE(trim_scale(p.progress_pct)::text, s.data->'market'->>'curveProgressPct') AS progress,
                  COALESCE(p.tick_at, (extract(epoch FROM s.as_of) * 1000)::bigint,
                           (extract(epoch FROM t.price_at) * 1000)::bigint, 0) AS as_of,
                  true AS pool,
                  EXISTS (SELECT 1 FROM trades x WHERE x.mint = t.mint AND x.kind = 'create') AS launch,
                  s.data AS safety, (extract(epoch FROM s.as_of) * 1000)::bigint AS safety_as_of
             FROM tokens t
             LEFT JOIN intel_prices p ON p.mint = t.mint
             LEFT JOIN token_safety s ON s.mint = t.mint AND NOT s.missing
            ORDER BY t.created_at DESC LIMIT 500) a"
    );
    if st.cfg.intel.discovery {
        sql.push_str(&format!(
            " UNION ALL SELECT {PULSE_COLS} FROM (
               SELECT d.mint, COALESCE(d.symbol, '') AS symbol, COALESCE(d.name, '') AS name,
                      COALESCE(it.image, s.data->>'image') AS image, d.venue, d.status,
                      COALESCE(it.decimals, 6::smallint) AS decimals,
                      trim_scale(d.price_sol)::text AS price, trim_scale(d.market_cap_sol)::text AS cap,
                      (extract(epoch FROM d.created_at) * 1000)::bigint AS created_ms, NULL::text AS quote_mint,
                      CASE WHEN d.status = 'curve' THEN trim_scale(d.progress_pct)::text END AS progress,
                      (extract(epoch FROM d.as_of) * 1000)::bigint AS as_of, false AS pool,
                      EXISTS (SELECT 1 FROM trades x WHERE x.mint = d.mint AND x.kind = 'create') AS launch,
                      s.data AS safety, (extract(epoch FROM s.as_of) * 1000)::bigint AS safety_as_of
                 FROM intel_discovery d
                 LEFT JOIN intel_tokens it ON it.mint = d.mint
                 LEFT JOIN token_safety s ON s.mint = d.mint AND NOT s.missing
                WHERE d.network = $1 AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.mint = d.mint)
                ORDER BY d.created_at DESC LIMIT 2000) b"
        ));
    }
    let rows = if st.cfg.intel.discovery {
        c.query(&sql, &[&st.cfg.cluster]).await
    } else {
        c.query(&sql, &[]).await
    }
    .map_err(db)?;
    let mints: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
    let grads: HashMap<String, i64> = c
        .query(
            "SELECT mint, (extract(epoch FROM graduated_at) * 1000)::bigint FROM curve_graduations WHERE mint = ANY($1)",
            &[&mints],
        )
        .await
        .map_err(db)?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let etas = etas(&c, &mints, st.cfg.comfort.eta_window_secs).await?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(rows.len());
    let mut as_of_max = 0i64;
    for r in &rows {
        let mint: String = r.get(0);
        if !seen.insert(mint.clone()) {
            continue;
        }
        let status: String = r.get(5);
        let progress = r
            .get::<_, Option<String>>(11)
            .filter(|_| status == "curve")
            .and_then(|p| progress_x100(&p).map(|x| (p, x)));
        let created_ms: i64 = r.get(9);
        let as_of: i64 = r.get(12);
        as_of_max = as_of_max.max(as_of);
        let mut card = json!({
            "mint": mint,
            "symbol": r.get::<_, String>(1),
            "name": r.get::<_, String>(2),
            "venue": r.get::<_, String>(4),
            "status": status,
            "decimals": r.get::<_, i16>(6),
            "priceSol": r.get::<_, String>(7),
            "marketCapSol": r.get::<_, String>(8),
            "createdAt": created_ms,
            "holders": Value::Null,
            "unzeenLaunch": r.get::<_, bool>(14),
            "pool": r.get::<_, bool>(13),
            "asOf": as_of,
        });
        // Pool tokens: the relayer's own URL (as in GET /api/tokens); indexer data: our media only.
        let pool: bool = r.get(13);
        if let Some(img) = r.get::<_, Option<String>>(3).filter(|s| pool || media_url_ok(s)) {
            card["image"] = json!(img);
        }
        card["quote"] = json!(quote_of(r.get::<_, Option<String>>(10).as_deref()));
        if let Some((p, _)) = &progress {
            card["curveProgressPct"] = json!(p);
            if let Some(e) = etas.get(&mint) {
                card["eta"] = e.json();
            }
        }
        let graduated_ms = grads.get(&mint).copied().filter(|_| status == "graduated");
        if let Some(g) = graduated_ms {
            card["graduatedAt"] = json!(g);
        }
        if let (Some(d), Some(at)) = (r.get::<_, Option<Value>>(15), r.get::<_, Option<i64>>(16)) {
            if let Some(n) = d.get("holders").and_then(|h| h.get("count")).and_then(Value::as_u64) {
                card["holders"] = json!(n);
            }
            if let Some(s) = safety_json(&mint, at, &d, None) {
                let mut f = json!({
                    "mintRevoked": s["authorities"]["mintRevoked"],
                    "freezeRevoked": s["authorities"]["freezeRevoked"],
                    "riskyExtensions": s["authorities"]["riskyExtensions"],
                    "asOf": s["asOf"],
                });
                if let Some(t) = s.get("holders").and_then(|h| h.get("top10Pct")) {
                    f["top10Pct"] = t.clone();
                }
                card["safety"] = f;
            }
        }
        out.push(PulseRow {
            card,
            status,
            progress: progress.map(|(_, x)| x),
            created_ms,
            graduated_ms,
            as_of,
        });
    }
    let now = now_ms() as i64;
    let (new, graduating, graduated) = columns(out, now, st.cfg.comfort.graduating_pct);
    Ok(json!({
        "asOf": as_of_max,
        "graduatingPct": st.cfg.comfort.graduating_pct,
        "etaWindowSecs": st.cfg.comfort.eta_window_secs,
        "new": new,
        "graduating": graduating,
        "graduated": graduated,
    }))
}

fn quote_of(quote_mint: Option<&str>) -> &'static str {
    match quote_mint {
        None => "SOL",
        Some(m) => crate::config::known_quotes(true)
            .into_iter()
            .chain(crate::config::known_quotes(false))
            .find(|q| q.mint == m)
            .map_or("SOL", |q| q.quote),
    }
}

/// `GET /api/pulse`: the cached body (same bytes for everyone).
pub async fn pulse(State(st): State<AppState>) -> ApiResult<Response> {
    let body = match st.pulse.get().await {
        Some(b) => b,
        None => {
            // First request before the timer's first build: build once and keep it.
            let v = build_pulse(&st).await?;
            st.pulse.put(v.to_string()).await;
            st.pulse.get().await.ok_or_else(ApiError::internal)?
        }
    };
    let mut r = (
        [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        body.to_string(),
    )
        .into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3"));
    Ok(r)
}

/// `/ws/pulse`: the whole Pulse on connect and on every change. Client messages are ignored.
pub async fn ws_pulse(State(st): State<AppState>, ws: WebSocketUpgrade) -> ApiResult<Response> {
    let permit = st
        .ws_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::rate_limited(10))?;
    let rx = st.pulse.tx.subscribe();
    let first = st.pulse.get().await;
    Ok(ws.max_message_size(4 * 1024).on_upgrade(move |sock| async move {
        ws_loop(sock, rx, first).await;
        drop(permit);
    }))
}

async fn ws_loop(mut sock: WebSocket, mut rx: broadcast::Receiver<Arc<str>>, first: Option<Arc<str>>) {
    if let Some(f) = first
        && sock.send(Message::Text(f.to_string().into())).await.is_err()
    {
        return;
    }
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Ok(m) => {
                    if sock.send(Message::Text(m.to_string().into())).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return,
            },
            incoming = sock.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if sock.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
        }
    }
}

// ------------------------------------------------------------------ Jupiter quotes

const WSOL: &str = "So11111111111111111111111111111111111111112";
const QUOTE_MAX_BODY: usize = 256 * 1024;
/// Response cache of `GET /api/quote` (the answer only changes when the grid does).
const QUOTE_CACHE_SECS: u32 = 10;

/// The fixed grid (lamports, log-spaced 0.01 .. 25 SOL): buys spend these, sells sell the
/// tokens worth these at the public spot price. Same grid for every token, every round.
pub const QUOTE_GRID_LAMPORTS: [u64; 6] = [
    10_000_000,
    50_000_000,
    250_000_000,
    1_000_000_000,
    5_000_000_000,
    25_000_000_000,
];

/// The fields of a Jupiter `/quote` answer we keep; `None` if malformed.
pub fn parse_jupiter(body: &Value) -> Option<(String, String, Vec<String>)> {
    let out = body.get("outAmount")?.as_str()?;
    if out.is_empty() || out.len() > 39 || !out.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let out = out.trim_start_matches('0');
    let out = if out.is_empty() {
        "0".to_string()
    } else {
        out.to_string()
    };
    let impact: f64 = body
        .get("priceImpactPct")
        .and_then(|v| {
            v.as_str()
                .map(str::to_string)
                .or_else(|| v.as_f64().map(|f| f.to_string()))
        })
        .and_then(|s| s.parse().ok())
        .filter(|f: &f64| f.is_finite())?;
    // Jupiter gives a ratio (0.0123 = 1.23 %).
    let pct = format!("{:.4}", (impact.abs() * 100.0).min(100.0));
    let mut route: Vec<String> = Vec::new();
    for leg in body.get("routePlan").and_then(Value::as_array).into_iter().flatten() {
        if let Some(l) = leg
            .get("swapInfo")
            .and_then(|s| s.get("label"))
            .and_then(Value::as_str)
            .map(|l| {
                l.chars()
                    .filter(|c| c.is_ascii_alphanumeric() || " .-_".contains(*c))
                    .take(32)
                    .collect::<String>()
            })
            .filter(|l| !l.is_empty())
            && !route.contains(&l)
            && route.len() < 4
        {
            route.push(l);
        }
    }
    Some((out, pct, route))
}

/// One quoted grid point.
#[derive(Clone, Debug, PartialEq)]
pub struct GridPoint {
    /// Input: lamports (buy) or token base units (sell).
    pub input: u128,
    pub output: u128,
    /// Impact, % with 4 decimals as a string from Jupiter, parsed.
    pub impact_pct: f64,
    pub route: Vec<String>,
    /// unix ms of the quote.
    pub at: i64,
}

/// Quote for `amount` from a grid (any order): proportional below the first point (the
/// chord from 0 lies under a concave curve: conservative), linear between neighbours (the
/// chord again), the impact of the upper neighbour. `None` above the last point or without
/// points. Returns (output, impact %, route, oldest quote time used).
pub fn interpolate(points: &[GridPoint], amount: u128) -> Option<(u128, f64, Vec<String>, i64)> {
    let mut p: Vec<&GridPoint> = points.iter().filter(|x| x.input > 0).collect();
    p.sort_by_key(|x| x.input);
    let last = p.last()?;
    if amount == 0 || amount > last.input {
        return None;
    }
    let i = p.iter().position(|x| x.input >= amount)?;
    let b = p[i];
    if i == 0 {
        let out = unzeen_fair::alloc::mul_div(b.output, amount, b.input)?;
        return Some((out, b.impact_pct, b.route.clone(), b.at));
    }
    let a = p[i - 1];
    let span = b.input - a.input;
    let out = if b.output >= a.output {
        a.output + unzeen_fair::alloc::mul_div(b.output - a.output, amount - a.input, span)?
    } else {
        // Malformed grid (more in, less out): the smaller of the two.
        b.output
    };
    Some((out, b.impact_pct, b.route.clone(), a.at.min(b.at)))
}

/// Tokens worth `lamports` at spot `price_e18` (SOL per whole token × 1e18).
pub fn tokens_for_lamports(lamports: u64, price_e18: u128, decimals: u32) -> Option<u128> {
    if price_e18 == 0 {
        return None;
    }
    unzeen_fair::alloc::mul_div(u128::from(lamports), 10u128.checked_pow(decimals + 9)?, price_e18)
        .filter(|t| *t > 0 && *t <= u128::from(u64::MAX))
}

#[derive(Default)]
struct Grids {
    /// (mint, buy) → points by grid slot.
    points: HashMap<(String, bool), [Option<GridPoint>; QUOTE_GRID_LAMPORTS.len()]>,
}

pub struct QuoteService {
    cfg: JupiterQuoteConfig,
    http: reqwest::Client,
    grids: Mutex<Grids>,
}

impl QuoteService {
    pub fn new(cfg: JupiterQuoteConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("unzeen")
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client");
        Self {
            cfg,
            http,
            grids: Mutex::new(Grids::default()),
        }
    }

    /// Points older than two rounds (+ slack) are not served.
    fn max_age_ms(&self) -> i64 {
        i64::from(self.cfg.round_secs) * 2_400
    }

    fn put(&self, mint: &str, buy: bool, slot: usize, p: GridPoint) {
        let mut g = self.grids.lock().unwrap_or_else(|e| e.into_inner());
        g.points.entry((mint.to_string(), buy)).or_default()[slot] = Some(p);
    }

    /// Forget mints that left the candidate set and stale points.
    fn prune(&self, keep: &std::collections::HashSet<String>, now: i64) {
        let max = self.max_age_ms();
        let mut g = self.grids.lock().unwrap_or_else(|e| e.into_inner());
        g.points.retain(|(m, _), slots| {
            for s in slots.iter_mut() {
                if s.as_ref().is_some_and(|p| p.at < now - max) {
                    *s = None;
                }
            }
            keep.contains(m) && slots.iter().any(Option::is_some)
        });
    }

    /// Fresh points of (mint, side).
    pub fn points(&self, mint: &str, buy: bool, now: i64) -> Vec<GridPoint> {
        let max = self.max_age_ms();
        let g = self.grids.lock().unwrap_or_else(|e| e.into_inner());
        g.points
            .get(&(mint.to_string(), buy))
            .map(|s| s.iter().flatten().filter(|p| p.at >= now - max).cloned().collect())
            .unwrap_or_default()
    }

    /// One upstream quote. Nothing of the request or the answer is logged.
    async fn fetch(&self, mint: &str, buy: bool, amount: u128) -> Option<GridPoint> {
        let (input, output) = if buy { (WSOL, mint) } else { (mint, WSOL) };
        let url = format!(
            "{}/quote?inputMint={input}&outputMint={output}&amount={amount}&slippageBps=50&restrictIntermediateTokens=true",
            self.cfg.url.trim_end_matches('/')
        );
        let mut rq = self.http.get(url);
        if let Some(key) = &self.cfg.api_key {
            rq = rq.header("x-api-key", key);
        }
        let resp = rq.send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let bytes = resp.bytes().await.ok()?;
        if bytes.len() > QUOTE_MAX_BODY {
            return None;
        }
        let body: Value = serde_json::from_slice(&bytes).ok()?;
        let (out, impact, route) = parse_jupiter(&body)?;
        Some(GridPoint {
            input: amount,
            output: out.parse().ok()?,
            impact_pct: impact.parse().ok()?,
            route,
            at: now_ms() as i64,
        })
    }
}

/// Graduated tokens the pool trades or shows (pool tokens, then Pulse's graduated discovery
/// tokens), SOL pairs with a public price: (mint, price, decimals).
async fn quote_candidates(st: &AppState, max: i64) -> ApiResult<Vec<(String, String, i16)>> {
    let c = client(st).await?;
    let rows = c
        .query(
            "SELECT mint, price, dec FROM (
               SELECT t.mint, trim_scale(t.price_sol)::text AS price, t.decimals AS dec, 0 AS k, t.created_at AS at
                 FROM tokens t
                WHERE t.quote_mint IS NULL AND t.price_sol > 0
                  AND (t.status = 'graduated' OR t.venue = 'jupiter'
                       OR EXISTS (SELECT 1 FROM intel_prices p WHERE p.mint = t.mint AND p.status = 'graduated'))
               UNION ALL
               SELECT d.mint, trim_scale(d.price_sol)::text, COALESCE(it.decimals, 6::smallint), 1, d.created_at
                 FROM intel_discovery d LEFT JOIN intel_tokens it ON it.mint = d.mint
                WHERE d.network = $1 AND d.status = 'graduated' AND d.price_sol > 0
                  AND d.created_at > now() - interval '24 hours'
                  AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.mint = d.mint)) x
             ORDER BY k, at DESC LIMIT $2",
            &[&st.cfg.cluster, &max],
        )
        .await
        .map_err(db)?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect())
}

/// One round: every candidate × both sides × the whole grid, in random order, one request
/// every `spacing` (± 30 %). The work depends only on the candidate set and the grid, never
/// on a user request.
pub async fn quote_round(st: &AppState, svc: &QuoteService, spacing: Duration) -> ApiResult<usize> {
    let cands = quote_candidates(st, i64::from(svc.cfg.max_mints)).await?;
    let mut tasks: Vec<(String, bool, usize, u128)> = Vec::new();
    for (mint, price, dec) in &cands {
        let p18 = crate::config::eth_to_wei(price).unwrap_or(0);
        for (slot, l) in QUOTE_GRID_LAMPORTS.iter().enumerate() {
            tasks.push((mint.clone(), true, slot, u128::from(*l)));
            if let Some(t) = tokens_for_lamports(*l, p18, u32::try_from(*dec).unwrap_or(6)) {
                tasks.push((mint.clone(), false, slot, t));
            }
        }
    }
    {
        use rand::seq::SliceRandom;
        tasks.shuffle(&mut rand::rng());
    }
    let mut ok = 0;
    for (mint, buy, slot, amount) in tasks {
        if let Some(p) = svc.fetch(&mint, buy, amount).await {
            svc.put(&mint, buy, slot, p);
            ok += 1;
        }
        if !spacing.is_zero() {
            let j = 0.7 + rand::random::<f64>() * 0.6;
            tokio::time::sleep(spacing.mul_f64(j)).await;
        }
    }
    let keep = cands.into_iter().map(|c| c.0).collect();
    svc.prune(&keep, now_ms() as i64);
    Ok(ok)
}

/// Background quoting (mainnet): a round every `round_secs` (± 20 %), requests spread over
/// the round and never faster than `rps`.
pub async fn quote_loop(st: AppState, svc: Arc<QuoteService>) {
    loop {
        let n = quote_candidates(&st, i64::from(svc.cfg.max_mints))
            .await
            .map_or(0, |c| c.len())
            * QUOTE_GRID_LAMPORTS.len()
            * 2;
        let round = f64::from(svc.cfg.round_secs);
        let spacing = Duration::from_secs_f64((round * 0.8 / n.max(1) as f64).max(1.0 / svc.cfg.rps));
        let t = Instant::now();
        if let Err(e) = quote_round(&st, &svc, spacing).await {
            tracing::warn!(code = e.code, "quote round failed");
        }
        let wait = round * (0.8 + rand::random::<f64>() * 0.4);
        let left = (wait - t.elapsed().as_secs_f64()).max(10.0);
        tokio::time::sleep(Duration::from_secs_f64(left)).await;
    }
}

/// `GET /api/quote?mint=&side=buy|sell&amount=` (mainnet, `features.quote`): answered only
/// from the background grid; no upstream request is ever made for it.
pub async fn quote(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Response> {
    let Some(svc) = st.quotes.as_ref() else {
        return Err(ApiError::not_found());
    };
    if q.keys().any(|k| !["mint", "side", "amount"].contains(&k.as_str())) {
        return Err(ApiError::bad_request("query: mint, side, amount"));
    }
    let mint = any_address(q.get("mint").ok_or_else(|| ApiError::bad_request("mint"))?, "mint")?;
    let buy = match q.get("side").map(String::as_str) {
        Some("buy") => true,
        Some("sell") => false,
        _ => return Err(ApiError::bad_request("side: buy | sell")),
    };
    let amount: u64 = q
        .get("amount")
        .filter(|a| !a.is_empty() && a.len() <= 20 && a.bytes().all(|b| b.is_ascii_digit()) && !a.starts_with('0'))
        .and_then(|a| a.parse().ok())
        .ok_or_else(|| ApiError::bad_request("amount: integer > 0, ≤ u64"))?;
    let points = svc.points(&mint, buy, now_ms() as i64);
    let max = points.iter().map(|p| p.input).max();
    let Some((out, impact, route, at)) = interpolate(&points, u128::from(amount)) else {
        return Err(ApiError::not_found());
    };
    let v = json!({
        "mint": mint,
        "side": if buy { "buy" } else { "sell" },
        "inAmount": amount.to_string(),
        "outAmount": out.to_string(),
        "priceImpactPct": format!("{impact:.4}"),
        "route": route,
        "maxAmount": max.unwrap_or(0).to_string(),
        "asOf": at,
    });
    Ok(crate::market::public(v, QUOTE_CACHE_SECS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_parse() {
        assert_eq!(progress_x100("12.34"), Some(1_234));
        assert_eq!(progress_x100("12.3"), Some(1_230));
        assert_eq!(progress_x100("100"), Some(10_000));
        assert_eq!(progress_x100("0.00"), Some(0));
        assert_eq!(progress_x100("41.2345"), Some(4_123));
        for bad in ["", "100.01", "100.0001", "1000", "1.23456", "-1", "a.b", ".5"] {
            assert_eq!(progress_x100(bad), None, "{bad}");
        }
    }

    #[test]
    fn eta_by_pace() {
        let now = 10_000_000;
        // 60 % → 70 % in 5 min: 2 pp/min, 30 pp left → 15 min.
        let s = [(now - 300_000, 6_000), (now - 150_000, 6_500), (now, 7_000)];
        let e = eta(&s, now, 600_000).unwrap();
        assert_eq!(e.secs, 900);
        assert_eq!(e.rate_x100_per_min, 200);
        assert_eq!(e.samples, 3);
        assert_eq!(e.json(), json!({"secs": 900, "ratePctPerMin": "2.00", "samples": 3}));
        // order does not matter; samples outside the window are ignored
        let mut s2 = vec![(now - 3_600_000, 0)];
        s2.extend(s.iter().rev());
        assert_eq!(eta(&s2, now, 600_000), Some(e));
        // rounded up to 10 s
        let e = eta(&[(now - 120_000, 9_000), (now, 9_001)], now, 600_000).unwrap();
        assert_eq!(e.secs % 10, 0);
        assert!(e.secs >= 999 * 120);
    }

    #[test]
    fn eta_none() {
        let now = 10_000_000;
        assert_eq!(eta(&[], now, 600_000), None);
        assert_eq!(eta(&[(now, 5_000)], now, 600_000), None, "one tick");
        assert_eq!(
            eta(&[(now - 60_000, 5_000), (now, 5_100)], now, 600_000),
            None,
            "span < 120 s"
        );
        assert_eq!(eta(&[(now - 300_000, 5_000), (now, 5_000)], now, 600_000), None, "flat");
        assert_eq!(
            eta(&[(now - 300_000, 5_100), (now, 5_000)], now, 600_000),
            None,
            "falling"
        );
        assert_eq!(
            eta(&[(now - 300_000, 9_000), (now, 10_000)], now, 600_000),
            None,
            "complete"
        );
        let old = now - 700_000;
        assert_eq!(
            eta(&[(old - 300_000, 5_000), (old, 6_000)], now, 600_000),
            None,
            "stale"
        );
        // 0.01 pp in 10 min → years: not published
        assert_eq!(eta(&[(now - 600_000, 1_000), (now, 1_001)], now, 600_000), None);
    }

    fn row(status: &str, progress: Option<u32>, created: i64, grad: Option<i64>, mint: &str) -> PulseRow {
        PulseRow {
            card: json!({ "mint": mint }),
            status: status.into(),
            progress,
            created_ms: created,
            graduated_ms: grad,
            as_of: 0,
        }
    }

    #[test]
    fn pulse_columns() {
        let now = 100 * 3_600_000;
        let h = 3_600_000;
        let rows = vec![
            row("curve", Some(1_000), now - h, None, "new1"),
            row("curve", None, now - 2 * h, None, "new2"),
            row("curve", Some(2_000), now - 7 * h, None, "old"),
            row("curve", Some(8_000), now - 50 * h, None, "g80"),
            row("curve", Some(9_500), now - 3 * h, None, "g95"),
            row("curve", Some(7_000), now - h / 2, None, "g70"),
            row("graduated", None, now - 80 * h, Some(now - h), "d1"),
            row("graduated", None, now - 10 * h, None, "d2"),
            row("graduated", None, now - 30 * h, Some(now - 25 * h), "dold"),
            row("graduated", None, now - 30 * h, None, "dunk"),
        ];
        let (n, g, d) = columns(rows, now, 70);
        let ids = |v: &[Value]| {
            v.iter()
                .map(|x| x["mint"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&n), ["new1", "new2"]);
        assert_eq!(ids(&g), ["g95", "g80", "g70"]);
        assert_eq!(ids(&d), ["d1", "d2"]);
        // ≤ 30 per column
        let many = (0..40)
            .map(|i| row("curve", Some(100), now - i * 1000, None, "m"))
            .collect();
        assert_eq!(columns(many, now, 70).0.len(), PULSE_COLUMN);
    }

    fn gp(input: u128, output: u128, at: i64) -> GridPoint {
        GridPoint {
            input,
            output,
            impact_pct: input as f64 / 1e9,
            route: vec![format!("r{input}")],
            at,
        }
    }

    #[test]
    fn grid_interpolation_is_conservative() {
        // Concave curve out = 1000·x/(1 + x/1e9): chords lie under it.
        let f = |x: u128| x * 1000 * 1_000_000_000 / (1_000_000_000 + x);
        let pts: Vec<GridPoint> = QUOTE_GRID_LAMPORTS
            .iter()
            .rev()
            .enumerate()
            .map(|(i, l)| gp(u128::from(*l), f(u128::from(*l)), 100 + i as i64))
            .collect();
        for x in [
            1u128,
            5_000_000,
            10_000_000,
            30_000_000,
            700_000_000,
            3_000_000_000,
            25_000_000_000,
        ] {
            let (out, _, _, _) = interpolate(&pts, x).unwrap();
            assert!(out <= f(x), "{x}: {out} > {}", f(x));
            assert!(out * 100 >= f(x) * 80, "{x}: too far below");
        }
        // exact at the points; impact/route of the upper neighbour; oldest time of the two
        let (out, imp, route, at) = interpolate(&pts, 1_000_000_000).unwrap();
        assert_eq!(out, f(1_000_000_000));
        assert_eq!(route, ["r1000000000"]);
        assert!((imp - 1.0).abs() < 1e-9);
        let (_, _, route, at2) = interpolate(&pts, 600_000_000).unwrap();
        assert_eq!(route, ["r1000000000"]);
        assert!(at2 <= at);
        // above the grid / empty / zero
        assert!(interpolate(&pts, 25_000_000_001).is_none());
        assert!(interpolate(&[], 1).is_none());
        assert!(interpolate(&pts, 0).is_none());
    }

    #[test]
    fn sell_grid_amounts() {
        // 1e-6 SOL per whole token (6 decimals): 0.01 SOL = 10 000 tokens = 1e10 base units.
        let p18 = 1_000_000_000_000u128;
        assert_eq!(tokens_for_lamports(10_000_000, p18, 6), Some(10_000_000_000));
        assert_eq!(tokens_for_lamports(10_000_000, 0, 6), None);
        assert_eq!(tokens_for_lamports(25_000_000_000, 1, 18), None, "beyond u64");
    }

    #[test]
    fn jupiter_answers() {
        // Live shape of /swap/v1/quote (SOL → BONK, 18.10).
        let body = json!({"inputMint":"So11111111111111111111111111111111111111112","inAmount":"100000000",
            "outputMint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","outAmount":"351101037915",
            "otherAmountThreshold":"347590027536","swapMode":"ExactIn","slippageBps":100,"platformFee":null,
            "priceImpactPct":"0.0003352436784791369303007821",
            "routePlan":[{"swapInfo":{"ammKey":"5zpy","label":"Whirlpool","inputMint":"So11","outputMint":"Dez",
                "inAmount":"100000000","outAmount":"351101037915"},"percent":100,"bps":null}],"contextSlot":458404085});
        let (out, pct, route) = parse_jupiter(&body).unwrap();
        assert_eq!(out, "351101037915");
        assert_eq!(pct, "0.0335");
        assert_eq!(route, ["Whirlpool"]);
        let neg = json!({"outAmount":"5","priceImpactPct":"-0.5","routePlan":[]});
        assert_eq!(parse_jupiter(&neg).unwrap().1, "50.0000");
        for bad in [
            json!({}),
            json!({"outAmount":"-1","priceImpactPct":"0"}),
            json!({"outAmount":"1e3","priceImpactPct":"0"}),
            json!({"outAmount":"1","priceImpactPct":"x"}),
            json!({"outAmount":1,"priceImpactPct":"0"}),
        ] {
            assert!(parse_jupiter(&bad).is_none(), "{bad}");
        }
        // labels are sanitized, deduped, ≤ 4
        let many = json!({"outAmount":"1","priceImpactPct":0.0,"routePlan":[
            {"swapInfo":{"label":"A<script>"}},{"swapInfo":{"label":"A<script>"}},{"swapInfo":{"label":"B"}},
            {"swapInfo":{"label":"C"}},{"swapInfo":{"label":"D"}},{"swapInfo":{"label":"E"}}]});
        assert_eq!(parse_jupiter(&many).unwrap().2, ["Ascript", "B", "C", "D"]);
    }
}

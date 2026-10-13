//! `GET /api/rates` (API v0.18): approximate public prices for display (≈ USD, the ZEC/SOL/ETH
//! currency switch). NEVER used for a trade: actions keep their own rate (`PoolInfo.rate`,
//! `RateUsed`, ZEC SPL parity).
//!
//! Source: NEAR Intents 1Click `GET /v0/tokens` (public token list with USD prices, no key),
//! fetched by a background timer every ~60 s (± jitter), 10 s retry after a failure. Nothing is
//! fetched because of a user request (D14), every client gets the same cached body, so the
//! endpoint tells nobody anything about who looks at prices. Older than [`MAX_AGE_SECS`] → 503.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    rate::now_ms,
};

/// 1Click asset ids of the displayed currencies (ETH: Ethereum mainnet ETH; `hood` ETH has
/// the same price and is checked as a fallback).
const ZEC: &str = "nep141:zec.omft.near";
const SOL: &str = "nep141:sol.omft.near";
const ETH: &[&str] = &["nep141:eth.omft.near", "nep141:hood.omft.near"];

/// Refresh period of the cache (seconds).
pub const REFRESH_SECS: f64 = 60.0;
/// A snapshot older than this is not served (5 missed refreshes).
pub const MAX_AGE_SECS: u64 = 300;

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub zec_usd: f64,
    pub sol_usd: f64,
    pub eth_usd: f64,
    /// When our timer fetched it, unix ms.
    pub ts_ms: u64,
}

pub struct PublicRates {
    url: String,
    http: reqwest::Client,
    cache: Mutex<Option<(Snapshot, Instant)>>,
}

impl PublicRates {
    pub fn new(oneclick_url: &str) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("unzeen")
            .build()
            .expect("reqwest client");
        Arc::new(Self {
            url: format!("{}/v0/tokens", oneclick_url.trim_end_matches('/')),
            http,
            cache: Mutex::new(None),
        })
    }

    /// Fresh cached snapshot, if any.
    pub async fn get(&self) -> Option<Snapshot> {
        let c = self.cache.lock().await;
        c.as_ref()
            .filter(|(_, at)| at.elapsed() <= Duration::from_secs(MAX_AGE_SECS))
            .map(|(s, _)| s.clone())
    }

    /// Test / operator hook: put a snapshot into the cache.
    pub async fn set(&self, s: Snapshot) {
        *self.cache.lock().await = Some((s, Instant::now()));
    }

    async fn fetch(&self) -> Result<Snapshot, &'static str> {
        let res = self.http.get(&self.url).send().await.map_err(|_| "transport")?;
        if !res.status().is_success() {
            return Err("http_status");
        }
        let v: Value = res.json().await.map_err(|_| "decode")?;
        parse_tokens(&v, now_ms()).ok_or("missing_prices")
    }

    /// Background timer: ~60 s (uniform ±10 s), 10 s after a failure.
    pub async fn refresh_loop(self: Arc<Self>) {
        loop {
            let ok = match self.fetch().await {
                Ok(s) => {
                    self.set(s).await;
                    true
                }
                Err(kind) => {
                    tracing::warn!(kind, "public rates refresh failed");
                    false
                }
            };
            let secs = if ok {
                REFRESH_SECS - 10.0 + 20.0 * ((rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64)
            } else {
                10.0
            };
            tokio::time::sleep(Duration::from_secs_f64(secs)).await;
        }
    }
}

fn price_of(list: &[Value], asset: &str) -> Option<f64> {
    list.iter()
        .find(|t| t.get("assetId").and_then(Value::as_str) == Some(asset))
        .and_then(|t| t.get("price"))
        .and_then(Value::as_f64)
        .filter(|p| p.is_finite() && *p > 0.0)
}

/// `/v0/tokens` body → snapshot (all three prices required).
pub fn parse_tokens(v: &Value, ts_ms: u64) -> Option<Snapshot> {
    let list = v.as_array()?;
    Some(Snapshot {
        zec_usd: price_of(list, ZEC)?,
        sol_usd: price_of(list, SOL)?,
        eth_usd: ETH.iter().find_map(|a| price_of(list, a))?,
        ts_ms,
    })
}

/// Decimal string with `sig` significant digits, no exponent, trailing zeros trimmed.
pub fn fmt_sig(x: f64, sig: usize) -> String {
    if !x.is_finite() || x <= 0.0 {
        return "0".into();
    }
    let mag = x.log10().floor() as i32;
    let decimals = (sig as i32 - 1 - mag).clamp(0, 18) as usize;
    let s = format!("{x:.decimals$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

/// `Rates` (API.md v0.18).
pub fn rates_json(s: &Snapshot) -> Value {
    json!({
        "usd": {
            "ZEC": fmt_sig(s.zec_usd, 6),
            "SOL": fmt_sig(s.sol_usd, 6),
            "ETH": fmt_sig(s.eth_usd, 6),
        },
        "pairs": {
            "ZEC/SOL": fmt_sig(s.zec_usd / s.sol_usd, 6),
            "ZEC/ETH": fmt_sig(s.zec_usd / s.eth_usd, 6),
        },
        "approximate": true,
        "source": "near-1click",
        "ts": s.ts_ms,
    })
}

/// `GET /api/rates`: same cached body for everyone; 503 until the first refresh succeeds.
pub async fn rates(State(st): State<AppState>) -> ApiResult<Response> {
    let s = st
        .public_rates
        .get()
        .await
        .ok_or_else(|| ApiError::venue_unavailable("rates not available yet"))?;
    let mut r = axum::Json(rates_json(&s)).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=60"));
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_oneclick_tokens() {
        let v: Value = serde_json::from_str(
            r#"[{"assetId":"nep141:zec.omft.near","decimals":8,"blockchain":"zec","symbol":"ZEC","price":1218.79},
                {"assetId":"nep141:eth.omft.near","decimals":18,"blockchain":"eth","symbol":"ETH","price":2506.85},
                {"assetId":"nep141:sol.omft.near","decimals":9,"blockchain":"sol","symbol":"SOL","price":107.79},
                {"assetId":"nep141:hood.omft.near","decimals":18,"blockchain":"hood","symbol":"ETH","price":2506.85}]"#,
        )
        .unwrap();
        let s = parse_tokens(&v, 5).unwrap();
        assert_eq!(
            (s.zec_usd, s.sol_usd, s.eth_usd, s.ts_ms),
            (1218.79, 107.79, 2506.85, 5)
        );
        let j = rates_json(&s);
        assert_eq!(j["usd"]["ZEC"], "1218.79");
        assert_eq!(j["pairs"]["ZEC/SOL"], "11.3071");
        assert_eq!(j["pairs"]["ZEC/ETH"], "0.486184");
        assert_eq!(j["approximate"], true);
        // hood ETH as a fallback; a missing price → no snapshot.
        let only_hood: Value = serde_json::from_str(
            r#"[{"assetId":"nep141:zec.omft.near","price":1},{"assetId":"nep141:sol.omft.near","price":2},
                {"assetId":"nep141:hood.omft.near","price":3}]"#,
        )
        .unwrap();
        assert_eq!(parse_tokens(&only_hood, 0).unwrap().eth_usd, 3.0);
        let no_sol: Value = serde_json::from_str(r#"[{"assetId":"nep141:zec.omft.near","price":1}]"#).unwrap();
        assert!(parse_tokens(&no_sol, 0).is_none());
        assert!(parse_tokens(&json!({"error": 1}), 0).is_none());
    }

    #[test]
    fn significant_digits() {
        assert_eq!(fmt_sig(1218.79, 6), "1218.79");
        assert_eq!(fmt_sig(0.000_012_345_678, 6), "0.0000123457");
        assert_eq!(fmt_sig(123_456_789.0, 6), "123456789");
        assert_eq!(fmt_sig(2.0, 6), "2");
        assert_eq!(fmt_sig(0.0, 6), "0");
        assert_eq!(fmt_sig(f64::NAN, 6), "0");
    }
}

//! ZEC→SOL rate for balance actions.
//!
//! - devnet with `DEVNET_ZEC_SOL_RATE`: fixed rate (source `fixed`).
//! - otherwise: dry quote of NEAR Intents 1Click for exactly 1 ZEC → SOL (source
//!   `near-1click`). Works without a JWT; `ONECLICK_JWT` is sent if set (never logged).
//!
//! Privacy: the quote request is constant (1 ZEC, dummy recipient/refund addresses that
//! belong to nobody in the pool) and cached, so 1Click learns nothing about users or
//! their amounts. The value is the mid used by the pool; the spread is applied by callers.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::RateConfig;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rate {
    /// Lamports per 1 ZEC (1e8 zat), before spread.
    pub lamports_per_zec: u64,
    pub source: &'static str,
    /// When the quote was obtained, unix ms.
    pub ts_ms: u64,
    /// The last background refresh failed and this quote is older than `RATE_CACHE_SECS`
    /// (callers double the spread).
    pub stale: bool,
}

#[derive(Debug)]
pub enum RateError {
    Unavailable,
}

impl std::error::Error for RateError {}

impl std::fmt::Display for RateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ZEC/SOL rate unavailable")
    }
}

pub struct RateProvider {
    cfg: RateConfig,
    http: reqwest::Client,
    cache: Mutex<Option<(Rate, Instant)>>,
}

const ZEC_ASSET: &str = "nep141:zec.omft.near";
const SOL_ASSET: &str = "nep141:sol.omft.near";
/// Native ETH on Robinhood Chain (v0.20 hood instance: the rate is wei per ZEC).
const HOOD_ETH_ASSET: &str = "nep141:hood.omft.near";
/// wSOL mint: a valid Solana address no user owns (1Click requires a recipient).
const DUMMY_SOL_RECIPIENT: &str = "So11111111111111111111111111111111111111112";
/// A valid checksummed EVM address not of the pool (1Click refuses burn addresses).
const DUMMY_EVM_RECIPIENT: &str = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
/// Placeholder refund address required by the API for a dry quote (no deposit is ever made).
const DUMMY_ZEC_REFUND: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl RateProvider {
    pub fn new(cfg: RateConfig) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("unzeen")
            .build()
            .expect("reqwest client");
        Arc::new(Self {
            cfg,
            http,
            cache: Mutex::new(None),
        })
    }

    pub fn is_fixed(&self) -> bool {
        self.cfg.fixed_lamports_per_zec.is_some()
    }

    /// Current mid rate. D14: never fetched on demand (a quote request at the moment of a
    /// user action would tell 1Click when actions happen); a background task refreshes it every
    /// 30–60 s ([`Self::refresh_loop`]). Older than `RATE_MAX_STALE_SECS` → unavailable.
    pub async fn get(&self) -> Result<Rate, RateError> {
        if let Some(l) = self.cfg.fixed_lamports_per_zec {
            return Ok(Rate {
                lamports_per_zec: l,
                source: "fixed",
                ts_ms: now_ms(),
                stale: false,
            });
        }
        let cache = self.cache.lock().await;
        match cache.as_ref() {
            Some((r, at)) if at.elapsed() <= Duration::from_secs(self.cfg.max_stale_secs) => Ok(Rate {
                stale: at.elapsed() > Duration::from_secs(self.cfg.cache_secs),
                ..r.clone()
            }),
            _ => Err(RateError::Unavailable),
        }
    }

    /// One quote fetch into the cache.
    pub async fn refresh(&self) -> bool {
        match self.fetch_oneclick().await {
            Ok(r) => {
                *self.cache.lock().await = Some((r, Instant::now()));
                true
            }
            Err(kind) => {
                tracing::warn!(kind, "1Click quote failed");
                false
            }
        }
    }

    /// Background refresh: every 30–60 s (uniform jitter), 10 s retry after a failure.
    pub async fn refresh_loop(self: Arc<Self>) {
        if self.is_fixed() {
            return;
        }
        loop {
            let ok = self.refresh().await;
            let secs = if ok {
                30.0 + 30.0 * ((rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64)
            } else {
                10.0
            };
            tokio::time::sleep(Duration::from_secs_f64(secs)).await;
        }
    }

    async fn fetch_oneclick(&self) -> Result<Rate, &'static str> {
        let deadline = SystemTime::now() + Duration::from_secs(600);
        let deadline = fmt_rfc3339(deadline);
        let body = json!({
            "dry": true,
            "swapType": "EXACT_INPUT",
            "slippageTolerance": 100,
            "originAsset": ZEC_ASSET,
            "depositType": "ORIGIN_CHAIN",
            "destinationAsset": if self.cfg.hood { HOOD_ETH_ASSET } else { SOL_ASSET },
            "amount": "100000000",
            "refundTo": DUMMY_ZEC_REFUND,
            "refundType": "ORIGIN_CHAIN",
            "recipient": if self.cfg.hood { DUMMY_EVM_RECIPIENT } else { DUMMY_SOL_RECIPIENT },
            "recipientType": "DESTINATION_CHAIN",
            "deadline": deadline,
        });
        let url = format!("{}/v0/quote", self.cfg.oneclick_url.trim_end_matches('/'));
        let mut req = self.http.post(url).json(&body);
        if let Some(jwt) = &self.cfg.oneclick_jwt {
            req = req.bearer_auth(jwt);
        }
        let res = req.send().await.map_err(|_| "transport")?;
        if !res.status().is_success() {
            return Err("http_status");
        }
        let v: Value = res.json().await.map_err(|_| "decode")?;
        let out = parse_amount_out(&v).ok_or("no_amount_out")?;
        Ok(Rate {
            lamports_per_zec: out,
            source: "near-1click",
            ts_ms: now_ms(),
            stale: false,
        })
    }
}

pub fn parse_amount_out(v: &Value) -> Option<u64> {
    let s = v.get("quote")?.get("amountOut")?.as_str()?;
    s.parse::<u64>().ok().filter(|l| *l > 0)
}

/// Spread against the user: `buy` gives fewer lamports per ZEC, `sell` needs more lamports
/// per ZEC credited.
pub fn apply_spread(mid: u64, bps: u64, buy: bool) -> u64 {
    let m = mid as u128;
    let b = bps.min(10_000) as u128;
    let v = if buy {
        m * (10_000 - b) / 10_000
    } else {
        m * (10_000 + b) / 10_000
    };
    v.min(u64::MAX as u128) as u64
}

/// zat × (native units per ZEC) / 1e8, floor. Native units: lamports (Solana) or wei
/// (Robinhood Chain); u128 since API v0.20 (wei passes u64 at 18.4 ETH).
pub fn zat_to_lamports(zat: u64, lamports_per_zec: u64) -> u128 {
    (zat as u128) * (lamports_per_zec as u128) / 100_000_000
}

/// Ceil variant (for minimums the pool must get).
pub fn zat_to_lamports_ceil(zat: u64, lamports_per_zec: u64) -> u128 {
    ((zat as u128) * (lamports_per_zec as u128)).div_ceil(100_000_000)
}

/// native units × 1e8 / (units per ZEC), ceil (fees the user pays); saturates at u64::MAX zat.
pub fn lamports_to_zat_ceil(lamports: u128, lamports_per_zec: u64) -> u64 {
    if lamports_per_zec == 0 {
        return u64::MAX;
    }
    unzeen_fair::alloc::mul_div_ceil(lamports, 100_000_000, lamports_per_zec as u128)
        .unwrap_or(u128::MAX)
        .min(u64::MAX as u128) as u64
}

/// SOL amounts of buys are rounded to this step (0.001 SOL).
pub const LAMPORTS_STEP: u64 = 1_000_000;
/// Robinhood Chain: ETH amounts of buys are rounded to 0.0001 ETH (1e14 wei). A Solana-sized
/// step (1e6) on wei would leave `zecIn × rate` almost exact on chain (review-numeric-hood п. 7).
pub const WEI_STEP: u64 = 100_000_000_000_000;

/// D10 rounding step of a buy's native quote amount on the pool's trading chain.
pub const fn buy_step(trade: unzeen_protocol::TradeNet) -> u64 {
    match trade {
        unzeen_protocol::TradeNet::Solana(_) => LAMPORTS_STEP,
        unzeen_protocol::TradeNet::Hood(_) => WEI_STEP,
    }
}

/// zat × (native units per ZEC) / 1e8, ceil, in u128 (no saturation: wei amounts pass u64 at
/// 18.4 ETH; review-numeric-hood п. 13).
pub fn zat_to_units_ceil(zat: u64, units_per_zec: u64) -> u128 {
    ((zat as u128) * (units_per_zec as u128)).div_ceil(100_000_000)
}

/// D10: the SOL amount of a buy must not reveal the ZEC amount the user typed (zecIn × rate is
/// reversible). Shave a random 0–1 % and round DOWN to 0.001 SOL; the user is only charged
/// the ZEC equivalent of what is actually spent. `u` is uniform in [0, 1).
pub fn fuzz_lamports(lamports: u128, u: f64) -> u128 {
    fuzz_units(lamports, u, LAMPORTS_STEP)
}

/// [`fuzz_lamports`] with another step (ZEC SPL units: 0.0001 ZEC; wei: 0.0001 ETH).
pub fn fuzz_units(units: u128, u: f64, step: u64) -> u128 {
    unzeen_fair::alloc::fuzz_step(units, u, u128::from(step))
}

/// Minimal RFC 3339 UTC formatter (no chrono dependency).
fn fmt_rfc3339(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339() {
        assert_eq!(fmt_rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            fmt_rfc3339(UNIX_EPOCH + Duration::from_secs(1_791_763_200)),
            "2026-10-12T00:00:00Z"
        );
        assert_eq!(
            fmt_rfc3339(UNIX_EPOCH + Duration::from_secs(951_782_400 + 3_661)),
            "2000-02-29T01:01:01Z"
        );
    }

    #[test]
    fn amounts() {
        let r = 11_469_831_889; // lamports per ZEC
        assert_eq!(zat_to_lamports(100_000_000, r), u128::from(r));
        assert_eq!(zat_to_lamports(500_000, r), 57_349_159);
        assert_eq!(zat_to_lamports_ceil(500_000, r), 57_349_160);
        assert_eq!(lamports_to_zat_ceil(u128::from(r), r), 100_000_000);
        assert_eq!(lamports_to_zat_ceil(1, r), 1);
        assert_eq!(apply_spread(10_000, 50, true), 9_950);
        assert_eq!(apply_spread(10_000, 50, false), 10_050);
        assert_eq!(
            zat_to_lamports(u64::MAX, u64::MAX),
            (u64::MAX as u128) * (u64::MAX as u128) / 100_000_000
        );
        // wei: 40 ZEC at 0.485 ETH/ZEC = 19.4 ETH (> u64::MAX wei), no saturation.
        assert_eq!(
            zat_to_lamports(4_000_000_000, 485_000_000_000_000_000),
            19_400_000_000_000_000_000
        );
        assert_eq!(
            lamports_to_zat_ceil(19_400_000_000_000_000_000, 485_000_000_000_000_000),
            4_000_000_000
        );
    }

    #[test]
    fn fuzz_rounds_down_within_one_percent() {
        let l = 5_766_050_000u128; // 0.5 ZEC at 11.5321 SOL/ZEC
        for u in [0.0, 0.3, 0.999] {
            let f = fuzz_lamports(l, u);
            assert_eq!(f % u128::from(LAMPORTS_STEP), 0);
            assert!(f <= l && f as f64 >= l as f64 * 0.99 - LAMPORTS_STEP as f64, "{f}");
        }
        assert_eq!(fuzz_lamports(5_766_050_000, 0.0), 5_766_000_000);
        assert_eq!(fuzz_lamports(999_999, 0.0), 0);
    }

    #[test]
    fn parse_quote() {
        let v: Value = serde_json::from_str(r#"{"quote":{"amountIn":"100000000","amountOut":"11469831889"}}"#).unwrap();
        assert_eq!(parse_amount_out(&v), Some(11_469_831_889));
        assert_eq!(parse_amount_out(&json!({"quote":{"amountOut":"0"}})), None);
        assert_eq!(parse_amount_out(&json!({"message":"x"})), None);
    }
}

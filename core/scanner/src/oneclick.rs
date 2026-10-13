//! NEAR Intents 1Click API client for the pool rebalance ZEC → SOL (mainnet only: 1Click has
//! no testnet). OpenAPI: `https://1click.chaindefuser.com/docs/v0/openapi.yaml` (checked
//! 2026-10-13): `POST /v0/quote`, `GET /v0/status?depositAddress=`, `POST /v0/deposit/submit`,
//! `GET /v0/tokens`.
//!
//! ZEC is supported on 1Click only through TRANSPARENT addresses (deposit and refund).
//! `ONECLICK_JWT` is optional (without it 1Click adds 0.25 %); it is never logged.
//!
//! Privacy: requests carry only pool-level data (fixed lot, the pool's rebalance SOL address,
//! the pool's refund t-address). No referral / session / connected-wallet fields are sent.

use std::time::Duration;

use serde_json::{Value, json};

pub const ZEC_ASSET: &str = "nep141:zec.omft.near";
pub const SOL_ASSET: &str = "nep141:sol.omft.near";
/// wSOL mint: a valid Solana address no one in the pool owns (dry quotes only).
pub const DUMMY_SOL_RECIPIENT: &str = "So11111111111111111111111111111111111111112";
/// Placeholder mainnet t-address for dry quotes (no deposit is ever made).
pub const DUMMY_ZEC_REFUND: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
/// 1Click minimum for ZEC (live answer 12.10: "try at least 132000").
pub const MIN_LOT_ZAT: u64 = 132_000;

/// Coarse, loggable error kinds (never bodies: they may echo addresses).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OcError {
    Transport,
    /// 4xx other than 404 (bad request, auth, rate limit).
    Client(u16),
    Server(u16),
    NotFound,
    Decode,
}

impl std::fmt::Display for OcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OcError::Transport => f.write_str("1click transport error"),
            OcError::Client(s) => write!(f, "1click http {s}"),
            OcError::Server(s) => write!(f, "1click http {s}"),
            OcError::NotFound => f.write_str("1click not found"),
            OcError::Decode => f.write_str("1click decode error"),
        }
    }
}

impl std::error::Error for OcError {}

/// The 1Click calls the rebalance needs (mocked in tests).
#[allow(async_fn_in_trait)]
pub trait OneClick {
    async fn quote(&self, req: &Value) -> Result<Value, OcError>;
    async fn status(&self, deposit_address: &str) -> Result<Value, OcError>;
    async fn submit_deposit(&self, tx_hash: &str, deposit_address: &str) -> Result<(), OcError>;
    async fn tokens(&self) -> Result<Value, OcError>;
}

pub struct HttpOneClick {
    base: String,
    jwt: Option<String>,
    http: reqwest::Client,
}

impl HttpOneClick {
    pub fn from_env() -> anyhow::Result<Self> {
        let base = std::env::var("ONECLICK_URL")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "https://1click.chaindefuser.com".into());
        let jwt = std::env::var("ONECLICK_JWT").ok().filter(|v| !v.is_empty());
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("unzeen")
            .build()?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            jwt,
            http,
        })
    }

    pub fn has_jwt(&self) -> bool {
        self.jwt.is_some()
    }

    fn auth(&self, r: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.jwt {
            Some(j) => r.bearer_auth(j),
            None => r,
        }
    }

    async fn send(&self, r: reqwest::RequestBuilder) -> Result<Value, OcError> {
        let res = self.auth(r).send().await.map_err(|_| OcError::Transport)?;
        let s = res.status().as_u16();
        match s {
            200..=299 => res.json().await.map_err(|_| OcError::Decode),
            404 => Err(OcError::NotFound),
            400..=499 => Err(OcError::Client(s)),
            _ => Err(OcError::Server(s)),
        }
    }
}

impl OneClick for HttpOneClick {
    async fn quote(&self, req: &Value) -> Result<Value, OcError> {
        self.send(self.http.post(format!("{}/v0/quote", self.base)).json(req))
            .await
    }

    async fn status(&self, deposit_address: &str) -> Result<Value, OcError> {
        self.send(
            self.http
                .get(format!("{}/v0/status", self.base))
                .query(&[("depositAddress", deposit_address)]),
        )
        .await
    }

    async fn submit_deposit(&self, tx_hash: &str, deposit_address: &str) -> Result<(), OcError> {
        self.send(
            self.http
                .post(format!("{}/v0/deposit/submit", self.base))
                .json(&json!({ "txHash": tx_hash, "depositAddress": deposit_address })),
        )
        .await
        .map(|_| ())
    }

    async fn tokens(&self) -> Result<Value, OcError> {
        self.send(self.http.get(format!("{}/v0/tokens", self.base))).await
    }
}

/// Inputs of a ZEC → SOL quote.
#[derive(Clone, Debug)]
pub struct QuoteParams<'a> {
    pub dry: bool,
    pub amount_zat: u64,
    pub refund_to: &'a str,
    pub recipient: &'a str,
    pub slippage_bps: u32,
    pub deadline_unix: u64,
}

/// `POST /v0/quote` body: EXACT_INPUT ZEC (origin chain, transparent deposit) → SOL to
/// `recipient` on Solana, refunds to `refund_to` on Zcash.
pub fn quote_request(p: &QuoteParams<'_>) -> Value {
    json!({
        "dry": p.dry,
        "depositMode": "SIMPLE",
        "swapType": "EXACT_INPUT",
        "slippageTolerance": p.slippage_bps,
        "originAsset": ZEC_ASSET,
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": SOL_ASSET,
        "amount": p.amount_zat.to_string(),
        "refundTo": p.refund_to,
        "refundType": "ORIGIN_CHAIN",
        "recipient": p.recipient,
        "recipientType": "DESTINATION_CHAIN",
        "deadline": fmt_rfc3339(p.deadline_unix),
        "quoteWaitingTimeMs": 3000,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedQuote {
    pub deposit_address: Option<String>,
    pub amount_in: u64,
    pub amount_out: u64,
    pub min_amount_out: u64,
    pub deadline_unix: Option<i64>,
    pub time_estimate_secs: Option<u64>,
}

/// Why a quote is refused (stable codes, stored as `error_code`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteReject {
    Malformed,
    AmountMismatch,
    RouteMismatch,
    MemoRequired,
    NoDepositAddress,
    BadDepositAddress,
    DeadlineTooSoon,
    PriceDeviation,
    NoPrice,
}

impl QuoteReject {
    pub fn code(self) -> &'static str {
        match self {
            QuoteReject::Malformed => "quote_malformed",
            QuoteReject::AmountMismatch => "quote_amount",
            QuoteReject::RouteMismatch => "quote_route",
            QuoteReject::MemoRequired => "quote_memo",
            QuoteReject::NoDepositAddress => "quote_no_address",
            QuoteReject::BadDepositAddress => "quote_bad_address",
            QuoteReject::DeadlineTooSoon => "quote_deadline",
            QuoteReject::PriceDeviation => "quote_price",
            QuoteReject::NoPrice => "quote_no_price",
        }
    }
}

fn u64_str(v: Option<&Value>) -> Option<u64> {
    v?.as_str()?.parse().ok()
}

pub fn parse_quote(v: &Value) -> Result<ParsedQuote, QuoteReject> {
    let q = v.get("quote").ok_or(QuoteReject::Malformed)?;
    let amount_in = u64_str(q.get("amountIn")).ok_or(QuoteReject::Malformed)?;
    let amount_out = u64_str(q.get("amountOut")).ok_or(QuoteReject::Malformed)?;
    let min_amount_out = u64_str(q.get("minAmountOut")).ok_or(QuoteReject::Malformed)?;
    if q.get("depositMemo").is_some_and(|m| !m.is_null()) {
        // A transparent ZEC deposit cannot carry a memo.
        return Err(QuoteReject::MemoRequired);
    }
    Ok(ParsedQuote {
        deposit_address: q.get("depositAddress").and_then(Value::as_str).map(str::to_string),
        amount_in,
        amount_out,
        min_amount_out,
        deadline_unix: q.get("deadline").and_then(Value::as_str).and_then(parse_rfc3339),
        time_estimate_secs: q.get("timeEstimate").and_then(Value::as_f64).map(|t| t.max(0.0) as u64),
    })
}

/// Checks every field we rely on. `expect_address` = a real (non-dry) quote. The echoed
/// request must match what we asked for: a response routing SOL elsewhere is refused.
pub fn check_quote(
    v: &Value,
    p: &QuoteParams<'_>,
    now_unix: u64,
    min_deadline_secs: u64,
) -> Result<ParsedQuote, QuoteReject> {
    let q = parse_quote(v)?;
    if q.amount_in != p.amount_zat {
        return Err(QuoteReject::AmountMismatch);
    }
    if q.min_amount_out == 0 || q.min_amount_out > q.amount_out {
        return Err(QuoteReject::Malformed);
    }
    if let Some(echo) = v.get("quoteRequest") {
        let s = |k: &str| echo.get(k).and_then(Value::as_str);
        if s("originAsset") != Some(ZEC_ASSET)
            || s("destinationAsset") != Some(SOL_ASSET)
            || s("recipient") != Some(p.recipient)
            || s("refundTo") != Some(p.refund_to)
            || s("swapType") != Some("EXACT_INPUT")
        {
            return Err(QuoteReject::RouteMismatch);
        }
    } else if !p.dry {
        return Err(QuoteReject::Malformed);
    }
    if !p.dry {
        if q.deposit_address.as_deref().is_none_or(str::is_empty) {
            return Err(QuoteReject::NoDepositAddress);
        }
        match q.deadline_unix {
            Some(d) if d >= (now_unix + min_deadline_secs) as i64 => {}
            _ => return Err(QuoteReject::DeadlineTooSoon),
        }
    }
    Ok(q)
}

/// Lamports a lot should give at the 1Click USD prices (`/v0/tokens`), before fees.
pub fn expected_lamports(tokens: &Value, lot_zat: u64) -> Option<u64> {
    let price = |id: &str| {
        tokens
            .as_array()?
            .iter()
            .find(|t| t.get("assetId").and_then(Value::as_str) == Some(id))?
            .get("price")?
            .as_f64()
            .filter(|p| p.is_finite() && *p > 0.0)
    };
    let (zec, sol) = (price(ZEC_ASSET)?, price(SOL_ASSET)?);
    // lamports = zat / 1e8 × zec/sol × 1e9
    let v = lot_zat as f64 * 10.0 * zec / sol;
    (v.is_finite() && v > 0.0 && v < u64::MAX as f64).then_some(v as u64)
}

/// The quote's guaranteed minimum must be within `max_dev_bps` of the reference value.
pub fn price_ok(min_amount_out: u64, expected: u64, max_dev_bps: u32) -> bool {
    let floor = (expected as u128) * (10_000 - u128::from(max_dev_bps.min(10_000))) / 10_000;
    u128::from(min_amount_out) >= floor
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedStatus {
    pub status: String,
    /// Lamports actually delivered (SUCCESS).
    pub amount_out: Option<u64>,
    pub dest_tx: Option<String>,
}

pub fn parse_status(v: &Value) -> Option<ParsedStatus> {
    let status = v.get("status")?.as_str()?.to_string();
    let d = v.get("swapDetails");
    Some(ParsedStatus {
        status,
        amount_out: d.and_then(|d| u64_str(d.get("amountOut"))),
        dest_tx: d
            .and_then(|d| d.get("destinationChainTxHashes"))
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|t| t.get("hash"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Minimal RFC 3339 UTC formatter (no chrono dependency).
pub fn fmt_rfc3339(secs: u64) -> String {
    let secs = secs as i64;
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

/// Parse `YYYY-MM-DDTHH:MM:SS[.fff]Z` (UTC only) to unix seconds.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if !s.ends_with('Z') {
        return None;
    }
    let tail = &s[19..s.len() - 1];
    if !(tail.is_empty() || (tail.starts_with('.') && tail[1..].bytes().all(|c| c.is_ascii_digit()))) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days-from-civil (Howard Hinnant).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn params(dry: bool) -> QuoteParams<'static> {
        QuoteParams {
            dry,
            amount_zat: 50_000_000,
            refund_to: DUMMY_ZEC_REFUND,
            recipient: DUMMY_SOL_RECIPIENT,
            slippage_bps: 100,
            deadline_unix: 1_791_770_400,
        }
    }

    fn quote_json(p: &QuoteParams<'_>, deposit: Option<&str>) -> Value {
        let mut q = json!({
            "amountIn": p.amount_zat.to_string(),
            "amountInFormatted": "0.5", "amountInUsd": "608.7",
            "minAmountIn": p.amount_zat.to_string(),
            "amountOut": "5600000000", "amountOutFormatted": "5.6", "amountOutUsd": "606.5",
            "minAmountOut": "5544000000",
            "timeEstimate": 452,
        });
        if let Some(d) = deposit {
            q["depositAddress"] = json!(d);
            q["deadline"] = json!(fmt_rfc3339(p.deadline_unix));
        }
        json!({
            "correlationId": "c", "timestamp": "2026-10-13T08:00:00Z", "signature": "ed25519:x",
            "quoteRequest": quote_request(p),
            "quote": q,
        })
    }

    #[test]
    fn request_has_mainnet_route_and_no_identifying_fields() {
        let r = quote_request(&params(true));
        assert_eq!(r["originAsset"], ZEC_ASSET);
        assert_eq!(r["destinationAsset"], SOL_ASSET);
        assert_eq!(r["swapType"], "EXACT_INPUT");
        assert_eq!(r["depositType"], "ORIGIN_CHAIN");
        assert_eq!(r["amount"], "50000000");
        assert_eq!(r["deadline"], "2026-10-12T02:00:00Z");
        for k in ["referral", "sessionId", "connectedWallets", "appFees"] {
            assert!(r.get(k).is_none(), "{k} must not be sent");
        }
    }

    #[test]
    fn dry_quote_is_accepted_without_address() {
        let p = params(true);
        let q = check_quote(&quote_json(&p, None), &p, 1_791_763_200, 1800).unwrap();
        assert_eq!(q.amount_out, 5_600_000_000);
        assert_eq!(q.min_amount_out, 5_544_000_000);
        assert_eq!(q.deposit_address, None);
        assert_eq!(q.time_estimate_secs, Some(452));
    }

    #[test]
    fn real_quote_checks() {
        let p = params(false);
        let now = 1_791_763_200; // deadline is 2 h later
        let ok = quote_json(&p, Some("t1abc"));
        assert_eq!(
            check_quote(&ok, &p, now, 1800).unwrap().deposit_address.as_deref(),
            Some("t1abc")
        );
        assert_eq!(
            check_quote(&quote_json(&p, None), &p, now, 1800),
            Err(QuoteReject::NoDepositAddress)
        );
        assert_eq!(check_quote(&ok, &p, now, 3 * 3600), Err(QuoteReject::DeadlineTooSoon));
        let mut other = ok.clone();
        other["quoteRequest"]["recipient"] = json!("Attacker1111111111111111111111111111111111");
        assert_eq!(check_quote(&other, &p, now, 1800), Err(QuoteReject::RouteMismatch));
        let mut amt = ok.clone();
        amt["quote"]["amountIn"] = json!("50000001");
        assert_eq!(check_quote(&amt, &p, now, 1800), Err(QuoteReject::AmountMismatch));
        let mut memo = ok.clone();
        memo["quote"]["depositMemo"] = json!("123");
        assert_eq!(check_quote(&memo, &p, now, 1800), Err(QuoteReject::MemoRequired));
        let mut min = ok.clone();
        min["quote"]["minAmountOut"] = json!("5600000001");
        assert_eq!(check_quote(&min, &p, now, 1800), Err(QuoteReject::Malformed));
        let mut no_echo = ok;
        no_echo.as_object_mut().unwrap().remove("quoteRequest");
        assert_eq!(check_quote(&no_echo, &p, now, 1800), Err(QuoteReject::Malformed));
    }

    #[test]
    fn price_reference() {
        let tokens = json!([
            {"assetId": ZEC_ASSET, "decimals": 8, "blockchain": "zec", "symbol": "ZEC", "price": 1217.53},
            {"assetId": SOL_ASSET, "decimals": 9, "blockchain": "sol", "symbol": "SOL", "price": 108.32},
            {"assetId": "nep141:other", "price": 1.0},
        ]);
        let e = expected_lamports(&tokens, 50_000_000).unwrap();
        // 0.5 × 1217.53 / 108.32 = 5.62006 SOL
        assert!((5_620_000_000..5_620_200_000).contains(&e), "{e}");
        assert!(price_ok(5_544_000_000, e, 300));
        assert!(!price_ok(5_400_000_000, e, 300));
        assert_eq!(expected_lamports(&json!([]), 50_000_000), None);
        assert_eq!(expected_lamports(&json!({"x": 1}), 50_000_000), None);
    }

    #[test]
    fn status_parsing() {
        let v = json!({
            "correlationId": "c", "status": "SUCCESS", "updatedAt": "2026-10-13T08:10:00Z",
            "quoteResponse": {},
            "swapDetails": {
                "intentHashes": [], "nearTxHashes": [], "originChainTxHashes": [],
                "amountOut": "5590000000",
                "destinationChainTxHashes": [{"hash": "5sig", "explorerUrl": "https://x"}]
            }
        });
        assert_eq!(
            parse_status(&v),
            Some(ParsedStatus {
                status: "SUCCESS".into(),
                amount_out: Some(5_590_000_000),
                dest_tx: Some("5sig".into())
            })
        );
        let p = parse_status(&json!({"status": "PENDING_DEPOSIT", "swapDetails": {}})).unwrap();
        assert_eq!(p.amount_out, None);
        assert_eq!(parse_status(&json!({})), None);
    }

    #[test]
    fn rfc3339_roundtrip() {
        for t in [0u64, 951_782_400 + 3_661, 1_791_763_200, 1_791_770_400 + 59] {
            assert_eq!(parse_rfc3339(&fmt_rfc3339(t)), Some(t as i64));
        }
        assert_eq!(parse_rfc3339("2026-10-13T07:35:30.634Z"), Some(1_791_876_930));
        assert_eq!(parse_rfc3339("2026-10-13T07:35:30+02:00"), None);
        assert_eq!(parse_rfc3339("garbage"), None);
    }
}

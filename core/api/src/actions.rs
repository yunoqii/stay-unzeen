//! `SignedAction` body → ledger `NewAction` (validation, amounts, jitter).

use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;
use unzeen_ledger::{
    JobOp, NewAction, NewJob, NewPayout, RateUsed,
    actions::{fuzz_token_amount_rand, quantize_min_out},
};
use zcash_address::unified::{self, Container, Encoding};

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    rate::{self, apply_spread, lamports_to_zat_ceil, zat_to_lamports, zat_to_lamports_ceil},
};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum SignedAction {
    Buy {
        venue: String,
        mint: String,
        #[serde(rename = "zecIn")]
        zec_in: String,
        #[serde(rename = "minOut")]
        min_out: String,
        /// `now` | `delayed` (default, 30–60 s epoch) | `max` (5–15 min epoch).
        #[serde(default)]
        exec: ExecMode,
    },
    Sell {
        venue: String,
        mint: String,
        amount: String,
        #[serde(rename = "minZecOut")]
        min_zec_out: String,
        /// `now` | `delayed` (default, 30–60 s epoch) | `max` (5–15 min epoch).
        #[serde(default)]
        exec: ExecMode,
    },
    Create {
        venue: String,
        meta: Meta,
        #[serde(rename = "initialBuyZec")]
        initial_buy_zec: Option<String>,
        /// v0.13: "SOL" (default) | "USDC" | "USD1" | "ZEC".
        quote: Option<String>,
        /// v0.13: raydium-launchlab only: "unzeen" (default) | "bonk" | "stonk".
        platform: Option<String>,
        /// `now` | `delayed` (default, 30–60 s epoch) | `max` (5–15 min epoch).
        #[serde(default)]
        exec: ExecMode,
    },
    WithdrawZec {
        to: String,
        amount: String,
        /// `delayed` (default) | `max` (10–60 min); `now` is refused (400).
        #[serde(default)]
        exec: ExecMode,
    },
    WithdrawToken {
        mint: String,
        amount: String,
        to: To,
        smart: Option<Smart>,
        /// `delayed` (default) | `max` (10–60 min); `now` is refused (400).
        #[serde(default)]
        exec: ExecMode,
    },
    Claim {
        #[allow(dead_code)]
        mint: Option<String>,
    },
    OrderCreate {},
    OrderCancel {},
    Chat {},
}

/// Execution mode of an action (API.md v0.4 `exec`, relayer_jobs.exec_mode).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecMode {
    /// No epoch: executed within seconds (pool-wide quantized priority fee, no Jito), paid
    /// by the user as `nowFeeLamports`. No timing privacy against network observers.
    Now,
    /// 30–60 s epochs, random order inside the epoch.
    #[default]
    Delayed,
    /// 5–15 min epochs (withdrawals: 10–60 min delay).
    Max,
}

impl ExecMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecMode::Now => "now",
            ExecMode::Delayed => "delayed",
            ExecMode::Max => "max",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Meta {
    pub name: String,
    pub symbol: String,
    pub image: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum To {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Smart {
    pub parts: u32,
    #[serde(rename = "maxDelayMin")]
    pub max_delay_min: u32,
}

pub(crate) const VENUES: [&str; 6] = ["pumpfun", "meteora-dbc", "jupiter", "raydium-launchlab", "bags", "pons"];
/// v0.18: venues of Robinhood Chain (`PoolInfo.chain.id = "hood"`); refused on a Solana server.
pub(crate) const HOOD_VENUES: [&str; 1] = ["pons"];
const PLATFORMS: [&str; 3] = ["unzeen", "bonk", "stonk"];
/// ZEC SPL amounts are rounded to 0.0001 ZEC (D10 for ZEC pairs).
pub const ZEC_UNITS_STEP: u64 = 10_000;
const ZEC_SPL_UNITS: u64 = 100_000_000;
const MAX_IMAGE_BYTES: usize = 512 * 1024;

/// Canonical unsigned integer string: digits only, no leading zeros, fits in i64.
pub fn parse_amount(s: &str, field: &str) -> ApiResult<u64> {
    let ok =
        !s.is_empty() && s.len() <= 19 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    let v: Option<u64> = if ok { s.parse().ok() } else { None };
    v.filter(|v| *v <= i64::MAX as u64)
        .ok_or_else(|| ApiError::bad_request(format!("{field}: expected an integer string in base units")))
}

fn positive(s: &str, field: &str) -> ApiResult<u64> {
    match parse_amount(s, field)? {
        0 => Err(ApiError::bad_request(format!("{field} must be > 0"))),
        v => Ok(v),
    }
}

/// Max digits of a token amount (v0.18): < 1e38, inside the ledger's i128 (NUMERIC(78,0) column).
/// Covers 18-decimal ERC-20 supplies (1e27) with room to spare.
pub const TOKEN_AMOUNT_MAX_DIGITS: usize = 38;

/// v0.18: token base units (sell / withdraw_token / order sell `amount`, buy `minOut`) —
/// canonical integer string up to [`TOKEN_AMOUNT_MAX_DIGITS`] digits (never parsed as u64).
pub fn parse_token_amount(s: &str, field: &str) -> ApiResult<u128> {
    let ok = !s.is_empty()
        && s.len() <= TOKEN_AMOUNT_MAX_DIGITS
        && s.bytes().all(|b| b.is_ascii_digit())
        && (s == "0" || !s.starts_with('0'));
    (if ok { s.parse::<u128>().ok() } else { None })
        .ok_or_else(|| ApiError::bad_request(format!("{field}: expected an integer string in base units")))
}

fn positive_tokens(s: &str, field: &str) -> ApiResult<u128> {
    match parse_token_amount(s, field)? {
        0 => Err(ApiError::bad_request(format!("{field} must be > 0"))),
        v => Ok(v),
    }
}

/// Solana address (base58 of 32 bytes), returned in canonical form.
pub fn solana_address(s: &str, field: &str) -> ApiResult<String> {
    match unzeen_protocol::pubkey_from_b58(s) {
        Some(b) if unzeen_protocol::pubkey_to_b58(&b) == s => Ok(s.to_string()),
        _ => Err(ApiError::bad_request(format!("{field}: not a Solana address"))),
    }
}

/// UA of this network with an Orchard/Ironwood receiver; t-addresses, Sapling-only and
/// other networks are rejected.
pub fn check_ua(st: &AppState, s: &str) -> ApiResult<()> {
    let (net, addr) = unified::Address::decode(s)
        .map(|(n, _, a)| (n, a))
        .map_err(|_| ApiError::bad_request("to: not a unified address (t-addresses and Sapling are not accepted)"))?;
    if net != st.cfg.zcash_net() {
        return Err(ApiError::bad_request("to: unified address of another network"));
    }
    if !addr.items().iter().any(|r| matches!(r, unified::Receiver::Orchard(_))) {
        return Err(ApiError::bad_request(
            "to: unified address has no Orchard/Ironwood receiver",
        ));
    }
    Ok(())
}

/// D2: execution epochs. Boundaries follow a random schedule (gaps uniform in
/// [min, max]) that does not depend on when requests arrive; every buy/sell/create gets
/// `not_before` = the next boundary of its schedule, so the relayer picks up the whole epoch
/// at once and runs it in random order.
pub struct Epochs {
    fast: std::sync::Mutex<f64>,
    max: std::sync::Mutex<f64>,
    cfg: crate::config::ExecConfig,
}

fn unix_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

impl Epochs {
    pub fn new(cfg: &crate::config::ExecConfig) -> Self {
        let now = unix_now();
        Self {
            fast: std::sync::Mutex::new(now + delay(cfg.epoch_min_secs, cfg.epoch_max_secs)),
            max: std::sync::Mutex::new(now + delay(cfg.max_epoch_min_secs, cfg.max_epoch_max_secs)),
            cfg: *cfg,
        }
    }

    /// Seconds from `now` until the next boundary of the chosen schedule.
    pub fn delay_at(&self, max_privacy: bool, now: f64) -> f64 {
        let (m, lo, hi) = if max_privacy {
            (&self.max, self.cfg.max_epoch_min_secs, self.cfg.max_epoch_max_secs)
        } else {
            (&self.fast, self.cfg.epoch_min_secs, self.cfg.epoch_max_secs)
        };
        let mut b = m.lock().unwrap_or_else(|e| e.into_inner());
        if *b <= now {
            // Skip whole idle periods in O(1) steps on average, then walk the random gaps.
            let mean = (lo + hi) / 2.0;
            let skip = ((now - *b) / mean).floor() - 1.0;
            if skip > 0.0 {
                *b += skip * mean;
            }
            while *b <= now {
                *b += delay(lo, hi);
            }
        }
        *b - now
    }

    pub fn delay(&self, max_privacy: bool) -> f64 {
        self.delay_at(max_privacy, unix_now())
    }
}

/// Delay of a withdrawal: none (`now`), the configured range (`delayed`) or 10–60 min (`max`).
fn withdraw_delay(min: f64, max: f64, mode: ExecMode) -> f64 {
    match mode {
        ExecMode::Now => 0.0,
        ExecMode::Delayed => delay(min, max),
        ExecMode::Max => delay(600.0, 3600.0),
    }
}

fn rand_unit() -> f64 {
    (rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64
}

fn delay(min: f64, max: f64) -> f64 {
    min + (max - min).max(0.0) * rand_unit()
}

fn venue(st: &AppState, v: &str) -> ApiResult<String> {
    if !VENUES.contains(&v) {
        return Err(ApiError::bad_request(
            "venue: expected pumpfun | meteora-dbc | jupiter | raydium-launchlab | bags | pons",
        ));
    }
    // v0.18: a venue of another chain (pons = Robinhood Chain) is never executed here.
    if HOOD_VENUES.contains(&v) {
        return Err(ApiError::venue_unavailable(format!(
            "{v} trades on Robinhood Chain, not on this server"
        )));
    }
    if !st.cfg.venues.iter().any(|e| e == v) {
        return Err(ApiError::venue_unavailable(format!("venue {v} is not enabled")));
    }
    // Jupiter routes only on mainnet liquidity (relayer 4b9a2a7), Bags exists only on mainnet
    // (v0.16): refused before any hold.
    if mainnet_only(v) && st.cfg.cluster != "mainnet-beta" {
        return Err(ApiError::venue_unavailable(format!("{v} is mainnet-only")));
    }
    Ok(v.to_string())
}

/// Venues without a devnet deployment.
pub(crate) fn mainnet_only(v: &str) -> bool {
    matches!(v, "jupiter" | "bags")
}

/// Known token facts from the public `tokens` table.
pub struct TokenFacts {
    pub venue: String,
    pub status: String,
    pub price_sol: String,
    pub decimals: i16,
    /// v0.13: NULL = SOL pair.
    pub quote_mint: Option<String>,
    /// v0.13: quote per whole token (decimal), when the relayer wrote it.
    pub price_quote: Option<String>,
}

async fn token_info(st: &AppState, mint: &str) -> ApiResult<Option<TokenFacts>> {
    let c = st.ledger.pg().get().await.map_err(unzeen_ledger::LedgerError::from)?;
    let r = c
        .query_opt(
            "SELECT venue, status, price_sol::text, decimals, quote_mint, price_quote::text FROM tokens WHERE mint = $1",
            &[&mint],
        )
        .await
        .map_err(unzeen_ledger::LedgerError::from)?;
    Ok(r.map(|r| TokenFacts {
        venue: r.get(0),
        status: r.get(1),
        price_sol: r.get(2),
        decimals: r.get(3),
        quote_mint: r.get(4),
        price_quote: r.get(5),
    }))
}

/// `graduated` for curve venues; a token known under another venue is a bad request.
async fn check_venue_status(st: &AppState, mint: &str, v: &str) -> ApiResult<Option<TokenFacts>> {
    match token_info(st, mint).await? {
        None => Ok(None),
        Some(t) => {
            if v != "jupiter" && t.venue != v {
                return Err(ApiError::bad_request(format!("token trades on {}, not {v}", t.venue)));
            }
            if t.status == "graduated" && v != "jupiter" {
                return Err(ApiError::graduated());
            }
            Ok(Some(t))
        }
    }
}

/// v0.13: is this a ZEC SPL pair (booked 1:1 in ZEC SPL units)? A pair whose quote is not
/// enabled is refused (`venue_unavailable`); USDC/USD1 pairs stay lamport-booked (None).
fn zec_pair<'a>(st: &'a AppState, t: Option<&TokenFacts>, v: &str) -> ApiResult<Option<&'a crate::config::QuoteCfg>> {
    let Some(q) = t.and_then(|t| t.quote_mint.as_deref()) else {
        return Ok(None);
    };
    let Some(cfg) = st.cfg.quotes.by_mint(q) else {
        return Err(ApiError::venue_unavailable("this token's quote pair is not enabled"));
    };
    if !cfg.is_zec() {
        return Ok(None);
    }
    if v == "jupiter" {
        return Err(ApiError::bad_request(
            "ZEC-pair tokens trade on their launchpad, not via jupiter",
        ));
    }
    Ok(Some(cfg))
}

/// ZEC SPL units per 1 ZEC with the parity spread (buy: fewer units per ZEC; sell: more).
pub fn zec_units_per_zec(spread_bps: u64, buy: bool) -> u64 {
    crate::rate::apply_spread(ZEC_SPL_UNITS, spread_bps, buy)
}

fn parity_used(applied: u64) -> RateUsed {
    RateUsed {
        lamports_per_zec: applied,
        source: "parity".into(),
        ts_ms: crate::rate::now_ms(),
    }
}

/// Estimated zat of `amount` base units at `price_quote` (decimal ZEC per whole token).
fn estimate_zat_zec(price_quote: &str, decimals: i16, amount: u128, units_per_zec: u64) -> Option<u64> {
    // sol_to_lamports gives price × 1e9; ZEC SPL has 8 decimals.
    let units_per_whole = crate::config::sol_to_lamports(&truncate_decimals(price_quote, 9))? / 10;
    let units = amount.checked_mul(units_per_whole as u128)? / 10u128.checked_pow(decimals.max(0) as u32)?;
    Some((units * 100_000_000 / (units_per_zec.max(1) as u128)).min(u64::MAX as u128) as u64)
}

async fn rate(st: &AppState) -> ApiResult<rate::Rate> {
    st.rate
        .get()
        .await
        .map_err(|_| ApiError::venue_unavailable("ZEC/SOL rate unavailable, retry later"))
}

fn used(r: &rate::Rate, applied: u64) -> RateUsed {
    RateUsed {
        lamports_per_zec: applied,
        source: r.source.into(),
        ts_ms: r.ts_ms,
    }
}

/// Estimated zat value of `amount` base units at `price_sol` (decimal SOL per whole token).
fn estimate_zat(price_sol: &str, decimals: i16, amount: u128, lamports_per_zec: u64) -> Option<u64> {
    let lamports_per_whole = crate::config::sol_to_lamports(&truncate_decimals(price_sol, 9))?;
    let lamports = amount.checked_mul(lamports_per_whole as u128)? / 10u128.checked_pow(decimals.max(0) as u32)?;
    let zat = lamports.checked_mul(100_000_000)? / (lamports_per_zec.max(1) as u128);
    Some(zat.min(u64::MAX as u128) as u64)
}

fn truncate_decimals(s: &str, n: usize) -> String {
    match s.split_once('.') {
        Some((i, f)) => format!("{i}.{}", &f[..f.len().min(n)]),
        None => s.to_string(),
    }
}

pub fn check_meta(m: &Meta) -> ApiResult<()> {
    let n = m.name.trim();
    if n.is_empty() || n.chars().count() > 32 || n.chars().any(char::is_control) {
        return Err(ApiError::bad_request("meta.name: 1..32 printable characters"));
    }
    let s = &m.symbol;
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(ApiError::bad_request("meta.symbol: 1..10 ASCII letters/digits"));
    }
    if let Some(img) = &m.image {
        let ok = [
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/webp;base64,",
        ]
        .iter()
        .find_map(|p| img.strip_prefix(p))
        .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
        .is_some_and(|bytes| !bytes.is_empty() && bytes.len() <= MAX_IMAGE_BYTES);
        if !ok {
            return Err(ApiError::bad_request(
                "meta.image: data:image/(png|jpeg|webp);base64,… up to 512 KiB",
            ));
        }
    }
    Ok(())
}

/// Split `amount` into `parts` non-equal positive pieces (±20 % around the mean).
pub fn split_amount(amount: u128, parts: u32) -> Vec<u128> {
    let parts = parts.max(1) as u128;
    let mean = amount / parts;
    let mut out = Vec::with_capacity(parts as usize);
    let mut left = amount;
    for i in 0..parts {
        let remaining_parts = parts - i;
        let v = if remaining_parts == 1 {
            left
        } else {
            // f64 jitter (53 bits) is enough for ±20 % of a 1e27 mean.
            let jitter = ((mean as f64) * 0.2 * (rand_unit() * 2.0 - 1.0)) as i128;
            let v = (mean as i128 + jitter).max(1) as u128;
            // Leave at least 1 per remaining part.
            v.min(left - (remaining_parts - 1))
        };
        out.push(v);
        left -= v;
    }
    out
}

/// D10: (zat charged, lamports to spend, scaled minOut) for a buy of `zec_in`. The SOL
/// amount is shaved 0–1 % and rounded down to 0.001 SOL so it does not reveal `zec_in`; the
/// user is charged only the ZEC equivalent of the lamports actually sent (the rest stays
/// available), and `minOut` shrinks in proportion (same minimum price).
pub fn fuzzed_buy(zec_in: u64, min_out: u128, applied: u64, min_action: u64) -> ApiResult<(u64, u64, u128)> {
    fuzzed_buy_step(zec_in, min_out, applied, min_action, rate::LAMPORTS_STEP)
}

/// [`fuzzed_buy`] with another rounding step (ZEC SPL pairs: 0.0001 ZEC).
pub fn fuzzed_buy_step(
    zec_in: u64,
    min_out: u128,
    applied: u64,
    min_action: u64,
    step: u64,
) -> ApiResult<(u64, u64, u128)> {
    let full = zat_to_lamports(zec_in, applied);
    let mut lamports = rate::fuzz_units(full, rand_unit(), step);
    // Never charge less than the minimum action because of rounding: step back up if possible.
    while lamports > 0 && lamports_to_zat_ceil(lamports, applied) < min_action {
        let up = lamports + step;
        if up > full {
            break;
        }
        lamports = up;
    }
    let zat = lamports_to_zat_ceil(lamports, applied).min(zec_in);
    if lamports == 0 || zat < min_action {
        return Err(ApiError::below_minimum(
            "zecIn too small (buys are rounded down to 0.001 SOL / 0.0001 ZEC)",
        ));
    }
    // minOut (token base units, u128) scaled by lamports/full ≤ 1: no overflow below 3.4e38/1.8e19.
    let min_out = min_out.saturating_mul(lamports as u128) / (full.max(1) as u128);
    Ok((zat, lamports, min_out))
}

pub async fn build(st: &AppState, pk: &[u8; 32], a: SignedAction) -> ApiResult<NewAction> {
    let exec = st.cfg.exec;
    let epoch = |mode: ExecMode| match mode {
        ExecMode::Now => 0.0,
        ExecMode::Delayed => st.epochs.delay(false),
        ExecMode::Max => st.epochs.delay(true),
    };
    let job = |op: JobOp, mode: ExecMode, delay_secs: f64| NewJob {
        exec_mode: mode.as_str(),
        ..NewJob::new(op, delay_secs)
    };
    // R-core-3: `now` costs a flat fee (PoolInfo.fees.nowFeeZat), part of the hold, not taken
    // out of lamports_in. It pays for the pool's priority lane, not for one tx's exact fee.
    let now_fee = |mode: ExecMode| {
        if mode == ExecMode::Now {
            st.cfg.fees.now_fee_zat
        } else {
            0
        }
    };
    let no_now = |mode: ExecMode| {
        if mode == ExecMode::Now {
            Err(ApiError::bad_request("exec: \"now\" is not available for withdrawals"))
        } else {
            Ok(())
        }
    };
    let spread_bps = st.cfg.rate.spread_bps;
    // D14: a stale quote (background refresh failing) doubles the spread.
    let spread = |r: &rate::Rate| {
        if r.stale {
            spread_bps.saturating_mul(2)
        } else {
            spread_bps
        }
    };
    let min_action = st.cfg.policy.min_action_zat;
    let base = |kind: &str| NewAction {
        kind: kind.into(),
        amount_zat: 0,
        fee_zat: 0,
        token_hold: None,
        rate: None,
        network: st.cfg.cluster.into(),
        jobs: vec![],
        payout: None,
        gain: None,
        quote_mint: None,
    };
    Ok(match a {
        SignedAction::Buy {
            venue: v,
            mint,
            zec_in,
            min_out,
            exec: mode,
        } => {
            let v = venue(st, &v)?;
            let mint = solana_address(&mint, "mint")?;
            let zec_in = positive(&zec_in, "zecIn")?;
            let min_out = parse_token_amount(&min_out, "minOut")?;
            if zec_in < min_action {
                return Err(ApiError::below_minimum("zecIn below PoolInfo.minActionZat"));
            }
            let known = check_venue_status(st, &mint, &v).await?;
            // No public price for a mint outside `tokens`: the user's own minOut is the only
            // protection, so it must be explicit (API v0.10).
            if known.is_none() && min_out == 0 {
                return Err(ApiError::bad_request(
                    "minOut required for a token without a pool price",
                ));
            }
            if let Some(q) = zec_pair(st, known.as_ref(), &v)? {
                // v0.13 ZEC SPL pair: 1:1 to ZEC, no SOL rate; job amounts in ZEC SPL units.
                let applied = zec_units_per_zec(st.cfg.quotes.zec_spread_bps, true);
                let (amount_zat, units, min_out) =
                    fuzzed_buy_step(zec_in, min_out, applied, min_action, ZEC_UNITS_STEP)?;
                let spot = known.as_ref().and_then(|t| {
                    let p = t.price_quote.as_deref()?;
                    let upw = crate::config::sol_to_lamports(&truncate_decimals(p, 9))? / 10;
                    crate::launch::tokens_at_spot(units, upw, t.decimals)
                });
                return Ok(NewAction {
                    gain: Some((mint.clone(), spot.map_or(min_out, u128::from).max(min_out))),
                    amount_zat,
                    fee_zat: now_fee(mode),
                    rate: Some(parity_used(applied)),
                    quote_mint: Some(q.mint.to_string()),
                    jobs: vec![NewJob {
                        venue: Some(v),
                        mint: Some(mint),
                        lamports_in: Some(units.into()),
                        min_out: Some(min_out),
                        ..job(JobOp::Buy, mode, epoch(mode))
                    }],
                    ..base("buy")
                });
            }
            let known = known.map(|t| (t.price_sol, t.decimals));
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread(&r), true);
            let (amount_zat, lamports, min_out) = fuzzed_buy(zec_in, min_out, applied, min_action)?;
            // Creator cap (v0.5): upper-bound token estimate; the ledger applies it only if
            // this key created the mint.
            let spot = known.and_then(|(p, d)| {
                let lpw = crate::config::sol_to_lamports(&truncate_decimals(&p, 9))?;
                crate::launch::tokens_at_spot(lamports, lpw, d)
            });
            let gain = crate::launch::buy_gain_estimate(
                &crate::rules_curve(st, &v).await?.0,
                lamports,
                spot,
                u64::try_from(min_out).unwrap_or(u64::MAX),
            );
            NewAction {
                gain: Some((mint.clone(), u128::from(gain).max(min_out))),
                amount_zat,
                fee_zat: now_fee(mode),
                rate: Some(used(&r, applied)),
                jobs: vec![NewJob {
                    venue: Some(v),
                    mint: Some(mint),
                    lamports_in: Some(lamports.into()),
                    min_out: Some(min_out),
                    ..job(JobOp::Buy, mode, epoch(mode))
                }],
                ..base("buy")
            }
        }
        SignedAction::Sell {
            venue: v,
            mint,
            amount,
            min_zec_out,
            exec: mode,
        } => {
            let v = venue(st, &v)?;
            let mint = solana_address(&mint, "mint")?;
            let amount = positive_tokens(&amount, "amount")?;
            let min_zec_out = parse_amount(&min_zec_out, "minZecOut")?;
            // A6: a sell that mirrors this key's public buy (±1 %) is shaved 0.5–2 % and
            // rounded to 3 significant digits (the rest stays available); minZecOut shrinks in
            // proportion (same minimum price). Other sells are left exact.
            // The minimum-action check keeps the signed floor (the shave must not turn a valid
            // sell into below_minimum).
            let signed_floor = min_zec_out;
            let (amount, min_zec_out) = if st.ledger.sell_mirrors_buy(pk, &mint, amount).await? {
                let a2 = fuzz_token_amount_rand(amount);
                if a2 == 0 {
                    return Err(ApiError::below_minimum("sell amount too small"));
                }
                // a2 ≤ amount, so m2 ≤ min_zec_out (a zat value).
                let m2 = ((min_zec_out as u128).saturating_mul(a2)).div_ceil(amount) as u64;
                (a2, m2)
            } else {
                (amount, min_zec_out)
            };
            let known = check_venue_status(st, &mint, &v).await?;
            if known.is_none() && min_zec_out == 0 {
                return Err(ApiError::bad_request(
                    "minZecOut required for a token without a pool price",
                ));
            }
            if let Some(q) = zec_pair(st, known.as_ref(), &v)? {
                // v0.13 ZEC SPL pair: proceeds in ZEC SPL units, credited 1:1 minus the spread.
                let applied = zec_units_per_zec(st.cfg.quotes.zec_spread_bps, false);
                let est = known
                    .as_ref()
                    .and_then(|t| estimate_zat_zec(t.price_quote.as_deref()?, t.decimals, amount, applied))
                    .unwrap_or(0);
                if signed_floor < min_action && est < min_action {
                    return Err(ApiError::below_minimum(
                        "sell value below PoolInfo.minActionZat (raise amount or minZecOut)",
                    ));
                }
                return Ok(NewAction {
                    fee_zat: now_fee(mode),
                    token_hold: Some((mint.clone(), amount)),
                    rate: Some(parity_used(applied)),
                    quote_mint: Some(q.mint.to_string()),
                    jobs: vec![NewJob {
                        venue: Some(v),
                        mint: Some(mint),
                        token_amount: Some(amount),
                        min_out: Some(zat_to_lamports_ceil(min_zec_out, applied).into()),
                        ..job(JobOp::Sell, mode, epoch(mode))
                    }],
                    ..base("sell")
                });
            }
            let known = known.map(|t| (t.price_sol, t.decimals));
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread(&r), false);
            // N7: sells are checked against the minimum too (by the signed floor, or by the
            // current price when the token is known).
            let est = known
                .and_then(|(p, d)| estimate_zat(&p, d, amount, applied))
                .unwrap_or(0);
            if signed_floor < min_action && est < min_action {
                return Err(ApiError::below_minimum(
                    "sell value below PoolInfo.minActionZat (raise amount or minZecOut)",
                ));
            }
            NewAction {
                fee_zat: now_fee(mode),
                token_hold: Some((mint.clone(), amount)),
                rate: Some(used(&r, applied)),
                jobs: vec![NewJob {
                    venue: Some(v),
                    mint: Some(mint),
                    token_amount: Some(amount),
                    min_out: Some(zat_to_lamports_ceil(min_zec_out, applied).into()),
                    ..job(JobOp::Sell, mode, epoch(mode))
                }],
                ..base("sell")
            }
        }
        SignedAction::Create {
            venue: v,
            meta,
            initial_buy_zec,
            exec: mode,
            quote,
            platform,
        } => {
            let v = venue(st, &v)?;
            if v == "jupiter" {
                return Err(ApiError::bad_request("create: jupiter is not a launchpad"));
            }
            check_meta(&meta)?;
            // v0.13: pair and LaunchLab platform.
            let quote = quote.unwrap_or_else(|| "SOL".into());
            if !["SOL", "USDC", "USD1", "ZEC"].contains(&quote.as_str()) {
                return Err(ApiError::bad_request("quote: SOL | USDC | USD1 | ZEC"));
            }
            let qcfg = if quote == "SOL" {
                None
            } else {
                let supported = crate::config::known_quotes(st.cfg.cluster == "mainnet-beta")
                    .into_iter()
                    .any(|q| q.quote == quote && q.venues.contains(&v.as_str()));
                if !supported {
                    return Err(ApiError::bad_request(format!(
                        "{v} has no {quote} pair on this network"
                    )));
                }
                Some(
                    st.cfg
                        .quotes
                        .for_venue(&quote, &v)
                        .ok_or_else(|| ApiError::venue_unavailable(format!("{quote} pairs are not enabled")))?,
                )
            };
            let platform = match (v.as_str(), platform) {
                ("raydium-launchlab", None) => Some("unzeen".to_string()),
                ("raydium-launchlab", Some(p)) if PLATFORMS.contains(&p.as_str()) => Some(p),
                ("raydium-launchlab", Some(_)) => {
                    return Err(ApiError::bad_request("platform: unzeen | bonk | stonk"));
                }
                (_, Some(_)) => return Err(ApiError::bad_request("platform: raydium-launchlab only")),
                (_, None) => None,
            };
            // D6: no relayer executes `create` yet; never take a hold that nobody settles.
            if !st.cfg.create_enabled {
                return Err(ApiError::venue_unavailable("create is not available yet"));
            }
            // A4 (final audit): without the relayer's Bags curve row (launch_curves) neither the
            // creator cap nor the first buy's min_out can be computed: refuse, never min_out 0.
            if v == "bags" && !crate::rules_curve(st, &v).await?.2 {
                return Err(ApiError::venue_unavailable(
                    "Bags launch curve not loaded yet, retry later",
                ));
            }
            let initial = match initial_buy_zec.as_deref() {
                Some(s) => parse_amount(s, "initialBuyZec")?,
                None => 0,
            };
            if initial > 0 && initial < min_action {
                return Err(ApiError::below_minimum("initialBuyZec below PoolInfo.minActionZat"));
            }
            let zec = qcfg.filter(|q| q.is_zec());
            let (applied, rate_used) = match zec {
                Some(_) => {
                    let a = zec_units_per_zec(st.cfg.quotes.zec_spread_bps, true);
                    (a, parity_used(a))
                }
                None => {
                    let r = rate(st).await?;
                    let a = apply_spread(r.lamports_per_zec, spread(&r), true);
                    (a, used(&r, a))
                }
            };
            // Creator cap (v0.5), checked on the requested amount before the random shave so
            // the answer is deterministic: initial buy within PoolInfo.launchRules.
            if initial > 0 && st.cfg.launch.cap_bps > 0 {
                let full = zat_to_lamports(initial, applied);
                let max = match zec {
                    Some(_) => crate::max_initial_buy_zec_units(st),
                    None => crate::max_initial_buy_for(st, &v).await?,
                };
                let step = if zec.is_some() {
                    ZEC_UNITS_STEP
                } else {
                    rate::LAMPORTS_STEP
                };
                if full - full % step > max {
                    return Err(ApiError::creator_cap());
                }
            }
            let step = if zec.is_some() {
                ZEC_UNITS_STEP
            } else {
                rate::LAMPORTS_STEP
            };
            let (amount_zat, lamports, _) = if initial > 0 {
                fuzzed_buy_step(initial, 0, applied, min_action, step)?
            } else {
                (0, 0, 0)
            };
            let mut m = json!({ "name": meta.name.trim(), "symbol": meta.symbol });
            if let Some(img) = meta.image {
                m["image"] = json!(img);
            }
            if let Some(q) = qcfg {
                m["quote"] = json!(q.quote);
            }
            if let Some(p) = platform {
                m["platform"] = json!(p);
            }
            let delay = epoch(mode);
            let mut jobs = Vec::with_capacity(2);
            if v == "bags" && lamports > 0 {
                // v0.16 (RELAYER v10): Bags' launch tx carries no first buy. The user's first
                // buy is a second job, `held` until the create is confirmed, then bought on the
                // pool through the vault pinned to the new mint. Not atomic: a sniper can buy
                // in between; min_out from the Bags curve bounds the price paid.
                let (curve, _, _) = crate::rules_curve(st, &v).await?;
                let min_out = u128::from(curve.tokens_out_initial(lamports) / 4 * 3);
                // RELAYER v10: the vault picked for the launch must also fund the first buy.
                m["reserve_lamports"] = json!(lamports);
                jobs.push(NewJob {
                    venue: Some(v.clone()),
                    lamports_in: Some(0u128),
                    min_out: Some(0),
                    meta: Some(m),
                    ..job(JobOp::Create, mode, delay)
                });
                jobs.push(NewJob {
                    venue: Some(v),
                    lamports_in: Some(lamports.into()),
                    min_out: Some(min_out),
                    held: true,
                    ..job(JobOp::Buy, mode, delay)
                });
            } else {
                jobs.push(NewJob {
                    venue: Some(v),
                    lamports_in: Some(lamports.into()),
                    min_out: Some(0),
                    meta: Some(m),
                    ..job(JobOp::Create, mode, delay)
                });
            }
            NewAction {
                amount_zat,
                fee_zat: st.cfg.fees.create_fee_zat + now_fee(mode),
                rate: Some(rate_used),
                quote_mint: zec.map(|q| q.mint.to_string()),
                jobs,
                ..base("create")
            }
        }
        SignedAction::WithdrawZec { to, amount, exec: mode } => {
            no_now(mode)?;
            check_ua(st, &to)?;
            let amount = positive(&amount, "amount")?;
            NewAction {
                amount_zat: amount,
                fee_zat: st.cfg.fees.withdraw_zec_fee_zat,
                payout: Some(NewPayout {
                    to_ua: to,
                    amount_zat: amount,
                    delay_secs: withdraw_delay(exec.zec_payout_delay_min_secs, exec.zec_payout_delay_max_secs, mode),
                }),
                ..base("withdraw_zec")
            }
        }
        SignedAction::WithdrawToken {
            mint,
            amount,
            to,
            smart,
            exec: mode,
        } => {
            no_now(mode)?;
            let mint = solana_address(&mint, "mint")?;
            let amount = positive_tokens(&amount, "amount")?;
            let dests: Vec<String> = match to {
                To::One(s) => vec![s],
                To::Many(v) => v,
            };
            let (parts, max_delay) = match &smart {
                Some(s) => {
                    if !(2..=5).contains(&s.parts) || !(1..=1440).contains(&s.max_delay_min) {
                        return Err(ApiError::bad_request("smart: parts 2..5, maxDelayMin 1..1440"));
                    }
                    (s.parts, f64::from(s.max_delay_min) * 60.0)
                }
                None => (1, exec.withdraw_token_delay_max_secs),
            };
            if dests.len() != parts as usize {
                return Err(ApiError::bad_request(
                    "to: one address per part (length of `to` = smart.parts)",
                ));
            }
            let mut seen = std::collections::HashSet::new();
            for d in &dests {
                solana_address(d, "to")?;
                if !seen.insert(d.as_str()) {
                    return Err(ApiError::bad_request("to: addresses must be distinct"));
                }
            }
            if amount < u128::from(parts) {
                return Err(ApiError::bad_request("amount smaller than the number of parts"));
            }
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread(&r), true);
            let f = st.cfg.fees;
            let cost = u64::from(parts) * (f.withdraw_token_gas_lamports + f.withdraw_token_cost_lamports);
            let min_delay = exec.withdraw_token_delay_min_secs.min(max_delay);
            // A1: always shaved 0.5–2 % and every part rounded down to 3 significant digits:
            // no part (nor their sum) equals a public buy. The remainder stays available.
            let total = fuzz_token_amount_rand(amount);
            let split: Vec<u128> = split_amount(total, parts).into_iter().map(quantize_min_out).collect();
            if total < u128::from(parts) || split.contains(&0) {
                return Err(ApiError::bad_request("amount too small to withdraw"));
            }
            let amount: u128 = split.iter().sum();
            let jobs = split
                .into_iter()
                .zip(dests)
                .map(|(n, d)| NewJob {
                    mint: Some(mint.clone()),
                    token_amount: Some(n),
                    dest: Some(d),
                    gas_lamports: Some(f.withdraw_token_gas_lamports),
                    ..job(JobOp::Transfer, mode, withdraw_delay(min_delay, max_delay, mode))
                })
                .collect();
            NewAction {
                fee_zat: lamports_to_zat_ceil(cost, applied),
                token_hold: Some((mint, amount)),
                rate: Some(used(&r, applied)),
                jobs,
                ..base("withdraw_token")
            }
        }
        // `claim` is handled before `build` (crate::creator_fees); unreachable here.
        SignedAction::Claim { .. }
        | SignedAction::OrderCreate {}
        | SignedAction::OrderCancel {}
        | SignedAction::Chat {} => {
            return Err(ApiError::bad_request("op not supported yet"));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_are_canonical() {
        assert_eq!(parse_amount("0", "x").unwrap(), 0);
        assert_eq!(parse_amount("100000", "x").unwrap(), 100_000);
        for bad in ["", "01", "-1", "+1", "1.0", " 1", "1e5", "9223372036854775808", "abc"] {
            assert!(parse_amount(bad, "x").is_err(), "{bad}");
        }
    }

    #[test]
    fn token_amounts_are_not_u64() {
        // v0.18: 18-decimal ERC-20 amounts (1e27 base units) and everything up to 38 digits.
        assert_eq!(
            parse_token_amount("1000000000000000000000000000", "x").unwrap(),
            10u128.pow(27)
        );
        assert_eq!(
            parse_token_amount("18446744073709551616", "x").unwrap(),
            u64::MAX as u128 + 1
        );
        let max = "9".repeat(TOKEN_AMOUNT_MAX_DIGITS);
        assert_eq!(parse_token_amount(&max, "x").unwrap(), 10u128.pow(38) - 1);
        assert!(i128::try_from(parse_token_amount(&max, "x").unwrap()).is_ok());
        for bad in [
            "",
            "01",
            "-1",
            "1.5",
            "1e27",
            &"1".repeat(39),
            "340282366920938463463374607431768211456",
        ] {
            assert!(parse_token_amount(bad, "x").is_err(), "{bad}");
        }
        assert!(positive_tokens("0", "x").is_err());
        // Splits and estimates of 1e27 stay exact sums and do not overflow.
        let v = split_amount(10u128.pow(27), 4);
        assert_eq!(v.iter().sum::<u128>(), 10u128.pow(27));
        assert!(v.iter().all(|x| *x > 0));
        // 1e27 base units, 18 decimals = 1e9 whole tokens at 1e-9 SOL = 1 SOL; 10 SOL/ZEC.
        assert_eq!(
            estimate_zat("0.000000001", 18, 10u128.pow(27), 10_000_000_000),
            Some(10_000_000)
        );
    }

    #[test]
    fn split_sums() {
        for parts in 1..=5 {
            for amount in [parts as u128, 7, 1_000, 123_456_789] {
                if amount < parts as u128 {
                    continue;
                }
                let v = split_amount(amount, parts);
                assert_eq!(v.len(), parts as usize);
                assert_eq!(v.iter().sum::<u128>(), amount);
                assert!(v.iter().all(|x| *x > 0));
            }
        }
    }

    #[test]
    fn estimate() {
        // 1e-6 SOL per whole token, 6 decimals, 1e12 base units = 1e6 tokens = 1 SOL; 10 SOL/ZEC.
        assert_eq!(
            estimate_zat("0.000001", 6, 1_000_000_000_000, 10_000_000_000),
            Some(10_000_000)
        );
        assert_eq!(estimate_zat("0.00000000012345", 6, 1, 1), Some(0));
    }

    #[test]
    fn fuzzed_buy_charges_only_what_is_spent() {
        let rate = 11_532_100_000; // lamports per ZEC
        for _ in 0..200 {
            let (zat, lamports, min_out) = fuzzed_buy(50_000_000, 1_000_000, rate, 100_000).unwrap();
            assert_eq!(lamports % rate::LAMPORTS_STEP, 0);
            assert!((49_400_000..=50_000_000).contains(&zat), "{zat}");
            assert!(lamports_to_zat_ceil(lamports, rate) == zat);
            assert!(zat_to_lamports(zat, rate) >= lamports);
            assert!((980_000..=1_000_000).contains(&min_out), "{min_out}");
        }
        // Too small to round to 0.001 SOL at all.
        assert!(fuzzed_buy(5_000, 0, rate, 1_000).is_err());
        // Right at the minimum: never charged below it.
        for _ in 0..200 {
            if let Ok((zat, _, _)) = fuzzed_buy(100_000, 0, rate, 100_000) {
                assert!(zat >= 100_000);
            }
        }
    }

    #[test]
    fn epochs_batch_actions_on_shared_boundaries() {
        let cfg = crate::config::ExecConfig {
            epoch_min_secs: 30.0,
            epoch_max_secs: 60.0,
            max_epoch_min_secs: 300.0,
            max_epoch_max_secs: 900.0,
            withdraw_token_delay_min_secs: 30.0,
            withdraw_token_delay_max_secs: 300.0,
            zec_payout_delay_min_secs: 60.0,
            zec_payout_delay_max_secs: 600.0,
        };
        let e = Epochs::new(&cfg);
        let t0 = unix_now();
        let d0 = e.delay_at(false, t0);
        assert!(d0 > 0.0 && d0 <= 60.0);
        // Two actions in the same epoch share the boundary.
        let d1 = e.delay_at(false, t0 + d0 / 2.0);
        assert!((t0 + d0 - (t0 + d0 / 2.0 + d1)).abs() < 1e-6);
        // After the boundary: the next one is 30..60 s later.
        let d2 = e.delay_at(false, t0 + d0 + 0.001);
        assert!((29.9..=60.0).contains(&d2), "{d2}");
        // Idle for a day: still a boundary within one gap.
        let d3 = e.delay_at(false, t0 + 86_400.0);
        assert!(d3 > 0.0 && d3 <= 60.0, "{d3}");
        let m = e.delay_at(true, t0);
        assert!(m > 0.0 && m <= 900.0);
    }

    #[test]
    fn exec_field() {
        let a: SignedAction = serde_json::from_str(
            r#"{"op":"sell","venue":"pumpfun","mint":"m","amount":"1","minZecOut":"1","exec":"max"}"#,
        )
        .unwrap();
        assert!(matches!(
            a,
            SignedAction::Sell {
                exec: ExecMode::Max,
                ..
            }
        ));
        // Optional everywhere, default `delayed`.
        let a: SignedAction =
            serde_json::from_str(r#"{"op":"buy","venue":"pumpfun","mint":"m","zecIn":"1","minOut":"1"}"#).unwrap();
        assert!(matches!(
            a,
            SignedAction::Buy {
                exec: ExecMode::Delayed,
                ..
            }
        ));
        let a: SignedAction = serde_json::from_str(r#"{"op":"withdraw_zec","to":"u","amount":"1"}"#).unwrap();
        assert!(matches!(
            a,
            SignedAction::WithdrawZec {
                exec: ExecMode::Delayed,
                ..
            }
        ));
        for bad in ["slow", "fast", "NOW", ""] {
            let body = format!(r#"{{"op":"withdraw_zec","to":"u","amount":"1","exec":"{bad}"}}"#);
            assert!(serde_json::from_str::<SignedAction>(&body).is_err(), "{bad}");
        }
        assert!(
            serde_json::from_str::<SignedAction>(r#"{"op":"withdraw_zec","to":"u","amount":"1","privacy":"max"}"#)
                .is_err()
        );
        assert_eq!(ExecMode::Now.as_str(), "now");
    }

    #[test]
    fn body_parsing() {
        let ok: SignedAction = serde_json::from_str(
            r#"{"op":"buy","venue":"pumpfun","mint":"So11111111111111111111111111111111111111112","zecIn":"1000000","minOut":"1","exec":"delayed"}"#,
        )
        .unwrap();
        assert!(matches!(ok, SignedAction::Buy { .. }));
        assert!(
            serde_json::from_str::<SignedAction>(
                r#"{"op":"buy","venue":"pumpfun","mint":"x","zecIn":"1","minOut":"1","exec":"now","extra":1}"#
            )
            .is_err()
        );
        assert!(serde_json::from_str::<SignedAction>(r#"{"op":"nope"}"#).is_err());
        let w: SignedAction = serde_json::from_str(
            r#"{"op":"withdraw_token","mint":"m","amount":"5","to":["a","b"],"smart":{"parts":2,"maxDelayMin":5},"exec":"delayed"}"#,
        )
        .unwrap();
        assert!(matches!(w, SignedAction::WithdrawToken { to: To::Many(_), .. }));
    }
}

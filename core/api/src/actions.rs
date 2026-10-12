//! `SignedAction` body → ledger `NewAction` (validation, amounts, jitter).

use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;
use unzeen_ledger::{JobOp, NewAction, NewJob, NewPayout, RateUsed};
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

const VENUES: [&str; 3] = ["pumpfun", "meteora-dbc", "jupiter"];
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
        return Err(ApiError::bad_request("venue: expected pumpfun | meteora-dbc | jupiter"));
    }
    if !st.cfg.venues.iter().any(|e| e == v) {
        return Err(ApiError::venue_unavailable(format!("venue {v} is not enabled")));
    }
    Ok(v.to_string())
}

/// Known token facts from the public `tokens` table: (venue, status, price_sol, decimals).
async fn token_info(st: &AppState, mint: &str) -> ApiResult<Option<(String, String, String, i16)>> {
    let c = st.ledger.pg().get().await.map_err(unzeen_ledger::LedgerError::from)?;
    let r = c
        .query_opt(
            "SELECT venue, status, price_sol::text, decimals FROM tokens WHERE mint = $1",
            &[&mint],
        )
        .await
        .map_err(unzeen_ledger::LedgerError::from)?;
    Ok(r.map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))))
}

/// `graduated` for curve venues; a token known under another venue is a bad request.
async fn check_venue_status(st: &AppState, mint: &str, v: &str) -> ApiResult<Option<(String, i16)>> {
    match token_info(st, mint).await? {
        None => Ok(None),
        Some((tv, status, price, dec)) => {
            if v != "jupiter" && tv != v {
                return Err(ApiError::bad_request(format!("token trades on {tv}, not {v}")));
            }
            if status == "graduated" && v != "jupiter" {
                return Err(ApiError::graduated());
            }
            Ok(Some((price, dec)))
        }
    }
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
fn estimate_zat(price_sol: &str, decimals: i16, amount: u64, lamports_per_zec: u64) -> Option<u64> {
    let lamports_per_whole = crate::config::sol_to_lamports(&truncate_decimals(price_sol, 9))?;
    let lamports = (amount as u128) * (lamports_per_whole as u128) / 10u128.checked_pow(decimals.max(0) as u32)?;
    let zat = lamports * 100_000_000 / (lamports_per_zec.max(1) as u128);
    Some(zat.min(u64::MAX as u128) as u64)
}

fn truncate_decimals(s: &str, n: usize) -> String {
    match s.split_once('.') {
        Some((i, f)) => format!("{i}.{}", &f[..f.len().min(n)]),
        None => s.to_string(),
    }
}

fn check_meta(m: &Meta) -> ApiResult<()> {
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
pub fn split_amount(amount: u64, parts: u32) -> Vec<u64> {
    let parts = parts.max(1) as u64;
    let mean = amount / parts;
    let mut out = Vec::with_capacity(parts as usize);
    let mut left = amount;
    for i in 0..parts {
        let remaining_parts = parts - i;
        let v = if remaining_parts == 1 {
            left
        } else {
            let jitter = ((mean as f64) * 0.2 * (rand_unit() * 2.0 - 1.0)) as i64;
            let v = (mean as i64 + jitter).max(1) as u64;
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
pub fn fuzzed_buy(zec_in: u64, min_out: u64, applied: u64, min_action: u64) -> ApiResult<(u64, u64, u64)> {
    let full = zat_to_lamports(zec_in, applied);
    let mut lamports = rate::fuzz_lamports(full, rand_unit());
    // Never charge less than the minimum action because of rounding: step back up if possible.
    while lamports > 0 && lamports_to_zat_ceil(lamports, applied) < min_action {
        let up = lamports + rate::LAMPORTS_STEP;
        if up > full {
            break;
        }
        lamports = up;
    }
    let zat = lamports_to_zat_ceil(lamports, applied).min(zec_in);
    if lamports == 0 || zat < min_action {
        return Err(ApiError::below_minimum(
            "zecIn too small (buys are rounded down to 0.001 SOL)",
        ));
    }
    let min_out = ((min_out as u128) * (lamports as u128) / (full.max(1) as u128)) as u64;
    Ok((zat, lamports, min_out))
}

pub async fn build(st: &AppState, a: SignedAction) -> ApiResult<NewAction> {
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
            let min_out = parse_amount(&min_out, "minOut")?;
            if zec_in < min_action {
                return Err(ApiError::below_minimum("zecIn below PoolInfo.minActionZat"));
            }
            let known = check_venue_status(st, &mint, &v).await?;
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread(&r), true);
            let (amount_zat, lamports, min_out) = fuzzed_buy(zec_in, min_out, applied, min_action)?;
            // Creator cap (v0.5): upper-bound token estimate; the ledger applies it only if
            // this key created the mint.
            let spot = known.and_then(|(p, d)| {
                let lpw = crate::config::sol_to_lamports(&truncate_decimals(&p, 9))?;
                crate::launch::tokens_at_spot(lamports, lpw, d)
            });
            let gain = crate::launch::buy_gain_estimate(&st.cfg.launch.curve(), lamports, spot, min_out);
            NewAction {
                gain: Some((mint.clone(), gain)),
                amount_zat,
                fee_zat: now_fee(mode),
                rate: Some(used(&r, applied)),
                jobs: vec![NewJob {
                    venue: Some(v),
                    mint: Some(mint),
                    lamports_in: Some(lamports),
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
            let amount = positive(&amount, "amount")?;
            let min_zec_out = parse_amount(&min_zec_out, "minZecOut")?;
            let known = check_venue_status(st, &mint, &v).await?;
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread(&r), false);
            // N7: sells are checked against the minimum too (by the signed floor, or by the
            // current price when the token is known).
            let est = known
                .and_then(|(p, d)| estimate_zat(&p, d, amount, applied))
                .unwrap_or(0);
            if min_zec_out < min_action && est < min_action {
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
                    min_out: Some(zat_to_lamports_ceil(min_zec_out, applied)),
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
        } => {
            let v = venue(st, &v)?;
            if v == "jupiter" {
                return Err(ApiError::bad_request("create: jupiter is not a launchpad"));
            }
            check_meta(&meta)?;
            // D6: no relayer executes `create` yet; never take a hold that nobody settles.
            if !st.cfg.create_enabled {
                return Err(ApiError::venue_unavailable("create is not available yet"));
            }
            let initial = match initial_buy_zec.as_deref() {
                Some(s) => parse_amount(s, "initialBuyZec")?,
                None => 0,
            };
            if initial > 0 && initial < min_action {
                return Err(ApiError::below_minimum("initialBuyZec below PoolInfo.minActionZat"));
            }
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread(&r), true);
            // Creator cap (v0.5), checked on the requested amount before the random shave so
            // the answer is deterministic: initial buy within PoolInfo.launchRules.
            if initial > 0 && st.cfg.launch.cap_bps > 0 {
                let full = zat_to_lamports(initial, applied);
                if full - full % rate::LAMPORTS_STEP > crate::max_initial_buy_lamports(&st.cfg.launch) {
                    return Err(ApiError::creator_cap());
                }
            }
            let (amount_zat, lamports, _) = if initial > 0 {
                fuzzed_buy(initial, 0, applied, min_action)?
            } else {
                (0, 0, 0)
            };
            let mut m = json!({ "name": meta.name.trim(), "symbol": meta.symbol });
            if let Some(img) = meta.image {
                m["image"] = json!(img);
            }
            NewAction {
                amount_zat,
                fee_zat: st.cfg.fees.create_fee_zat + now_fee(mode),
                rate: Some(used(&r, applied)),
                jobs: vec![NewJob {
                    venue: Some(v),
                    lamports_in: Some(lamports),
                    min_out: Some(0),
                    meta: Some(m),
                    ..job(JobOp::Create, mode, epoch(mode))
                }],
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
            let amount = positive(&amount, "amount")?;
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
            if amount < u64::from(parts) {
                return Err(ApiError::bad_request("amount smaller than the number of parts"));
            }
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread(&r), true);
            let f = st.cfg.fees;
            let cost = u64::from(parts) * (f.withdraw_token_gas_lamports + f.withdraw_token_cost_lamports);
            let min_delay = exec.withdraw_token_delay_min_secs.min(max_delay);
            let jobs = split_amount(amount, parts)
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
    fn split_sums() {
        for parts in 1..=5 {
            for amount in [parts as u64, 7, 1_000, 123_456_789] {
                if amount < parts as u64 {
                    continue;
                }
                let v = split_amount(amount, parts);
                assert_eq!(v.len(), parts as usize);
                assert_eq!(v.iter().sum::<u64>(), amount);
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

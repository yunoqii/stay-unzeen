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
    },
    Sell {
        venue: String,
        mint: String,
        amount: String,
        #[serde(rename = "minZecOut")]
        min_zec_out: String,
    },
    Create {
        venue: String,
        meta: Meta,
        #[serde(rename = "initialBuyZec")]
        initial_buy_zec: Option<String>,
    },
    WithdrawZec {
        to: String,
        amount: String,
    },
    WithdrawToken {
        mint: String,
        amount: String,
        to: To,
        smart: Option<Smart>,
    },
    Claim {
        #[allow(dead_code)]
        mint: Option<String>,
    },
    OrderCreate {},
    OrderCancel {},
    Chat {},
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

pub async fn build(st: &AppState, a: SignedAction) -> ApiResult<NewAction> {
    let exec = st.cfg.exec;
    let jitter = || delay(exec.jitter_min_secs, exec.jitter_max_secs);
    let spread = st.cfg.rate.spread_bps;
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
    };
    Ok(match a {
        SignedAction::Buy {
            venue: v,
            mint,
            zec_in,
            min_out,
        } => {
            let v = venue(st, &v)?;
            let mint = solana_address(&mint, "mint")?;
            let zec_in = positive(&zec_in, "zecIn")?;
            let min_out = parse_amount(&min_out, "minOut")?;
            if zec_in < min_action {
                return Err(ApiError::below_minimum("zecIn below PoolInfo.minActionZat"));
            }
            check_venue_status(st, &mint, &v).await?;
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread, true);
            let lamports = zat_to_lamports(zec_in, applied);
            if lamports == 0 {
                return Err(ApiError::below_minimum("zecIn too small"));
            }
            NewAction {
                amount_zat: zec_in,
                rate: Some(used(&r, applied)),
                jobs: vec![NewJob {
                    venue: Some(v),
                    mint: Some(mint),
                    lamports_in: Some(lamports),
                    min_out: Some(min_out),
                    ..NewJob::new(JobOp::Buy, jitter())
                }],
                ..base("buy")
            }
        }
        SignedAction::Sell {
            venue: v,
            mint,
            amount,
            min_zec_out,
        } => {
            let v = venue(st, &v)?;
            let mint = solana_address(&mint, "mint")?;
            let amount = positive(&amount, "amount")?;
            let min_zec_out = parse_amount(&min_zec_out, "minZecOut")?;
            let known = check_venue_status(st, &mint, &v).await?;
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread, false);
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
                token_hold: Some((mint.clone(), amount)),
                rate: Some(used(&r, applied)),
                jobs: vec![NewJob {
                    venue: Some(v),
                    mint: Some(mint),
                    token_amount: Some(amount),
                    min_out: Some(zat_to_lamports_ceil(min_zec_out, applied)),
                    ..NewJob::new(JobOp::Sell, jitter())
                }],
                ..base("sell")
            }
        }
        SignedAction::Create {
            venue: v,
            meta,
            initial_buy_zec,
        } => {
            let v = venue(st, &v)?;
            if v == "jupiter" {
                return Err(ApiError::bad_request("create: jupiter is not a launchpad"));
            }
            check_meta(&meta)?;
            let initial = match initial_buy_zec.as_deref() {
                Some(s) => parse_amount(s, "initialBuyZec")?,
                None => 0,
            };
            if initial > 0 && initial < min_action {
                return Err(ApiError::below_minimum("initialBuyZec below PoolInfo.minActionZat"));
            }
            let r = rate(st).await?;
            let applied = apply_spread(r.lamports_per_zec, spread, true);
            let mut m = json!({ "name": meta.name.trim(), "symbol": meta.symbol });
            if let Some(img) = meta.image {
                m["image"] = json!(img);
            }
            NewAction {
                amount_zat: initial,
                fee_zat: st.cfg.fees.create_fee_zat,
                rate: Some(used(&r, applied)),
                jobs: vec![NewJob {
                    venue: Some(v),
                    lamports_in: Some(zat_to_lamports(initial, applied)),
                    min_out: Some(0),
                    meta: Some(m),
                    ..NewJob::new(JobOp::Create, jitter())
                }],
                ..base("create")
            }
        }
        SignedAction::WithdrawZec { to, amount } => {
            check_ua(st, &to)?;
            let amount = positive(&amount, "amount")?;
            NewAction {
                amount_zat: amount,
                fee_zat: st.cfg.fees.withdraw_zec_fee_zat,
                payout: Some(NewPayout {
                    to_ua: to,
                    amount_zat: amount,
                    delay_secs: delay(exec.zec_payout_delay_min_secs, exec.zec_payout_delay_max_secs),
                }),
                ..base("withdraw_zec")
            }
        }
        SignedAction::WithdrawToken {
            mint,
            amount,
            to,
            smart,
        } => {
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
            let applied = apply_spread(r.lamports_per_zec, spread, true);
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
                    ..NewJob::new(JobOp::Transfer, delay(min_delay, max_delay))
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
    fn body_parsing() {
        let ok: SignedAction = serde_json::from_str(
            r#"{"op":"buy","venue":"pumpfun","mint":"So11111111111111111111111111111111111111112","zecIn":"1000000","minOut":"1"}"#,
        )
        .unwrap();
        assert!(matches!(ok, SignedAction::Buy { .. }));
        assert!(
            serde_json::from_str::<SignedAction>(
                r#"{"op":"buy","venue":"pumpfun","mint":"x","zecIn":"1","minOut":"1","extra":1}"#
            )
            .is_err()
        );
        assert!(serde_json::from_str::<SignedAction>(r#"{"op":"nope"}"#).is_err());
        let w: SignedAction = serde_json::from_str(
            r#"{"op":"withdraw_token","mint":"m","amount":"5","to":["a","b"],"smart":{"parts":2,"maxDelayMin":5}}"#,
        )
        .unwrap();
        assert!(matches!(w, SignedAction::WithdrawToken { to: To::Many(_), .. }));
    }
}

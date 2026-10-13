//! Private orders (API.md v0.8; v0.15 bracket + re-arm): `order_create` / `order_cancel`, `Portfolio.orders`,
//! `PoolInfo.orders` and the evaluator loop (price only from the indexer tick, never RPC).
//!
//! Logs: counts only — never mint, price, order id or time of an order.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use unzeen_ledger::{
    RateUsed,
    orders::{self as lo, EvalParams, NewOrder, OrderRow},
};

use crate::{
    AppState,
    actions::{parse_amount, parse_token_amount, solana_address},
    error::{ApiError, ApiResult},
    rate::{apply_spread, zat_to_lamports},
};

pub const KINDS: [&str; 5] = ["limit_buy", "limit_sell", "take_profit", "stop_loss", "bracket"];
pub const MAX_TTL_SECS: u64 = 259_200;
pub const DEFAULT_TTL_SECS: u64 = 86_400;

pub fn default_slippage(kind: &str) -> u32 {
    if kind == "stop_loss" { 1_500 } else { 500 }
}

// Parsed once per request and dropped: the size difference does not matter.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum OrderOp {
    OrderCreate {
        venue: String,
        mint: String,
        kind: String,
        #[serde(rename = "triggerPriceSol")]
        trigger_price_sol: Option<String>,
        /// v0.15 bracket legs.
        #[serde(rename = "tpPriceSol")]
        tp_price_sol: Option<String>,
        #[serde(rename = "slPriceSol")]
        sl_price_sol: Option<String>,
        #[serde(rename = "slSlippageBps")]
        sl_slippage_bps: Option<u32>,
        rearm: Option<bool>,
        amount: String,
        #[serde(rename = "slippageBps")]
        slippage_bps: Option<u32>,
        #[serde(rename = "ttlSecs")]
        ttl_secs: Option<u64>,
        exec: Option<String>,
    },
    OrderCancel {
        #[serde(rename = "orderId")]
        order_id: String,
    },
}

pub fn is_order_op(v: &Value) -> bool {
    v.get("op")
        .and_then(Value::as_str)
        .is_some_and(|o| o.starts_with("order_"))
}

/// Positive decimal, ≤ 18 fractional digits, ≤ 18 significant digits; canonical form.
pub fn check_price(s: &str) -> ApiResult<String> {
    let bad = || ApiError::bad_request("triggerPriceSol: positive decimal, up to 18 significant digits");
    let e18 = lo::parse_e18(s).filter(|v| *v > 0).ok_or_else(bad)?;
    let digits = s.trim_start_matches(['0', '.']).replace('.', "");
    if digits.trim_end_matches('0').len() > 18 {
        return Err(bad());
    }
    let (i, f) = (e18 / 10u128.pow(18), e18 % 10u128.pow(18));
    let f = format!("{f:018}");
    let f = f.trim_end_matches('0');
    Ok(if f.is_empty() {
        i.to_string()
    } else {
        format!("{i}.{f}")
    })
}

fn rate(st: &AppState, r: &crate::rate::Rate, buy: bool) -> RateUsed {
    let spread = if r.stale {
        st.cfg.rate.spread_bps.saturating_mul(2)
    } else {
        st.cfg.rate.spread_bps
    };
    RateUsed {
        lamports_per_zec: apply_spread(r.lamports_per_zec, spread, buy),
        source: r.source.into(),
        ts_ms: r.ts_ms,
    }
}

fn unsupported() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "order_unsupported_mint",
        "orders only for pump.fun tokens the pool has traded, on the curve",
    )
}

/// A checked order request (also built by the scenario executor for `order_place`).
// Built once per request and consumed right away: the size difference does not matter.
#[allow(clippy::large_enum_variant)]
pub enum OrderReq {
    Create(NewOrder),
    Cancel([u8; 16]),
}

pub async fn submit(st: &AppState, raw: Value, pk: &[u8; 32], nonce: &[u8; 16], hash: &[u8; 32]) -> ApiResult<Value> {
    match parse(st, raw).await? {
        OrderReq::Cancel(id) => {
            let r = st.ledger.order_cancel(pk, nonce, hash, &id).await?;
            Ok(json!({ "id": hex::encode(r.id), "status": r.status }))
        }
        OrderReq::Create(o) => {
            let rec = st.ledger.order_create(pk, nonce, hash, &o).await?;
            Ok(json!({ "id": hex::encode(rec.id), "status": rec.status }))
        }
    }
}

/// Parse and check `order_create` / `order_cancel` (prices, amounts, minimum value, creator cap
/// estimate) exactly as a signed request is checked.
pub async fn parse(st: &AppState, raw: Value) -> ApiResult<OrderReq> {
    let op: OrderOp = serde_json::from_value(raw).map_err(|_| ApiError::bad_request("invalid action body"))?;
    match op {
        OrderOp::OrderCancel { order_id } => {
            let id: [u8; 16] = (order_id.len() == 32
                && order_id.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
            .then(|| hex::decode(&order_id).ok())
            .flatten()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(ApiError::not_found)?;
            Ok(OrderReq::Cancel(id))
        }
        OrderOp::OrderCreate {
            venue,
            mint,
            kind,
            trigger_price_sol,
            tp_price_sol,
            sl_price_sol,
            sl_slippage_bps,
            rearm,
            amount,
            slippage_bps,
            ttl_secs,
            exec,
        } => {
            if venue != "pumpfun" {
                return Err(unsupported());
            }
            if !KINDS.contains(&kind.as_str()) {
                return Err(ApiError::bad_request(
                    "kind: limit_buy | limit_sell | take_profit | stop_loss | bracket",
                ));
            }
            let exec = match exec.as_deref() {
                None | Some("delayed") => "delayed",
                Some("max") => "max",
                _ => {
                    return Err(ApiError::bad_request(
                        "exec: \"delayed\" | \"max\" (\"now\" is not available for orders)",
                    ));
                }
            };
            let mint = solana_address(&mint, "mint")?;
            let bracket = kind == "bracket";
            // v0.15: a bracket has tpPriceSol + slPriceSol and no triggerPriceSol; the rest the reverse.
            let (trigger, sl) = match (bracket, trigger_price_sol, tp_price_sol, sl_price_sol, sl_slippage_bps) {
                (false, Some(t), None, None, None) => (check_price(&t)?, None),
                (true, None, Some(tp), Some(sl), _) => {
                    let (tp, sl) = (check_price(&tp)?, check_price(&sl)?);
                    if lo::parse_e18(&sl) >= lo::parse_e18(&tp) {
                        return Err(ApiError::bad_request("slPriceSol must be below tpPriceSol"));
                    }
                    (tp, Some(sl))
                }
                (true, ..) => {
                    return Err(ApiError::bad_request(
                        "bracket: tpPriceSol and slPriceSol (no triggerPriceSol)",
                    ));
                }
                _ => {
                    return Err(ApiError::bad_request(
                        "triggerPriceSol required; tpPriceSol/slPriceSol/slSlippageBps only for bracket",
                    ));
                }
            };
            // limit_buy: zat (i64 range); sell kinds: token base units (v0.18, up to 38 digits).
            let amount: u128 = if kind == "limit_buy" {
                u128::from(parse_amount(&amount, "amount")?)
            } else {
                crate::actions::token_cap(st, parse_token_amount(&amount, "amount")?, "amount")?
            };
            if amount == 0 {
                return Err(ApiError::bad_request("amount must be > 0"));
            }
            let slip = slippage_bps.unwrap_or_else(|| default_slippage(&kind));
            let sl_slip = bracket.then(|| sl_slippage_bps.unwrap_or_else(|| default_slippage("stop_loss")));
            if !(50..=5_000).contains(&slip) || sl_slip.is_some_and(|v| !(50..=5_000).contains(&v)) {
                return Err(ApiError::bad_request("slippageBps / slSlippageBps: 50..5000"));
            }
            let ttl = ttl_secs.unwrap_or(DEFAULT_TTL_SECS);
            if !(3_600..=MAX_TTL_SECS).contains(&ttl) {
                return Err(ApiError::bad_request("ttlSecs: 3600..259200"));
            }
            let (tv, tstatus, dec, _price) = st.ledger.order_mint_info(&mint).await?.ok_or_else(unsupported)?;
            if tv != "pumpfun" || tstatus != "curve" {
                return Err(unsupported());
            }
            let r = st
                .rate
                .get()
                .await
                .map_err(|_| ApiError::venue_unavailable("ZEC/SOL rate unavailable, retry later"))?;
            // Value checks use the lowest exit price: the SL leg of a bracket.
            let e18 = lo::parse_e18(sl.as_deref().unwrap_or(&trigger))
                .ok_or_else(|| ApiError::bad_request("triggerPriceSol"))?;
            let buy = kind == "limit_buy";
            let min_action = st.cfg.policy.min_action_zat;
            let gain = if buy {
                // Creator cap: upper-bound tokens for this buy (initial curve, or the trigger price).
                let zat = u64::try_from(amount).map_err(|_| ApiError::bad_request("amount"))?;
                let lamports = zat_to_lamports(zat, rate(st, &r, true).lamports_per_zec);
                let lpw = e18 / 1_000_000_000;
                let spot = crate::launch::tokens_at_spot(lamports, lpw.max(1), dec);
                let curve = crate::rules_curve(st, "pumpfun").await?.0;
                Some(crate::launch::buy_gain_estimate(&curve, lamports, spot, 0))
            } else {
                // Sell value at the trigger price must reach the minimum action.
                let lamports = lo::sell_min_out(amount, e18, dec.clamp(0, 18) as u32, 0).unwrap_or(0);
                let zat = lamports.saturating_mul(100_000_000) / (rate(st, &r, false).lamports_per_zec.max(1) as u128);
                if zat < min_action as u128 {
                    return Err(ApiError::below_minimum(
                        "order value at the trigger price below PoolInfo.minActionZat",
                    ));
                }
                None
            };
            let o = NewOrder {
                kind,
                venue,
                mint,
                trigger,
                amount,
                slippage_bps: slip,
                exec_mode: exec.into(),
                ttl_secs: ttl,
                gain,
                sl_trigger: sl,
                sl_slippage_bps: sl_slip,
                rearm: rearm.unwrap_or(false),
            };
            Ok(OrderReq::Create(o))
        }
    }
}

pub fn order_json(o: &OrderRow) -> Value {
    let mut v = json!({
        "id": hex::encode(o.id),
        "venue": o.venue,
        "mint": o.mint,
        "kind": o.kind,
        "triggerPriceSol": o.trigger,
        "amount": o.amount.to_string(),
        "slippageBps": o.slippage_bps,
        "exec": o.exec_mode,
        "status": o.status,
        "createdAt": o.created_at_ms,
        "expiresAt": o.expires_at_ms,
        "rearms": o.rearms,
    });
    if o.kind == "bracket" {
        v["slPriceSol"] = json!(o.sl_trigger.clone().unwrap_or_default());
        v["slSlippageBps"] = json!(o.sl_slippage_bps.unwrap_or(0));
        if let Some(l) = &o.leg {
            v["leg"] = json!(l);
        }
    }
    if o.rearm {
        v["rearm"] = json!(true);
    }
    if o.armed && o.status == "open" {
        v["armed"] = json!(true);
    }
    if let Some(a) = o.action_id {
        v["actionId"] = json!(hex::encode(a));
    }
    if let Some(e) = &o.error
        && o.status == "failed"
    {
        v["error"] = json!(e);
    }
    v
}

pub fn pool_block() -> Value {
    json!({
        "kinds": KINDS,
        "venues": ["pumpfun"],
        "maxOpenPerKey": lo::MAX_OPEN_PER_KEY,
        "maxOpenPerMint": lo::MAX_OPEN_PER_MINT,
        "maxTtlSecs": MAX_TTL_SECS,
        "defaultTtlSecs": DEFAULT_TTL_SECS,
        "defaultSlippageBps": {
            "limit_buy": default_slippage("limit_buy"),
            "limit_sell": default_slippage("limit_sell"),
            "take_profit": default_slippage("take_profit"),
            "stop_loss": default_slippage("stop_loss"),
            "bracket": default_slippage("bracket"),
        },
        "slConfirmTicks": 2,
        "maxRearms": lo::MAX_REARMS,
        "priceTick": { "minSecs": 45, "maxSecs": 75 },
    })
}

/// Evaluator: once a second, cheap when no new tick exists.
pub async fn evaluator_loop(st: AppState) {
    let mut every = tokio::time::interval(Duration::from_secs(1));
    loop {
        every.tick().await;
        let rates = st.rate.get().await.ok();
        let p = EvalParams {
            rate_buy: rates.as_ref().map(|r| rate(&st, r, true)),
            rate_sell: rates.as_ref().map(|r| rate(&st, r, false)),
            delay_delayed: st.epochs.delay(false),
            delay_max: st.epochs.delay(true),
        };
        match st.ledger.orders_tick(st.cfg.cluster, &p).await {
            Ok(r) if r.triggered + r.failed + r.expired + r.closed + r.rearmed + r.errors > 0 => tracing::info!(
                triggered = r.triggered,
                rearmed = r.rearmed,
                failed = r.failed,
                expired = r.expired,
                closed = r.closed,
                errors = r.errors,
                "orders pass"
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "orders pass failed"),
        }
    }
}

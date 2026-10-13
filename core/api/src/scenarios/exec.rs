//! Scenario executor (spec §3, S3): one pass per second over due plans, each plan in its own
//! transaction (row lock, SKIP LOCKED), random order. A trade step goes through the same
//! `actions::build` as a manual request and `submit_in` behind a savepoint; settlement of that
//! action moves the plan on. No RPC, no 1Click request: only the pool's own DB and the rate cache.
//!
//! Server floors applied here (spec §4.1, not configurable): P5/P7 `wait_fixed` ± max(30 s, 10 %);
//! P6 a buy funded by an earlier sell's output waits U(3, 15) min and spends U(2, 8) % less;
//! P9 two trade steps in a row are separated by U(1, 3) epochs; A5 a retried sell is shaved.
//! Logs: counters only (no plan id, mint, amount or time).

use serde_json::{Value, json};
use unzeen_ledger::{
    LedgerError,
    orders::{buy_min_out, parse_e18, sell_min_out},
    scenarios::{self as sc, ScenarioRow},
};

use crate::{AppState, actions, error::ApiError, rate};

const TRADES: &[&str] = &["buy", "sell", "sell_all"];
/// Errors a `retry` may repeat (spec §2.3).
const TRANSIENT: &[&str] = &["slippage", "pool_liquidity", "venue_unavailable", "rate_limited"];
/// Tick price older than this is not used for a slippage guard (same as orders).
const TICK_MAX_AGE_SECS: i64 = 180;

pub fn floors_json() -> Value {
    json!({
        "afterDepositSecs": [600, 2400], "timeAtJitterSecs": [0, 600],
        "fixedWaitJitterPct": 10, "fixedWaitJitterMinSecs": 30,
        "withdrawAfterTradeMinSecs": 3600, "withdrawExtraSecs": [0, 1800],
        "swapGapSecs": [180, 900], "swapShaveBps": [200, 800],
        "chatAfterTradeSecs": [600, 1800], "repeatJitterPct": 10, "dcaWeightJitterPct": 20,
        "tradeGapEpochs": [1, 3],
    })
}

fn unit() -> f64 {
    (rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64
}

fn uni(lo: f64, hi: f64) -> f64 {
    lo + (hi - lo).max(0.0) * unit()
}

fn epoch_mean(st: &AppState) -> f64 {
    (st.cfg.exec.epoch_min_secs + st.cfg.exec.epoch_max_secs) / 2.0
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PassReport {
    pub fired: u64,
    pub failed: u64,
    pub closed: u64,
}

/// One executor pass over due plans of this network.
pub async fn pass(st: &AppState) -> PassReport {
    let mut rep = PassReport::default();
    let ids = match st.ledger.scenarios_due(st.cfg.cluster, 100).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "scenario pass: listing failed");
            return rep;
        }
    };
    for id in ids {
        match plan_pass(st, &id, &mut rep).await {
            Ok(()) => {}
            Err(e) => {
                rep.failed += 1;
                tracing::warn!(error = %e, "scenario step failed (internal)");
            }
        }
    }
    rep
}

/// Loop (1 s), started by `spawn_background` when `UNZEEN_SCENARIOS=1`. Counters only.
pub async fn run(st: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tick.tick().await;
        let r = pass(&st).await;
        if r.fired + r.failed + r.closed > 0 {
            tracing::debug!(fired = r.fired, failed = r.failed, closed = r.closed, "scenario pass");
        }
    }
}

/// What a step decided: next timer (seconds) or the plan closes.
enum Next {
    In(Option<f64>),
    Close(&'static str, Option<String>),
}

fn steps(row: &ScenarioRow) -> Vec<Value> {
    row.plan["steps"].as_array().cloned().unwrap_or_default()
}

fn set_step_status(row: &mut ScenarioRow, i: usize, s: &str) {
    if !row.state["steps"].is_object() {
        row.state["steps"] = json!({});
    }
    row.state["steps"][i.to_string()] = json!(s);
}

fn out_of(row: &ScenarioRow, k: usize) -> &Value {
    &row.state["out"][k.to_string()]
}

/// Move to the next step with floors; `done` past the end.
fn advance(st: &AppState, row: &mut ScenarioRow, steps: &[Value]) -> Next {
    let prev_trade = TRADES.contains(&steps[row.cursor]["block"]["type"].as_str().unwrap_or(""));
    row.cursor += 1;
    row.phase = "ready".into();
    row.attempt = 0;
    goto_floor(st, row, steps, prev_trade)
}

fn goto_floor(st: &AppState, row: &mut ScenarioRow, steps: &[Value], prev_trade: bool) -> Next {
    let Some(next) = steps.get(row.cursor) else {
        return Next::Close("done", None);
    };
    let b = &next["block"];
    let ty = b["type"].as_str().unwrap_or("");
    let mut delay = 0.0;
    if TRADES.contains(&ty) && prev_trade {
        // P9: never two pool trades of one plan in adjacent epochs.
        delay += uni(1.0, 3.0) * epoch_mean(st);
    }
    if ty == "buy"
        && let Some(k) = b["zec"]["of"]["step"].as_u64()
        && matches!(
            steps.get(k as usize).and_then(|s| s["block"]["type"].as_str()),
            Some("sell" | "sell_all")
        )
    {
        // P6: "sold for X → bought for ≈X" never lines up in time.
        delay += uni(180.0, 900.0);
    }
    Next::In(Some(delay))
}

/// onFail of the current step for `code`. `transient_ok` = the error may be retried.
fn on_fail(st: &AppState, row: &mut ScenarioRow, steps: &[Value], code: &str) -> Next {
    let i = row.cursor;
    let spec = steps[i].get("onFail").cloned().unwrap_or(json!("stop"));
    let then = match &spec {
        Value::Object(o) if o.contains_key("retry") => {
            let max = o["retry"].as_u64().unwrap_or(0) as u32;
            if TRANSIENT.contains(&code) && row.attempt < max {
                row.attempt += 1;
                row.phase = "ready".into();
                return Next::In(Some(uni(1.0, 5.0) * epoch_mean(st)));
            }
            o.get("then").cloned().unwrap_or(json!("stop"))
        }
        other => other.clone(),
    };
    set_step_status(row, i, "failed");
    match &then {
        Value::String(s) if s == "skip" => {
            set_step_status(row, i, "skipped");
            advance(st, row, steps)
        }
        Value::Object(o) if o.contains_key("goto") => {
            set_step_status(row, i, "skipped");
            let prev_trade = TRADES.contains(&steps[i]["block"]["type"].as_str().unwrap_or(""));
            row.cursor = o["goto"].as_u64().unwrap_or(steps.len() as u64) as usize;
            row.phase = "ready".into();
            row.attempt = 0;
            goto_floor(st, row, steps, prev_trade)
        }
        _ => Next::Close("failed", Some(code.to_string())),
    }
}

async fn plan_pass(st: &AppState, id: &[u8; 16], rep: &mut PassReport) -> Result<(), LedgerError> {
    let mut c = st.ledger.pg().get().await?;
    let tx = c.transaction().await?;
    let Some(mut row) = sc::lock(&tx, id).await? else {
        return Ok(());
    };
    if !matches!(row.status.as_str(), "active" | "waiting_start") {
        return Ok(());
    }
    if row.expired {
        // TTL is a cancel with status `expired`: open orders of the plan are cancelled; a step
        // already queued still finishes (like a fired order).
        sc::close_in(&tx, id, "expired", None).await?;
        tx.commit().await?;
        rep.closed += 1;
        return Ok(());
    }
    if row.status != "active" {
        return Ok(());
    }
    let steps = steps(&row);
    let next = if row.phase == "in_flight" {
        settle_in_flight(st, &tx, &mut row, &steps).await?
    } else if row.due {
        run_step(st, &tx, &mut row, &steps, rep).await?
    } else {
        return Ok(());
    };
    match next {
        Next::In(None) if row.phase == "in_flight" => sc::save(&tx, &row, None).await?,
        Next::In(None) => return Ok(()), // nothing changed (still waiting on settlement)
        Next::In(t) => sc::save(&tx, &row, t).await?,
        Next::Close(status, err) => {
            sc::save(&tx, &row, None).await?;
            sc::close_in(&tx, id, status, err.as_deref()).await?;
            rep.closed += 1;
        }
    }
    tx.commit().await?;
    Ok(())
}

async fn settle_in_flight<C: unzeen_ledger::deadpool_postgres::GenericClient>(
    st: &AppState,
    tx: &C,
    row: &mut ScenarioRow,
    steps: &[Value],
) -> Result<Next, LedgerError> {
    let Some((seq, aid)) = sc::queued_run(tx, &row.id).await? else {
        // Lost link (scrubbed): treat as done without output.
        set_step_status(row, row.cursor, "done");
        return Ok(advance(st, row, steps));
    };
    let Some((status, err, fill)) = sc::action_outcome(tx, &aid).await? else {
        return Ok(Next::In(None));
    };
    match status.as_str() {
        "executed" => {
            sc::finish_run(tx, &row.id, seq, "done", None).await?;
            let i = row.cursor;
            let f = fill.unwrap_or(Value::Null);
            let ty = steps[i]["block"]["type"].as_str().unwrap_or("");
            let mut out = json!({});
            if let Some(m) = row.state["pending"]["mint"].as_str() {
                out["mint"] = json!(m);
            }
            match ty {
                "buy" => out["tokens"] = f["tokenAmount"].clone(),
                "sell" | "sell_all" => out["zat"] = f["zecCredited"].clone(),
                _ => {}
            }
            if !row.state["out"].is_object() {
                row.state["out"] = json!({});
            }
            row.state["out"][i.to_string()] = out;
            row.state["pending"] = Value::Null;
            set_step_status(row, i, "done");
            Ok(advance(st, row, steps))
        }
        "failed" => {
            let code = err.unwrap_or_else(|| "internal".into());
            sc::finish_run(tx, &row.id, seq, "failed", Some(&code)).await?;
            row.state["pending"] = Value::Null;
            Ok(on_fail(st, row, steps, &code))
        }
        _ => Ok(Next::In(None)),
    }
}

async fn run_step<C: unzeen_ledger::deadpool_postgres::GenericClient>(
    st: &AppState,
    tx: &C,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
) -> Result<Next, LedgerError> {
    let Some(step) = steps.get(row.cursor) else {
        return Ok(Next::Close("done", None));
    };
    let b = &step["block"];
    let i = row.cursor;
    match b["type"].as_str().unwrap_or("") {
        "manual_start" => {
            set_step_status(row, i, "done");
            Ok(advance(st, row, steps))
        }
        "end" => {
            set_step_status(row, i, "done");
            Ok(Next::Close("done", None))
        }
        "wait_fixed" | "wait_random" if row.phase == "waiting" => {
            set_step_status(row, i, "done");
            Ok(advance(st, row, steps))
        }
        "wait_fixed" => {
            let s = b["secs"].as_f64().unwrap_or(30.0);
            let j = (s * 0.1).max(30.0);
            row.phase = "waiting".into();
            set_step_status(row, i, "waiting");
            Ok(Next::In(Some(uni((s - j).max(1.0), s + j))))
        }
        "wait_random" => {
            let (lo, hi) = (
                b["minSecs"].as_f64().unwrap_or(30.0),
                b["maxSecs"].as_f64().unwrap_or(60.0),
            );
            row.phase = "waiting".into();
            set_step_status(row, i, "waiting");
            Ok(Next::In(Some(uni(lo, hi))))
        }
        "buy" | "sell" | "sell_all" => trade(st, tx, row, steps, rep).await,
        // Blocks of later stages are refused at creation; a plan stored before cannot reach here.
        _ => Ok(Next::Close("failed", Some("bad_request".into()))),
    }
}

/// Resolve `MintRef`: literal or the mint recorded as the output of an earlier step.
fn mint_of(row: &ScenarioRow, v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Object(_) => out_of(row, v["step"].as_u64()? as usize)["mint"]
            .as_str()
            .map(String::from),
        _ => None,
    }
}

fn pct(base: u128, p: u64) -> u128 {
    base.saturating_mul(u128::from(p.min(100))) / 100
}

/// Resolve `AmountSpec` against the balance or an earlier step's output.
async fn amount_of<C: unzeen_ledger::deadpool_postgres::GenericClient>(
    tx: &C,
    row: &ScenarioRow,
    spec: &Value,
    zat: bool,
    mint: &str,
) -> Result<u128, LedgerError> {
    if let Some(a) = spec["abs"].as_str() {
        return Ok(a.parse().unwrap_or(0));
    }
    let p = spec["pct"].as_u64().unwrap_or(0);
    let base = match &spec["of"] {
        Value::String(_) => {
            if zat {
                u128::from(sc::zec_available(tx, &row.pk).await?.0)
            } else {
                sc::token_available(tx, &row.pk, mint).await?
            }
        }
        r => {
            let k = r["step"].as_u64().unwrap_or(u64::MAX) as usize;
            let key = if zat { "zat" } else { "tokens" };
            out_of(row, k)[key].as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
        }
    };
    Ok(pct(base, p))
}

/// Price (e18, quote per whole token) for a guard and the token's decimals / ZEC-pair flag.
async fn guard_price<C: unzeen_ledger::deadpool_postgres::GenericClient>(
    tx: &C,
    st: &AppState,
    mint: &str,
    guard: &Value,
) -> Result<Option<(u128, u32, u32, bool)>, LedgerError> {
    let t = tx
        .query_opt(
            "SELECT t.decimals, t.quote_mint, p.price_sol::text,
                    (extract(epoch FROM now()) * 1000)::bigint - p.tick_at
             FROM tokens t LEFT JOIN intel_prices p ON p.mint = t.mint WHERE t.mint = $1",
            &[&mint],
        )
        .await?;
    let (dec, quote, tick, age): (i16, Option<String>, Option<String>, Option<i64>) = match &t {
        Some(r) => (r.get(0), r.get(1), r.get(2), r.get(3)),
        None => (6, None, None, None),
    };
    let zec_pair = match &quote {
        None => false,
        Some(q) => match st.cfg.quotes.by_mint(q) {
            Some(cfg) if cfg.is_zec() => true,
            // USDC/USD1 pairs are lamport-booked with a USD price: no v1 guard.
            _ => return Ok(None),
        },
    };
    if let Some(lp) = guard["limitPrice"].as_str() {
        return Ok(parse_e18(lp).map(|e| (e, dec.clamp(0, 18) as u32, 0, zec_pair)));
    }
    let slip = guard["slippageBps"].as_u64().unwrap_or(500) as u32;
    if zec_pair {
        return Ok(None);
    }
    let fresh = age.is_some_and(|a| a <= TICK_MAX_AGE_SECS * 1000);
    Ok(tick
        .filter(|_| fresh)
        .and_then(|p| parse_e18(&p))
        .map(|e| (e, dec.clamp(0, 18) as u32, slip, false)))
}

async fn trade<C: unzeen_ledger::deadpool_postgres::GenericClient>(
    st: &AppState,
    tx: &C,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
) -> Result<Next, LedgerError> {
    let i = row.cursor;
    let b = steps[i]["block"].clone();
    let ty = b["type"].as_str().unwrap_or("").to_string();
    if sc::zec_available(tx, &row.pk).await?.1 {
        // balance_frozen (reorg) is not a step error: wait.
        return Ok(Next::In(Some(60.0)));
    }
    let Some(mint) = mint_of(row, &b["mint"]) else {
        return Ok(on_fail(st, row, steps, "not_found"));
    };
    let venue = b["venue"].as_str().unwrap_or("").to_string();
    // P1 (lead 13.10): a retried Now step is no longer the human click it followed: delayed.
    let exec = match b["exec"].as_str() {
        Some("now") if row.attempt > 0 => "delayed".to_string(),
        x => x.unwrap_or("delayed").to_string(),
    };
    let Some((e18, dec, slip, zec_pair)) = guard_price(tx, st, &mint, &b["guard"]).await? else {
        // No fresh tick / no supported guard: transient (the next tick may bring a price).
        return Ok(on_fail(st, row, steps, "venue_unavailable"));
    };
    let Ok(r) = st.rate.get().await else {
        return Ok(on_fail(st, row, steps, "venue_unavailable"));
    };
    let spread = if r.stale {
        st.cfg.rate.spread_bps.saturating_mul(2)
    } else {
        st.cfg.rate.spread_bps
    };
    let body = if ty == "buy" {
        let mut zat = amount_of(tx, row, &b["zec"], true, &mint).await?;
        if let Some(k) = b["zec"]["of"]["step"].as_u64()
            && matches!(
                steps.get(k as usize).and_then(|s| s["block"]["type"].as_str()),
                Some("sell" | "sell_all")
            )
        {
            // P6: spend U(2, 8) % less than the sell brought.
            zat = zat.saturating_mul(10_000 - uni(200.0, 800.0) as u128) / 10_000;
        }
        let zat = u64::try_from(zat).unwrap_or(u64::MAX);
        // Quote units the buy will spend (lamports at the buy rate; ZEC SPL ×10 to the 1e9 scale).
        let units = if zec_pair {
            zat.saturating_mul(10)
        } else {
            rate::zat_to_lamports(zat, rate::apply_spread(r.lamports_per_zec, spread, true))
        };
        let min_out = buy_min_out(units, e18, dec, slip).unwrap_or(0).max(1);
        json!({ "op": "buy", "venue": venue, "mint": mint, "zecIn": zat.to_string(),
                "minOut": min_out.to_string(), "exec": exec })
    } else {
        let mut amount = if ty == "sell_all" {
            sc::token_available(tx, &row.pk, &mint).await?
        } else {
            amount_of(tx, row, &b["amount"], false, &mint).await?
        };
        if row.attempt > 0 {
            // A5: a retried sell never repeats the amount of its failed attempt.
            amount = unzeen_ledger::actions::fuzz_token_amount_rand(amount);
        }
        let quote = sell_min_out(amount, e18, dec, slip).unwrap_or(0);
        let min_zat = if zec_pair {
            quote / 10
        } else {
            let sell = rate::apply_spread(r.lamports_per_zec, spread, false);
            quote.saturating_mul(100_000_000) / u128::from(sell.max(1))
        };
        json!({ "op": "sell", "venue": venue, "mint": mint, "amount": amount.to_string(),
                "minZecOut": min_zat.min(i64::MAX as u128).to_string(), "exec": exec })
    };
    let action: actions::SignedAction = match serde_json::from_value(body) {
        Ok(a) => a,
        Err(_) => return Ok(on_fail(st, row, steps, "bad_request")),
    };
    let new = match actions::build(st, &row.pk, action).await {
        Ok(n) => n,
        Err(e) => return step_error(st, tx, row, steps, &e).await,
    };
    match sc::submit_step(&st.ledger, tx, &row.pk, &new).await {
        Ok(rec) => {
            sc::insert_run(tx, &row.id, i, row.attempt, "queued", Some(&rec.id), None).await?;
            row.runs += 1;
            row.phase = "in_flight".into();
            row.state["pending"] = json!({ "mint": mint });
            set_step_status(row, i, "running");
            rep.fired += 1;
            Ok(Next::In(None))
        }
        Err(LedgerError::Db(s)) => Err(LedgerError::Db(s)),
        Err(LedgerError::Pool(s)) => Err(LedgerError::Pool(s)),
        Err(e) => Ok(step_error(st, tx, row, steps, &ApiError::from(e)).await?),
    }
}

async fn step_error<C: unzeen_ledger::deadpool_postgres::GenericClient>(
    st: &AppState,
    tx: &C,
    row: &mut ScenarioRow,
    steps: &[Value],
    e: &ApiError,
) -> Result<Next, LedgerError> {
    if e.code == "balance_frozen" {
        return Ok(Next::In(Some(60.0)));
    }
    sc::insert_run(tx, &row.id, row.cursor, row.attempt, "failed", None, Some(e.code)).await?;
    Ok(on_fail(st, row, steps, e.code))
}

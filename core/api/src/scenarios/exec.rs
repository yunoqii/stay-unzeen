//! Scenario executor (spec §3, S3–S6): one pass per second over due plans, each plan in its own
//! transaction (row lock, SKIP LOCKED), random order.
//!
//! - Trades, `create`, withdrawals: the same `actions::build` as a manual request, then
//!   `submit_in` behind a savepoint; settlement of that action moves the plan on (`in_flight`).
//! - Orders and `claim`: `*_in` ledger functions inside the plan's transaction, behind a savepoint.
//! - `fl_*` and `chat` keep their own transaction; their nonce / request hash are derived from
//!   K_scn and (plan, step, run), so a pass that dies before committing the plan replays the same
//!   request next time and gets the original receipt instead of acting twice.
//! - Triggers read only what core already has (indexer tick, safety snapshots, the ledger, the
//!   clock): **no RPC and no 1Click request** from this module (S7 test checks the source).
//!
//! Server floors (spec §4.1, not configurable): P3 deposit trigger fires U(10, 40) min after the
//! credit; P4 a chat after a trade of the mint is slow and waits U(10, 30) min; P5 `abs` amounts
//! of a repeated iteration ±10 %, DCA weights ±20 %; P6 a buy funded by a sell waits U(3, 15) min
//! and spends U(2, 8) % less (also inside `swap`); P7 `wait_fixed` ± max(30 s, 10 %), `time_at`
//! plus U(0, 10) min; P9 two trades in a row are U(1, 3) epochs apart; P2 extra U(0, 30) min
//! before a token withdrawal; A5 a retried sell is shaved; a retried Now step runs `delayed` (P1).
//!
//! Logs: counters only (no plan id, mint, amount or time).

use serde_json::{Value, json};
use unzeen_ledger::{
    LedgerError,
    orders::{buy_min_out, parse_e18, sell_min_out},
    scenarios::{self as sc, ScenarioRow},
};

use sha2::{Digest, Sha256};

use crate::{AppState, actions, error::ApiError, rate};

/// Steps that trade on the pool (P9 spacing).
const TRADES: &[&str] = &["buy", "sell", "sell_all", "swap", "dca"];
/// Poll period of triggers (s), random inside.
const POLL: (f64, f64) = (20.0, 40.0);
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

type Tx<'a> = unzeen_ledger::deadpool_postgres::Transaction<'a>;

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

fn set_out(row: &mut ScenarioRow, k: usize, v: Value) {
    if !row.state["out"].is_object() {
        row.state["out"] = json!({});
    }
    row.state["out"][k.to_string()] = v;
}

fn ty_of(steps: &[Value], i: usize) -> &str {
    steps.get(i).and_then(|s| s["block"]["type"].as_str()).unwrap_or("")
}

/// Per-step scratch (trigger arming, swap leg, dca slices), cleared when the step ends.
fn sub(row: &mut ScenarioRow) -> &mut Value {
    if !row.state["sub"].is_object() {
        row.state["sub"] = json!({});
    }
    &mut row.state["sub"]
}

/// Move to the next step with floors; `done` past the end.
fn advance(st: &AppState, row: &mut ScenarioRow, steps: &[Value]) -> Next {
    let prev_trade = TRADES.contains(&ty_of(steps, row.cursor));
    row.cursor += 1;
    row.phase = "ready".into();
    row.attempt = 0;
    row.state["sub"] = json!({});
    goto_floor(st, row, steps, prev_trade)
}

/// What a step is about to do, for the time floors.
enum Floor<'a> {
    Buy,
    Sell,
    WithdrawToken(&'a str),
    Chat(&'a str),
}

/// A floor draw kept for the step (re-rolling on every pass would bias the wait short).
fn draw(row: &mut ScenarioRow, key: &str, lo: f64, hi: f64) -> f64 {
    if let Some(v) = sub(row)[key].as_f64() {
        return v;
    }
    let v = uni(lo, hi);
    sub(row)[key] = json!(v);
    v
}

/// Seconds the step must still wait for the server floors, measured from the key's LAST REAL
/// trade in the ledger (any action: manual, a fired order, another plan), `None` = may run:
/// - P9 / P5: any pool trade of the key ≥ U(1, 3) epochs before this trade (repeat bodies and
///   non-trading steps in between change nothing);
/// - P6: a buy ≥ U(3, 15) min after the key's last sell (whatever funds it, `of: "balance"` too);
/// - P2: a token withdrawal ≥ 1 h + U(0, 30 min) after the last trade of that mint (a fired
///   order or a trade outside the plan included);
/// - P4: a chat line ≥ U(10, 30) min after the last trade of that mint (then always `slow`).
async fn floor_wait(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    f: Floor<'_>,
) -> Result<Option<f64>, LedgerError> {
    let need_and_since = match f {
        Floor::Buy | Floor::Sell => {
            let Some((since, kind)) = sc::last_trade(tx, &row.pk, None).await? else {
                return Ok(None);
            };
            let mut need = draw(row, "p9", 1.0, 3.0) * epoch_mean(st);
            if matches!(f, Floor::Buy) && kind == "sell" {
                need = need.max(draw(row, "p6", 180.0, 900.0));
            }
            (need, since)
        }
        Floor::WithdrawToken(m) => {
            let Some((since, _)) = sc::last_trade(tx, &row.pk, Some(m)).await? else {
                return Ok(None);
            };
            (3_600.0 + draw(row, "p2", 0.0, 1_800.0), since)
        }
        Floor::Chat(m) => {
            let Some((since, _)) = sc::last_trade(tx, &row.pk, Some(m)).await? else {
                return Ok(None);
            };
            (draw(row, "p4", 600.0, 1_800.0), since)
        }
    };
    let (need, since) = need_and_since;
    Ok((since < need).then_some(need - since + 1.0))
}

/// The step waits for a floor: never a failure.
fn hold_for(row: &mut ScenarioRow, secs: f64) -> Next {
    let i = row.cursor;
    set_step_status(row, i, "waiting");
    Next::In(Some(secs))
}

fn goto_floor(st: &AppState, row: &mut ScenarioRow, steps: &[Value], prev_trade: bool) -> Next {
    let Some(next) = steps.get(row.cursor) else {
        return Next::Close("done", None);
    };
    // Floors are checked by TIME against the key's real last trade when the step runs
    // ([`floor_wait`]), not by which step came before (review-scenarios п. 1/3/4/6).
    let _ = (st, next, prev_trade);
    Next::In(Some(0.0))
}

/// onFail of the current step for `code`.
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
    jump(st, row, steps, &then, code)
}

/// `stop` | `skip` | `{goto}` after a failed (or false) step.
fn jump(st: &AppState, row: &mut ScenarioRow, steps: &[Value], then: &Value, code: &str) -> Next {
    let i = row.cursor;
    // A step that ends without success drops its sealed blob now (review-scenarios п. 12).
    row.state["dropSealed"] = json!(i);
    set_step_status(row, i, "failed");
    match then {
        Value::String(s) if s == "skip" => {
            set_step_status(row, i, "skipped");
            advance(st, row, steps)
        }
        Value::Object(o) if o.contains_key("goto") => {
            set_step_status(row, i, "skipped");
            let prev_trade = TRADES.contains(&ty_of(steps, i));
            row.cursor = o["goto"].as_u64().unwrap_or(steps.len() as u64) as usize;
            row.phase = "ready".into();
            row.attempt = 0;
            row.state["sub"] = json!({});
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
    if let Some(k) = row.state.get("dropSealed").and_then(Value::as_u64) {
        sc::drop_sealed(&tx, id, k as usize).await?;
        if let Some(o) = row.state.as_object_mut() {
            o.remove("dropSealed");
        }
    }
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

/// The queued action of the current step finished?
async fn settle_in_flight(
    st: &AppState,
    tx: &Tx<'_>,
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
    let i = row.cursor;
    match status.as_str() {
        "executed" => {
            sc::finish_run(tx, &row.id, seq, "done", None).await?;
            // Sealed address / meta: kept until the step is confirmed (a retry needs it again).
            sc::drop_sealed(tx, &row.id, i).await?;
            let f = fill.unwrap_or(Value::Null);
            let pending_mint = row.state["pending"]["mint"].as_str().map(String::from);
            row.state["pending"] = Value::Null;
            match ty_of(steps, i) {
                "swap" if sub(row)["leg"] == "sell" => {
                    // P6 inside swap: proceeds known → hidden pause, then the buy leg.
                    sub(row)["proceeds"] = f["zecCredited"].clone();
                    sub(row)["leg"] = json!("buy");
                    row.phase = "waiting".into();
                    return Ok(Next::In(Some(uni(180.0, 900.0))));
                }
                "dca" => {
                    let k = sub(row)["k"].as_u64().unwrap_or(0) + 1;
                    let slices = steps[i]["block"]["slices"].as_u64().unwrap_or(1);
                    sub(row)["k"] = json!(k);
                    if k < slices {
                        let ev = &steps[i]["block"]["everySecs"];
                        row.phase = "waiting".into();
                        return Ok(Next::In(Some(uni(
                            ev["min"].as_f64().unwrap_or(600.0),
                            ev["max"].as_f64().unwrap_or(900.0),
                        ))));
                    }
                }
                _ => {}
            }
            let mut out = json!({});
            if let Some(m) = pending_mint.or_else(|| f["mint"].as_str().map(String::from)) {
                out["mint"] = json!(m);
            }
            if let Some(m) = f["mint"].as_str().filter(|_| ty_of(steps, i) == "create") {
                out["mint"] = json!(m);
            }
            match ty_of(steps, i) {
                "buy" | "swap" | "create" => out["tokens"] = f["tokenAmount"].clone(),
                "sell" | "sell_all" => out["zat"] = f["zecCredited"].clone(),
                _ => {}
            }
            set_out(row, i, out);
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

fn now_ms() -> i64 {
    rate::now_ms() as i64
}

/// Arm a trigger once (state.sub.armedMs); `true` when its timeout passed.
fn trigger_timed_out(row: &mut ScenarioRow, b: &Value) -> bool {
    let now = now_ms();
    let armed = match sub(row)["armedMs"].as_i64() {
        Some(a) => a,
        None => {
            sub(row)["armedMs"] = json!(now);
            now
        }
    };
    b["timeoutSecs"].as_i64().is_some_and(|t| now - armed > t * 1_000)
}

fn poll() -> Next {
    Next::In(Some(uni(POLL.0, POLL.1)))
}

/// A trigger fired: the step is done (`floor` seconds of `waiting` first, if any).
fn fire(st: &AppState, row: &mut ScenarioRow, steps: &[Value], floor: Option<f64>) -> Next {
    let i = row.cursor;
    match floor {
        Some(f) => {
            row.phase = "waiting".into();
            sub(row)["fired"] = json!(true);
            set_step_status(row, i, "waiting");
            Next::In(Some(f))
        }
        None => {
            set_step_status(row, i, "done");
            advance(st, row, steps)
        }
    }
}

async fn run_step(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
) -> Result<Next, LedgerError> {
    let Some(step) = steps.get(row.cursor) else {
        return Ok(Next::Close("done", None));
    };
    let b = step["block"].clone();
    let i = row.cursor;
    let ty = b["type"].as_str().unwrap_or("").to_string();
    // Waiting-phase continuations: a wait / time trigger / trigger floor elapsed, or the next
    // leg of a swap / slice of a dca is due.
    if row.phase == "waiting" {
        match ty.as_str() {
            "swap" | "dca" => {
                row.phase = "ready".into();
            }
            _ => {
                set_step_status(row, i, "done");
                return Ok(advance(st, row, steps));
            }
        }
    }
    match ty.as_str() {
        "manual_start" => {
            set_step_status(row, i, "done");
            Ok(advance(st, row, steps))
        }
        "end" => {
            set_step_status(row, i, "done");
            Ok(Next::Close("done", None))
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
        "time_at" => {
            // P7: at + U(0, 10 min).
            let at = b["at"].as_i64().unwrap_or(0);
            row.phase = "waiting".into();
            set_step_status(row, i, "waiting");
            Ok(Next::In(Some(
                ((at - now_ms()) as f64 / 1_000.0).max(0.0) + uni(0.0, 600.0),
            )))
        }
        "price_cross" | "curve_progress" | "own_result" | "deposit_received" => trigger(st, tx, row, steps, &b).await,
        "check_safety" => check_safety(st, tx, row, steps, &b).await,
        "repeat" => {
            let key = i.to_string();
            let done = row.state["rep"][&key].as_u64().unwrap_or(0);
            let times = b["times"].as_u64().unwrap_or(1);
            if !row.state["rep"].is_object() {
                row.state["rep"] = json!({});
            }
            if done + 1 < times {
                row.state["rep"][&key] = json!(done + 1);
                row.state["iter"] = json!(row.state["iter"].as_u64().unwrap_or(0) + 1);
                let from = b["from"].as_u64().unwrap_or(0) as usize;
                // Steps of the body run again: their statuses restart.
                for k in from..i {
                    if let Some(o) = row.state["steps"].as_object_mut() {
                        o.remove(&k.to_string());
                    }
                }
                row.cursor = from;
                row.phase = "ready".into();
                row.attempt = 0;
                row.state["sub"] = json!({});
                Ok(goto_floor(st, row, steps, false))
            } else {
                row.state["rep"][&key] = json!(0);
                set_step_status(row, i, "done");
                Ok(advance(st, row, steps))
            }
        }
        "buy" | "sell" | "sell_all" => {
            let mint = mint_of(row, &b["mint"]);
            let Some(mint) = mint else {
                return Ok(on_fail(st, row, steps, "not_found"));
            };
            let t = if ty == "buy" {
                let mut zat = amount_of(tx, row, &b["zec"], true, &mint).await?;
                if let Some(k) = b["zec"]["of"]["step"].as_u64()
                    && matches!(ty_of(steps, k as usize), "sell" | "sell_all")
                {
                    // P6: spend U(2, 8) % less than the sell brought.
                    zat = zat.saturating_mul(10_000 - uni(200.0, 800.0) as u128) / 10_000;
                }
                Trade::Buy { zat }
            } else {
                let amount = if ty == "sell_all" {
                    sc::token_available(tx, &row.pk, &mint).await?
                } else {
                    amount_of(tx, row, &b["amount"], false, &mint).await?
                };
                Trade::Sell { amount }
            };
            let venue = b["venue"].as_str().unwrap_or("").to_string();
            submit_trade(
                st,
                tx,
                row,
                steps,
                rep,
                t,
                &venue,
                &mint,
                &b["guard"],
                b["exec"].as_str(),
            )
            .await
        }
        "swap" => {
            let leg = sub(row)["leg"].as_str().unwrap_or("sell").to_string();
            let (Some(from), Some(to)) = (mint_of(row, &b["from"]), mint_of(row, &b["to"])) else {
                return Ok(on_fail(st, row, steps, "not_found"));
            };
            if leg == "sell" {
                sub(row)["leg"] = json!("sell");
                let amount = amount_of(tx, row, &b["amount"], false, &from).await?;
                let venue = venue_of(tx, &b["venueSell"], &from).await?;
                submit_trade(
                    st,
                    tx,
                    row,
                    steps,
                    rep,
                    Trade::Sell { amount },
                    &venue,
                    &from,
                    &b["guardSell"],
                    b["exec"].as_str(),
                )
                .await
            } else {
                let p: u128 = sub(row)["proceeds"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0);
                // P6: the buy spends U(2, 8) % less than the sell brought.
                let zat = p.saturating_mul(10_000 - uni(200.0, 800.0) as u128) / 10_000;
                let venue = venue_of(tx, &b["venueBuy"], &to).await?;
                submit_trade(
                    st,
                    tx,
                    row,
                    steps,
                    rep,
                    Trade::Buy { zat },
                    &venue,
                    &to,
                    &b["guardBuy"],
                    b["exec"].as_str(),
                )
                .await
            }
        }
        "dca" => {
            let Some(mint) = mint_of(row, &b["mint"]) else {
                return Ok(on_fail(st, row, steps, "not_found"));
            };
            let buy = b["side"] == "buy";
            if sub(row)["weights"].is_null() {
                // P5: random ±20 % weights, normalized; total fixed at the first slice.
                let n = b["slices"].as_u64().unwrap_or(2).max(1) as usize;
                let w: Vec<f64> = (0..n).map(|_| uni(0.8, 1.2)).collect();
                let sum: f64 = w.iter().sum();
                let total = amount_of(tx, row, &b["total"], buy, &mint).await?;
                sub(row)["weights"] = json!(w.iter().map(|x| x / sum).collect::<Vec<_>>());
                sub(row)["total"] = json!(total.to_string());
                sub(row)["k"] = json!(0);
            }
            let k = sub(row)["k"].as_u64().unwrap_or(0) as usize;
            let total: u128 = sub(row)["total"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0);
            let w = sub(row)["weights"][k].as_f64().unwrap_or(0.0);
            let part = ((total as f64) * w) as u128;
            let t = if buy {
                Trade::Buy { zat: part }
            } else {
                Trade::Sell { amount: part }
            };
            let venue = b["venue"].as_str().unwrap_or("").to_string();
            submit_trade(
                st,
                tx,
                row,
                steps,
                rep,
                t,
                &venue,
                &mint,
                &b["guard"],
                b["exec"].as_str(),
            )
            .await
        }
        "order_place" => order_place(st, tx, row, steps, rep, &b).await,
        "order_cancel" => {
            let oid = match b["ref"]["step"].as_u64() {
                Some(k) => sc::step_order(tx, &row.id, k as usize).await?,
                None => hex16(b["ref"]["orderId"].as_str()),
            };
            let Some(oid) = oid else {
                return Ok(on_fail(st, row, steps, "not_found"));
            };
            sc::savepoint(tx).await?;
            match st
                .ledger
                .order_cancel_in(tx, &row.pk, &rand::random(), &rand::random(), &oid)
                .await
            {
                Ok(_) => {
                    sc::release(tx).await?;
                    sc::insert_done_run(tx, &row.id, i, None, Some(&oid)).await?;
                    set_step_status(row, i, "done");
                    Ok(advance(st, row, steps))
                }
                Err(e) => {
                    sc::rollback_to(tx).await?;
                    step_error(st, tx, row, steps, &ApiError::from(e)).await
                }
            }
        }
        "claim" => claim(st, tx, row, steps, rep, &b).await,
        "create" | "withdraw_token" | "withdraw_zec" => sealed_action(st, tx, row, steps, rep, &b).await,
        "fl_create" | "fl_bid" | "fl_cancel" | "chat" => side_tx(st, tx, row, steps, rep, &b).await,
        _ => Ok(Next::Close("failed", Some("bad_request".into()))),
    }
}

fn hex16(s: Option<&str>) -> Option<[u8; 16]> {
    s.and_then(|s| hex::decode(s).ok()).and_then(|v| v.try_into().ok())
}

/// Venue of a swap leg: given, or the token's own venue (`tokens`).
async fn venue_of(tx: &Tx<'_>, v: &Value, mint: &str) -> Result<String, LedgerError> {
    if let Some(v) = v.as_str() {
        return Ok(v.to_string());
    }
    Ok(tx
        .query_opt("SELECT venue FROM tokens WHERE mint = $1", &[&mint])
        .await?
        .map_or_else(|| "pumpfun".to_string(), |r| r.get(0)))
}

async fn trigger(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    b: &Value,
) -> Result<Next, LedgerError> {
    let timed_out = trigger_timed_out(row, b);
    let fired = match b["type"].as_str().unwrap_or("") {
        "price_cross" => {
            let Some(mint) = mint_of(row, &b["mint"]) else {
                return Ok(on_fail(st, row, steps, "not_found"));
            };
            let t0 = match sub(row)["tick0"].as_i64() {
                Some(t) => t,
                None => {
                    // E16 as for orders: only ticks after arming count.
                    let t = sc::tick(tx, &mint).await?.map_or(0, |x| x.1);
                    sub(row)["tick0"] = json!(t);
                    t
                }
            };
            match sc::tick(tx, &mint).await? {
                Some((price, at, age, _))
                    if at > t0 && age <= TICK_MAX_AGE_SECS * 1_000 && sub(row)["last"].as_i64() != Some(at) =>
                {
                    sub(row)["last"] = json!(at);
                    let (p, lim) = (
                        parse_e18(&price).unwrap_or(0),
                        parse_e18(b["priceSol"].as_str().unwrap_or("0")).unwrap_or(0),
                    );
                    if b["op"] == "gte" {
                        p >= lim
                    } else {
                        // `lte`: two consecutive ticks (like SL, O4).
                        let hits = if p <= lim {
                            sub(row)["hits"].as_u64().unwrap_or(0) + 1
                        } else {
                            0
                        };
                        sub(row)["hits"] = json!(hits);
                        hits >= 2
                    }
                }
                _ => false,
            }
        }
        "curve_progress" => {
            let Some(mint) = mint_of(row, &b["mint"]) else {
                return Ok(on_fail(st, row, steps, "not_found"));
            };
            let grad = sc::tick(tx, &mint).await?.is_some_and(|t| t.3 == "graduated");
            let snap = sc::safety(tx, &mint).await?.map(|x| x.0).unwrap_or(Value::Null);
            let graduated = grad || snap["market"]["status"] == "graduated";
            if b["graduated"] == true {
                graduated
            } else {
                let pct = snap["market"]["curveProgressPct"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok());
                graduated || pct.is_some_and(|p| p >= b["gtePct"].as_f64().unwrap_or(101.0))
            }
        }
        "own_result" => {
            let r = &b["ref"];
            let outcome: Option<&str> = if let Some(k) = r["step"].as_u64() {
                match sc::step_order(tx, &row.id, k as usize).await? {
                    Some(o) => order_outcome(sc::order_status(tx, &row.pk, &o).await?),
                    None => Some("missing"),
                }
            } else if let Some(o) = hex16(r["orderId"].as_str()) {
                order_outcome(sc::order_status(tx, &row.pk, &o).await?)
            } else if let Some(a) = hex16(r["actionId"].as_str()) {
                match sc::action_status(tx, &row.pk, &a).await?.as_deref() {
                    Some("executed") => Some("filled"),
                    Some("failed") => Some("failed"),
                    Some(_) => None,
                    None => Some("missing"),
                }
            } else {
                Some("missing")
            };
            match (outcome, b["on"].as_str().unwrap_or("any")) {
                (None, _) => false,
                (Some("missing"), _) => return Ok(on_fail(st, row, steps, "not_found")),
                (Some(_), "any") => true,
                (Some(o), want) if o == want => true,
                (Some(_), _) => return Ok(on_fail(st, row, steps, "order_not_open")),
            }
        }
        "deposit_received" => {
            let total = sc::deposits_total(tx, &row.pk).await?;
            let base = match sub(row)["base"].as_u64() {
                Some(b) => b,
                None => {
                    sub(row)["base"] = json!(total);
                    total
                }
            };
            let got = total.saturating_sub(base);
            if got >= b["minZat"].as_str().and_then(|s| s.parse().ok()).unwrap_or(u64::MAX) {
                set_out(row, row.cursor, json!({ "zat": got.to_string() }));
                // P3: never trade at a fixed offset from the Zcash block.
                return Ok(fire(st, row, steps, Some(uni(600.0, 2_400.0))));
            }
            false
        }
        _ => false,
    };
    if fired {
        return Ok(fire(st, row, steps, None));
    }
    if timed_out {
        return Ok(on_fail(st, row, steps, "timeout"));
    }
    set_step_status(row, row.cursor, "waiting");
    Ok(poll())
}

fn order_outcome(s: Option<String>) -> Option<&'static str> {
    match s.as_deref() {
        Some("filled") => Some("filled"),
        Some("failed" | "cancelled" | "expired") => Some("failed"),
        Some(_) => None,
        None => Some("missing"),
    }
}

/// Safety snapshot vs `require`: `None` = no data.
fn safety_ok(d: &Value, req: &Value) -> bool {
    let pct = |v: &Value| v.as_str().and_then(|s| s.parse::<f64>().ok());
    let Some(r) = req.as_object() else { return false };
    r.iter().all(|(k, v)| {
        let lim = v.as_f64().unwrap_or(0.0);
        match k.as_str() {
            "authoritiesRevoked" => {
                d["authorities"]["mintRevoked"] == true && d["authorities"]["freezeRevoked"] == true
            }
            "noRiskyExtensions" => d["authorities"]["riskyExtensions"]
                .as_array()
                .is_some_and(Vec::is_empty),
            "maxTop10Pct" => pct(&d["holders"]["top10Pct"]).is_some_and(|p| p <= lim),
            // null devPct: an Unzeen launch (no dev by design) passes.
            "maxDevPct" => {
                d["holders"].is_object()
                    && (d["holders"]["devPct"].is_null() || pct(&d["holders"]["devPct"]).is_some_and(|p| p <= lim))
            }
            "minLpBurnedPct" => pct(&d["market"]["lpBurnedPct"]).is_some_and(|p| p >= lim),
            "maxSniperPct" => pct(&d["firstBlocks"]["sniperPct"]).is_some_and(|p| p <= lim),
            _ => false,
        }
    })
}

async fn check_safety(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    b: &Value,
) -> Result<Next, LedgerError> {
    let Some(mint) = mint_of(row, &b["mint"]) else {
        return Ok(on_fail(st, row, steps, "not_found"));
    };
    let snap = sc::safety(tx, &mint).await?;
    let polls = sub(row)["polls"].as_u64().unwrap_or(0);
    let verdict = match snap {
        Some((d, age)) if age <= 600 || polls >= 3 => Some(safety_ok(&d, &b["require"])),
        _ if polls >= 3 => Some(false),
        _ => None,
    };
    match verdict {
        Some(true) => {
            set_step_status(row, row.cursor, "done");
            Ok(advance(st, row, steps))
        }
        Some(false) => Ok(jump(st, row, steps, &b["onFalse"].clone(), "check_failed")),
        None => {
            // No fresh snapshot: the same CA queue as a search (batched with decoys), ≤ 3 ticks.
            sc::request_intel(tx, &mint, st.cfg.intel.queue_max).await?;
            sub(row)["polls"] = json!(polls + 1);
            set_step_status(row, row.cursor, "waiting");
            Ok(Next::In(Some(uni(60.0, 90.0))))
        }
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

/// Resolve `AmountSpec` against the balance or an earlier step's output. P5: an `abs` amount in
/// a repeated iteration is moved ±10 %.
async fn amount_of(tx: &Tx<'_>, row: &ScenarioRow, spec: &Value, zat: bool, mint: &str) -> Result<u128, LedgerError> {
    if let Some(a) = spec["abs"].as_str() {
        let v: u128 = a.parse().unwrap_or(0);
        if row.state["iter"].as_u64().unwrap_or(0) > 0 {
            return Ok(((v as f64) * uni(0.9, 1.1)) as u128);
        }
        return Ok(v);
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

type Guarded = Result<(u128, u32, u32, bool), &'static str>;

/// Price (e18, quote per whole token) for a guard and the token's decimals / ZEC-pair flag.
/// USDC/USD1 pairs are refused at plan creation (`unsupported_pair`); `None` = no price yet
/// (transient), `Some(Err("not_found"))` = decimals unknown to core.
async fn guard_price(tx: &Tx<'_>, st: &AppState, mint: &str, guard: &Value) -> Result<Option<Guarded>, LedgerError> {
    // Decimals only from core's data (pool tokens or the indexer's card), never a default: a
    // wrong decimals value moves minOut by orders of magnitude (review-scenarios п. 5).
    let t = tx
        .query_opt(
            "SELECT COALESCE(t.decimals, it.decimals), t.quote_mint, p.price_sol::text,
                    (extract(epoch FROM now()) * 1000)::bigint - p.tick_at
             FROM (SELECT $1::text AS mint) m
             LEFT JOIN tokens t ON t.mint = m.mint
             LEFT JOIN intel_tokens it ON it.mint = m.mint
             LEFT JOIN intel_prices p ON p.mint = m.mint",
            &[&mint],
        )
        .await?;
    let (dec, quote, tick, age): (Option<i16>, Option<String>, Option<String>, Option<i64>) = match &t {
        Some(r) => (r.get(0), r.get(1), r.get(2), r.get(3)),
        None => (None, None, None, None),
    };
    let Some(dec) = dec else {
        return Ok(Some(Err("not_found")));
    };
    let zec_pair = match &quote {
        None => false,
        Some(q) => match st.cfg.quotes.by_mint(q) {
            Some(cfg) if cfg.is_zec() => true,
            _ => return Ok(None),
        },
    };
    if let Some(lp) = guard["limitPrice"].as_str() {
        return Ok(parse_e18(lp).map(|e| Ok((e, dec.clamp(0, 18) as u32, 0, zec_pair))));
    }
    let slip = guard["slippageBps"].as_u64().unwrap_or(500) as u32;
    if zec_pair {
        return Ok(None);
    }
    let fresh = age.is_some_and(|a| a <= TICK_MAX_AGE_SECS * 1000);
    Ok(tick
        .filter(|_| fresh)
        .and_then(|p| parse_e18(&p))
        .map(|e| Ok((e, dec.clamp(0, 18) as u32, slip, false))))
}

enum Trade {
    Buy { zat: u128 },
    Sell { amount: u128 },
}

#[allow(clippy::too_many_arguments)]
async fn submit_trade(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
    t: Trade,
    venue: &str,
    mint: &str,
    guard: &Value,
    exec: Option<&str>,
) -> Result<Next, LedgerError> {
    if sc::zec_available(tx, &row.pk).await?.1 {
        // balance_frozen (reorg) is not a step error: wait.
        return Ok(Next::In(Some(60.0)));
    }
    let fl = if matches!(t, Trade::Buy { .. }) {
        Floor::Buy
    } else {
        Floor::Sell
    };
    if let Some(w) = floor_wait(st, tx, row, fl).await? {
        return Ok(hold_for(row, w));
    }
    // P1 (lead 13.10): a retried Now step is no longer the human click it followed: delayed.
    let exec = match exec {
        Some("now") if row.attempt == 0 => "now",
        Some("max") => "max",
        _ => "delayed",
    };
    let (e18, dec, slip, zec_pair) = match guard_price(tx, st, mint, guard).await? {
        Some(Ok(g)) => g,
        Some(Err(code)) => return Ok(on_fail(st, row, steps, code)),
        // No fresh tick yet: transient (the next tick may bring a price).
        None => return Ok(on_fail(st, row, steps, "venue_unavailable")),
    };
    let Ok(r) = st.rate.get().await else {
        return Ok(on_fail(st, row, steps, "venue_unavailable"));
    };
    let spread = if r.stale {
        st.cfg.rate.spread_bps.saturating_mul(2)
    } else {
        st.cfg.rate.spread_bps
    };
    let body = match t {
        Trade::Buy { zat } => {
            let zat = u64::try_from(zat).unwrap_or(u64::MAX);
            // Quote units the buy will spend (lamports at the buy rate; ZEC SPL ×10 to the 1e9 scale).
            let units = if zec_pair {
                u128::from(zat) * 10
            } else {
                rate::zat_to_lamports(zat, rate::apply_spread(r.lamports_per_zec, spread, true))
            };
            let min_out = buy_min_out(units, e18, dec, slip).unwrap_or(0).max(1);
            json!({ "op": "buy", "venue": venue, "mint": mint, "zecIn": zat.to_string(),
                    "minOut": min_out.to_string(), "exec": exec })
        }
        Trade::Sell { mut amount } => {
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
        }
    };
    submit_built(st, tx, row, steps, rep, body, Some(mint), None).await
}

/// `build()` + `submit_in` behind a savepoint; on success the step is `in_flight`.
#[allow(clippy::too_many_arguments)]
async fn submit_built(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
    body: Value,
    mint: Option<&str>,
    drop_sealed: Option<usize>,
) -> Result<Next, LedgerError> {
    let i = row.cursor;
    let action: actions::SignedAction = match serde_json::from_value(body) {
        Ok(a) => a,
        Err(_) => return step_error(st, tx, row, steps, &ApiError::bad_request("step")).await,
    };
    let new = match actions::build(st, &row.pk, action).await {
        Ok(n) => n,
        Err(e) => return step_error(st, tx, row, steps, &e).await,
    };
    match sc::submit_step(&st.ledger, tx, &row.pk, &new).await {
        Ok(rec) => {
            sc::insert_run(tx, &row.id, i, row.attempt, "queued", Some(&rec.id), None).await?;
            // The sealed blob of this step is dropped once the action is confirmed (settlement)
            // or the step gives up (`jump`), not at queueing: a retry still needs it.
            let _ = drop_sealed;
            row.runs += 1;
            row.phase = "in_flight".into();
            row.state["pending"] = json!({ "mint": mint });
            set_step_status(row, i, "running");
            rep.fired += 1;
            Ok(Next::In(None))
        }
        Err(LedgerError::Db(s)) => Err(LedgerError::Db(s)),
        Err(LedgerError::Pool(s)) => Err(LedgerError::Pool(s)),
        Err(e) => step_error(st, tx, row, steps, &ApiError::from(e)).await,
    }
}

async fn step_error(
    st: &AppState,
    tx: &Tx<'_>,
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

/// Unseal the sealed part of a step (K_scn, AAD = plan salt ‖ step).
fn unsealed(st: &AppState, row: &ScenarioRow, blob: Option<Vec<u8>>, step: usize) -> Option<Value> {
    let key = st.cfg.scenarios.key.as_ref()?;
    let salt = hex16(row.state["sealId"].as_str())?;
    super::ops::unseal(&key.0, &salt, step, &blob?)
}

async fn sealed_action(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
    b: &Value,
) -> Result<Next, LedgerError> {
    let i = row.cursor;
    let secret = unsealed(st, row, sc::sealed(tx, &row.id, i).await?, i);
    let exec = b["exec"].as_str().unwrap_or("delayed");
    let body = match b["type"].as_str().unwrap_or("") {
        "create" => {
            let c = &b["create"];
            let Some(meta) = secret.as_ref().map(|s| s["meta"].clone()) else {
                return step_error(st, tx, row, steps, &ApiError::bad_request("sealed")).await;
            };
            // P1: a retried Now launch is delayed like a retried Now trade (review п. 7).
            let ex = match c["exec"].as_str() {
                Some("now") if row.attempt == 0 => "now",
                Some("max") => "max",
                _ => "delayed",
            };
            let mut v = json!({ "op": "create", "venue": c["venue"], "meta": meta, "exec": ex });
            if c.get("initialBuyZec").is_some() {
                let z = amount_of(tx, row, &c["initialBuyZec"], true, "").await?;
                v["initialBuyZec"] = json!(z.to_string());
            }
            for k in ["quote", "platform"] {
                if let Some(x) = c.get(k) {
                    v[k] = x.clone();
                }
            }
            v
        }
        "withdraw_token" => {
            let (Some(mint), Some(to)) = (mint_of(row, &b["mint"]), secret.as_ref().map(|s| s["to"].clone())) else {
                return step_error(st, tx, row, steps, &ApiError::bad_request("sealed")).await;
            };
            if let Some(w) = floor_wait(st, tx, row, Floor::WithdrawToken(&mint)).await? {
                return Ok(hold_for(row, w));
            }
            let amount = amount_of(tx, row, &b["amount"], false, &mint).await?;
            let mut v = json!({ "op": "withdraw_token", "mint": mint, "amount": amount.to_string(),
                                "to": to, "exec": exec });
            if let Some(s) = b.get("smart") {
                v["smart"] = s.clone();
            }
            v
        }
        _ => {
            let Some(to) = secret.as_ref().map(|s| s["to"].clone()) else {
                return step_error(st, tx, row, steps, &ApiError::bad_request("sealed")).await;
            };
            let amount = amount_of(tx, row, &b["amount"], true, "").await?;
            json!({ "op": "withdraw_zec", "to": to, "amount": amount.to_string(), "exec": exec })
        }
    };
    submit_built(st, tx, row, steps, rep, body, None, Some(i)).await
}

async fn order_place(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
    b: &Value,
) -> Result<Next, LedgerError> {
    let i = row.cursor;
    let o = &b["order"];
    let Some(mint) = mint_of(row, &o["mint"]) else {
        return Ok(on_fail(st, row, steps, "not_found"));
    };
    let buy = o["kind"] == "limit_buy";
    let amount = amount_of(tx, row, &o["amount"], buy, &mint).await?;
    let mut raw = o.clone();
    raw["op"] = json!("order_create");
    raw["mint"] = json!(mint);
    raw["amount"] = json!(amount.to_string());
    if raw.get("venue").is_none() {
        raw["venue"] = json!("pumpfun");
    }
    let req = match crate::orders::parse(st, raw).await {
        Ok(crate::orders::OrderReq::Create(o)) => o,
        Ok(_) => return step_error(st, tx, row, steps, &ApiError::bad_request("order")).await,
        Err(e) => return step_error(st, tx, row, steps, &e).await,
    };
    sc::savepoint(tx).await?;
    match st
        .ledger
        .order_create_in(tx, &row.pk, &rand::random(), &rand::random(), &req)
        .await
    {
        Ok(rec) => {
            sc::release(tx).await?;
            sc::insert_done_run(tx, &row.id, i, None, Some(&rec.id)).await?;
            row.runs += 1;
            rep.fired += 1;
            set_out(row, i, json!({ "mint": mint }));
            set_step_status(row, i, "done");
            Ok(advance(st, row, steps))
        }
        Err(e) => {
            sc::rollback_to(tx).await?;
            step_error(st, tx, row, steps, &ApiError::from(e)).await
        }
    }
}

async fn claim(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
    b: &Value,
) -> Result<Next, LedgerError> {
    let i = row.cursor;
    let mint = match b.get("mint") {
        Some(m) => match mint_of(row, m) {
            Some(m) => Some(m),
            None => return Ok(on_fail(st, row, steps, "not_found")),
        },
        None => None,
    };
    let Ok(r) = st.rate.get().await else {
        return Ok(on_fail(st, row, steps, "venue_unavailable"));
    };
    let spread = if r.stale {
        st.cfg.rate.spread_bps.saturating_mul(2)
    } else {
        st.cfg.rate.spread_bps
    };
    let used = unzeen_ledger::RateUsed {
        lamports_per_zec: rate::apply_spread(r.lamports_per_zec, spread, false),
        source: r.source.into(),
        ts_ms: r.ts_ms,
    };
    sc::savepoint(tx).await?;
    match st
        .ledger
        .claim_in(tx, &row.pk, &rand::random(), &rand::random(), mint.as_deref(), &used)
        .await
    {
        Ok(rec) => {
            sc::release(tx).await?;
            let fill = sc::action_outcome(tx, &rec.id)
                .await?
                .and_then(|x| x.2)
                .unwrap_or(Value::Null);
            sc::insert_done_run(tx, &row.id, i, Some(&rec.id), None).await?;
            row.runs += 1;
            rep.fired += 1;
            set_out(row, i, json!({ "zat": fill["zecCredited"] }));
            set_step_status(row, i, "done");
            Ok(advance(st, row, steps))
        }
        Err(e) => {
            sc::rollback_to(tx).await?;
            step_error(st, tx, row, steps, &ApiError::from(e)).await
        }
    }
}

/// Deterministic (nonce, request hash) of a side-transaction step: replays of the same run get
/// the original receipt. Keyed with K_scn so they cannot be recomputed from the DB.
fn derived_nonce(st: &AppState, row: &ScenarioRow) -> ([u8; 16], [u8; 32]) {
    let key = st.cfg.scenarios.key.as_ref().map_or([0u8; 32], |k| k.0);
    let h = |tag: &[u8]| -> [u8; 32] {
        let mut d = Sha256::new();
        d.update(key);
        d.update(tag);
        d.update(row.id);
        d.update((row.cursor as u16).to_be_bytes());
        d.update((row.runs as u16).to_be_bytes());
        d.update((row.attempt as u16).to_be_bytes());
        d.update(row.state["rep"].to_string().as_bytes());
        d.finalize().into()
    };
    let n = h(b"unzeen/scenario/nonce/v1");
    (n[..16].try_into().expect("16"), h(b"unzeen/scenario/hash/v1"))
}

/// `fl_*` and `chat`: their own transaction (existing code paths), replay-safe nonce.
async fn side_tx(
    st: &AppState,
    tx: &Tx<'_>,
    row: &mut ScenarioRow,
    steps: &[Value],
    rep: &mut PassReport,
    b: &Value,
) -> Result<Next, LedgerError> {
    let i = row.cursor;
    let secret = unsealed(st, row, sc::sealed(tx, &row.id, i).await?, i);
    let (nonce, hash) = derived_nonce(st, row);
    let ty = b["type"].as_str().unwrap_or("");
    let res = match ty {
        "chat" => {
            let Some(mint) = mint_of(row, &b["mint"]) else {
                return Ok(on_fail(st, row, steps, "not_found"));
            };
            let Some(text) = secret.as_ref().map(|s| s["text"].clone()) else {
                return step_error(st, tx, row, steps, &ApiError::bad_request("sealed")).await;
            };
            // P4: after a trade of this mint (any, by time) the message waits and is always slow.
            if let Some(w) = floor_wait(st, tx, row, Floor::Chat(&mint)).await? {
                return Ok(hold_for(row, w));
            }
            let slow = sc::last_trade(tx, &row.pk, Some(&mint)).await?.is_some();
            let raw = json!({ "op": "chat", "mint": mint, "text": text,
                              "showCreatorBadge": b["showCreatorBadge"].as_bool().unwrap_or(false), "slow": slow });
            let n = unzeen_ledger::NonceCtx {
                pk: row.pk,
                nonce,
                request_hash: hash,
                ts_ms: rate::now_ms(),
            };
            crate::chat::submit_inner(st, raw, crate::chat::BODY_BYTES, n).await
        }
        _ => {
            let mut raw = match ty {
                "fl_create" => {
                    let mut l = b["launch"].clone();
                    if let Some(m) = secret.as_ref().map(|s| s["meta"].clone()) {
                        l["meta"] = m;
                    }
                    l
                }
                "fl_bid" => {
                    let Some(ct) = secret.as_ref().map(|s| s["ciphertext"].clone()) else {
                        return step_error(st, tx, row, steps, &ApiError::bad_request("sealed")).await;
                    };
                    json!({ "launchId": b["launchId"], "holdZat": b["holdZat"], "ciphertext": ct })
                }
                _ => json!({ "launchId": b["launchId"] }),
            };
            raw["op"] = json!(ty);
            if !st.cfg.fair.enabled {
                return step_error(st, tx, row, steps, &ApiError::bad_request("feature")).await;
            }
            crate::fair::submit(st, raw, &row.pk, &nonce, &hash).await
        }
    };
    match res {
        Ok(v) => {
            let aid = hex16(v["id"].as_str());
            sc::insert_done_run(tx, &row.id, i, aid.as_ref(), None).await?;
            sc::drop_sealed(tx, &row.id, i).await?;
            row.runs += 1;
            rep.fired += 1;
            set_step_status(row, i, "done");
            Ok(advance(st, row, steps))
        }
        Err(e) => step_error(st, tx, row, steps, &e).await,
    }
}

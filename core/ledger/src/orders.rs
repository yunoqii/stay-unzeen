//! Private orders (API.md v0.8, spec docs/analysis/orders.md): limit_buy, limit_sell,
//! take_profit (= limit_sell on the server), stop_loss (two consecutive ticks), and v0.15
//! bracket (TP + SL legs on ONE token hold, OCO).
//!
//! - Bracket: one `orders` row (`trigger_price_sol` = TP, `sl_price_sol` = SL). A leg firing
//!   moves the row to `triggered` (+ `leg`) in the same transaction that creates the trade, so
//!   the other leg is extinguished atomically; the row lock makes concurrent passes safe.
//! - Re-arm (v0.15, `rearm`): a trade that failed as a whole with `slippage` (settlement, see
//!   [`rearm_on_slippage`]) or a stop-loss guard miss puts the order back to `open` with its
//!   hold, at most [`MAX_REARMS`] times and only before `expires_at`.
//!
//! - Create: one transaction = nonce + hold (on the `order_create` action row, whose id is the
//!   order id) + `orders` row. Creator lock / cap / frozen / minimums come from `submit_in`.
//! - Evaluate (after each indexer tick, price from `intel_prices` only): a firing order becomes
//!   an ordinary `buy`/`sell` action + relayer job on the next epoch; the hold moves from the
//!   order to that action without touching the balance (buy: the D10 remainder is released).
//! - Close: cancel / expire / graduated / below minimum release the hold; the action's
//!   settlement decides `filled` / `failed`.
//! - D1: 24 h after closing amount/price/mint/slippage/action are erased, 48 h → deleted.
//!
//! Privacy: nothing here logs; callers log counts only.

use deadpool_postgres::GenericClient;

use crate::{
    ActionReceipt, Ledger, LedgerError, Result,
    actions::{NewAction, RateUsed, ZAT_PER_ZEC, token_journal},
    fair::is_replay,
    journal, to_i64, to_u64,
};

pub const MAX_OPEN_PER_KEY: i64 = 10;
pub const MAX_OPEN_PER_MINT: i64 = 4;
pub const MAX_OPEN_GLOBAL: i64 = 1_000;
/// v0.15: how many times an order with `rearm` goes back to `open` after slippage
/// (also the DB CHECK on `orders.rearms`).
pub const MAX_REARMS: i16 = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct NewOrder {
    pub kind: String,
    pub venue: String,
    pub mint: String,
    /// Canonical decimal string (validated by the API: > 0, ≤ 18 fractional digits).
    pub trigger: String,
    pub amount: u64,
    pub slippage_bps: u32,
    pub exec_mode: String,
    pub ttl_secs: u64,
    /// limit_buy: upper-bound token estimate for the creator cap (ignored for non-creators).
    pub gain: Option<u64>,
    /// v0.15 bracket only: the stop-loss leg (canonical decimal, < `trigger`) and its slippage.
    /// `trigger` / `slippage_bps` are the take-profit leg.
    pub sl_trigger: Option<String>,
    pub sl_slippage_bps: Option<u32>,
    /// v0.15: back to `open` after slippage (≤ [`MAX_REARMS`] times).
    pub rearm: bool,
}

impl NewOrder {
    pub fn is_buy(&self) -> bool {
        self.kind == "limit_buy"
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct OrderRow {
    pub id: [u8; 16],
    pub venue: String,
    pub mint: String,
    pub kind: String,
    pub trigger: String,
    pub amount: u64,
    pub slippage_bps: i32,
    pub exec_mode: String,
    pub status: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub armed: bool,
    pub action_id: Option<[u8; 16]>,
    pub error: Option<String>,
    /// v0.15 bracket: stop-loss leg price and slippage; `leg` = the leg that fired.
    pub sl_trigger: Option<String>,
    pub sl_slippage_bps: Option<i32>,
    pub leg: Option<String>,
    pub rearm: bool,
    pub rearms: u32,
}

/// Inputs of one evaluation pass, computed by the API.
#[derive(Clone, Debug, PartialEq)]
pub struct EvalParams {
    pub rate_buy: Option<RateUsed>,
    pub rate_sell: Option<RateUsed>,
    /// Seconds to the next epoch boundary: (`delayed`, `max`).
    pub delay_delayed: f64,
    pub delay_max: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvalReport {
    pub triggered: u64,
    pub armed: u64,
    pub failed: u64,
    pub expired: u64,
    pub closed: u64,
    /// v0.15: orders put back to `open` after a stop-loss guard miss (settlement re-arms are
    /// not counted here).
    pub rearmed: u64,
    /// Orders whose evaluation failed (rolled back alone, retried next pass).
    pub errors: u64,
}

/// E16: a tick older than this (indexer down) is never acted on.
pub const TICK_MAX_AGE_MS: i64 = 180_000;

/// E4: off-chain trigger guard at the tick price `p`. A stop-loss sells only while
/// `p ≥ trigger × (1 − slippage)`; a limit buy only while `p ≤ trigger × (1 + slippage)`
/// (always true once it fired, kept for symmetry). Sells above the trigger are fine.
pub fn trigger_guard_ok(kind: &str, price_e18: u128, trigger_e18: u128, slippage_bps: u32) -> bool {
    let s = slippage_bps.min(10_000) as u128;
    match kind {
        "stop_loss" => price_e18.saturating_mul(10_000) >= trigger_e18.saturating_mul(10_000 - s),
        "limit_buy" => price_e18.saturating_mul(10_000) <= trigger_e18.saturating_mul(10_000 + s),
        _ => true,
    }
}

/// Decimal string → value × 1e18 (exact for ≤ 18 fractional digits).
pub fn parse_e18(s: &str) -> Option<u128> {
    let (int, frac) = s.trim().split_once('.').unwrap_or((s.trim(), ""));
    if int.is_empty() && frac.is_empty() || frac.len() > 18 {
        return None;
    }
    if !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let i: u128 = if int.is_empty() { 0 } else { int.parse().ok()? };
    let f: u128 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<18}").parse().ok()?
    };
    i.checked_mul(10u128.pow(18))?.checked_add(f)
}

/// buy: min tokens (base units) for `lamports` at `trigger × (1 + slippage)`.
pub fn buy_min_out(lamports: u64, trigger_e18: u128, decimals: u32, slippage_bps: u32) -> Option<u64> {
    // tokens_whole = lamports / (trigger · 1e9 · (1 + s)); base = · 10^dec
    let num = (lamports as u128)
        .checked_mul(10u128.checked_pow(decimals)?)?
        .checked_mul(1_000_000_000)?
        .checked_mul(10_000)?;
    let den = trigger_e18.checked_mul(10_000 + slippage_bps as u128)?;
    if den == 0 {
        return None;
    }
    Some((num / den).min(u64::MAX as u128) as u64)
}

/// sell: min lamports for `amount` base units at `trigger × (1 − slippage)`.
pub fn sell_min_out(amount: u64, trigger_e18: u128, decimals: u32, slippage_bps: u32) -> Option<u64> {
    // lamports = amount / 10^dec · trigger · 1e9 = amount · trigger_e18 / (10^dec · 1e9)
    let num = (amount as u128)
        .checked_mul(trigger_e18)?
        .checked_mul(10_000 - slippage_bps.min(10_000) as u128)?;
    let den = 10u128
        .checked_pow(decimals)?
        .checked_mul(1_000_000_000)?
        .checked_mul(10_000)?;
    Some((num / den).min(u64::MAX as u128) as u64)
}

fn id16(v: Vec<u8>) -> [u8; 16] {
    v.try_into().unwrap_or([0; 16])
}

/// Release the hold of an order (held on its `order_create` action) and close it.
async fn close_order<C: GenericClient>(tx: &C, order_id: &[u8], status: &str, error: Option<&str>) -> Result<()> {
    if let Some(a) = tx
        .query_opt(
            "SELECT anon_pubkey, hold_zat, token_mint, token_hold FROM actions
             WHERE id = $1 AND status = 'queued' FOR UPDATE",
            &[&order_id],
        )
        .await?
    {
        let (pk, hold, tmint, thold): (Vec<u8>, i64, Option<String>, i64) = (a.get(0), a.get(1), a.get(2), a.get(3));
        if hold > 0 {
            tx.execute(
                "UPDATE balances SET held_zat = held_zat - $2, available_zat = available_zat + $2, updated_at = now()
                 WHERE anon_pubkey = $1",
                &[&pk, &hold],
            )
            .await?;
            journal(tx, &pk, "release", hold, -hold, None, Some(order_id)).await?;
        }
        if let (Some(m), true) = (&tmint, thold > 0) {
            tx.execute(
                "UPDATE token_balances SET held = held - $3, available = available + $3, updated_at = now()
                 WHERE anon_pubkey = $1 AND mint = $2",
                &[&pk, m, &thold],
            )
            .await?;
            token_journal(tx, &pk, m, "release", thold, -thold, order_id).await?;
        }
        tx.execute(
            "UPDATE actions SET status = 'failed', error = $2, gain_mint = NULL, gain_est = NULL, updated_at = now()
             WHERE id = $1",
            &[&order_id, &error.unwrap_or(status)],
        )
        .await?;
    }
    tx.execute(
        "UPDATE orders SET status = $2, error = $3, sl_armed_tick = NULL, closed_at = now() WHERE id = $1",
        &[&order_id, &status, &error],
    )
    .await?;
    Ok(())
}

/// v0.15 re-arm, called by settlement inside its transaction for an action that failed as a
/// whole with `slippage`. If it is the trade of a `triggered` order with `rearm` (re-arms left,
/// not expired), its hold goes back onto the order (the `order_create` action is queued again
/// with the same ZEC / token hold and creator-cap estimate; balances do not change) and the
/// order is `open` again (SL disarmed, leg and action link cleared). Returns `true` when the
/// hold was taken over: the caller must then NOT release it.
pub(crate) async fn rearm_on_slippage<C: GenericClient>(tx: &C, action_id: &[u8]) -> Result<bool> {
    let Some(o) = tx
        .query_opt(
            "SELECT id FROM orders WHERE action_id = $1 AND status = 'triggered' AND rearm AND rearms < $2
               AND expires_at > now() FOR UPDATE",
            &[&action_id, &MAX_REARMS],
        )
        .await?
    else {
        return Ok(false);
    };
    let oid: Vec<u8> = o.get(0);
    let a = tx
        .query_one(
            "SELECT hold_zat, token_hold, gain_mint, gain_est FROM actions WHERE id = $1",
            &[&action_id],
        )
        .await?;
    let (hold, thold, gmint, gest): (i64, i64, Option<String>, Option<i64>) = (a.get(0), a.get(1), a.get(2), a.get(3));
    let n = tx
        .execute(
            "UPDATE actions SET status = 'queued', error = NULL, hold_zat = $2, token_hold = $3, gain_mint = $4,
                    gain_est = $5, updated_at = now()
             WHERE id = $1 AND status = 'executed'",
            &[&oid, &hold, &thold, &gmint, &gest],
        )
        .await?;
    if n != 1 {
        return Ok(false);
    }
    tx.execute(
        "UPDATE orders SET status = 'open', action_id = NULL, leg = NULL, sl_armed_tick = NULL,
                rearms = rearms + 1, amount = CASE WHEN kind = 'limit_buy' THEN $2::bigint ELSE $3::bigint END
         WHERE id = $1",
        &[&oid, &hold, &thold],
    )
    .await?;
    Ok(true)
}

impl Ledger {
    /// `order_create`. Receipt id = order id; status `open`.
    pub async fn order_create(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        o: &NewOrder,
    ) -> Result<ActionReceipt> {
        let (pk_s, nonce_s): (&[u8], &[u8]) = (pk, nonce);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let a = NewAction {
            kind: "order_create".into(),
            amount_zat: if o.is_buy() { o.amount } else { 0 },
            token_hold: (!o.is_buy()).then(|| (o.mint.clone(), o.amount)),
            gain: o.gain.map(|g| (o.mint.clone(), g)),
            ..NewAction::default()
        };
        if is_replay(&tx, pk_s, nonce_s).await? {
            let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
            let rid: &[u8] = &r.id;
            if let Some(row) = tx.query_opt("SELECT status FROM orders WHERE id = $1", &[&rid]).await? {
                r.status = row.get(0);
            }
            return Ok(r);
        }
        tx.execute("SELECT pg_advisory_xact_lock(7566726966790002)", &[])
            .await?;
        let counts = tx
            .query_one(
                "SELECT count(*) FILTER (WHERE anon_pubkey = $1),
                        count(*) FILTER (WHERE anon_pubkey = $1 AND mint = $2),
                        count(*)
                 FROM orders WHERE status IN ('open', 'triggered')",
                &[&pk_s, &o.mint],
            )
            .await?;
        let (per_key, per_mint, global): (i64, i64, i64) = (counts.get(0), counts.get(1), counts.get(2));
        if global >= MAX_OPEN_GLOBAL {
            return Err(LedgerError::OrdersFull);
        }
        if per_key >= MAX_OPEN_PER_KEY || per_mint >= MAX_OPEN_PER_MINT {
            return Err(LedgerError::OrderLimit);
        }
        let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
        let id: &[u8] = &r.id;
        tx.execute(
            "INSERT INTO orders (id, anon_pubkey, venue, mint, kind, trigger_price_sol, amount, slippage_bps, exec_mode,
                                 expires_at, last_tick, sl_price_sol, sl_slippage_bps, rearm)
             VALUES ($1, $2, $3, $4, $5, $6::text::numeric, $7, $8, $9,
                     date_trunc('hour', now() + make_interval(secs => $10) + interval '1 hour' - interval '1 microsecond'),
                     -- E16: only ticks AFTER the order are evaluated.
                     (SELECT tick_at FROM intel_prices WHERE mint = $4),
                     $11::text::numeric, $12, $13)",
            &[
                &id,
                &pk_s,
                &o.venue,
                &o.mint,
                &o.kind,
                &o.trigger,
                &to_i64(o.amount)?,
                &(o.slippage_bps as i32),
                &o.exec_mode,
                &(o.ttl_secs as f64),
                &o.sl_trigger,
                &o.sl_slippage_bps.map(|v| v as i32),
                &o.rearm,
            ],
        )
        .await?;
        tx.commit().await?;
        r.status = "open".into();
        Ok(r)
    }

    /// `order_cancel`: only from `open`. Receipt = the cancel action, status `cancelled`.
    pub async fn order_cancel(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        order_id: &[u8; 16],
    ) -> Result<ActionReceipt> {
        let (pk_s, nonce_s, oid): (&[u8], &[u8], &[u8]) = (pk, nonce, order_id);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let cancel = NewAction {
            kind: "order_cancel".into(),
            ..NewAction::default()
        };
        if is_replay(&tx, pk_s, nonce_s).await? {
            let mut r = self.submit_in(&tx, pk, nonce, request_hash, &cancel).await?;
            r.status = "cancelled".into();
            return Ok(r);
        }
        let Some(o) = tx
            .query_opt(
                "SELECT status FROM orders WHERE id = $1 AND anon_pubkey = $2 AND mint IS NOT NULL FOR UPDATE",
                &[&oid, &pk_s],
            )
            .await?
        else {
            return Err(LedgerError::NotFound);
        };
        if o.get::<_, String>(0) != "open" {
            return Err(LedgerError::OrderNotOpen);
        }
        let mut r = self.submit_in(&tx, pk, nonce, request_hash, &cancel).await?;
        close_order(&tx, oid, "cancelled", None).await?;
        let rid: &[u8] = &r.id;
        tx.execute(
            "UPDATE actions SET status = 'executed', updated_at = now() WHERE id = $1",
            &[&rid],
        )
        .await?;
        tx.commit().await?;
        r.status = "cancelled".into();
        Ok(r)
    }

    /// `Portfolio.orders`: open/triggered first, then closed ones not yet scrubbed; ≤ 20.
    pub async fn owner_orders(&self, pk: &[u8; 32]) -> Result<Vec<OrderRow>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT id, venue, mint, kind, trigger_price_sol::text, amount, slippage_bps, exec_mode, status,
                        (extract(epoch FROM created_at) * 1000)::bigint, (extract(epoch FROM expires_at) * 1000)::bigint,
                        sl_armed_tick IS NOT NULL, action_id, error, sl_price_sol::text, sl_slippage_bps, leg, rearm,
                        rearms
                 FROM orders WHERE anon_pubkey = $1 AND mint IS NOT NULL
                 ORDER BY (status IN ('open', 'triggered')) DESC, created_at DESC, id LIMIT 20",
                &[&pk_s],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| OrderRow {
                id: id16(r.get(0)),
                venue: r.get(1),
                mint: r.get(2),
                kind: r.get(3),
                trigger: r.get::<_, Option<String>>(4).unwrap_or_default(),
                amount: to_u64(r.get(5)),
                slippage_bps: r.get::<_, Option<i32>>(6).unwrap_or(0),
                exec_mode: r.get(7),
                status: r.get(8),
                created_at_ms: to_u64(r.get(9)),
                expires_at_ms: to_u64(r.get(10)),
                armed: r.get(11),
                action_id: r.get::<_, Option<Vec<u8>>>(12).map(id16),
                error: r.get(13),
                sl_trigger: r.get(14),
                sl_slippage_bps: r.get(15),
                leg: r.get(16),
                rearm: r.get(17),
                rearms: r.get::<_, i16>(18).max(0) as u32,
            })
            .collect())
    }

    /// One pass: expire, close triggered orders whose action settled, evaluate new ticks.
    /// E16: every order is evaluated in its own transaction (one failing order never rolls
    /// back the others), and only on a tick newer than the order and fresher than
    /// [`TICK_MAX_AGE_MS`].
    pub async fn orders_tick(&self, network: &str, p: &EvalParams) -> Result<EvalReport> {
        let mut rep = EvalReport::default();
        {
            let mut c = self.pool.get().await?;
            let tx = c.transaction().await?;
            // Expired.
            for r in tx
                .query(
                    "SELECT id FROM orders WHERE status = 'open' AND expires_at <= now() FOR UPDATE SKIP LOCKED",
                    &[],
                )
                .await?
            {
                let id: Vec<u8> = r.get(0);
                close_order(&tx, &id, "expired", None).await?;
                rep.expired += 1;
            }
            // Triggered orders whose action is closed.
            for r in tx
                .query(
                    "SELECT o.id, a.status, a.error FROM orders o JOIN actions a ON a.id = o.action_id
                     WHERE o.status = 'triggered' AND a.status <> 'queued' FOR UPDATE OF o SKIP LOCKED",
                    &[],
                )
                .await?
            {
                let (id, st, err): (Vec<u8>, String, Option<String>) = (r.get(0), r.get(1), r.get(2));
                let (ns, e) = if st == "executed" {
                    ("filled", None)
                } else {
                    ("failed", err)
                };
                tx.execute(
                    "UPDATE orders SET status = $2, error = $3, closed_at = now() WHERE id = $1",
                    &[&id, &ns, &e],
                )
                .await?;
                rep.closed += 1;
            }
            tx.commit().await?;
        }
        // Orders with a new tick, in random order (no arrival order).
        let mut ids: Vec<Vec<u8>> = {
            let c = self.pool.get().await?;
            c.query(
                "SELECT o.id FROM orders o JOIN intel_prices p ON p.mint = o.mint
                 WHERE o.status = 'open' AND p.tick_at > COALESCE(o.last_tick, 0)",
                &[],
            )
            .await?
            .into_iter()
            .map(|r| r.get(0))
            .collect()
        };
        for i in (1..ids.len()).rev() {
            ids.swap(i, (rand::random::<u64>() % (i as u64 + 1)) as usize);
        }
        for id in ids {
            let res = async {
                let mut c = self.pool.get().await?;
                let tx = c.transaction().await?;
                self.eval_order(&tx, network, p, &id, &mut rep).await?;
                tx.commit().await?;
                Ok::<(), LedgerError>(())
            }
            .await;
            if let Err(e) = res {
                // Rolled back alone; retried on the next pass. Kind only, no order data.
                tracing::warn!(error = e.kind(), "order evaluation failed");
                rep.errors += 1;
            }
        }
        Ok(rep)
    }

    /// Evaluate one open order against its newest tick (inside `tx`).
    async fn eval_order<C: GenericClient>(
        &self,
        tx: &C,
        network: &str,
        p: &EvalParams,
        id: &[u8],
        rep: &mut EvalReport,
    ) -> Result<()> {
        let Some(r) = tx
            .query_opt(
                "SELECT o.id, o.anon_pubkey, o.kind, o.mint, o.amount, o.slippage_bps, o.exec_mode, o.sl_armed_tick,
                        p.tick_at, p.prev_tick_at, p.status,
                        p.price_sol <= o.trigger_price_sol, p.price_sol >= o.trigger_price_sol,
                        o.trigger_price_sol::text, COALESCE(t.decimals, 6::smallint), COALESCE(b.frozen, FALSE),
                        p.price_sol::text, (extract(epoch FROM now()) * 1000)::bigint - p.tick_at,
                        p.price_sol <= o.sl_price_sol, o.sl_price_sol::text, o.sl_slippage_bps,
                        o.rearm AND o.rearms < $2 AND o.expires_at > now(), o.rearms
                 FROM orders o JOIN intel_prices p ON p.mint = o.mint
                 LEFT JOIN tokens t ON t.mint = o.mint LEFT JOIN balances b ON b.anon_pubkey = o.anon_pubkey
                 WHERE o.id = $1 AND o.status = 'open' AND p.tick_at > COALESCE(o.last_tick, 0)
                 FOR UPDATE OF o SKIP LOCKED",
                &[&id, &MAX_REARMS],
            )
            .await?
        else {
            return Ok(());
        };
        let id: Vec<u8> = r.get(0);
        let pk: Vec<u8> = r.get(1);
        let kind: String = r.get(2);
        let mint: String = r.get(3);
        let amount = to_u64(r.get(4));
        let slip = r.get::<_, Option<i32>>(5).unwrap_or(500).max(0) as u32;
        let exec: String = r.get(6);
        let armed: Option<i64> = r.get(7);
        let (tick, prev_tick): (i64, Option<i64>) = (r.get(8), r.get(9));
        let graduated = r.get::<_, String>(10) == "graduated";
        let (le, ge): (bool, bool) = (r.get(11), r.get(12));
        let trigger: String = r.get(13);
        let dec = r.get::<_, i16>(14).clamp(0, 18) as u32;
        let frozen: bool = r.get(15);
        let price: String = r.get(16);
        let age_ms: i64 = r.get(17);
        let sl_le: bool = r.get::<_, Option<bool>>(18).unwrap_or(false);
        let sl_trigger: Option<String> = r.get(19);
        let sl_slip = r.get::<_, Option<i32>>(20).unwrap_or(1_500).max(0) as u32;
        let can_rearm: bool = r.get(21);
        let rearms: i16 = r.get(22);
        let set_tick = |armed_next: Option<i64>| {
            let id = id.clone();
            async move {
                tx.execute(
                    "UPDATE orders SET last_tick = $2, sl_armed_tick = $3 WHERE id = $1",
                    &[&id, &tick, &armed_next],
                )
                .await
            }
        };
        if age_ms > TICK_MAX_AGE_MS {
            // Stale tick (indexer was down): consumed without a decision; it cannot be one of
            // the two consecutive stop-loss ticks.
            set_tick(None).await?;
            return Ok(());
        }
        if graduated {
            close_order(tx, &id, "failed", Some("graduated")).await?;
            rep.failed += 1;
            return Ok(());
        }
        let Some(decision) = decide(&kind, le, ge, sl_le, armed, prev_tick) else {
            return Ok(());
        };
        let (eff, leg) = match decision {
            Decision::Wait { arm } => {
                set_tick(arm.then_some(tick)).await?;
                if arm {
                    rep.armed += 1;
                }
                return Ok(());
            }
            Decision::Fire { kind, leg } => (kind, leg),
        };
        // The fired leg's trigger and slippage (bracket SL leg: its own columns).
        let (trigger, slip) = if leg == Some("sl") {
            (sl_trigger.unwrap_or_default(), sl_slip)
        } else {
            (trigger, slip)
        };
        let buy = eff == "limit_buy";
        let rate = if buy { p.rate_buy.as_ref() } else { p.rate_sell.as_ref() };
        let (Some(rate), false) = (rate, frozen) else {
            // No rate / frozen balance: wait for the next tick (SL stays armed).
            set_tick((eff == "stop_loss").then_some(tick)).await?;
            return Ok(());
        };
        let (Some(trigger_e18), Some(price_e18)) = (parse_e18(&trigger), parse_e18(&price)) else {
            close_order(tx, &id, "failed", Some("bad_request")).await?;
            rep.failed += 1;
            return Ok(());
        };
        // E4: the trigger guard stays off chain. A stop-loss whose tick gapped below
        // trigger × (1 − slippage) does not sell (as before, when min_out came from the trigger).
        if !trigger_guard_ok(eff, price_e18, trigger_e18, slip) {
            if can_rearm {
                // v0.15: back to waiting (disarmed), hold kept; one re-arm used.
                tx.execute(
                    "UPDATE orders SET last_tick = $2, sl_armed_tick = NULL, rearms = rearms + 1 WHERE id = $1",
                    &[&id, &tick],
                )
                .await?;
                rep.rearmed += 1;
            } else {
                close_order(tx, &id, "failed", Some("slippage")).await?;
                rep.failed += 1;
            }
            return Ok(());
        }
        let a = tx
            .query_one(
                "SELECT hold_zat, gain_mint, gain_est FROM actions WHERE id = $1 FOR UPDATE",
                &[&id],
            )
            .await?;
        let (hold, gain_mint, gain_est): (i64, Option<String>, Option<i64>) = (a.get(0), a.get(1), a.get(2));
        // E4: min_out from the PUBLIC tick price (like a manual trade from a public price),
        // never from the trigger; quantized at job insertion.
        // A5 / A6 (final audit): a sell never repeats the amount of its failed attempt nor
        // mirrors this key's public buy. After a re-arm, or when the amount matches a buy
        // (±1 %), it is shaved 0.5–2 % and rounded to 3 significant digits; the remainder of
        // the order's token hold goes back to `available` in this transaction.
        let amount = if !buy && (rearms > 0 || crate::actions::matches_public_buy(tx, &pk, &mint, amount).await?) {
            let a2 = crate::actions::fuzz_token_amount_rand(amount);
            if a2 == 0 {
                close_order(tx, &id, "failed", Some("below_minimum")).await?;
                rep.failed += 1;
                return Ok(());
            }
            let back = to_i64(amount - a2)?;
            tx.execute(
                "UPDATE token_balances SET held = held - $3, available = available + $3, updated_at = now()
                 WHERE anon_pubkey = $1 AND mint = $2",
                &[&pk, &mint, &back],
            )
            .await?;
            token_journal(tx, &pk, &mint, "release", back, -back, &id).await?;
            tx.execute("UPDATE orders SET amount = $2 WHERE id = $1", &[&id, &to_i64(a2)?])
                .await?;
            a2
        } else {
            amount
        };
        let (lamports, zat, min_out) = if buy {
            let full = ((hold.max(0) as u128) * (rate.lamports_per_zec as u128) / ZAT_PER_ZEC) as u64;
            let shave = (rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64;
            let lamports = unzeen_fair::alloc::fuzz_lamports(full, shave);
            let zat = ((lamports as u128) * ZAT_PER_ZEC)
                .div_ceil(rate.lamports_per_zec.max(1) as u128)
                .min(hold.max(0) as u128) as u64;
            match buy_min_out(lamports, price_e18, dec, slip) {
                Some(m) if lamports > 0 && zat >= self.policy.min_action_zat => (lamports, zat, m),
                _ => {
                    close_order(tx, &id, "failed", Some("below_minimum")).await?;
                    rep.failed += 1;
                    return Ok(());
                }
            }
        } else {
            match sell_min_out(amount, price_e18, dec, slip) {
                Some(m) => (0, 0, m),
                None => {
                    close_order(tx, &id, "failed", Some("bad_request")).await?;
                    rep.failed += 1;
                    return Ok(());
                }
            }
        };
        let min_out = crate::actions::quantize_min_out(min_out);
        // The trade: an ordinary buy/sell action + relayer job on the next epoch. E20: a random
        // request hash, like a signed request (no "came from an order" marker in the DB).
        let aid: [u8; 16] = rand::random();
        let nonce: [u8; 16] = rand::random();
        let rh: [u8; 32] = rand::random();
        let (aid_s, nonce_s, rh_s): (&[u8], &[u8], &[u8]) = (&aid, &nonce, &rh);
        let zat_i = to_i64(zat)?;
        let (tmint, thold): (Option<&str>, i64) = if buy {
            (None, 0)
        } else {
            (Some(mint.as_str()), to_i64(amount)?)
        };
        tx.execute(
            "INSERT INTO actions (id, anon_pubkey, nonce, request_hash, kind, hold_zat, status, amount_zat, fee_zat,
                                  rate_lamports_per_zec, rate_source, rate_ts, token_mint, token_hold,
                                  gain_mint, gain_est)
             VALUES ($1, $2, $3, $4, $5, $6, 'queued', $6, 0, $7, $8, to_timestamp($9), $10, $11, $12, $13)",
            &[
                &aid_s,
                &pk,
                &nonce_s,
                &rh_s,
                &(if buy { "buy" } else { "sell" }),
                &zat_i,
                &to_i64(rate.lamports_per_zec)?,
                &rate.source,
                &(to_i64(rate.ts_ms)? as f64 / 1000.0),
                &tmint,
                &thold,
                &gain_mint,
                &gain_est,
            ],
        )
        .await?;
        let delay = if exec == "max" { p.delay_max } else { p.delay_delayed };
        tx.execute(
            "INSERT INTO relayer_jobs (action_id, part, op, venue, mint, lamports_in, token_amount, min_out,
                                       network, not_before, exec_mode)
             VALUES ($1, 0, $2, 'pumpfun', $3, $4, $5, $6, $7, now() + make_interval(secs => $8), $9)",
            &[
                &aid_s,
                &(if buy { "buy" } else { "sell" }),
                &mint,
                &(if buy { Some(to_i64(lamports)?) } else { None }),
                &(if buy { None } else { Some(to_i64(amount)?) }),
                &to_i64(min_out)?,
                &network,
                &delay.max(0.0),
                &exec,
            ],
        )
        .await?;
        // Move the hold: the order action keeps nothing; a buy's D10 remainder is released.
        let back = hold - zat_i;
        if buy && back > 0 {
            tx.execute(
                "UPDATE balances SET held_zat = held_zat - $2, available_zat = available_zat + $2,
                        updated_at = now() WHERE anon_pubkey = $1",
                &[&pk, &back],
            )
            .await?;
            journal(tx, &pk, "release", back, -back, None, Some(&id)).await?;
        }
        tx.execute(
            "UPDATE actions SET status = 'executed', hold_zat = 0, token_hold = 0, gain_mint = NULL, gain_est = NULL,
                    updated_at = now() WHERE id = $1",
            &[&id],
        )
        .await?;
        // OCO: the whole row (both legs of a bracket) leaves `open` in this transaction.
        tx.execute(
            "UPDATE orders SET status = 'triggered', action_id = $2, last_tick = $3, sl_armed_tick = NULL, leg = $4
             WHERE id = $1",
            &[&id, &aid_s, &tick, &leg],
        )
        .await?;
        rep.triggered += 1;
        Ok(())
    }

    /// D1 for orders: closed + 24 h → amounts, price, mint, slippage, action link erased;
    /// closed + 48 h → deleted.
    pub async fn orders_janitor(&self) -> Result<(u64, u64)> {
        let c = self.pool.get().await?;
        let scrubbed = c
            .execute(
                "UPDATE orders SET mint = NULL, trigger_price_sol = NULL, amount = 0, slippage_bps = NULL,
                        action_id = NULL, sl_armed_tick = NULL, last_tick = NULL, sl_price_sol = NULL,
                        sl_slippage_bps = NULL, leg = NULL, rearms = 0
                 WHERE closed_at < now() - interval '24 hours' AND mint IS NOT NULL",
                &[],
            )
            .await?;
        let deleted = c
            .execute("DELETE FROM orders WHERE closed_at < now() - interval '48 hours'", &[])
            .await?;
        Ok((scrubbed, deleted))
    }

    /// Facts for validating an order mint: (venue, status, decimals) from `tokens`, and the
    /// last tick price (decimal string) if any. v0.13: SOL pairs only (a non-SOL pair answers
    /// like an unknown mint → order_unsupported_mint).
    pub async fn order_mint_info(&self, mint: &str) -> Result<Option<(String, String, i16, Option<String>)>> {
        let c = self.pool.get().await?;
        let r = c
            .query_opt(
                "SELECT t.venue, t.status, t.decimals, p.price_sol::text FROM tokens t
                 LEFT JOIN intel_prices p ON p.mint = t.mint WHERE t.mint = $1 AND t.quote_mint IS NULL",
                &[&mint],
            )
            .await?;
        Ok(r.map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))))
    }
}

/// Outcome of one tick for an open order (prices already compared in SQL).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Not firing; `arm` = a stop-loss condition holds on this tick (first of two).
    Wait { arm: bool },
    /// Fire as `kind` (`limit_buy` / `limit_sell` / `take_profit` / `stop_loss`); `leg` is set
    /// for a bracket (`"tp"` / `"sl"`).
    Fire {
        kind: &'static str,
        leg: Option<&'static str>,
    },
}

/// Trigger decision. `le` / `ge`: tick price vs `trigger_price_sol` (bracket: the TP leg);
/// `sl_le`: tick price ≤ the bracket SL leg; `armed`: tick where the SL condition first held;
/// `prev_tick`: the tick before this one. A stop-loss (or SL leg) fires only when it was armed
/// on exactly the previous tick. Bracket: TP wins on its tick and disarms SL. `None` for an
/// unknown kind (left untouched).
pub fn decide(
    kind: &str,
    le: bool,
    ge: bool,
    sl_le: bool,
    armed: Option<i64>,
    prev_tick: Option<i64>,
) -> Option<Decision> {
    let confirmed = armed.is_some() && armed == prev_tick;
    Some(match kind {
        "limit_buy" if le => Decision::Fire {
            kind: "limit_buy",
            leg: None,
        },
        "limit_sell" | "take_profit" if ge => Decision::Fire {
            kind: if kind == "limit_sell" {
                "limit_sell"
            } else {
                "take_profit"
            },
            leg: None,
        },
        "stop_loss" if le && confirmed => Decision::Fire {
            kind: "stop_loss",
            leg: None,
        },
        "stop_loss" => Decision::Wait { arm: le },
        "bracket" if ge => Decision::Fire {
            kind: "take_profit",
            leg: Some("tp"),
        },
        "bracket" if sl_le && confirmed => Decision::Fire {
            kind: "stop_loss",
            leg: Some("sl"),
        },
        "bracket" => Decision::Wait { arm: sl_le },
        "limit_buy" | "limit_sell" | "take_profit" => Decision::Wait { arm: false },
        _ => return None,
    })
}

#[cfg(test)]
mod decide_tests {
    use super::*;

    const TP: Decision = Decision::Fire {
        kind: "take_profit",
        leg: Some("tp"),
    };
    const SL: Decision = Decision::Fire {
        kind: "stop_loss",
        leg: Some("sl"),
    };

    #[test]
    fn bracket_legs() {
        // Between the legs: nothing.
        assert_eq!(
            decide("bracket", true, false, false, None, Some(1)),
            Some(Decision::Wait { arm: false })
        );
        // TP fires on the first tick, no confirmation.
        assert_eq!(decide("bracket", false, true, false, None, None), Some(TP));
        // SL: first tick arms, second consecutive tick fires.
        assert_eq!(
            decide("bracket", true, false, true, None, Some(1)),
            Some(Decision::Wait { arm: true })
        );
        assert_eq!(decide("bracket", true, false, true, Some(1), Some(1)), Some(SL));
        // Armed on an older tick (a tick in between): re-arm, do not fire.
        assert_eq!(
            decide("bracket", true, false, true, Some(1), Some(2)),
            Some(Decision::Wait { arm: true })
        );
        // Armed SL, then the price jumps over TP: TP fires (SL never does).
        assert_eq!(decide("bracket", false, true, false, Some(1), Some(1)), Some(TP));
    }

    #[test]
    fn single_kinds_unchanged() {
        let fire = |k| Some(Decision::Fire { kind: k, leg: None });
        assert_eq!(decide("limit_buy", true, false, false, None, None), fire("limit_buy"));
        assert_eq!(decide("limit_sell", false, true, false, None, None), fire("limit_sell"));
        assert_eq!(
            decide("take_profit", true, true, false, None, None),
            fire("take_profit")
        );
        assert_eq!(
            decide("stop_loss", true, false, false, None, Some(1)),
            Some(Decision::Wait { arm: true })
        );
        assert_eq!(
            decide("stop_loss", true, false, false, Some(1), Some(1)),
            fire("stop_loss")
        );
        assert_eq!(
            decide("stop_loss", false, true, false, Some(1), Some(1)),
            Some(Decision::Wait { arm: false })
        );
        // sl_le is ignored outside brackets.
        assert_eq!(
            decide("limit_sell", false, false, true, Some(1), Some(1)),
            Some(Decision::Wait { arm: false })
        );
        assert_eq!(decide("weird", true, true, true, None, None), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimals() {
        assert_eq!(parse_e18("1"), Some(10u128.pow(18)));
        assert_eq!(parse_e18("0.000000028"), Some(28_000_000_000));
        assert_eq!(parse_e18(".5"), Some(5 * 10u128.pow(17)));
        assert_eq!(parse_e18("0.0000000000000000001"), None);
        assert_eq!(parse_e18("-1"), None);
        assert_eq!(parse_e18("1e5"), None);
    }

    #[test]
    fn min_outs_follow_the_trigger() {
        // 1e-6 SOL per whole token (6 decimals), 1 SOL → 1e6 whole tokens = 1e12 base units.
        let t = parse_e18("0.000001").unwrap();
        assert_eq!(buy_min_out(1_000_000_000, t, 6, 0), Some(1_000_000_000_000));
        // 5 % slippage: 1/1.05 of that.
        assert_eq!(buy_min_out(1_000_000_000, t, 6, 500), Some(952_380_952_380));
        // sell 1e12 base units at 1e-6 → 1 SOL; 15 % slippage → 0.85 SOL.
        assert_eq!(sell_min_out(1_000_000_000_000, t, 6, 0), Some(1_000_000_000));
        assert_eq!(sell_min_out(1_000_000_000_000, t, 6, 1_500), Some(850_000_000));
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn stop_loss_guard_at_tick_price() {
        let t = parse_e18("0.000001").unwrap();
        // 15 % slippage: sells down to 0.85e-6, not below.
        assert!(trigger_guard_ok(
            "stop_loss",
            parse_e18("0.00000095").unwrap(),
            t,
            1_500
        ));
        assert!(trigger_guard_ok(
            "stop_loss",
            parse_e18("0.00000085").unwrap(),
            t,
            1_500
        ));
        assert!(!trigger_guard_ok(
            "stop_loss",
            parse_e18("0.00000084").unwrap(),
            t,
            1_500
        ));
        assert!(trigger_guard_ok("limit_buy", parse_e18("0.0000009").unwrap(), t, 500));
        assert!(!trigger_guard_ok("limit_buy", parse_e18("0.00000106").unwrap(), t, 500));
        assert!(trigger_guard_ok("take_profit", parse_e18("1").unwrap(), t, 500));
    }

    #[test]
    fn min_out_from_tick_does_not_reveal_trigger() {
        // Same tick price, two different triggers: identical on-chain min_out.
        let p = parse_e18("0.00000095").unwrap();
        let a = crate::actions::quantize_min_out(sell_min_out(500_000_000_000, p, 6, 1_500).unwrap());
        assert!(trigger_guard_ok("stop_loss", p, parse_e18("0.000001").unwrap(), 1_500));
        assert!(trigger_guard_ok(
            "stop_loss",
            p,
            parse_e18("0.00000097").unwrap(),
            1_500
        ));
        assert_eq!(
            a, 403_000_000,
            "500 000 tokens × 0.95e-6 × 0.85 = 0.40375 SOL → 3 digits"
        );
    }
}

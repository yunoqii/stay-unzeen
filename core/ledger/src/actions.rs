//! Balance actions with relayer jobs (docs/RELAYER.md), settlement and owner views.
//!
//! - [`Ledger::submit`]: one Postgres transaction = nonce + ZEC hold + token hold + relayer
//!   jobs / ZEC payout. A rejected action rolls back entirely (nonce stays unused).
//! - [`Ledger::settle_ready`]: closes actions whose jobs are all `confirmed`/`failed`.
//! - [`Ledger::detach_old_jobs`]: breaks `action_id` ↔ Solana signature after 24 h.
//!
//! Privacy: nothing here logs. `relayer_jobs` never receives the anon key.

use deadpool_postgres::GenericClient;
use serde_json::{Value, json};

use crate::{ActionReceipt, Ledger, LedgerError, Result, journal, to_i64, to_u64};

/// 1 ZEC in zatoshis.
pub const ZAT_PER_ZEC: u128 = 100_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobOp {
    Buy,
    Sell,
    Create,
    Transfer,
}

impl JobOp {
    pub fn as_str(self) -> &'static str {
        match self {
            JobOp::Buy => "buy",
            JobOp::Sell => "sell",
            JobOp::Create => "create",
            JobOp::Transfer => "transfer",
        }
    }
}

/// One relayer job (column meanings: docs/RELAYER.md).
#[derive(Clone, Debug, PartialEq)]
pub struct NewJob {
    pub op: JobOp,
    pub venue: Option<String>,
    pub mint: Option<String>,
    pub lamports_in: Option<u64>,
    pub token_amount: Option<u64>,
    pub min_out: Option<u64>,
    pub meta: Option<Value>,
    pub dest: Option<String>,
    pub gas_lamports: Option<u64>,
    /// Execution delay from now (epoch boundary / withdrawal delay), seconds.
    pub delay_secs: f64,
    /// `now` | `delayed` | `max` (relayer_jobs.exec_mode).
    pub exec_mode: &'static str,
}

impl NewJob {
    pub fn new(op: JobOp, delay_secs: f64) -> Self {
        Self {
            op,
            venue: None,
            mint: None,
            lamports_in: None,
            token_amount: None,
            min_out: None,
            meta: None,
            dest: None,
            gas_lamports: None,
            delay_secs,
            exec_mode: "delayed",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NewPayout {
    pub to_ua: String,
    pub amount_zat: u64,
    pub delay_secs: f64,
}

/// ZEC→SOL rate fixed for an action (after spread).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateUsed {
    pub lamports_per_zec: u64,
    pub source: String,
    pub ts_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewAction {
    /// API op (`buy`, `sell`, `create`, `withdraw_zec`, `withdraw_token`).
    pub kind: String,
    /// User amount in zat, checked against `min_action_zat` when > 0.
    pub amount_zat: u64,
    /// Service fee in zat (not subject to the minimum).
    pub fee_zat: u64,
    /// Token hold `(mint, base units)` for sell / withdraw_token.
    pub token_hold: Option<(String, u64)>,
    pub rate: Option<RateUsed>,
    pub network: String,
    pub jobs: Vec<NewJob>,
    pub payout: Option<NewPayout>,
    /// buy: `(mint, upper-bound estimate of tokens received)`. Checked against the creator
    /// cap only when the key created that mint (API v0.5); ignored otherwise.
    pub gain: Option<(String, u64)>,
}

/// What the owner sees in `GET /api/actions/:id`.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionView {
    pub status: String,
    pub error: Option<String>,
    pub solana_tx: Option<String>,
    pub rate: Option<RateUsed>,
    pub fill: Option<Value>,
}

/// What one janitor run did (counters only).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JanitorReport {
    pub detached: u64,
    /// Creator locks that expired and were cleared.
    pub unlocked: u64,
    pub scrubbed: u64,
    pub journal_deleted: u64,
    pub payouts_deleted: u64,
}

/// Columns 0..=6 of an owner view (see [`view_from_row`]). Status `sent` while a tx is in
/// flight (signature written by the relayer / payout broadcast).
const VIEW_COLS: &str = "CASE WHEN a.status = 'queued' AND (
        EXISTS (SELECT 1 FROM relayer_jobs j WHERE j.action_id = a.id AND j.status IN ('sent', 'confirmed'))
     OR EXISTS (SELECT 1 FROM zec_payouts p WHERE p.action_id = a.id AND p.status = 'sent'))
    THEN 'sent' ELSE a.status END,
    a.error, a.rate_lamports_per_zec, a.rate_source,
    (extract(epoch FROM a.rate_ts) * 1000)::bigint, a.fill,
    (SELECT j.signature FROM relayer_jobs j
      WHERE j.action_id = a.id AND j.status = 'confirmed' ORDER BY j.part LIMIT 1)";

fn view_from_row(r: &tokio_postgres::Row) -> ActionView {
    ActionView {
        status: r.get(0),
        error: r.get(1),
        rate: read_rate(r, 2, 3, 4),
        fill: r.get(5),
        solana_tx: r.get(6),
    }
}

/// An action of the owner's list: `ActionStatus & { id, kind }`.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionBrief {
    pub id: [u8; 16],
    pub kind: String,
    pub view: ActionView,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenHolding {
    pub mint: String,
    pub available: u64,
    pub held: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositRow {
    /// Stable random id (16 bytes), owner-only.
    pub id: [u8; 16],
    pub amount_zat: u64,
    pub status: String,
    /// Unix ms, rounded down to the UTC day (N5).
    pub ts_ms: u64,
    /// D3: the deposit's amount is public on chain (transparent / Sapling / legacy Orchard source).
    pub public_source: bool,
}

fn opt_i64(v: Option<u64>) -> Result<Option<i64>> {
    v.map(to_i64).transpose()
}

fn read_rate(r: &tokio_postgres::Row, rate: usize, src: usize, ts: usize) -> Option<RateUsed> {
    let lpz: Option<i64> = r.get(rate);
    lpz.map(|l| RateUsed {
        lamports_per_zec: to_u64(l),
        source: r.get::<_, Option<String>>(src).unwrap_or_default(),
        ts_ms: to_u64(r.get::<_, Option<i64>>(ts).unwrap_or(0)),
    })
}

impl Ledger {
    /// Reserve funds and enqueue the work of a signed action, consuming its nonce, all in one
    /// transaction. Same `(pk, nonce)` + same `request_hash` returns the original receipt.
    pub async fn submit(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        a: &NewAction,
    ) -> Result<ActionReceipt> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let r = self.submit_in(&tx, pk, nonce, request_hash, a).await?;
        tx.commit().await?;
        Ok(r)
    }

    /// [`Self::submit`] inside a caller's transaction (fair-launch ops add their own rows).
    /// On a replay (`replayed = true`) nothing was written.
    pub(crate) async fn submit_in<C: GenericClient>(
        &self,
        tx: &C,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        a: &NewAction,
    ) -> Result<ActionReceipt> {
        if a.amount_zat > 0 && a.amount_zat < self.policy.min_action_zat {
            return Err(LedgerError::BelowMinimum);
        }
        let hold = to_i64(a.amount_zat.checked_add(a.fee_zat).ok_or(LedgerError::Range)?)?;
        let (amount, fee) = (to_i64(a.amount_zat)?, to_i64(a.fee_zat)?);
        let id: [u8; 16] = rand::random();
        let (pk_s, nonce_s, hash_s, id_s): (&[u8], &[u8], &[u8], &[u8]) = (pk, nonce, request_hash, &id);
        let (tmint, thold) = match &a.token_hold {
            Some((m, n)) if *n > 0 => (Some(m.as_str()), to_i64(*n)?),
            Some(_) => return Err(LedgerError::Range),
            None => (None, 0),
        };
        let (rate, rate_src, rate_ts) = match &a.rate {
            Some(r) => (
                Some(to_i64(r.lamports_per_zec)?),
                Some(r.source.as_str()),
                Some(to_i64(r.ts_ms)? as f64 / 1000.0),
            ),
            None => (None, None, None),
        };

        let inserted = tx
            .execute(
                "INSERT INTO actions (id, anon_pubkey, nonce, request_hash, kind, hold_zat, status,
                                      amount_zat, fee_zat, rate_lamports_per_zec, rate_source, rate_ts,
                                      token_mint, token_hold)
                 VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, to_timestamp($11), $12, $13)
                 ON CONFLICT (anon_pubkey, nonce) DO NOTHING",
                &[
                    &id_s, &pk_s, &nonce_s, &hash_s, &a.kind, &hold, &amount, &fee, &rate, &rate_src, &rate_ts, &tmint,
                    &thold,
                ],
            )
            .await?
            == 1;
        if !inserted {
            let r = tx
                .query_one(
                    "SELECT id, request_hash, status, rate_lamports_per_zec, rate_source,
                            (extract(epoch FROM rate_ts) * 1000)::bigint
                     FROM actions WHERE anon_pubkey = $1 AND nonce = $2",
                    &[&pk_s, &nonce_s],
                )
                .await?;
            let prev_hash: Vec<u8> = r.get(1);
            if prev_hash != request_hash[..] {
                return Err(LedgerError::Replay);
            }
            let prev_id: Vec<u8> = r.get(0);
            return Ok(ActionReceipt {
                id: prev_id.try_into().map_err(|_| LedgerError::Range)?,
                status: r.get(2),
                replayed: true,
                rate: read_rate(&r, 3, 4, 5),
            });
        }

        // Frozen balances accept no new actions at all (even token-only ones).
        let frozen: Option<bool> = tx
            .query_opt(
                "SELECT frozen FROM balances WHERE anon_pubkey = $1 FOR UPDATE",
                &[&pk_s],
            )
            .await?
            .map(|r| r.get(0));
        if frozen == Some(true) {
            return Err(LedgerError::Frozen);
        }
        if hold > 0 {
            let ok = tx
                .execute(
                    "UPDATE balances SET available_zat = available_zat - $2, held_zat = held_zat + $2,
                            updated_at = now()
                     WHERE anon_pubkey = $1 AND available_zat >= $2 AND NOT frozen",
                    &[&pk_s, &hold],
                )
                .await?
                == 1;
            if !ok {
                return Err(LedgerError::InsufficientBalance);
            }
            journal(tx, pk_s, "hold", -hold, hold, None, Some(id_s)).await?;
        }
        if let Some((m, est)) = &a.gain {
            self.check_creator_cap(tx, pk_s, id_s, m, *est).await?;
        }
        if let Some(m) = tmint {
            // Creator rule: the initial-buy tokens stay on the balance until the lock ends.
            let locked: i64 = tx
                .query_opt(
                    "SELECT locked_amount FROM creator_tokens
                     WHERE mint = $1 AND anon_pubkey = $2 AND locked_until > now()",
                    &[&m, &pk_s],
                )
                .await?
                .map_or(0, |r| r.get(0));
            let ok = tx
                .execute(
                    "UPDATE token_balances SET available = available - $3, held = held + $3, updated_at = now()
                     WHERE anon_pubkey = $1 AND mint = $2 AND available >= $3 AND available - $3 >= $4",
                    &[&pk_s, &m, &thold, &locked],
                )
                .await?
                == 1;
            if !ok {
                if locked > 0 {
                    let available: i64 = tx
                        .query_opt(
                            "SELECT available FROM token_balances WHERE anon_pubkey = $1 AND mint = $2",
                            &[&pk_s, &m],
                        )
                        .await?
                        .map_or(0, |r| r.get(0));
                    if available >= thold {
                        return Err(LedgerError::CreatorLocked);
                    }
                }
                return Err(LedgerError::InsufficientBalance);
            }
            token_journal(tx, pk_s, m, "hold", -thold, thold, id_s).await?;
        }
        for (part, j) in a.jobs.iter().enumerate() {
            let part = i16::try_from(part).map_err(|_| LedgerError::Range)?;
            tx.execute(
                "INSERT INTO relayer_jobs (action_id, part, op, venue, mint, lamports_in, token_amount,
                                           min_out, meta, dest, gas_lamports, network, not_before, exec_mode)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                         now() + make_interval(secs => $13), $14)",
                &[
                    &id_s,
                    &part,
                    &j.op.as_str(),
                    &j.venue,
                    &j.mint,
                    &opt_i64(j.lamports_in)?,
                    &opt_i64(j.token_amount)?,
                    &opt_i64(j.min_out)?,
                    &j.meta,
                    &j.dest,
                    &opt_i64(j.gas_lamports)?,
                    &a.network,
                    &j.delay_secs.max(0.0),
                    &j.exec_mode,
                ],
            )
            .await?;
        }
        if let Some(p) = &a.payout {
            tx.execute(
                "INSERT INTO zec_payouts (action_id, to_ua, amount_zat, not_before)
                 VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
                &[&id_s, &p.to_ua, &to_i64(p.amount_zat)?, &p.delay_secs.max(0.0)],
            )
            .await?;
        }
        Ok(ActionReceipt {
            id,
            status: "queued".into(),
            replayed: false,
            rate: a.rate.clone(),
        })
    }

    /// Creator cap (API v0.5): a buy of the mint's creator must keep its position through the
    /// pool (available + held + estimates of its queued buys + this estimate) within the cap.
    /// The estimate is remembered on the action until settlement.
    async fn check_creator_cap<C: GenericClient>(
        &self,
        tx: &C,
        pk: &[u8],
        action_id: &[u8],
        mint: &str,
        est: u64,
    ) -> Result<()> {
        if self.rules.cap_tokens == 0 {
            return Ok(());
        }
        let creator = tx
            .query_opt(
                "SELECT 1 FROM creator_tokens WHERE mint = $1 AND anon_pubkey = $2",
                &[&mint, &pk],
            )
            .await?
            .is_some();
        if !creator {
            return Ok(());
        }
        let est = to_i64(est)?;
        let position: i64 = tx
            .query_one(
                "SELECT (COALESCE((SELECT available + held FROM token_balances
                                    WHERE anon_pubkey = $1 AND mint = $2), 0)
                       + COALESCE((SELECT sum(gain_est) FROM actions
                                    WHERE anon_pubkey = $1 AND gain_mint = $2 AND status = 'queued'), 0))::bigint",
                &[&pk, &mint],
            )
            .await?
            .get(0);
        if i128::from(position) + i128::from(est) > i128::from(self.rules.cap_tokens) {
            return Err(LedgerError::CreatorCap);
        }
        tx.execute(
            "UPDATE actions SET gain_mint = $2, gain_est = $3 WHERE id = $1",
            &[&action_id, &mint, &est],
        )
        .await?;
        Ok(())
    }

    /// Last `limit` actions of a key with their owner view (R-core-6: the client polls the
    /// portfolio instead of per-action URLs). Queued first, then most recent day.
    pub async fn recent_actions(&self, pk: &[u8; 32], limit: i64) -> Result<Vec<ActionBrief>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                &format!(
                    "SELECT {VIEW_COLS}, a.id, a.kind FROM actions a
                     WHERE a.anon_pubkey = $1 AND a.kind NOT LIKE 'fl\\_%' AND a.kind NOT LIKE 'order\\_%'
                     ORDER BY (a.status = 'queued') DESC, a.created_at DESC, a.id LIMIT $2"
                ),
                &[&pk_s, &limit],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| ActionBrief {
                view: view_from_row(&r),
                id: r.get::<_, Vec<u8>>(7).try_into().unwrap_or([0; 16]),
                kind: r.get(8),
            })
            .collect())
    }

    /// Owner view of an action; `None` if it does not exist or belongs to another key.
    pub async fn action_view(&self, pk: &[u8; 32], id: &[u8; 16]) -> Result<Option<ActionView>> {
        let (pk_s, id_s): (&[u8], &[u8]) = (pk, id);
        let c = self.pool.get().await?;
        let r = c
            .query_opt(
                &format!("SELECT {VIEW_COLS} FROM actions a WHERE a.id = $1 AND a.anon_pubkey = $2"),
                &[&id_s, &pk_s],
            )
            .await?;
        Ok(r.map(|r| view_from_row(&r)))
    }

    pub async fn token_holdings(&self, pk: &[u8; 32]) -> Result<Vec<TokenHolding>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT mint, available, held FROM token_balances
                 WHERE anon_pubkey = $1 AND (available > 0 OR held > 0) ORDER BY mint",
                &[&pk_s],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| TokenHolding {
                mint: r.get(0),
                available: to_u64(r.get(1)),
                held: to_u64(r.get(2)),
            })
            .collect())
    }

    /// Last `limit` deposits of a key that reached the user (credited / refund_pending).
    pub async fn recent_deposits(&self, pk: &[u8; 32], limit: i64) -> Result<Vec<DepositRow>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT d.amount_zat, d.status, d.public_id,
                        (floor(extract(epoch FROM COALESCE(
                            (SELECT min(o.created_at) FROM ledger_ops o
                              WHERE o.deposit_id = d.id AND o.kind = 'deposit_credit'),
                            d.updated_at)) / 86400) * 86400000)::bigint AS ts,
                        d.public_source
                 FROM deposits d
                 WHERE d.anon_pubkey = $1 AND d.status IN ('credited', 'refund_pending')
                 ORDER BY ts DESC, d.id DESC LIMIT $2",
                &[&pk_s, &limit],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| DepositRow {
                amount_zat: to_u64(r.get(0)),
                status: r.get(1),
                id: r.get::<_, Vec<u8>>(2).try_into().unwrap_or([0; 16]),
                ts_ms: to_u64(r.get(3)),
                public_source: r.get(4),
            })
            .collect())
    }

    /// Settle up to `limit` actions whose relayer jobs are all final. Returns how many.
    pub async fn settle_ready(&self, limit: i64) -> Result<usize> {
        let ids: Vec<Vec<u8>> = {
            let c = self.pool.get().await?;
            c.query(
                "SELECT j.action_id FROM relayer_jobs j
                 WHERE j.status IN ('confirmed', 'failed') AND j.settled_at IS NULL AND j.action_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM relayer_jobs o
                                    WHERE o.action_id = j.action_id AND o.status NOT IN ('confirmed', 'failed'))
                 GROUP BY j.action_id LIMIT $1",
                &[&limit],
            )
            .await?
            .into_iter()
            .map(|r| r.get(0))
            .collect()
        };
        let mut n = 0;
        for id in ids {
            if self.settle_action_jobs(&id).await? {
                n += 1;
            }
        }
        Ok(n)
    }

    async fn settle_action_jobs(&self, action_id: &[u8]) -> Result<bool> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let Some(a) = tx
            .query_opt(
                "SELECT anon_pubkey, kind, status, hold_zat, amount_zat, fee_zat, rate_lamports_per_zec,
                        token_mint, token_hold
                 FROM actions WHERE id = $1 FOR UPDATE SKIP LOCKED",
                &[&action_id],
            )
            .await?
        else {
            return Ok(false); // another settler holds it
        };
        let pk: Vec<u8> = a.get(0);
        let kind: String = a.get(1);
        let status: String = a.get(2);
        let hold: i64 = a.get(3);
        let amount: i64 = a.get(4);
        let rate: Option<i64> = a.get(6);
        let token_mint: Option<String> = a.get(7);
        let token_hold: i64 = a.get(8);

        let jobs = tx
            .query(
                "SELECT id, op, mint, lamports_in, token_amount, status, out_mint, out_token_amount,
                        out_lamports, error_code, venue, out_creator_fee
                 FROM relayer_jobs WHERE action_id = $1 AND settled_at IS NULL ORDER BY part FOR UPDATE",
                &[&action_id],
            )
            .await?;
        let job_ids: Vec<i64> = jobs.iter().map(|r| r.get(0)).collect();
        if jobs.is_empty()
            || jobs
                .iter()
                .any(|r| !matches!(r.get::<_, &str>(5), "confirmed" | "failed"))
        {
            return Ok(false);
        }
        if status != "queued" {
            // Closed before (should not happen): only mark the jobs.
            mark_settled(&tx, &job_ids).await?;
            tx.commit().await?;
            return Ok(true);
        }

        let mut any_ok = false;
        let mut first_err: Option<String> = None;
        let mut refund: i64 = 0;
        let mut fill = serde_json::Map::new();
        // Token hold accounting (sell / transfer): spent vs returned.
        let mut tok_spent: i64 = 0;
        let mut tok_back: i64 = 0;
        let mut sol_total: i64 = 0;
        let mut tok_total: i64 = 0;

        for j in &jobs {
            let op: &str = j.get(1);
            let ok = j.get::<_, &str>(5) == "confirmed";
            let lamports_in: Option<i64> = j.get(3);
            let job_tokens: Option<i64> = j.get(4);
            let out_tokens: i64 = j.get::<_, Option<i64>>(7).unwrap_or(0).max(0);
            let out_lamports: i64 = j.get::<_, Option<i64>>(8).unwrap_or(0).max(0);
            if !ok {
                if first_err.is_none() {
                    first_err = Some(j.get::<_, Option<String>>(9).unwrap_or_else(|| "internal".into()));
                }
                if matches!(op, "sell" | "transfer") {
                    tok_back += job_tokens.unwrap_or(0);
                }
                continue;
            }
            any_ok = true;
            sol_total += out_lamports;
            tok_total += out_tokens;
            match op {
                "buy" | "create" => {
                    let mint: Option<String> = if op == "create" { j.get(6) } else { j.get(2) };
                    let li = lamports_in.unwrap_or(0);
                    if li > 0 && out_lamports < li {
                        // Unspent lamports of the (initial) buy go back in ZEC, pro rata.
                        refund += ((amount as i128) * ((li - out_lamports) as i128) / (li as i128)) as i64;
                    }
                    if let Some(m) = &mint {
                        if out_tokens > 0 {
                            credit_tokens(&tx, &pk, m, out_tokens, action_id).await?;
                        }
                        if op == "create" {
                            // Creator rule: the initial-buy tokens are locked; the end is rounded
                            // up to the hour (never earlier than lock_secs).
                            let (locked, lock_secs) = if self.rules.lock_secs > 0 && out_tokens > 0 {
                                (out_tokens, self.rules.lock_secs as f64)
                            } else {
                                (0, 0.0)
                            };
                            // v0.9: the creator fee of this very tx is the pool's.
                            let launch_fee = crate::creator_fees::launch_creator_fee(
                                &self.rules,
                                j.get::<_, Option<&str>>(10),
                                out_lamports,
                                j.get::<_, Option<i64>>(11),
                            );
                            tx.execute(
                                "INSERT INTO creator_tokens (mint, anon_pubkey, locked_amount, locked_until,
                                                             launch_fee_lamports, launch_fee_left)
                                 VALUES ($1, $2, $3::bigint, CASE WHEN $3::bigint > 0
                                     THEN date_trunc('hour', now() + make_interval(secs => $4::float8))
                                          + interval '1 hour' END, $5, $5)
                                 ON CONFLICT (mint) DO NOTHING",
                                &[m, &pk, &locked, &lock_secs, &launch_fee],
                            )
                            .await?;
                            fill.insert("mint".into(), json!(m));
                        }
                    }
                }
                "sell" => {
                    let sold = out_tokens.min(job_tokens.unwrap_or(0));
                    tok_spent += sold;
                    tok_back += job_tokens.unwrap_or(0) - sold;
                    let r = rate.unwrap_or(0);
                    if r > 0 && out_lamports > 0 {
                        let zat = ((out_lamports as i128) * (ZAT_PER_ZEC as i128) / (r as i128)) as i64;
                        if zat > 0 {
                            tx.execute(
                                "INSERT INTO balances (anon_pubkey, available_zat) VALUES ($1, $2)
                                 ON CONFLICT (anon_pubkey) DO UPDATE
                                   SET available_zat = balances.available_zat + EXCLUDED.available_zat,
                                       updated_at = now()",
                                &[&pk, &zat],
                            )
                            .await?;
                            journal(&tx, &pk, "sell_credit", zat, 0, None, Some(action_id)).await?;
                        }
                        fill.insert("zecCredited".into(), json!(zat.to_string()));
                    }
                }
                "transfer" => tok_spent += job_tokens.unwrap_or(0),
                _ => {}
            }
        }

        // Token hold: spend what left the pool, return the rest.
        if let Some(m) = &token_mint {
            debug_assert!(tok_spent + tok_back <= token_hold);
            let back = token_hold - tok_spent; // includes any part not covered by a job
            if token_hold > 0 {
                tx.execute(
                    "UPDATE token_balances SET held = held - $3, available = available + $4, updated_at = now()
                     WHERE anon_pubkey = $1 AND mint = $2",
                    &[&pk, m, &token_hold, &back],
                )
                .await?;
                if tok_spent > 0 {
                    token_journal(&tx, &pk, m, "spend", 0, -tok_spent, action_id).await?;
                }
                if back > 0 {
                    token_journal(&tx, &pk, m, "release", back, -back, action_id).await?;
                }
            }
            let _ = tok_back;
        }

        // ZEC hold: spent if anything executed (minus refund), else returned in full.
        if hold > 0 {
            let refund = if any_ok { refund.clamp(0, hold) } else { hold };
            tx.execute(
                "UPDATE balances SET held_zat = held_zat - $2, available_zat = available_zat + $3,
                        updated_at = now() WHERE anon_pubkey = $1",
                &[&pk, &hold, &refund],
            )
            .await?;
            if any_ok {
                journal(&tx, &pk, "settle", 0, -(hold - refund), None, Some(action_id)).await?;
                if refund > 0 {
                    journal(&tx, &pk, "refund", refund, -refund, None, Some(action_id)).await?;
                }
                fill.insert("zecSpent".into(), json!((hold - refund).to_string()));
            } else {
                journal(&tx, &pk, "release", hold, -hold, None, Some(action_id)).await?;
            }
        }

        let (new_status, err) = if any_ok {
            ("executed", None)
        } else {
            ("failed", first_err)
        };
        let fill_v = if any_ok {
            if kind != "withdraw_token" {
                fill.insert("solAmount".into(), json!(sol_total.to_string()));
            }
            fill.insert("tokenAmount".into(), json!(tok_total.to_string()));
            fill.insert("executedAt".into(), json!(minute_now_ms()));
            Some(Value::Object(fill))
        } else {
            None
        };
        tx.execute(
            "UPDATE actions SET status = $2, error = $3, fill = $4, gain_mint = NULL, gain_est = NULL,
                    updated_at = now() WHERE id = $1",
            &[&action_id, &new_status, &err, &fill_v],
        )
        .await?;
        mark_settled(&tx, &job_ids).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Janitor (M9 + D1), run periodically by the API:
    /// - 24 h after settlement: drop the `action_id` ↔ signature link and the recipient;
    /// - closed actions older than 24–48 h (their `updated_at` is day-truncated): erase
    ///   amounts, fee, rate, token hold and fill, i.e. everything that matches public
    ///   Solana amounts;
    /// - journals (`ledger_ops`, `token_ops`) older than 48 h are deleted: balances live in
    ///   `balances` / `token_balances`, history is not kept;
    /// - final ZEC payouts older than 48 h are deleted.
    ///
    /// Returns the number of jobs detached.
    pub async fn detach_old_jobs(&self) -> Result<u64> {
        Ok(self.janitor().await?.detached)
    }

    pub async fn janitor(&self) -> Result<JanitorReport> {
        let c = self.pool.get().await?;
        let detached = c
            .execute(
                "UPDATE relayer_jobs SET action_id = NULL, dest = NULL
                 WHERE action_id IS NOT NULL AND settled_at < now() - interval '24 hours'",
                &[],
            )
            .await?;
        let scrubbed = c
            .execute(
                "UPDATE actions SET amount_zat = 0, fee_zat = 0, hold_zat = 0, rate_lamports_per_zec = NULL,
                        rate_source = NULL, rate_ts = NULL, token_mint = NULL, token_hold = 0, fill = NULL,
                        gain_mint = NULL, gain_est = NULL
                 WHERE status <> 'queued' AND updated_at < now() - interval '48 hours'
                   AND (amount_zat <> 0 OR fee_zat <> 0 OR hold_zat <> 0 OR rate_lamports_per_zec IS NOT NULL
                        OR token_mint IS NOT NULL OR fill IS NOT NULL OR rate_ts IS NOT NULL
                        OR gain_mint IS NOT NULL)",
                &[],
            )
            .await?;
        let journal_deleted = c
            .execute(
                "DELETE FROM ledger_ops WHERE created_at < now() - interval '48 hours'",
                &[],
            )
            .await?
            + c.execute(
                "DELETE FROM token_ops WHERE created_at < now() - interval '48 hours'",
                &[],
            )
            .await?;
        let unlocked = c
            .execute(
                "UPDATE creator_tokens SET locked_amount = 0, locked_until = NULL
                 WHERE locked_until IS NOT NULL AND locked_until <= now()",
                &[],
            )
            .await?;
        let payouts_deleted = c
            .execute(
                "DELETE FROM zec_payouts WHERE status IN ('confirmed', 'failed')
                   AND updated_at < now() - interval '48 hours'",
                &[],
            )
            .await?;
        Ok(JanitorReport {
            detached,
            unlocked,
            scrubbed,
            journal_deleted,
            payouts_deleted,
        })
    }

    /// Value stored by the scanner in `pool_meta` (e.g. `pool_ua`, `network`).
    pub async fn pool_meta(&self, key: &str) -> Result<Option<String>> {
        let c = self.pool.get().await?;
        Ok(c.query_opt("SELECT value FROM pool_meta WHERE key = $1", &[&key])
            .await?
            .map(|r| r.get(0)))
    }

    pub async fn set_pool_meta(&self, key: &str, value: &str) -> Result<()> {
        let c = self.pool.get().await?;
        c.execute(
            "INSERT INTO pool_meta (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            &[&key, &value],
        )
        .await?;
        Ok(())
    }
}

/// Now as unix ms, rounded down to the minute (`ActionStatus.executedAt`, API v0.5).
pub fn minute_now_ms() -> u64 {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    ms - ms % 60_000
}

/// D1: once settled, a job keeps only hour-precision times (the relayer no longer needs
/// them) and no launch image.
pub(crate) async fn mark_settled<C: GenericClient>(tx: &C, ids: &[i64]) -> Result<()> {
    tx.execute(
        "UPDATE relayer_jobs SET
                settled_at  = date_trunc('hour', now()),
                updated_at  = date_trunc('hour', now()),
                created_at  = date_trunc('hour', created_at),
                not_before  = date_trunc('hour', not_before),
                claimed_at  = date_trunc('hour', claimed_at),
                lease_until = date_trunc('hour', lease_until),
                meta        = CASE WHEN meta ? 'image' THEN meta - 'image' ELSE meta END,
                exec_mode   = NULL
         WHERE id = ANY($1)",
        &[&ids],
    )
    .await?;
    Ok(())
}

pub(crate) async fn credit_tokens<C: GenericClient>(
    tx: &C,
    pk: &[u8],
    mint: &str,
    n: i64,
    action_id: &[u8],
) -> Result<()> {
    tx.execute(
        "INSERT INTO token_balances (anon_pubkey, mint, available) VALUES ($1, $2, $3)
         ON CONFLICT (anon_pubkey, mint) DO UPDATE
           SET available = token_balances.available + EXCLUDED.available, updated_at = now()",
        &[&pk, &mint, &n],
    )
    .await?;
    token_journal(tx, pk, mint, "buy_credit", n, 0, action_id).await
}

pub(crate) async fn token_journal<C: GenericClient>(
    tx: &C,
    pk: &[u8],
    mint: &str,
    kind: &str,
    d_avail: i64,
    d_held: i64,
    action_id: &[u8],
) -> Result<()> {
    tx.execute(
        "INSERT INTO token_ops (anon_pubkey, mint, kind, delta_available, delta_held, action_id)
         VALUES ($1, $2, $3, $4, $5, $6)",
        &[&pk, &mint, &kind, &d_avail, &d_held, &action_id],
    )
    .await?;
    Ok(())
}

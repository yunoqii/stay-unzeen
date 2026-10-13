//! `withdraw_zec` payouts (table `zec_payouts`), executed by the scanner (pool wallet).
//!
//! Life cycle: `queued` (not_before = API jitter) → `sent` (txid written BEFORE broadcast) →
//! `confirmed` (hold spent, `to_ua` and `txid` erased) | back to `queued` if the tx expired
//! unmined | `failed` (hold released, `to_ua` erased).
//!
//! A sent tx is never replaced by a new one until the old one provably cannot be mined
//! (expiry height passed without it in the chain): no double payouts.
//!
//! Privacy: nothing here logs; `to_ua` lives only while the payout is pending.

use crate::{Ledger, LedgerError, Result, journal, to_u64};
use deadpool_postgres::GenericClient;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutRow {
    pub id: i64,
    pub to_ua: String,
    pub amount_zat: u64,
}

/// Payouts broadcast in one tx (grouped by txid).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InflightPayout {
    pub txid: [u8; 32],
    pub ids: Vec<i64>,
}

/// A payout above the cap, waiting for the operator (`payout list-held`). No recipient.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldPayout {
    pub id: i64,
    pub amount_zat: u64,
    pub queued_secs: i64,
}

impl Ledger {
    /// Up to `limit` payouts whose delay has passed, oldest first. A2: with `cap`, payouts
    /// above it are skipped IN SQL unless approved, so they never block the ones behind them.
    pub async fn ready_payouts(&self, limit: i64, cap: Option<u64>) -> Result<Vec<PayoutRow>> {
        let c = self.pool.get().await?;
        let cap = cap.map(|v| v.min(i64::MAX as u64) as i64);
        let rows = c
            .query(
                "SELECT id, to_ua, amount_zat FROM zec_payouts
                 WHERE status = 'queued' AND not_before <= now() AND to_ua IS NOT NULL
                   AND ($2::bigint IS NULL OR amount_zat <= $2 OR approved)
                 ORDER BY not_before LIMIT $1",
                &[&limit, &cap],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| PayoutRow {
                id: r.get(0),
                to_ua: r.get(1),
                amount_zat: to_u64(r.get(2)),
            })
            .collect())
    }

    /// Record the txid of a built (not yet broadcast) tx for these payouts. Returns the number
    /// of rows moved to `sent`; if it is not `ids.len()`, do NOT broadcast.
    pub async fn mark_payouts_sent(&self, ids: &[i64], txid: &[u8; 32]) -> Result<u64> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let txid_s: &[u8] = txid;
        let n = tx
            .execute(
                "UPDATE zec_payouts SET status = 'sent', txid = $2, attempts = attempts + 1, updated_at = now()
                 WHERE id = ANY($1) AND status = 'queued'",
                &[&ids, &txid_s],
            )
            .await?;
        if n as usize != ids.len() {
            return Ok(0); // rolled back
        }
        tx.commit().await?;
        Ok(n)
    }

    pub async fn inflight_payouts(&self) -> Result<Vec<InflightPayout>> {
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT txid, array_agg(id ORDER BY id) FROM zec_payouts
                 WHERE status = 'sent' GROUP BY txid",
                &[],
            )
            .await?;
        rows.into_iter()
            .map(|r| {
                let t: Vec<u8> = r.get(0);
                Ok(InflightPayout {
                    txid: t.try_into().map_err(|_| LedgerError::Range)?,
                    ids: r.get(1),
                })
            })
            .collect()
    }

    /// The payout tx is mined with enough confirmations: spend the holds, close the actions,
    /// erase recipient and txid. Idempotent. Returns the number of payouts closed.
    pub async fn confirm_payouts(&self, txid: &[u8; 32]) -> Result<usize> {
        let txid_s: &[u8] = txid;
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let rows = tx
            .query(
                "UPDATE zec_payouts SET status = 'confirmed', to_ua = NULL, txid = NULL, updated_at = now()
                 WHERE txid = $1 AND status = 'sent' RETURNING action_id",
                &[&txid_s],
            )
            .await?;
        for r in &rows {
            let action_id: Vec<u8> = r.get(0);
            close_in(&tx, &action_id, true, None).await?;
        }
        tx.commit().await?;
        Ok(rows.len())
    }

    /// The tx expired unmined (or was never accepted): back to the queue after `delay_secs`.
    pub async fn requeue_payouts(&self, txid: &[u8; 32], delay_secs: f64) -> Result<u64> {
        let txid_s: &[u8] = txid;
        let c = self.pool.get().await?;
        Ok(c.execute(
            "UPDATE zec_payouts SET status = 'queued', txid = NULL, updated_at = now(),
                    not_before = now() + make_interval(secs => $2)
             WHERE txid = $1 AND status = 'sent'",
            &[&txid_s, &delay_secs.max(0.0)],
        )
        .await?)
    }

    /// Permanent failure (e.g. the recipient became unusable): release holds, erase `to_ua`.
    pub async fn fail_payouts(&self, ids: &[i64], code: &str) -> Result<usize> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let rows = tx
            .query(
                "UPDATE zec_payouts SET status = 'failed', to_ua = NULL, txid = NULL, error_code = $2,
                        updated_at = now()
                 WHERE id = ANY($1) AND status = 'queued' RETURNING action_id",
                &[&ids, &code],
            )
            .await?;
        for r in &rows {
            let action_id: Vec<u8> = r.get(0);
            close_in(&tx, &action_id, false, Some(code)).await?;
        }
        tx.commit().await?;
        Ok(rows.len())
    }
}

/// Close a queued action inside `tx`: `ok` spends the ZEC hold, otherwise releases it.
pub(crate) async fn close_in<C: GenericClient>(tx: &C, id: &[u8], ok: bool, error: Option<&str>) -> Result<bool> {
    let status = if ok { "executed" } else { "failed" };
    let Some(r) = tx
        .query_opt(
            "UPDATE actions SET status = $2, error = $3, updated_at = now(),
                    fill = CASE WHEN $4 THEN jsonb_build_object('zecSpent', hold_zat::text,
                        'executedAt', (floor(extract(epoch FROM now()) / 60) * 60000)::bigint) END
             WHERE id = $1 AND status = 'queued' RETURNING anon_pubkey, hold_zat",
            &[&id, &status, &error, &ok],
        )
        .await?
    else {
        return Ok(false);
    };
    let pk: Vec<u8> = r.get(0);
    let hold: i64 = r.get(1);
    if hold > 0 {
        if ok {
            tx.execute(
                "UPDATE balances SET held_zat = held_zat - $2, updated_at = now() WHERE anon_pubkey = $1",
                &[&pk, &hold],
            )
            .await?;
            journal(tx, &pk, "settle", 0, -hold, None, Some(id)).await?;
        } else {
            tx.execute(
                "UPDATE balances SET held_zat = held_zat - $2, available_zat = available_zat + $2,
                        updated_at = now() WHERE anon_pubkey = $1",
                &[&pk, &hold],
            )
            .await?;
            journal(tx, &pk, "release", hold, -hold, None, Some(id)).await?;
        }
    }
    Ok(true)
}

impl Ledger {
    /// A2: queued payouts above `cap` not yet approved (operator review), oldest first.
    pub async fn held_payouts(&self, cap: u64) -> Result<Vec<HeldPayout>> {
        let c = self.pool.get().await?;
        let cap = cap.min(i64::MAX as u64) as i64;
        let rows = c
            .query(
                "SELECT id, amount_zat, extract(epoch FROM now() - created_at)::bigint FROM zec_payouts
                 WHERE status = 'queued' AND to_ua IS NOT NULL AND amount_zat > $1 AND NOT approved
                 ORDER BY not_before",
                &[&cap],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| HeldPayout {
                id: r.get(0),
                amount_zat: to_u64(r.get(1)),
                queued_secs: r.get(2),
            })
            .collect())
    }

    /// A2: operator approval of one queued payout above the cap. `false` if no such queued payout.
    pub async fn approve_payout(&self, id: i64) -> Result<bool> {
        let c = self.pool.get().await?;
        Ok(c.execute(
            "UPDATE zec_payouts SET approved = TRUE, updated_at = now() WHERE id = $1 AND status = 'queued'",
            &[&id],
        )
        .await?
            == 1)
    }
}

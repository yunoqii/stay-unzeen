//! Creator fees (API.md v0.7, RELAYER.md v4): the relayer's global sweeper records landed
//! sweeps in `creator_fee_sweeps`; core credits `kind = 'creator'` rows to the creator's anon key
//! (`creator_tokens`) as claimable lamports, on an epoch boundary (never at the moment a sweep
//! lands). `partner` rows and mints without an Unzeen creator are pool revenue. `claim` is a
//! ledger-only operation: claimable lamports → ZEC balance at the sell rate.
//!
//! Privacy (D1): `credited_at` is hour-coarse, claimable rows carry day-coarse times, the
//! journal lives 48 h, claim amounts are scrubbed with the action after 24–48 h.

use serde_json::json;

use crate::{
    ActionReceipt, Ledger, LedgerError, Result,
    actions::{NewAction, RateUsed, ZAT_PER_ZEC},
    journal, to_i64, to_u64,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CreditReport {
    pub credited: u64,
    pub pool_revenue: u64,
}

impl Ledger {
    /// Credit every confirmed, uncredited creator sweep of `network` (one transaction).
    pub async fn credit_fee_sweeps(&self, network: &str) -> Result<CreditReport> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let rows = tx
            .query(
                "SELECT s.id, s.mint, s.lamports, ct.anon_pubkey
                 FROM creator_fee_sweeps s LEFT JOIN creator_tokens ct ON ct.mint = s.mint
                 WHERE s.network = $1 AND s.status = 'confirmed' AND s.kind = 'creator' AND s.credited_at IS NULL
                 FOR UPDATE OF s SKIP LOCKED",
                &[&network],
            )
            .await?;
        let mut rep = CreditReport::default();
        for r in &rows {
            let (id, mint, lamports, pk): (i64, String, Option<i64>, Option<Vec<u8>>) =
                (r.get(0), r.get(1), r.get(2), r.get(3));
            let lamports = lamports.unwrap_or(0);
            match pk {
                Some(pk) if lamports > 0 => {
                    tx.execute(
                        "INSERT INTO creator_claimable (anon_pubkey, mint, lamports) VALUES ($1, $2, $3)
                         ON CONFLICT (anon_pubkey, mint) DO UPDATE
                           SET lamports = creator_claimable.lamports + EXCLUDED.lamports, updated_at = now()",
                        &[&pk, &mint, &lamports],
                    )
                    .await?;
                    rep.credited += 1;
                }
                _ => rep.pool_revenue += 1,
            }
            tx.execute(
                "UPDATE creator_fee_sweeps SET credited_at = date_trunc('hour', now()) WHERE id = $1",
                &[&id],
            )
            .await?;
        }
        tx.commit().await?;
        Ok(rep)
    }

    /// `Portfolio.claimable`: (mint, lamports) with a positive amount.
    pub async fn claimable(&self, pk: &[u8; 32]) -> Result<Vec<(String, u64)>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        Ok(c.query(
            "SELECT mint, lamports FROM creator_claimable WHERE anon_pubkey = $1 AND lamports > 0 ORDER BY mint",
            &[&pk_s],
        )
        .await?
        .into_iter()
        .map(|r| (r.get(0), to_u64(r.get(1))))
        .collect())
    }

    /// `claim {mint?}`: claimable lamports (of one mint or all) → ZEC at `rate` (lamports per
    /// ZEC, sell side). Ledger only. Below `min_action_zat` → BelowMinimum (nothing changes).
    pub async fn claim(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        mint: Option<&str>,
        rate: &RateUsed,
    ) -> Result<ActionReceipt> {
        let pk_s: &[u8] = pk;
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let a = NewAction {
            kind: "claim".into(),
            rate: Some(rate.clone()),
            ..NewAction::default()
        };
        let mut receipt = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
        if receipt.replayed {
            return Ok(receipt);
        }
        let rows = tx
            .query(
                "SELECT mint, lamports FROM creator_claimable
                 WHERE anon_pubkey = $1 AND lamports > 0 AND ($2::text IS NULL OR mint = $2) FOR UPDATE",
                &[&pk_s, &mint],
            )
            .await?;
        let lamports: u64 = rows.iter().map(|r| to_u64(r.get(1))).sum();
        let zat = ((lamports as u128) * ZAT_PER_ZEC / (rate.lamports_per_zec.max(1) as u128)) as u64;
        if rows.is_empty() || zat < self.policy.min_action_zat {
            return Err(LedgerError::BelowMinimum);
        }
        for r in &rows {
            let m: String = r.get(0);
            tx.execute(
                "UPDATE creator_claimable SET lamports = 0, updated_at = now() WHERE anon_pubkey = $1 AND mint = $2",
                &[&pk_s, &m],
            )
            .await?;
        }
        let z = to_i64(zat)?;
        tx.execute(
            "INSERT INTO balances (anon_pubkey, available_zat) VALUES ($1, $2)
             ON CONFLICT (anon_pubkey) DO UPDATE SET available_zat = balances.available_zat + EXCLUDED.available_zat,
                                                     updated_at = now()",
            &[&pk_s, &z],
        )
        .await?;
        let aid: &[u8] = &receipt.id;
        journal(&tx, pk_s, "fee_credit", z, 0, None, Some(aid)).await?;
        let fill = json!({
            "solAmount": lamports.to_string(),
            "zecCredited": zat.to_string(),
            "tokenAmount": "0",
            "executedAt": crate::actions::minute_now_ms(),
        });
        tx.execute(
            "UPDATE actions SET status = 'executed', amount_zat = $2, fill = $3, updated_at = now() WHERE id = $1",
            &[&aid, &z, &fill],
        )
        .await?;
        tx.commit().await?;
        receipt.status = "executed".into();
        Ok(receipt)
    }
}

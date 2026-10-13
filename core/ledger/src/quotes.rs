//! Non-SOL pairs (migration 0019, API.md v0.13, RELAYER.md v8): the pool's quote assets, the
//! quote stock schedule (`fund_quote` jobs) and their settlement. Pool-level only: no user data.

use serde_json::json;

use crate::{Ledger, Result, actions::mark_settled};

/// One quote asset of the network as published to the relayer (`pool_quotes`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolQuote {
    pub mint: String,
    pub quote: String,
    pub decimals: i16,
    pub bridged: bool,
}

impl Ledger {
    /// Core's quote registry for this network (the relayer reads it for the Verify snapshot).
    pub async fn set_pool_quotes(&self, network: &str, quotes: &[PoolQuote]) -> Result<()> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        for q in quotes {
            tx.execute(
                "INSERT INTO pool_quotes (network, mint, quote, decimals, bridged) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (network, mint) DO UPDATE SET quote = EXCLUDED.quote, decimals = EXCLUDED.decimals,
                                                           bridged = EXCLUDED.bridged",
                &[&network, &q.mint, &q.quote, &q.decimals, &q.bridged],
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn pool_quotes(&self, network: &str) -> Result<Vec<PoolQuote>> {
        let c = self.pool.get().await?;
        Ok(c.query(
            "SELECT mint, quote, decimals, bridged FROM pool_quotes WHERE network = $1 ORDER BY mint",
            &[&network],
        )
        .await?
        .into_iter()
        .map(|r| PoolQuote {
            mint: r.get(0),
            quote: r.get(1),
            decimals: r.get(2),
            bridged: r.get(3),
        })
        .collect())
    }

    /// Quote stock of the pool from the relayer: (Σ on vaults + on the rebalance address, age s).
    pub async fn quote_inventory(&self, network: &str, mint: &str) -> Result<Option<(u128, u64)>> {
        let c = self.pool.get().await?;
        let row = c
            .query_opt(
                "SELECT (vault_amount + reserve_amount)::text, EXTRACT(EPOCH FROM now() - updated_at)::float8
                 FROM pool_quote_inventory WHERE network = $1 AND quote_mint = $2",
                &[&network, &mint],
            )
            .await?;
        Ok(row.map(|r| {
            let total: String = r.get(0);
            let age: f64 = r.get(1);
            (total.parse().unwrap_or(0), age.max(0.0) as u64)
        }))
    }

    /// Vaults of the pool on `network` (public addresses, as known from relayer bookkeeping).
    pub async fn pool_vaults(&self, network: &str) -> Result<Vec<String>> {
        let c = self.pool.get().await?;
        Ok(c.query(
            "SELECT vault FROM relayer_vault_usage WHERE network = $1
             UNION SELECT vault FROM mint_vaults WHERE network = $1",
            &[&network],
        )
        .await?
        .into_iter()
        .map(|r| r.get(0))
        .collect())
    }

    /// Queue `fund_quote` for (vault, mint) at `delay_secs`, unless one is still open for that
    /// pair. Returns the job id when queued.
    pub async fn queue_fund_quote(
        &self,
        network: &str,
        vault: &str,
        mint: &str,
        delay_secs: f64,
    ) -> Result<Option<i64>> {
        let c = self.pool.get().await?;
        let open = c
            .query_opt(
                "SELECT 1 FROM relayer_jobs WHERE op = 'fund_quote' AND network = $1 AND settled_at IS NULL
                   AND meta->>'vault' = $2 AND meta->>'quote' = $3",
                &[&network, &vault, &mint],
            )
            .await?
            .is_some();
        if open {
            return Ok(None);
        }
        Ok(Some(
            c.query_one(
                "INSERT INTO relayer_jobs (op, meta, network, exec_mode, not_before)
                 VALUES ('fund_quote', $1, $2, 'delayed', now() + make_interval(secs => $3)) RETURNING id",
                &[
                    &json!({ "quote": mint, "vault": vault }),
                    &network,
                    &delay_secs.max(0.0),
                ],
            )
            .await?
            .get(0),
        ))
    }

    /// Close final `fund_quote` jobs (core-owned, no ledger effect). Returns how many.
    pub async fn settle_fund_quotes(&self) -> Result<usize> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let ids: Vec<i64> = tx
            .query(
                "SELECT id FROM relayer_jobs WHERE op = 'fund_quote' AND status IN ('confirmed', 'failed')
                   AND settled_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
                &[],
            )
            .await?
            .into_iter()
            .map(|r| r.get(0))
            .collect();
        if !ids.is_empty() {
            mark_settled(&tx, &ids).await?;
        }
        tx.commit().await?;
        Ok(ids.len())
    }
}

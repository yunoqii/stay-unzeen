//! Pool rebalance ZEC → SOL through NEAR Intents 1Click (migration 0015, RELAYER.md v7).
//!
//! Journal `pool_rebalances`: one row per rebalance, at most one live row per network
//! (partial unique index). Life cycle:
//!
//! `planned` (random `not_before`) → `quoted` (1Click deposit address, used once) → `sending`
//! (txid written BEFORE broadcast) → `deposited` (mined with K confirmations) → `distributing`
//! (relayer job `fund_vaults`: rebalance address → vaults) → `done`.
//! Terminal side exits: `dry_run`, `cancelled`, `expired`, `failed`, `refunded`; `attention`
//! needs the operator and blocks new rebalances.
//!
//! Privacy: pool-level data only (fixed lot, pool addresses, public txids). No anon keys,
//! actions, deposits or payouts are read or written here, and nothing here logs.

use deadpool_postgres::GenericClient;
use serde_json::{Value, json};

use crate::num::Num;
use crate::{Ledger, LedgerError, Result, to_i64, to_u64};

/// ZEC SPL (Zcash on Solana, bridged) — target of `zec_spl` rebalances (0019).
pub const ZEC_SPL_MINT: &str = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

/// Statuses of a live (non-terminal) rebalance.
pub const LIVE: [&str; 6] = ["planned", "quoted", "sending", "deposited", "distributing", "attention"];

/// SOL inventory of the pool as last written by the relayer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inventory {
    pub vault_lamports: u64,
    pub vault_count: u32,
    pub rebalance_lamports: u64,
    pub age_secs: u64,
}

/// A live rebalance as the scanner step needs it (ages from the DB clock).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveRebalance {
    pub id: i64,
    pub status: String,
    pub dry_run: bool,
    pub forced: bool,
    pub lot_zat: u64,
    pub due: bool,
    pub deposit_address: Option<String>,
    pub quote_age_secs: Option<u64>,
    /// Seconds until the 1Click quote deadline (negative = passed).
    pub deadline_left_secs: Option<i64>,
    pub amount_out_quote: Option<u64>,
    pub min_amount_out: Option<u64>,
    pub txid: Option<[u8; 32]>,
    pub expiry_height: Option<u32>,
    pub mined_height: Option<u32>,
    pub submitted: bool,
    pub oc_status: Option<String>,
    pub polled_age_secs: Option<u64>,
    /// Seconds since the deposit tx was mined-with-K (status `deposited`), for alerting.
    pub deposited_age_secs: Option<u64>,
    pub fund_job_id: Option<i64>,
}

/// Recent history for the schedule guards.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct History {
    /// Rebalances started in the last 24 h (cancelled and expired ones excluded).
    pub last_24h: u32,
    /// Seconds since the last rebalance finished (any terminal status except cancelled/expired).
    pub since_last_secs: Option<u64>,
}

/// Operator listing (`rebalance status`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RebalanceView {
    pub id: i64,
    pub status: String,
    pub dry_run: bool,
    pub lot_zat: u64,
    pub amount_out_quote: Option<u64>,
    pub amount_out: Option<u64>,
    pub oc_status: Option<String>,
    pub error_code: Option<String>,
    pub created_unix: i64,
    pub finished_unix: Option<i64>,
    /// `sol` | `zec_spl` (0019).
    pub target: String,
}

/// Outcome of [`Ledger::rebalance_fund_step`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FundOutcome {
    /// The `fund_vaults` job is still queued / in flight.
    Waiting,
    /// Confirmed: rebalance `done`, job settled.
    Done,
    /// The job failed and a new one was queued.
    Retried,
    /// Failed too many times: rebalance `attention`.
    Attention,
}

/// The ZEC → SOL rebalance is Solana-only and keeps `u64` lamports; its NUMERIC(78,0) columns
/// (0026) are converted here (a value above u64 reads as `u64::MAX`, never wraps).
fn opt_u64(v: Option<Num>) -> Option<u64> {
    v.map(num_u64)
}

fn num_u64(v: Num) -> u64 {
    u64::try_from(v.0.max(0)).unwrap_or(u64::MAX)
}

fn opt_u32(v: Option<i32>) -> Option<u32> {
    v.and_then(|x| u32::try_from(x).ok())
}

fn secs(v: Option<f64>) -> Option<u64> {
    v.map(|s| if s.is_finite() && s > 0.0 { s as u64 } else { 0 })
}

/// Queue the distribution job (rebalance address → vaults).
async fn insert_fund_job<C: GenericClient>(c: &C, network: &str, lamports: i64, delay_secs: f64) -> Result<i64> {
    Ok(c.query_one(
        "INSERT INTO relayer_jobs (op, lamports_in, meta, network, exec_mode, not_before)
         VALUES ('fund_vaults', $1, $2, $3, 'delayed', now() + make_interval(secs => $4)) RETURNING id",
        &[
            &Num::from(lamports),
            &json!({ "purpose": "rebalance" }),
            &network,
            &delay_secs,
        ],
    )
    .await?
    .get(0))
}

impl Ledger {
    /// Last SOL inventory written by the relayer for `network`.
    pub async fn sol_inventory(&self, network: &str) -> Result<Option<Inventory>> {
        let c = self.pool.get().await?;
        let row = c
            .query_opt(
                "SELECT vault_lamports, vault_count, rebalance_lamports,
                        EXTRACT(EPOCH FROM now() - updated_at)::float8
                 FROM pool_sol_inventory WHERE network = $1",
                &[&network],
            )
            .await?;
        Ok(row.map(|r| Inventory {
            vault_lamports: num_u64(r.get(0)),
            vault_count: u32::try_from(r.get::<_, i32>(1)).unwrap_or(0),
            rebalance_lamports: num_u64(r.get(2)),
            age_secs: secs(r.get(3)).unwrap_or(0),
        }))
    }

    /// Lamports already promised to queued Solana jobs of `network` (not yet sent): buys and
    /// launch buys, plus the gas drops of token withdrawals.
    pub async fn committed_sol(&self, network: &str) -> Result<u64> {
        let c = self.pool.get().await?;
        let v: i64 = c
            .query_one(
                "SELECT COALESCE(sum(CASE WHEN op IN ('buy', 'create', 'fair_create') THEN COALESCE(lamports_in, 0)
                                          WHEN op = 'transfer' THEN COALESCE(gas_lamports, 0)
                                          ELSE 0 END), 0)::bigint
                 FROM relayer_jobs WHERE network = $1 AND status IN ('held', 'queued', 'claimed')",
                &[&network],
            )
            .await?
            .get(0);
        Ok(to_u64(v))
    }

    /// ZEC SPL units promised to queued ZEC-pair buys / launch buys (RELAYER v8: their
    /// `lamports_in` is in ZEC SPL units).
    pub async fn committed_zec_spl(&self, network: &str) -> Result<u64> {
        let c = self.pool.get().await?;
        let v: i64 = c
            .query_one(
                "SELECT COALESCE(sum(j.lamports_in), 0)::bigint FROM relayer_jobs j
                 LEFT JOIN tokens t ON t.mint = j.mint
                 WHERE j.network = $1 AND j.status IN ('held', 'queued', 'claimed')
                   AND ((j.op = 'buy' AND t.quote_mint = $2) OR (j.op = 'create' AND j.meta->>'quote' = 'ZEC'))",
                &[&network, &ZEC_SPL_MINT],
            )
            .await?
            .get(0);
        Ok(to_u64(v))
    }

    /// Σ ZEC the pool owes its users (available + held of every balance; pending payouts are
    /// held until confirmed). The rebalance only spends ZEC above this.
    pub async fn zec_liabilities(&self) -> Result<u64> {
        let c = self.pool.get().await?;
        let v: i64 = c
            .query_one(
                "SELECT COALESCE(sum(available_zat + held_zat), 0)::bigint FROM balances",
                &[],
            )
            .await?
            .get(0);
        Ok(to_u64(v))
    }

    /// Live rebalance of `network` towards `target` (`sol` | `zec_spl`, 0019).
    pub async fn live_rebalance(&self, network: &str, target: &str) -> Result<Option<LiveRebalance>> {
        let c = self.pool.get().await?;
        let row = c
            .query_opt(
                "SELECT id, status, dry_run, lot_zat, not_before <= now(), deposit_address,
                        EXTRACT(EPOCH FROM now() - quoted_at)::float8,
                        EXTRACT(EPOCH FROM quote_deadline - now())::float8,
                        amount_out_quote, min_amount_out, txid, expiry_height, mined_height,
                        submitted_at IS NOT NULL, oc_status,
                        EXTRACT(EPOCH FROM now() - polled_at)::float8,
                        CASE WHEN status = 'deposited' THEN EXTRACT(EPOCH FROM now() - updated_at)::float8 END,
                        fund_job_id, forced
                 FROM pool_rebalances WHERE network = $1 AND status = ANY($2) AND target = $3",
                &[&network, &&LIVE[..], &target],
            )
            .await?;
        Ok(row.map(|r| LiveRebalance {
            id: r.get(0),
            status: r.get(1),
            dry_run: r.get(2),
            lot_zat: to_u64(r.get(3)),
            due: r.get(4),
            deposit_address: r.get(5),
            quote_age_secs: secs(r.get(6)),
            deadline_left_secs: r.get::<_, Option<f64>>(7).map(|s| s as i64),
            amount_out_quote: opt_u64(r.get(8)),
            min_amount_out: opt_u64(r.get(9)),
            txid: r
                .get::<_, Option<Vec<u8>>>(10)
                .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok()),
            expiry_height: opt_u32(r.get(11)),
            mined_height: opt_u32(r.get(12)),
            submitted: r.get(13),
            oc_status: r.get(14),
            polled_age_secs: secs(r.get(15)),
            deposited_age_secs: secs(r.get(16)),
            fund_job_id: r.get(17),
            forced: r.get(18),
        }))
    }

    pub async fn rebalance_history(&self, network: &str, target: &str) -> Result<History> {
        let c = self.pool.get().await?;
        let r = c
            .query_one(
                "SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours'
                                           AND status NOT IN ('cancelled', 'expired')),
                        EXTRACT(EPOCH FROM now() - max(finished_at)
                                FILTER (WHERE status NOT IN ('cancelled', 'expired')))::float8
                 FROM pool_rebalances WHERE network = $1 AND target = $2",
                &[&network, &target],
            )
            .await?;
        Ok(History {
            last_24h: u32::try_from(r.get::<_, i64>(0)).unwrap_or(u32::MAX),
            since_last_secs: secs(r.get(1)),
        })
    }

    /// New rebalance due in `delay_secs`. `None` if one is already live on this network.
    pub async fn plan_rebalance(
        &self,
        network: &str,
        target: &str,
        lot_zat: u64,
        delay_secs: f64,
        dry_run: bool,
        forced: bool,
    ) -> Result<Option<i64>> {
        let c = self.pool.get().await?;
        let lot = to_i64(lot_zat)?;
        let row = c
            .query_opt(
                "INSERT INTO pool_rebalances (network, dry_run, lot_zat, not_before, forced, target)
                 VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6)
                 ON CONFLICT DO NOTHING RETURNING id",
                &[&network, &dry_run, &lot, &delay_secs.max(0.0), &forced, &target],
            )
            .await?;
        Ok(row.map(|r| r.get(0)))
    }

    /// Move a rebalance from one of `from` to a terminal or `attention` status.
    pub async fn rebalance_finish(
        &self,
        id: i64,
        from: &[&str],
        status: &str,
        error_code: Option<&str>,
    ) -> Result<bool> {
        let c = self.pool.get().await?;
        let n = c
            .execute(
                "UPDATE pool_rebalances SET status = $3, error_code = COALESCE($4, error_code), updated_at = now(),
                        finished_at = CASE WHEN $3 = 'attention' THEN NULL ELSE now() END
                 WHERE id = $1 AND status = ANY($2)",
                &[&id, &from, &status, &error_code],
            )
            .await?;
        Ok(n == 1)
    }

    /// `planned` → `quoted`: store the 1Click quote (with its signature) and deposit address.
    pub async fn rebalance_quoted(
        &self,
        id: i64,
        deposit_address: &str,
        quote: &Value,
        amount_out_quote: u64,
        min_amount_out: u64,
        deadline_unix: i64,
    ) -> Result<bool> {
        let c = self.pool.get().await?;
        let n = c
            .execute(
                "UPDATE pool_rebalances SET status = 'quoted', deposit_address = $2, quote = $3, quoted_at = now(),
                        amount_out_quote = $4, min_amount_out = $5, quote_deadline = to_timestamp($6), updated_at = now()
                 WHERE id = $1 AND status = 'planned' AND deposit_address IS NULL",
                &[
                    &id,
                    &deposit_address,
                    quote,
                    &Num::from(amount_out_quote),
                    &Num::from(min_amount_out),
                    &(deadline_unix as f64),
                ],
            )
            .await?;
        Ok(n == 1)
    }

    /// `planned` → `dry_run` (testnet/devnet or no mainnet flag): the quote is kept for review.
    pub async fn rebalance_dry_run_done(
        &self,
        id: i64,
        quote: &Value,
        amount_out_quote: u64,
        min_amount_out: u64,
    ) -> Result<bool> {
        let c = self.pool.get().await?;
        let n = c
            .execute(
                "UPDATE pool_rebalances SET status = 'dry_run', quote = $2, quoted_at = now(), amount_out_quote = $3,
                        min_amount_out = $4, updated_at = now(), finished_at = now()
                 WHERE id = $1 AND status = 'planned' AND dry_run",
                &[&id, quote, &Num::from(amount_out_quote), &Num::from(min_amount_out)],
            )
            .await?;
        Ok(n == 1)
    }

    /// `quoted` → `sending` with the txid of the built (NOT yet broadcast) tx. `false` → do not
    /// broadcast (the row changed under us).
    pub async fn rebalance_sending(&self, id: i64, txid: &[u8; 32], expiry_height: u32) -> Result<bool> {
        let c = self.pool.get().await?;
        let txid_s: &[u8] = txid;
        let exp = i32::try_from(expiry_height).map_err(|_| LedgerError::Range)?;
        let n = c
            .execute(
                "UPDATE pool_rebalances SET status = 'sending', txid = $2, expiry_height = $3, updated_at = now()
                 WHERE id = $1 AND status = 'quoted' AND txid IS NULL",
                &[&id, &txid_s, &exp],
            )
            .await?;
        Ok(n == 1)
    }

    /// `sending` → `deposited`: the deposit tx has K confirmations.
    pub async fn rebalance_mined(&self, id: i64, height: u32) -> Result<bool> {
        let c = self.pool.get().await?;
        let h = i32::try_from(height).map_err(|_| LedgerError::Range)?;
        let n = c
            .execute(
                "UPDATE pool_rebalances SET status = 'deposited', mined_height = $2, updated_at = now()
                 WHERE id = $1 AND status = 'sending'",
                &[&id, &h],
            )
            .await?;
        Ok(n == 1)
    }

    pub async fn rebalance_submitted(&self, id: i64) -> Result<()> {
        let c = self.pool.get().await?;
        c.execute(
            "UPDATE pool_rebalances SET submitted_at = now() WHERE id = $1 AND submitted_at IS NULL",
            &[&id],
        )
        .await?;
        Ok(())
    }

    pub async fn rebalance_polled(&self, id: i64, oc_status: &str) -> Result<()> {
        let c = self.pool.get().await?;
        c.execute(
            "UPDATE pool_rebalances SET oc_status = $2, polled_at = now() WHERE id = $1",
            &[&id, &oc_status],
        )
        .await?;
        Ok(())
    }

    /// 1Click SUCCESS: `deposited` → `distributing` and queue `fund_vaults` of `fund_lamports`
    /// (due in `delay_secs`) in the same transaction. `fund_lamports = 0` → straight to `done`.
    pub async fn rebalance_success(
        &self,
        id: i64,
        network: &str,
        amount_out: u64,
        dest_tx: Option<&str>,
        fund_lamports: u64,
        delay_secs: f64,
    ) -> Result<bool> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let Some(target) = tx
            .query_opt(
                "SELECT target FROM pool_rebalances WHERE id = $1 AND network = $2 AND status = 'deposited' FOR UPDATE",
                &[&id, &network],
            )
            .await?
            .map(|r| r.get::<_, String>(0))
        else {
            return Ok(false);
        };
        if target == "zec_spl" {
            // RELAYER v8: ZEC SPL landed on the rebalance address; one fund_quote per vault spreads
            // it (the relayer tops each vault up to its stock policy, staggered 20–120 s).
            let vaults: Vec<String> = tx
                .query(
                    "SELECT vault FROM relayer_vault_usage WHERE network = $1
                     UNION SELECT vault FROM mint_vaults WHERE network = $1",
                    &[&network],
                )
                .await?
                .into_iter()
                .map(|r| r.get(0))
                .collect();
            let (mut at, mut jobs) = (delay_secs.max(0.0), Vec::new());
            for v in vaults {
                at += 20.0 + 100.0 * ((rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64);
                jobs.push(
                    tx.query_one(
                        "INSERT INTO relayer_jobs (op, meta, network, exec_mode, not_before)
                         VALUES ('fund_quote', $1, $2, 'delayed', now() + make_interval(secs => $3)) RETURNING id",
                        &[&json!({ "quote": ZEC_SPL_MINT, "vault": v }), &network, &at],
                    )
                    .await?
                    .get::<_, i64>(0),
                );
            }
            tx.execute(
                "UPDATE pool_rebalances SET status = CASE WHEN cardinality($4::bigint[]) = 0 THEN 'done' ELSE 'distributing' END,
                        oc_status = 'SUCCESS', amount_out = $2, dest_tx = $3, fund_quote_jobs = $4, updated_at = now(),
                        finished_at = CASE WHEN cardinality($4::bigint[]) = 0 THEN now() END
                 WHERE id = $1",
                &[&id, &Num::from(amount_out), &dest_tx, &jobs],
            )
            .await?;
            tx.commit().await?;
            return Ok(true);
        }
        let job = if fund_lamports > 0 {
            Some(insert_fund_job(&tx, network, to_i64(fund_lamports)?, delay_secs).await?)
        } else {
            None
        };
        tx.execute(
            "UPDATE pool_rebalances SET status = CASE WHEN $4::bigint IS NULL THEN 'done' ELSE 'distributing' END,
                    oc_status = 'SUCCESS', amount_out = $2, dest_tx = $3, fund_job_id = $4,
                    fund_attempts = CASE WHEN $4::bigint IS NULL THEN 0 ELSE 1 END, updated_at = now(),
                    finished_at = CASE WHEN $4::bigint IS NULL THEN now() END
             WHERE id = $1",
            &[&id, &Num::from(amount_out), &dest_tx, &job],
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Follow the `fund_vaults` job of a `distributing` rebalance. Core settles the job itself
    /// (`settled_at`, `exec_mode` erased); a failed job is re-queued after `retry_delay_secs`
    /// up to `max_attempts`, then the rebalance needs the operator.
    pub async fn rebalance_fund_step(&self, id: i64, max_attempts: u32, retry_delay_secs: f64) -> Result<FundOutcome> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let Some(r) = tx
            .query_opt(
                "SELECT network, fund_job_id, fund_attempts, amount_out, target, fund_quote_jobs FROM pool_rebalances
                 WHERE id = $1 AND status = 'distributing' FOR UPDATE",
                &[&id],
            )
            .await?
        else {
            return Ok(FundOutcome::Waiting);
        };
        if r.get::<_, String>(4) == "zec_spl" {
            // Done once every fund_quote is final (the API settles them). A failed one leaves the
            // rest on the rebalance address for the next distribution: no retry loop here.
            let jobs: Vec<i64> = r.get::<_, Option<Vec<i64>>>(5).unwrap_or_default();
            let open: i64 = tx
                .query_one(
                    "SELECT count(*) FROM relayer_jobs WHERE id = ANY($1) AND status NOT IN ('confirmed', 'failed')",
                    &[&jobs],
                )
                .await?
                .get(0);
            if open > 0 {
                return Ok(FundOutcome::Waiting);
            }
            tx.execute(
                "UPDATE pool_rebalances SET status = 'done', updated_at = now(), finished_at = now() WHERE id = $1",
                &[&id],
            )
            .await?;
            tx.commit().await?;
            return Ok(FundOutcome::Done);
        }
        let network: String = r.get(0);
        let job: Option<i64> = r.get(1);
        let attempts: i32 = r.get(2);
        let Some(job) = job else {
            tx.execute(
                "UPDATE pool_rebalances SET status = 'attention', error_code = 'fund_job_missing', updated_at = now()
                 WHERE id = $1",
                &[&id],
            )
            .await?;
            tx.commit().await?;
            return Ok(FundOutcome::Attention);
        };
        let Some(j) = tx
            .query_opt(
                "SELECT status, lamports_in FROM relayer_jobs WHERE id = $1 AND op = 'fund_vaults' FOR UPDATE",
                &[&job],
            )
            .await?
        else {
            return Ok(FundOutcome::Waiting);
        };
        let status: String = j.get(0);
        let lamports: Option<i64> = j
            .get::<_, Option<Num>>(1)
            .map(|n| i64::try_from(n.0).unwrap_or(i64::MAX));
        let out = match status.as_str() {
            "confirmed" => {
                tx.execute(
                    "UPDATE pool_rebalances SET status = 'done', updated_at = now(), finished_at = now() WHERE id = $1",
                    &[&id],
                )
                .await?;
                FundOutcome::Done
            }
            "failed" if u32::try_from(attempts).unwrap_or(u32::MAX) < max_attempts => {
                let next = insert_fund_job(&tx, &network, lamports.unwrap_or(0).max(1), retry_delay_secs).await?;
                tx.execute(
                    "UPDATE pool_rebalances SET fund_job_id = $2, fund_attempts = fund_attempts + 1, updated_at = now()
                     WHERE id = $1",
                    &[&id, &next],
                )
                .await?;
                FundOutcome::Retried
            }
            "failed" => {
                tx.execute(
                    "UPDATE pool_rebalances SET status = 'attention', error_code = 'fund_failed', updated_at = now()
                     WHERE id = $1",
                    &[&id],
                )
                .await?;
                FundOutcome::Attention
            }
            _ => return Ok(FundOutcome::Waiting),
        };
        crate::actions::mark_settled(&tx, &[job]).await?;
        tx.commit().await?;
        Ok(out)
    }

    /// Operator: close a rebalance that needs attention (`failed` or `done` after a manual fix).
    pub async fn close_rebalance(&self, id: i64, status: &str) -> Result<bool> {
        if !matches!(status, "failed" | "done" | "refunded") {
            return Err(LedgerError::Range);
        }
        self.rebalance_finish(id, &["attention", "planned"], status, Some("operator"))
            .await
    }

    /// Is `address` one of the pool's trading vaults (the rebalance address must not be)?
    pub async fn is_vault(&self, network: &str, address: &str) -> Result<bool> {
        let c = self.pool.get().await?;
        Ok(c.query_one(
            "SELECT EXISTS (SELECT 1 FROM mint_vaults WHERE network = $1 AND vault = $2)
                 OR EXISTS (SELECT 1 FROM relayer_vault_usage WHERE network = $1 AND vault = $2)",
            &[&network, &address],
        )
        .await?
        .get(0))
    }

    pub async fn list_rebalances(&self, network: &str, limit: i64) -> Result<Vec<RebalanceView>> {
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT id, status, dry_run, lot_zat, amount_out_quote, amount_out, oc_status, error_code,
                        EXTRACT(EPOCH FROM created_at)::bigint, EXTRACT(EPOCH FROM finished_at)::bigint, target
                 FROM pool_rebalances WHERE network = $1 ORDER BY id DESC LIMIT $2",
                &[&network, &limit],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| RebalanceView {
                id: r.get(0),
                status: r.get(1),
                dry_run: r.get(2),
                lot_zat: to_u64(r.get(3)),
                amount_out_quote: opt_u64(r.get(4)),
                amount_out: opt_u64(r.get(5)),
                oc_status: r.get(6),
                error_code: r.get(7),
                created_unix: r.get(8),
                finished_unix: r.get(9),
                target: r.get(10),
            })
            .collect())
    }
}

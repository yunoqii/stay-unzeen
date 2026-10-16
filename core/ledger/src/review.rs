//! GAP-11: operator resolution of relayer jobs in `needs_review` (RELAYER v15, 0031) without
//! hand-written SQL: `unzeen-api review-job`.
//!
//! `needs_review` = the tx landed (signature recorded) but its result was not parsed. The
//! action keeps its hold and is not refunded. Three ways out, all only from `needs_review`
//! and only while unsettled:
//! - **reparse**: hand the job back to the relayer now (lease expired), which re-reads the
//!   receipt from the chain and writes `confirmed` with the real `out_*` (or `needs_review`
//!   again). This is the preferred path: amounts come from the chain, not from a human.
//! - **confirm** with explicit `out_*` read from the explorer, checked against the job.
//! - **fail**: the operator verified that NO funds moved. The core settler then refunds.
//!
//! Privacy: nothing here logs. The rows contain only pool-side data (no anon key; the
//! action link is the random `action_id`, never selected here).

use crate::{Ledger, Result};

/// One `needs_review` job, pool-side fields only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewJob {
    pub id: i64,
    pub op: String,
    pub venue: Option<String>,
    pub network: String,
    pub mint: Option<String>,
    /// Decimal strings (NUMERIC(78,0)).
    pub lamports_in: Option<String>,
    pub token_amount: Option<String>,
    pub signature: Option<String>,
    pub error_message: Option<String>,
    pub age_secs: i64,
}

/// Facts of the landed tx, from the explorer (decimal strings).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReviewOut {
    pub out_token_amount: Option<String>,
    pub out_lamports: Option<String>,
    pub out_mint: Option<String>,
    pub out_quote_mint: Option<String>,
    pub out_quote_amount: Option<String>,
    pub slot: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    Reparse,
    Confirm(ReviewOut),
    /// `error_code` from the RELAYER list.
    Fail {
        code: String,
    },
}

pub const FAIL_CODES: &[&str] = &[
    "slippage",
    "graduated",
    "pool_liquidity",
    "venue_unavailable",
    "not_found",
    "bad_request",
    "internal",
];

fn amount(name: &str, v: &Option<String>) -> std::result::Result<Option<u128>, String> {
    match v {
        None => Ok(None),
        Some(s) => {
            let s = s.trim();
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err(format!("{name} must be a non-negative integer in base units"));
            }
            s.parse::<u128>()
                .map(Some)
                .map_err(|_| format!("{name} is out of range"))
        }
    }
}

/// Check explicit `out_*` against the job (pure). Mirrors what the relayer writes on
/// `confirmed` (RELAYER "Операции и что вернуть в confirmed").
pub fn check_confirm(job: &ReviewJob, out: &ReviewOut) -> std::result::Result<(), String> {
    if job.signature.is_none() {
        return Err("job has no recorded signature: nothing landed, use --fail".into());
    }
    let tokens = amount("--out-token-amount", &out.out_token_amount)?;
    let lamports = amount("--out-lamports", &out.out_lamports)?;
    let quote = amount("--out-quote-amount", &out.out_quote_amount)?;
    if quote.is_some() != out.out_quote_mint.is_some() {
        return Err("--out-quote-amount and --out-quote-mint go together".into());
    }
    if quote.is_some() && lamports.is_some() {
        return Err("ZEC/quote pairs have out_lamports NULL: give either lamports or quote".into());
    }
    let lamports_in = amount("lamports_in", &job.lamports_in)?;
    let token_amount = amount("token_amount", &job.token_amount)?;
    let value = lamports.or(quote);
    match job.op.as_str() {
        // M2: a confirmed create also needs tokens, mint_vaults, trades and the price row the
        // relayer writes in one transaction; a hand-written confirm would leave a broken token.
        "create" | "fair_create" => {
            return Err("create cannot be confirmed by hand (tokens/mint_vaults/trades rows): use --reparse".into());
        }
        "buy" => {
            let t = tokens.ok_or("--out-token-amount is required")?;
            let v = value.ok_or("--out-lamports (or --out-quote-amount) is required")?;
            if let Some(max) = lamports_in
                && v > max
            {
                return Err(format!("spent {v} > lamports_in {max} of the job"));
            }
            if t == 0 {
                return Err("a confirmed buy received 0 tokens: use --fail if nothing was bought".into());
            }
        }
        "sell" => {
            let t = tokens.ok_or("--out-token-amount is required")?;
            value.ok_or("--out-lamports (or --out-quote-amount) is required")?;
            if let Some(max) = token_amount
                && t > max
            {
                return Err(format!("sold {t} > token_amount {max} of the job"));
            }
        }
        "transfer" => {
            let t = tokens.ok_or("--out-token-amount is required")?;
            if Some(t) != token_amount {
                return Err("a transfer moves exactly token_amount".into());
            }
            if value.is_some_and(|v| v != 0) {
                return Err("transfer: out_lamports is 0".into());
            }
        }
        "fund_vaults" => {
            value.ok_or("--out-lamports is required (amount that reached the vaults)")?;
        }
        other => {
            return Err(format!(
                "op {other:?} cannot be confirmed by hand (memo/signature fields): use --reparse or --fail"
            ));
        }
    }
    Ok(())
}

impl Ledger {
    /// All jobs in `needs_review`, oldest first.
    pub async fn review_jobs(&self) -> Result<Vec<ReviewJob>> {
        self.review_query("status = 'needs_review' AND settled_at IS NULL", None)
            .await
    }

    /// One job by id, whatever its status (to explain why it cannot be resolved).
    pub async fn review_job(&self, id: i64) -> Result<Option<(ReviewJob, String, bool)>> {
        let c = self.pool.get().await?;
        let r = c
            .query_opt(
                "SELECT status, settled_at IS NOT NULL FROM relayer_jobs WHERE id = $1",
                &[&id],
            )
            .await?;
        let Some(r) = r else { return Ok(None) };
        let (status, settled): (String, bool) = (r.get(0), r.get(1));
        let job = self.review_query("id = $1", Some(id)).await?.into_iter().next();
        Ok(job.map(|j| (j, status, settled)))
    }

    async fn review_query(&self, cond: &str, id: Option<i64>) -> Result<Vec<ReviewJob>> {
        let c = self.pool.get().await?;
        let q = format!(
            "SELECT id, op, venue, network, mint, lamports_in::text, token_amount::text, signature,
                    error_message, extract(epoch FROM now() - updated_at)::bigint
               FROM relayer_jobs WHERE {cond} ORDER BY id"
        );
        let rows = match id {
            Some(id) => c.query(&q, &[&id]).await?,
            None => c.query(&q, &[]).await?,
        };
        Ok(rows
            .iter()
            .map(|r| ReviewJob {
                id: r.get(0),
                op: r.get(1),
                venue: r.get(2),
                network: r.get(3),
                mint: r.get(4),
                lamports_in: r.get(5),
                token_amount: r.get(6),
                signature: r.get(7),
                error_message: r.get(8),
                age_secs: r.get::<_, Option<i64>>(9).unwrap_or(0),
            })
            .collect())
    }

    /// Apply a resolution to a `needs_review`, unsettled job. `Ok(false)`: the job is not (or
    /// no longer) in `needs_review` (e.g. the relayer resolved it meanwhile): nothing changed.
    /// The caller validates `Confirm` with [`check_confirm`] first.
    pub async fn resolve_review(&self, id: i64, res: &Resolution) -> Result<bool> {
        let c = self.pool.get().await?;
        const WHERE: &str = "WHERE id = $1 AND status = 'needs_review' AND settled_at IS NULL";
        let n = match res {
            // Lease over now: the relayer re-claims it on its next pass (claim takes
            // `needs_review` rows whose lease expired) and re-reads the receipt.
            Resolution::Reparse => {
                c.execute(
                    &format!(
                        "UPDATE relayer_jobs SET lease_until = now() - interval '1 second', updated_at = now() {WHERE}"
                    ),
                    &[&id],
                )
                .await?
            }
            Resolution::Fail { code } => {
                c.execute(
                    &format!(
                        "UPDATE relayer_jobs SET status = 'failed', error_code = $2,
                                error_message = 'operator review: no funds moved', updated_at = now() {WHERE}"
                    ),
                    &[&id, code],
                )
                .await?
            }
            Resolution::Confirm(o) => {
                c.execute(
                    &format!(
                        "UPDATE relayer_jobs SET status = 'confirmed',
                                out_token_amount = $2::text::numeric, out_lamports = $3::text::numeric,
                                out_mint = COALESCE($4, out_mint), out_quote_mint = $5,
                                out_quote_amount = $6::text::numeric, slot = COALESCE($7, slot),
                                error_message = NULL, updated_at = now() {WHERE}"
                    ),
                    &[
                        &id,
                        &o.out_token_amount,
                        &o.out_lamports,
                        &o.out_mint,
                        &o.out_quote_mint,
                        &o.out_quote_amount,
                        &o.slot,
                    ],
                )
                .await?
            }
        };
        Ok(n == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(op: &str) -> ReviewJob {
        ReviewJob {
            id: 1,
            op: op.into(),
            venue: Some("pons".into()),
            network: "hood".into(),
            mint: None,
            lamports_in: Some("1000".into()),
            token_amount: Some("500".into()),
            signature: Some("0xabc".into()),
            error_message: None,
            age_secs: 0,
        }
    }

    fn out(t: Option<&str>, l: Option<&str>) -> ReviewOut {
        ReviewOut {
            out_token_amount: t.map(Into::into),
            out_lamports: l.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn confirm_rules() {
        assert!(check_confirm(&job("buy"), &out(Some("7"), Some("900"))).is_ok());
        assert!(
            check_confirm(&job("buy"), &out(Some("7"), Some("1001"))).is_err(),
            "more than lamports_in"
        );
        assert!(check_confirm(&job("buy"), &out(Some("0"), Some("900"))).is_err());
        assert!(check_confirm(&job("buy"), &out(None, Some("900"))).is_err());
        assert!(check_confirm(&job("buy"), &out(Some("-1"), Some("900"))).is_err());
        assert!(check_confirm(&job("buy"), &out(Some("1e3"), Some("900"))).is_err());
        assert!(check_confirm(&job("sell"), &out(Some("500"), Some("1"))).is_ok());
        assert!(check_confirm(&job("sell"), &out(Some("501"), Some("1"))).is_err());
        // M2: never by hand, even with every field.
        let mut o = out(Some("5"), Some("10"));
        o.out_mint = Some("0xMint".into());
        assert!(check_confirm(&job("create"), &o).unwrap_err().contains("--reparse"));
        assert!(check_confirm(&job("fair_create"), &o).is_err());
        assert!(check_confirm(&job("transfer"), &out(Some("500"), None)).is_ok());
        assert!(check_confirm(&job("transfer"), &out(Some("499"), None)).is_err());
        assert!(check_confirm(&job("fund_vaults"), &out(None, Some("8"))).is_ok());
        assert!(check_confirm(&job("attest"), &out(None, None)).is_err());
        let mut nosig = job("buy");
        nosig.signature = None;
        assert!(check_confirm(&nosig, &out(Some("7"), Some("900"))).is_err());
        // Quote pairs: amount + mint together, no lamports.
        let q = ReviewOut {
            out_token_amount: Some("7".into()),
            out_quote_amount: Some("900".into()),
            out_quote_mint: Some("ZECSPL".into()),
            ..Default::default()
        };
        assert!(check_confirm(&job("buy"), &q).is_ok());
        let q2 = ReviewOut {
            out_quote_mint: None,
            ..q.clone()
        };
        assert!(check_confirm(&job("buy"), &q2).is_err());
        let q3 = ReviewOut {
            out_lamports: Some("1".into()),
            ..q
        };
        assert!(check_confirm(&job("buy"), &q3).is_err());
        // 78-digit NUMERIC columns: wei beyond u64 are fine.
        let mut big = job("sell");
        big.token_amount = Some("100000000000000000000000".into());
        assert!(check_confirm(&big, &out(Some("99999999999999999999999"), Some("1"))).is_ok());
    }
}

//! Creator cabinet (API.md v0.9, `GET /api/creator`, signed): tokens launched by an anon key.
//!
//! T1: everything here is answered only to the key that created the token (signed request,
//! padded response). No number about a creator is ever published elsewhere: the public token
//! endpoints and `/api/stats` read none of `creator_tokens` / `creator_claimable`.

use serde_json::Value;

use crate::{Ledger, Result, to_u64};

/// Max tokens in one cabinet response (newest first).
pub const CABINET_MAX: i64 = 50;

#[derive(Clone, Debug)]
pub struct CreatorTokenRow {
    pub mint: String,
    /// Public token card (`tokens`, or the indexer's `intel_tokens`); `None` before the relayer
    /// wrote it.
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub image: Option<String>,
    pub decimals: Option<i16>,
    pub venue: Option<String>,
    pub status: Option<String>,
    pub created_at_ms: Option<i64>,
    /// Creator fees credited and not yet claimed / already claimed (lamports).
    pub claimable: u64,
    pub claimed: u64,
    /// v0.14: the same for ZEC-pair fees, zat.
    pub claimable_zat: u64,
    pub claimed_zat: u64,
    /// Pool trades of the mint (public, as in the feed): lamports and count.
    pub volume_lamports: u64,
    pub trades: u64,
    /// Lock of the initial buy: amount and end (unix ms), only while it is active.
    pub locked_amount: u64,
    pub locked_until_ms: Option<i64>,
    /// Position through the pool for the cap: available + held + queued buy estimates.
    pub position: u64,
    /// Indexer snapshot (`token_safety.data`) and its tick minute.
    pub safety: Option<Value>,
    pub safety_as_of_ms: Option<i64>,
}

impl Ledger {
    /// Tokens created by `pk`, newest first (≤ [`CABINET_MAX`]).
    pub async fn creator_cabinet(&self, pk: &[u8; 32]) -> Result<Vec<CreatorTokenRow>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT ct.mint,
                        COALESCE(t.symbol, it.symbol), COALESCE(t.name, it.name), COALESCE(t.image, it.image),
                        COALESCE(t.decimals, it.decimals), COALESCE(t.venue, it.venue), COALESCE(t.status, it.status),
                        (extract(epoch FROM COALESCE(t.created_at, it.created_at)) * 1000)::bigint,
                        COALESCE(cc.lamports, 0), COALESCE(cc.claimed_lamports, 0),
                        COALESCE(v.vol, 0)::bigint, COALESCE(v.n, 0)::bigint,
                        CASE WHEN ct.locked_until > now() THEN ct.locked_amount ELSE 0 END,
                        CASE WHEN ct.locked_until > now() AND ct.locked_amount > 0
                             THEN (extract(epoch FROM ct.locked_until) * 1000)::bigint END,
                        (COALESCE(tb.available + tb.held, 0)
                         + COALESCE((SELECT sum(gain_est) FROM actions
                                      WHERE anon_pubkey = $1 AND gain_mint = ct.mint AND status = 'queued'), 0))::bigint,
                        ts.data, (extract(epoch FROM ts.as_of) * 1000)::bigint,
                        COALESCE(cc.zat, 0), COALESCE(cc.claimed_zat, 0)
                 FROM creator_tokens ct
                 LEFT JOIN tokens t ON t.mint = ct.mint
                 LEFT JOIN intel_tokens it ON it.mint = ct.mint
                 LEFT JOIN creator_claimable cc ON cc.anon_pubkey = $1 AND cc.mint = ct.mint
                 LEFT JOIN token_balances tb ON tb.anon_pubkey = $1 AND tb.mint = ct.mint
                 LEFT JOIN token_safety ts ON ts.mint = ct.mint AND NOT ts.missing
                 LEFT JOIN LATERAL (SELECT sum(sol_amount) AS vol, count(*) AS n FROM trades
                                    WHERE mint = ct.mint AND kind IN ('buy', 'sell')) v ON TRUE
                 WHERE ct.anon_pubkey = $1
                 ORDER BY COALESCE(t.created_at, it.created_at) DESC NULLS LAST, ct.mint
                 LIMIT $2",
                &[&pk_s, &CABINET_MAX],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| CreatorTokenRow {
                mint: r.get(0),
                symbol: r.get(1),
                name: r.get(2),
                image: r.get(3),
                decimals: r.get(4),
                venue: r.get(5),
                status: r.get(6),
                created_at_ms: r.get(7),
                claimable: to_u64(r.get(8)),
                claimed: to_u64(r.get(9)),
                claimable_zat: to_u64(r.get(17)),
                claimed_zat: to_u64(r.get(18)),
                volume_lamports: to_u64(r.get(10)),
                trades: to_u64(r.get(11)),
                locked_amount: to_u64(r.get(12)),
                locked_until_ms: r.get(13),
                position: to_u64(r.get(14)),
                safety: r.get(15),
                safety_as_of_ms: r.get(16),
            })
            .collect())
    }
}

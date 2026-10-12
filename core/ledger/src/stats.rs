//! Public platform stats (API.md v0.9, `GET /api/stats`; review-day2 H6).
//!
//! - Computed **once per UTC day** (00:00 UTC; devnet: manual command) into `stats_snapshots`;
//!   the endpoint serves the stored row. No realtime aggregate exists anywhere, so the stats are
//!   not an oracle of "deposit X at time T".
//! - Data cut-off is 00:00 UTC of the snapshot day: a recompute later the same day gives the
//!   same numbers (except token cards, which are the current public `tokens` rows).
//! - Trades, volume and launches come only from the pool's public Solana trades (`trades`).
//!   The only ledger figure is the shielded ZEC total: rounded down, and it moves only when at
//!   least `k` new deposits were credited since its last move (no single-deposit delta).
//! - k-anonymity: any category built from fewer than `k` events is published as `"<k"`.
//! - Nothing about creators (fees, claims, positions) is ever part of the stats (T1).

use deadpool_postgres::GenericClient;
use serde_json::{Map, Value, json};

use crate::{Ledger, Result, to_i64, to_u64};

/// Venues always present in `byVenue` (fixed key set: absence tells nothing).
pub const VENUES: [&str; 3] = ["pumpfun", "meteora-dbc", "jupiter"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatsParams {
    /// k-anonymity threshold (5): fewer events → `"<k"`.
    pub k: u64,
    /// SOL volumes rounded down to this many lamports (default 0.1 SOL).
    pub sol_round_lamports: u64,
    /// Shielded ZEC total rounded down to this many zatoshis (default 1 ZEC).
    pub zec_round_zat: u64,
    /// Top tokens: how many, and the trailing window before the cut-off (days).
    pub top_n: i64,
    pub top_window_days: i32,
}

impl Default for StatsParams {
    fn default() -> Self {
        Self {
            k: 5,
            sol_round_lamports: 100_000_000,
            zec_round_zat: 100_000_000,
            top_n: 10,
            top_window_days: 7,
        }
    }
}

/// `n` (a count of events) or `"<k"`.
pub fn k_count(n: u64, k: u64) -> Value {
    if n < k { json!(format!("<{k}")) } else { json!(n) }
}

/// Decimal string of `v` base units rounded DOWN to `step`, or `"<k"` when it is built from
/// fewer than `k` events.
pub fn k_amount(events: u64, v: u64, step: u64, decimals: u32, k: u64) -> Value {
    if events < k {
        return json!(format!("<{k}"));
    }
    json!(units(round_down(v, step), decimals))
}

pub fn round_down(v: u64, step: u64) -> u64 {
    if step <= 1 { v } else { v - v % step }
}

/// `v / 10^decimals` as a plain decimal string without trailing zeros ("12.5", "0", "3").
pub fn units(v: u64, decimals: u32) -> String {
    let d = 10u128.pow(decimals);
    let (w, f) = ((v as u128) / d, (v as u128) % d);
    if f == 0 {
        return w.to_string();
    }
    let f = format!("{f:0width$}", width = decimals as usize);
    format!("{w}.{}", f.trim_end_matches('0'))
}

/// Shielded total to publish: (zat, deposit count it was published at). It moves only when
/// `count - prev_count >= k`; before the first `k` deposits nothing is published.
pub fn zec_publish(prev: Option<(u64, u64)>, total_zat: u64, count: u64, p: &StatsParams) -> (u64, u64) {
    let (pz, pc) = prev.unwrap_or((0, 0));
    if count >= pc.saturating_add(p.k) {
        (round_down(total_zat, p.zec_round_zat), count)
    } else {
        (pz, pc)
    }
}

#[derive(Clone, Debug, Default)]
struct VenueAgg {
    trades: u64,
    volume: u64,
    launches: u64,
}

impl Ledger {
    /// Compute and store today's snapshot (cut-off 00:00 UTC today). Returns the UTC day.
    pub async fn stats_snapshot(&self, network: &str, p: &StatsParams) -> Result<String> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        // One snapshot computation at a time per network.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtext('unzeen/stats/' || $1))",
            &[&network],
        )
        .await?;
        let day: String = tx
            .query_one("SELECT (now() AT TIME ZONE 'UTC')::date::text", &[])
            .await?
            .get(0);
        let data = compute(&tx, network, &day, p).await?;
        let (zec_zat, zec_deposits) = (to_i64(data.1.0)?, to_i64(data.1.1)?);
        tx.execute(
            "INSERT INTO stats_snapshots (network, day, data, zec_zat, zec_deposits)
             VALUES ($1, $2::text::date, $3, $4, $5)
             ON CONFLICT (network, day) DO UPDATE
               SET data = EXCLUDED.data, zec_zat = EXCLUDED.zec_zat, zec_deposits = EXCLUDED.zec_deposits",
            &[&network, &day, &data.0, &zec_zat, &zec_deposits],
        )
        .await?;
        tx.commit().await?;
        Ok(day)
    }

    /// No snapshot for today's UTC day yet (the daily scheduler then computes one).
    pub async fn stats_due(&self, network: &str) -> Result<bool> {
        let c = self.pool.get().await?;
        Ok(c.query_opt(
            "SELECT 1 FROM stats_snapshots WHERE network = $1 AND day = (now() AT TIME ZONE 'UTC')::date",
            &[&network],
        )
        .await?
        .is_none())
    }

    /// Latest snapshot as `PlatformStats` (with `asOf`, unix ms of its 00:00 UTC cut-off).
    pub async fn stats_latest(&self, network: &str) -> Result<Option<Value>> {
        let c = self.pool.get().await?;
        Ok(c.query_opt(
            "SELECT data, (extract(epoch FROM (day::timestamp AT TIME ZONE 'UTC')) * 1000)::bigint
             FROM stats_snapshots WHERE network = $1 ORDER BY day DESC LIMIT 1",
            &[&network],
        )
        .await?
        .map(|r| {
            let mut v: Value = r.get(0);
            v["asOf"] = json!(r.get::<_, i64>(1));
            v
        }))
    }
}

/// `(PlatformStats without asOf, (published zat, deposit count))`.
async fn compute<C: GenericClient>(tx: &C, network: &str, day: &str, p: &StatsParams) -> Result<(Value, (u64, u64))> {
    const CUT: &str = "($1::text::date::timestamp AT TIME ZONE 'UTC')";
    let k = p.k;
    // Public pool trades (already on Solana), up to the cut-off.
    let rows = tx
        .query(
            &format!(
                "SELECT venue,
                        count(*) FILTER (WHERE kind IN ('buy', 'sell')),
                        COALESCE(sum(sol_amount) FILTER (WHERE kind IN ('buy', 'sell')), 0)::bigint,
                        count(*) FILTER (WHERE kind = 'create')
                 FROM trades WHERE ts < {CUT} GROUP BY venue"
            ),
            &[&day],
        )
        .await?;
    let mut by: Map<String, Value> = Map::new();
    let mut total = VenueAgg::default();
    let mut aggs: Vec<(String, VenueAgg)> = Vec::new();
    for r in &rows {
        let a = VenueAgg {
            trades: to_u64(r.get(1)),
            volume: to_u64(r.get(2)),
            launches: to_u64(r.get(3)),
        };
        total.trades += a.trades;
        total.volume += a.volume;
        total.launches += a.launches;
        aggs.push((r.get(0), a));
    }
    for v in VENUES {
        let a = aggs
            .iter()
            .find(|(n, _)| n == v)
            .map(|(_, a)| a.clone())
            .unwrap_or_default();
        by.insert(
            v.into(),
            json!({
                "volumeSol": k_amount(a.trades, a.volume, p.sol_round_lamports, 9, k),
                "trades": k_count(a.trades, k),
                "launches": k_count(a.launches, k),
            }),
        );
    }

    // Shielded ZEC: credited deposits seen before the cut-off (created_at is day-coarse).
    let d = tx
        .query_one(
            &format!(
                "SELECT count(*), COALESCE(sum(credited_zat), 0)::bigint FROM deposits
                 WHERE status = 'credited' AND NOT reorged AND created_at < {CUT}"
            ),
            &[&day],
        )
        .await?;
    let (dep_n, dep_zat) = (to_u64(d.get(0)), to_u64(d.get(1)));
    let prev = tx
        .query_opt(
            "SELECT zec_zat, zec_deposits FROM stats_snapshots
             WHERE network = $1 AND day < $2::text::date ORDER BY day DESC LIMIT 1",
            &[&network, &day],
        )
        .await?
        .map(|r| (to_u64(r.get(0)), to_u64(r.get(1))));
    let (zec_zat, zec_n) = zec_publish(prev, dep_zat, dep_n, p);

    // Top tokens by pool volume over the trailing window; only tokens with >= k trades in it.
    let top = tx
        .query(
            &format!(
                "SELECT t.mint, t.symbol, t.name, t.image, t.venue, t.status, t.decimals,
                        trim_scale(t.price_sol)::text, trim_scale(t.market_cap_sol)::text,
                        (extract(epoch FROM t.created_at) * 1000)::bigint, x.vol, x.n
                 FROM (SELECT mint, sum(sol_amount)::bigint AS vol, count(*) AS n FROM trades
                       WHERE kind IN ('buy', 'sell') AND ts < {CUT}
                         AND ts >= {CUT} - make_interval(days => $2)
                       GROUP BY mint HAVING count(*) >= $3) x
                 JOIN tokens t ON t.mint = x.mint
                 ORDER BY x.vol DESC, t.mint LIMIT $4"
            ),
            &[&day, &p.top_window_days, &to_i64(k)?, &p.top_n],
        )
        .await?;
    let top: Vec<Value> = top
        .iter()
        .map(|r| {
            let mut v = json!({
                "mint": r.get::<_, String>(0),
                "symbol": r.get::<_, String>(1),
                "name": r.get::<_, String>(2),
                "venue": r.get::<_, String>(4),
                "status": r.get::<_, String>(5),
                "decimals": r.get::<_, i16>(6),
                "priceSol": r.get::<_, String>(7),
                "marketCapSol": r.get::<_, String>(8),
                "createdAt": r.get::<_, i64>(9),
                "volumeSol": units(round_down(to_u64(r.get(10)), p.sol_round_lamports), 9),
                "trades": to_u64(r.get(11)),
            });
            if let Some(img) = r.get::<_, Option<String>>(3) {
                v["image"] = json!(img);
            }
            v
        })
        .collect();

    let data = json!({
        "volumeSol": k_amount(total.trades, total.volume, p.sol_round_lamports, 9, k),
        "trades": k_count(total.trades, k),
        "launches": k_count(total.launches, k),
        "zecShielded": k_amount(zec_n, zec_zat, p.zec_round_zat, 8, k),
        "byVenue": by,
        "topTokens": top,
        "topWindowDays": p.top_window_days,
    });
    Ok((data, (zec_zat, zec_n)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn k_anonymity() {
        assert_eq!(k_count(0, 5), json!("<5"));
        assert_eq!(k_count(4, 5), json!("<5"));
        assert_eq!(k_count(5, 5), json!(5));
        assert_eq!(k_amount(4, 9_000_000_000, 100_000_000, 9, 5), json!("<5"));
        assert_eq!(k_amount(5, 12_345_678_901, 100_000_000, 9, 5), json!("12.3"));
        assert_eq!(k_amount(9, 99_999_999, 100_000_000, 9, 5), json!("0"));
    }

    #[test]
    fn units_and_rounding() {
        assert_eq!(units(0, 9), "0");
        assert_eq!(units(1_000_000_000, 9), "1");
        assert_eq!(units(1_500_000_000, 9), "1.5");
        assert_eq!(units(1, 9), "0.000000001");
        assert_eq!(units(250_000_000, 8), "2.5");
        assert_eq!(units(u64::MAX, 9), "18446744073.709551615");
        assert_eq!(round_down(1_999, 1_000), 1_000);
        assert_eq!(round_down(1_999, 0), 1_999);
        assert_eq!(round_down(1_999, 1), 1_999);
    }

    #[test]
    fn shielded_total_moves_only_after_k_deposits() {
        let p = StatsParams::default(); // k = 5, 1 ZEC
        // Fewer than k deposits ever: nothing published.
        assert_eq!(zec_publish(None, 750_000_000, 4, &p), (0, 0));
        // k deposits: published, rounded down to 1 ZEC.
        assert_eq!(zec_publish(None, 750_000_000, 5, &p), (700_000_000, 5));
        // Next day only 4 new deposits: unchanged (no single-deposit delta).
        assert_eq!(
            zec_publish(Some((700_000_000, 5)), 2_000_000_000, 9, &p),
            (700_000_000, 5)
        );
        // 5 new deposits: moves.
        assert_eq!(
            zec_publish(Some((700_000_000, 5)), 2_040_000_000, 10, &p),
            (2_000_000_000, 10)
        );
    }
}

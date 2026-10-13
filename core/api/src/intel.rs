//! Token intel (docs/INTEL.md, API v0.5): `GET /api/tokens/:mint/safety`, the cold-mint
//! queue (202 pending) and the warm-set sync.
//!
//! Privacy:
//! - public, unsigned, identical answers for everyone; nothing is logged per mint;
//! - a request never triggers an RPC call: it only queues the mint for the indexer's fixed
//!   tick, where it is padded with decoys (docs/INTEL.md);
//! - T1: for tokens launched through Unzeen the creator's share and history are never
//!   published (`dev` dropped, `devPct = null`), whatever the snapshot says.

use std::time::Duration;

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    actions::{any_address, solana_address},
    error::{ApiError, ApiResult},
    launch,
    market::{client, db, public},
};

type Client = unzeen_ledger::deadpool_postgres::Object;

/// Extra time after `next_tick_at` for the indexer to finish the tick.
const TICK_MARGIN_MS: i64 = 10_000;
/// Answer when the indexer has not published a schedule (or is down).
const DEFAULT_RETRY_MS: i64 = 60_000;

// ------------------------------------------------------------------ pending (202)

/// `retryAfterMs` from the indexer's published schedule: the same for every caller.
pub fn retry_after_ms(next_tick_at: Option<i64>, now: i64) -> i64 {
    match next_tick_at {
        Some(t) if t + 30_000 >= now => (t - now + TICK_MARGIN_MS).max(1_000),
        _ => DEFAULT_RETRY_MS,
    }
}

pub async fn pending(c: &Client) -> ApiResult<Response> {
    let next: Option<i64> = c
        .query_opt("SELECT value FROM intel_meta WHERE key = 'next_tick_at'", &[])
        .await
        .map_err(db)?
        .and_then(|r| r.get::<_, String>(0).parse().ok());
    let retry = retry_after_ms(next, crate::rate::now_ms() as i64);
    let mut r = (
        StatusCode::ACCEPTED,
        Json(json!({ "status": "pending", "retryAfterMs": retry })),
    )
        .into_response();
    let secs = (retry as u64).div_ceil(1000).max(1);
    if let Ok(h) = HeaderValue::from_str(&format!("public, max-age={secs}")) {
        r.headers_mut().insert(header::CACHE_CONTROL, h);
    }
    Ok(r)
}

/// Queue a cold mint for the next tick (bounded; pool tokens are pinned in the warm set and
/// need no request). Idempotent; never stores anything about the caller.
pub async fn enqueue(st: &AppState, c: &Client, mint: &str) -> ApiResult<()> {
    c.execute(
        "INSERT INTO intel_requests (mint)
         SELECT $1 WHERE (SELECT count(*) FROM intel_requests) < $2
                     AND NOT EXISTS (SELECT 1 FROM tokens WHERE mint = $1)
         ON CONFLICT (mint) DO NOTHING",
        &[&mint, &st.cfg.intel.queue_max],
    )
    .await
    .map_err(db)?;
    Ok(())
}

/// Token launched through Unzeen: its `create` is in the public feed (relayer) or the
/// ledger has creator rights for it (existence only, the key is never read here).
pub async fn is_unzeen_launch(c: &Client, mint: &str) -> ApiResult<bool> {
    Ok(c.query_one(
        "SELECT EXISTS (SELECT 1 FROM trades WHERE mint = $1 AND kind = 'create')
                 OR EXISTS (SELECT 1 FROM creator_tokens WHERE mint = $1)",
        &[&mint],
    )
    .await
    .map_err(db)?
    .get(0))
}

// ------------------------------------------------------------------ GET /api/tokens/:mint/safety

pub async fn safety(State(st): State<AppState>, Path(mint): Path<String>) -> ApiResult<Response> {
    let mint = any_address(&mint, "mint")?;
    let c = client(&st).await?;
    let row = c
        .query_opt(
            "SELECT (extract(epoch FROM as_of) * 1000)::bigint, missing, data FROM token_safety WHERE mint = $1",
            &[&mint],
        )
        .await
        .map_err(db)?;
    let Some(row) = row else {
        enqueue(&st, &c, &mint).await?;
        return pending(&c).await;
    };
    if row.get::<_, bool>(1) {
        let mut r = ApiError::not_found().into_response();
        r.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=60"));
        return Ok(r);
    }
    let as_of: i64 = row.get(0);
    let data: Option<Value> = row.get(2);
    let launch = is_unzeen_launch(&c, &mint).await?;
    let l = &st.cfg.launch;
    match data.and_then(|d| safety_json(&mint, as_of, &d, launch.then_some((l.lock_secs, l.cap_bps)))) {
        Some(mut v) => {
            // v0.6: fair-launched mint (only while the feature is visible).
            if st.cfg.fair.enabled
                && launch
                && st.ledger.fl_is_fair_mint(&mint).await?
                && let Some(rules) = v["unzeen"]["rules"].as_array_mut()
            {
                rules.insert(0, json!("fair_launch_sealed_bids"));
            }
            Ok(public(v, 60))
        }
        // Malformed snapshot (indexer bug): same as "no snapshot yet".
        None => pending(&c).await,
    }
}

/// Decimal percent string `0..=100`, at most 4 decimals.
fn pct(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let (i, f) = s.split_once('.').unwrap_or((s, ""));
    let ok = (1..=3).contains(&i.len())
        && i.bytes().all(|b| b.is_ascii_digit())
        && (s.contains('.') && (1..=4).contains(&f.len()) || !s.contains('.'))
        && f.bytes().all(|b| b.is_ascii_digit());
    (ok && s.parse::<f64>().is_ok_and(|x| x <= 100.0)).then(|| s.to_string())
}

fn uint(v: &Value) -> Option<Value> {
    v.as_u64().map(Value::from)
}

const RISKY: [&str; 6] = [
    "permanentDelegate",
    "transferHook",
    "transferFee",
    "defaultFrozen",
    "mintClose",
    "pausable",
];

/// Only our media: `http(s)://<host>/…/media/<sha40>.<png|jpeg|jpg|webp>`, no query/fragment.
pub fn media_url_ok(s: &str) -> bool {
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or("");
    if rest.is_empty() || s.contains(['?', '#', '\\', '@']) || s.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    match rest.rsplit_once("/media/") {
        Some((host, name)) => {
            !host.is_empty()
                && !name.contains('/')
                && crate::media_name_ok(name).is_some_and(|m| m != "application/json")
        }
        None => false,
    }
}

/// `https://` link on one of `hosts` (empty = any host), without credentials or spaces.
fn https_link(v: &Value, hosts: &[&str]) -> Option<String> {
    let s = v.as_str()?;
    if s.len() > 200 || s.chars().any(|c| c.is_whitespace() || c.is_control()) || s.contains(['@', '\\']) {
        return None;
    }
    let rest = s.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if host.is_empty() || host.contains(':') {
        return None;
    }
    let host = host.strip_prefix("www.").unwrap_or(&host);
    (hosts.is_empty() || hosts.contains(&host)).then(|| s.to_string())
}

/// `TokenSafety` (API v0.5) from an indexer snapshot: whitelisted fields only, T1 applied
/// when `launch = Some((lock_secs, cap_bps))`. `None` if a required field is malformed.
pub fn safety_json(mint: &str, as_of_ms: i64, d: &Value, launch: Option<(u64, u64)>) -> Option<Value> {
    let as_of = as_of_ms - as_of_ms.rem_euclid(60_000);
    let program = d
        .get("program")?
        .as_str()
        .filter(|p| ["spl-token", "token-2022"].contains(p))?;

    let a = d.get("authorities")?;
    let mint_revoked = a.get("mintRevoked")?.as_bool()?;
    let freeze_revoked = a.get("freezeRevoked")?.as_bool()?;
    let immutable = match a.get("metadataImmutable") {
        Some(Value::Bool(b)) => json!(b),
        _ => Value::Null,
    };
    let risky: Vec<&str> = a
        .get("riskyExtensions")
        .and_then(Value::as_array)
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .filter(|x| RISKY.contains(x))
                .collect()
        })
        .unwrap_or_default();

    let m = d.get("market")?;
    let venue = m
        .get("venue")?
        .as_str()
        .filter(|v| ["pumpfun", "meteora-dbc", "jupiter"].contains(v))?;
    let status = m
        .get("status")?
        .as_str()
        .filter(|v| ["curve", "graduated"].contains(v))?;
    let mut market = json!({ "venue": venue, "status": status });
    if status == "curve"
        && let Some(p) = m.get("curveProgressPct").and_then(pct)
    {
        market["curveProgressPct"] = json!(p);
    }
    if let Some(p) = m.get("lpBurnedPct").and_then(pct) {
        market["lpBurnedPct"] = json!(p);
    }

    let mut out = json!({
        "mint": mint,
        "asOf": as_of,
        "program": program,
        "authorities": {
            "mintRevoked": mint_revoked,
            "freezeRevoked": freeze_revoked,
            "metadataImmutable": immutable,
            "riskyExtensions": risky,
        },
        "market": market,
    });

    if let Some(h) = d.get("holders")
        && let (Some(top), Some(pool)) = (h.get("top10Pct").and_then(pct), h.get("unzeenPoolPct").and_then(pct))
    {
        // T1: the anonymous creator's share is never published.
        let dev = if launch.is_some() {
            Value::Null
        } else {
            h.get("devPct").and_then(pct).map_or(Value::Null, Value::from)
        };
        out["holders"] = json!({ "top10Pct": top, "devPct": dev, "unzeenPoolPct": pool, "asOf": as_of });
    }

    // T1: no dev history for Unzeen launches.
    if launch.is_none()
        && let Some(dv) = d.get("dev")
        && let (Some(addr), Some(l), Some(r), Some(since)) = (
            dv.get("address").and_then(Value::as_str),
            dv.get("launchesSeen").and_then(uint),
            dv.get("rugsSeen").and_then(uint),
            dv.get("since").and_then(uint),
        )
        && solana_address(addr, "dev").is_ok()
    {
        out["dev"] = json!({ "address": addr, "launchesSeen": l, "rugsSeen": r, "since": since });
    }

    if let Some(f) = d.get("firstBlocks")
        && let (Some(sn), Some(snp), Some(ss), Some(ssp)) = (
            f.get("snipers").and_then(uint),
            f.get("sniperPct").and_then(pct),
            f.get("sameSlotBuyers").and_then(uint),
            f.get("sameSlotPct").and_then(pct),
        )
    {
        let ulb = launch.is_some() || f.get("unzeenLaunchBuy").and_then(Value::as_bool) == Some(true);
        out["firstBlocks"] = json!({
            "snipers": sn, "sniperPct": snp, "sameSlotBuyers": ss, "sameSlotPct": ssp, "unzeenLaunchBuy": ulb,
        });
    }

    if let Some(so) = d.get("socials") {
        let mut s = Map::new();
        if let Some(v) = so.get("twitter").and_then(|v| https_link(v, &["x.com", "twitter.com"])) {
            s.insert("twitter".into(), json!(v));
        }
        if let Some(v) = so.get("telegram").and_then(|v| https_link(v, &["t.me"])) {
            s.insert("telegram".into(), json!(v));
        }
        if let Some(v) = so.get("website").and_then(|v| https_link(v, &[])) {
            s.insert("website".into(), json!(v));
        }
        if !s.is_empty() {
            out["socials"] = Value::Object(s);
        }
    }

    if let Some(img) = d.get("image").and_then(Value::as_str).filter(|s| media_url_ok(s)) {
        out["image"] = json!(img);
    }

    if let Some((lock, cap)) = launch {
        out["unzeen"] = json!({
            "launch": true,
            "rules": launch::rule_ids(lock, cap, mint_revoked && freeze_revoked),
        });
    }
    Some(out)
}

// ------------------------------------------------------------------ warm set sync

/// Every 60 s: pin the pool's tokens in the warm set (with `hot` for a pool trade in the last
/// hour), drop expired unpinned mints with their snapshots, and forget `missing` answers
/// after an hour. Counters only in logs.
pub async fn warm_sync_loop(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        if let Err(e) = warm_sync(&st).await {
            tracing::warn!(code = e.code, "warm set sync failed");
        }
    }
}

pub async fn warm_sync(st: &AppState) -> ApiResult<()> {
    let c = client(st).await?;
    c.batch_execute(
        "INSERT INTO intel_warm (mint, pinned, hot)
         SELECT m.mint, TRUE,
                EXISTS (SELECT 1 FROM trades t WHERE t.mint = m.mint AND t.ts > now() - interval '1 hour')
         FROM (SELECT mint FROM tokens UNION SELECT mint FROM mint_vaults) m
         ON CONFLICT (mint) DO UPDATE SET pinned = TRUE, hot = EXCLUDED.hot
         WHERE NOT intel_warm.pinned OR intel_warm.hot <> EXCLUDED.hot;
         DELETE FROM intel_warm WHERE NOT pinned AND expires_at < now();
         DELETE FROM token_safety WHERE missing AND as_of < now() - interval '1 hour';
         DELETE FROM token_safety s
          WHERE NOT EXISTS (SELECT 1 FROM intel_warm w WHERE w.mint = s.mint)
            AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.mint = s.mint)
            AND NOT (s.missing AND s.as_of >= now() - interval '1 hour');
         DELETE FROM intel_tokens i
          WHERE NOT EXISTS (SELECT 1 FROM intel_warm w WHERE w.mint = i.mint);
         DELETE FROM intel_creates WHERE created_at < now() - interval '90 days';",
    )
    .await
    .map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> Value {
        json!({
            "program": "token-2022",
            "authorities": { "mintRevoked": true, "freezeRevoked": true, "metadataImmutable": true,
                             "riskyExtensions": ["transferHook", "evil"] },
            "holders": { "top10Pct": "12.5", "devPct": "3.1", "unzeenPoolPct": "0.8" },
            "dev": { "address": "So11111111111111111111111111111111111111112", "launchesSeen": 3, "rugsSeen": 1, "since": 1 },
            "firstBlocks": { "snipers": 2, "sniperPct": "4", "sameSlotBuyers": 0, "sameSlotPct": "0", "unzeenLaunchBuy": false },
            "market": { "venue": "pumpfun", "status": "curve", "curveProgressPct": "41.25", "lpBurnedPct": "x" },
            "socials": { "twitter": "https://x.com/abc", "telegram": "http://t.me/abc", "website": "https://evil.example/a" },
            "image": "https://api.unzeen.test/media/0123456789abcdef0123456789abcdef01234567.png",
            "unzeen": { "launch": true, "rules": ["fake"] },
            "extra": 1
        })
    }

    #[test]
    fn foreign_token_passes_whitelisted_fields() {
        let v = safety_json("M", 1_760_000_059_999, &snap(), None).unwrap();
        assert_eq!(v["asOf"], 1_760_000_040_000i64);
        assert_eq!(v["holders"]["devPct"], "3.1");
        assert_eq!(v["holders"]["asOf"], 1_760_000_040_000i64);
        assert_eq!(v["authorities"]["riskyExtensions"], json!(["transferHook"]));
        assert_eq!(v["dev"]["launchesSeen"], 3);
        assert_eq!(v["market"]["curveProgressPct"], "41.25");
        assert!(v["market"].get("lpBurnedPct").is_none());
        assert_eq!(
            v["socials"],
            json!({ "twitter": "https://x.com/abc", "website": "https://evil.example/a" })
        );
        assert!(v["image"].is_string());
        // The indexer cannot claim an Unzeen launch, nor add fields.
        assert!(v.get("unzeen").is_none());
        assert!(v.get("extra").is_none());
    }

    #[test]
    fn t1_unzeen_launch_hides_creator() {
        let v = safety_json("M", 0, &snap(), Some((86_400, 500))).unwrap();
        assert!(v.get("dev").is_none());
        assert_eq!(v["holders"]["devPct"], Value::Null);
        assert_eq!(v["firstBlocks"]["unzeenLaunchBuy"], true);
        assert_eq!(
            v["unzeen"],
            json!({ "launch": true, "rules": ["creator_initial_buy_locked_24h", "initial_buy_cap_5pct", "authorities_revoked"] })
        );
        let mut s = snap();
        s["authorities"]["freezeRevoked"] = json!(false);
        let v = safety_json("M", 0, &s, Some((86_400, 500))).unwrap();
        assert_eq!(v["unzeen"]["rules"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn malformed_snapshots_are_rejected() {
        for (path, bad) in [
            ("program", json!("evil")),
            ("market", json!({ "venue": "x", "status": "curve" })),
            ("authorities", json!({ "mintRevoked": "yes" })),
        ] {
            let mut s = snap();
            s[path] = bad;
            assert!(safety_json("M", 0, &s, None).is_none(), "{path}");
        }
    }

    #[test]
    fn percents_and_links() {
        for ok in ["0", "100", "12.5", "99.9999"] {
            assert!(pct(&json!(ok)).is_some(), "{ok}");
        }
        for bad in ["", "101", "1.", ".5", "1e2", "-1", "12.34567", "1000", "NaN"] {
            assert!(pct(&json!(bad)).is_none(), "{bad}");
        }
        assert!(pct(&json!(5)).is_none());
        assert!(https_link(&json!("https://www.twitter.com/a"), &["x.com", "twitter.com"]).is_some());
        assert!(https_link(&json!("https://x.com.evil/a"), &["x.com"]).is_none());
        assert!(https_link(&json!("https://user@x.com/a"), &["x.com"]).is_none());
        assert!(https_link(&json!("https://x.com:8443/a"), &["x.com"]).is_none());
        assert!(https_link(&json!("javascript:alert(1)"), &[]).is_none());
    }

    #[test]
    fn media_urls() {
        let name = "0123456789abcdef0123456789abcdef01234567";
        assert!(media_url_ok(&format!("https://api.unzeen.io/media/{name}.webp")));
        assert!(media_url_ok(&format!("http://127.0.0.1:8080/media/{name}.jpg")));
        for bad in [
            format!("https://ipfs.io/ipfs/{name}.png"),
            format!("https://h/media/{name}.svg"),
            format!("https://h/media/{name}.json"),
            format!("https://h/media/{name}.png?x=1"),
            format!("https://h/media/../{name}.png"),
            format!("/media/{name}.png"),
            format!("https://u@h/media/{name}.png"),
        ] {
            assert!(!media_url_ok(&bad), "{bad}");
        }
    }

    #[test]
    fn retry_after() {
        assert_eq!(retry_after_ms(None, 1_000_000), DEFAULT_RETRY_MS);
        assert_eq!(retry_after_ms(Some(1_020_000), 1_000_000), 30_000);
        // Tick due now / just overdue: a short wait, at least 1 s.
        assert_eq!(retry_after_ms(Some(1_000_000), 1_000_000), 10_000);
        assert_eq!(retry_after_ms(Some(985_000), 1_000_000), 1_000);
        // Indexer silent for > 30 s.
        assert_eq!(retry_after_ms(Some(900_000), 1_000_000), DEFAULT_RETRY_MS);
    }
}

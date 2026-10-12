//! Public market data: feed, tokens, trades, candles, WS. Source: `trades` / `tokens`
//! written by the relayer (docs/RELAYER.md). Everything here is public on Solana already.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;
use unzeen_ledger::{LedgerError, tokio_postgres::Row};

use crate::{
    AppState,
    actions::solana_address,
    error::{ApiError, ApiResult},
};

pub struct FeedMsg {
    pub id: i64,
    pub mint: String,
    pub json: String,
}

const TRADE_COLS: &str = "id, kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature,
     (extract(epoch FROM ts) * 1000)::bigint";

fn trade_json(r: &Row) -> Value {
    json!({
        "id": r.get::<_, i64>(0).to_string(),
        "kind": r.get::<_, String>(1),
        "venue": r.get::<_, String>(2),
        "mint": r.get::<_, String>(3),
        "symbol": r.get::<_, String>(4),
        "tokenAmount": r.get::<_, i64>(5).to_string(),
        "solAmount": r.get::<_, i64>(6).to_string(),
        "decimals": r.get::<_, i16>(7),
        "solanaTx": r.get::<_, String>(8),
        "ts": r.get::<_, i64>(9),
    })
}

const TOKEN_COLS: &str = "mint, symbol, name, image, venue, status, decimals,
     trim_scale(price_sol)::text, trim_scale(market_cap_sol)::text, (extract(epoch FROM created_at) * 1000)::bigint";

fn token_json(r: &Row) -> Value {
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
    });
    if let Some(img) = r.get::<_, Option<String>>(3) {
        v["image"] = json!(img);
    }
    v
}

async fn client(st: &AppState) -> ApiResult<unzeen_ledger::deadpool_postgres::Object> {
    Ok(st.ledger.pg().get().await.map_err(LedgerError::from)?)
}

fn db(e: unzeen_ledger::tokio_postgres::Error) -> ApiError {
    LedgerError::from(e).into()
}

fn public(v: Value, max_age: u32) -> Response {
    let mut r = Json(v).into_response();
    if let Ok(h) = HeaderValue::from_str(&format!("public, max-age={max_age}")) {
        r.headers_mut().insert(header::CACHE_CONTROL, h);
    }
    r
}

fn limit(q: &HashMap<String, String>, default: i64, max: i64) -> ApiResult<i64> {
    match q.get("limit") {
        None => Ok(default),
        Some(s) => s
            .parse::<i64>()
            .ok()
            .filter(|v| (1..=max).contains(v))
            .ok_or_else(|| ApiError::bad_request(format!("limit: 1..{max}"))),
    }
}

fn mint_param(m: &str) -> ApiResult<String> {
    // Unknown / malformed mints are simply "not tracked".
    solana_address(m, "mint").map_err(|_| ApiError::not_found())
}

pub async fn feed(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Response> {
    let n = limit(&q, 50, 200)?;
    let c = client(&st).await?;
    let rows = c
        .query(
            &format!("SELECT {TRADE_COLS} FROM trades ORDER BY id DESC LIMIT $1"),
            &[&n],
        )
        .await
        .map_err(db)?;
    Ok(public(Value::Array(rows.iter().map(trade_json).collect()), 2))
}

pub async fn tokens(State(st): State<AppState>) -> ApiResult<Response> {
    let c = client(&st).await?;
    let rows = c
        .query(
            &format!("SELECT {TOKEN_COLS} FROM tokens ORDER BY created_at DESC LIMIT 200"),
            &[],
        )
        .await
        .map_err(db)?;
    Ok(public(Value::Array(rows.iter().map(token_json).collect()), 5))
}

pub async fn token(State(st): State<AppState>, Path(mint): Path<String>) -> ApiResult<Response> {
    let mint = mint_param(&mint)?;
    let c = client(&st).await?;
    let t = c
        .query_opt(&format!("SELECT {TOKEN_COLS} FROM tokens WHERE mint = $1"), &[&mint])
        .await
        .map_err(db)?
        .ok_or_else(ApiError::not_found)?;
    let trades = c
        .query(
            &format!("SELECT {TRADE_COLS} FROM trades WHERE mint = $1 ORDER BY id DESC LIMIT 50"),
            &[&mint],
        )
        .await
        .map_err(db)?;
    let mut v = token_json(&t);
    v["trades"] = Value::Array(trades.iter().map(trade_json).collect());
    Ok(public(v, 2))
}

async fn ensure_token(c: &unzeen_ledger::deadpool_postgres::Object, mint: &str) -> ApiResult<()> {
    c.query_opt("SELECT 1 FROM tokens WHERE mint = $1", &[&mint])
        .await
        .map_err(db)?
        .map(|_| ())
        .ok_or_else(ApiError::not_found)
}

pub async fn trades(
    State(st): State<AppState>,
    Path(mint): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let mint = mint_param(&mint)?;
    let n = limit(&q, 50, 200)?;
    let before: i64 = match q.get("before") {
        None => i64::MAX,
        Some(s) => s
            .parse()
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| ApiError::bad_request("before: trade id"))?,
    };
    let c = client(&st).await?;
    ensure_token(&c, &mint).await?;
    let rows = c
        .query(
            &format!("SELECT {TRADE_COLS} FROM trades WHERE mint = $1 AND id < $2 ORDER BY id DESC LIMIT $3"),
            &[&mint, &before, &n],
        )
        .await
        .map_err(db)?;
    Ok(public(Value::Array(rows.iter().map(trade_json).collect()), 2))
}

pub fn tf_secs(tf: &str) -> Option<i64> {
    Some(match tf {
        "1m" => 60,
        "5m" => 300,
        "15m" => 900,
        "1h" => 3_600,
        "4h" => 14_400,
        "1d" => 86_400,
        _ => return None,
    })
}

pub async fn candles(
    State(st): State<AppState>,
    Path(mint): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let mint = mint_param(&mint)?;
    let tf = tf_secs(q.get("tf").map_or("5m", String::as_str))
        .ok_or_else(|| ApiError::bad_request("tf: 1m | 5m | 15m | 1h | 4h | 1d"))?;
    let secs = |k: &str| -> ApiResult<Option<i64>> {
        q.get(k)
            .map(|s| {
                s.parse::<i64>()
                    .ok()
                    .filter(|v| *v >= 0)
                    .ok_or_else(|| ApiError::bad_request(format!("{k}: unix seconds")))
            })
            .transpose()
    };
    let now = crate::rate::now_ms() as i64 / 1000;
    let to = secs("to")?.unwrap_or(now + tf);
    let mut from = secs("from")?.unwrap_or(to - 300 * tf);
    if from >= to {
        return Err(ApiError::bad_request("from must be < to"));
    }
    from = from.max(to - 1000 * tf); // at most 1000 bars
    let c = client(&st).await?;
    ensure_token(&c, &mint).await?;
    let rows = c
        .query(
            "SELECT b,
                    trim_scale(round(o, 18))::text, trim_scale(round(h, 18))::text,
                    trim_scale(round(l, 18))::text, trim_scale(round(cl, 18))::text, v
             FROM (
               SELECT (floor(extract(epoch FROM ts) / $2::float8) * $2::float8)::bigint AS b,
                      (array_agg(p ORDER BY ts, id))[1] AS o, max(p) AS h, min(p) AS l,
                      (array_agg(p ORDER BY ts DESC, id DESC))[1] AS cl, sum(sol_amount)::bigint AS v
               FROM (SELECT id, ts, sol_amount,
                            (sol_amount::numeric / 1000000000) / (token_amount::numeric / power(10::numeric, decimals)) AS p
                     FROM trades
                     WHERE mint = $1 AND kind IN ('buy', 'sell') AND token_amount > 0
                       AND ts >= to_timestamp($3::float8) AND ts < to_timestamp($4::float8)) t
               GROUP BY b) x
             ORDER BY b",
            &[&mint, &(tf as f64), &(from as f64), &(to as f64)],
        )
        .await
        .map_err(db)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "time": r.get::<_, i64>(0),
                "open": r.get::<_, String>(1),
                "high": r.get::<_, String>(2),
                "low": r.get::<_, String>(3),
                "close": r.get::<_, String>(4),
                "volume": r.get::<_, i64>(5).to_string(),
            })
        })
        .collect();
    Ok(public(Value::Array(out), 5))
}

/// Poll `trades` for new rows every second and broadcast them to WS subscribers.
pub async fn poll_trades(st: AppState) {
    let mut last: Option<i64> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let res: ApiResult<()> = async {
            let c = client(&st).await?;
            let from = match last {
                Some(v) => v,
                None => {
                    let r = c
                        .query_one("SELECT COALESCE(max(id), 0) FROM trades", &[])
                        .await
                        .map_err(db)?;
                    let v: i64 = r.get(0);
                    last = Some(v);
                    v
                }
            };
            let rows = c
                .query(
                    &format!("SELECT {TRADE_COLS} FROM trades WHERE id > $1 ORDER BY id LIMIT 500"),
                    &[&from],
                )
                .await
                .map_err(db)?;
            for r in &rows {
                let j = trade_json(r);
                let msg = FeedMsg {
                    id: r.get(0),
                    mint: r.get(3),
                    json: j.to_string(),
                };
                last = Some(msg.id);
                let _ = st.feed_tx.send(Arc::new(msg));
            }
            Ok(())
        }
        .await;
        if let Err(e) = res {
            tracing::warn!(code = e.code, "feed poll failed");
        }
    }
}

pub async fn ws_feed(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let mint = match q.get("mint") {
        Some(m) => Some(solana_address(m, "mint")?),
        None => None,
    };
    let permit = st
        .ws_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::rate_limited(10))?;
    let rx = st.feed_tx.subscribe();
    Ok(ws.max_message_size(4 * 1024).on_upgrade(move |sock| async move {
        ws_loop(sock, rx, mint).await;
        drop(permit);
    }))
}

async fn ws_loop(mut sock: WebSocket, mut rx: tokio::sync::broadcast::Receiver<Arc<FeedMsg>>, mint: Option<String>) {
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Ok(m) => {
                    if mint.as_deref().is_some_and(|f| f != m.mint) {
                        continue;
                    }
                    if sock.send(Message::Text(m.json.clone().into())).await.is_err() {
                        return;
                    }
                }
                // Slow client: skip missed events (the page can refetch via REST).
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return,
            },
            incoming = sock.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {} // ignore client messages
            },
            _ = ping.tick() => {
                if sock.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
        }
    }
}

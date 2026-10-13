//! Token chat (API.md v0.12 «Чат», docs/analysis/chat.md; lead R1–R6, R8).
//!
//! - `chat` / `chat_delete` / `chat_hide` / `chat_report` / `noop` arrive as signed
//!   `POST /api/actions` with a body of EXACTLY 1024 bytes; answers and errors are padded to
//!   1024. Nothing goes to `actions`, holds or journals; the only per-key trace is the nonce row
//!   (≤ 120 s) for idempotent replay.
//! - Publication / removal / hide happen on the shared Delayed epoch boundaries
//!   ([`publisher_loop`]), random order inside a batch.
//! - Never logged: text, mint, nick, key, message id.

use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, RandomState};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use unzeen_ledger::{ChatPost, ChatQuery, ChatRequest, NonceCtx};
use unzeen_protocol::chat as pc;

use crate::{
    AppState,
    actions::solana_address,
    error::{ApiError, ApiResult},
    rate::apply_spread,
};

pub const BODY_BYTES: usize = 1024;
pub const REPORT_HIDE_THRESHOLD: i64 = 3;
pub const SLOW_MIN_SECS: f64 = 120.0;
pub const SLOW_MAX_SECS: f64 = 300.0;
const RATE_MIN_INTERVAL: Duration = Duration::from_secs(10);
const RATE_PER_HOUR: usize = 20;
const RATE_PER_DAY: usize = 100;

pub const OPS: [&str; 5] = ["chat", "chat_delete", "chat_hide", "chat_report", "noop"];

pub fn is_chat_op(raw: &Value) -> bool {
    raw.get("op").and_then(Value::as_str).is_some_and(|o| OPS.contains(&o))
}

/// `PoolInfo.chat` (only with `features.chat`).
pub fn pool_block(st: &AppState) -> Value {
    json!({
        "minAccountZat": st.cfg.chat.min_account_zat.to_string(),
        "maxChars": pc::MAX_CHARS,
        "maxJsonBytes": pc::MAX_JSON_BYTES,
        "bodyBytes": BODY_BYTES,
        "rate": { "minIntervalSecs": RATE_MIN_INTERVAL.as_secs(), "perHour": RATE_PER_HOUR, "perDay": RATE_PER_DAY },
        "reportHideThreshold": REPORT_HIDE_THRESHOLD,
        "slowDelaySecs": { "min": SLOW_MIN_SECS as u64, "max": SLOW_MAX_SECS as u64 },
        "retentionDays": unzeen_ledger::chat::RETENTION_DAYS,
    })
}

/// Per-key chat limits (all chat_* ops together): 1 / 10 s, 20 / h, 100 / day. In memory, keys
/// hashed with a per-process random key, nothing persisted.
pub struct ChatLimiter {
    hasher: RandomState,
    map: Mutex<HashMap<u64, VecDeque<Instant>>>,
}

impl Default for ChatLimiter {
    fn default() -> Self {
        Self {
            hasher: RandomState::new(),
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl ChatLimiter {
    /// `Err(retry_after_secs)`.
    pub fn check(&self, pk: &[u8; 32]) -> Result<(), u64> {
        self.check_at(pk, Instant::now())
    }

    pub fn check_at(&self, pk: &[u8; 32], now: Instant) -> Result<(), u64> {
        const DAY: Duration = Duration::from_secs(86_400);
        let h = self.hasher.hash_one(pk);
        let mut m = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if m.len() > 100_000 {
            m.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < DAY));
        }
        let q = m.entry(h).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= DAY) {
            q.pop_front();
        }
        if let Some(last) = q.back() {
            let since = now.duration_since(*last);
            if since < RATE_MIN_INTERVAL {
                return Err((RATE_MIN_INTERVAL - since).as_secs().max(1));
            }
        }
        let hour = q
            .iter()
            .filter(|t| now.duration_since(**t) < Duration::from_secs(3600))
            .count();
        if hour >= RATE_PER_HOUR {
            return Err(600);
        }
        if q.len() >= RATE_PER_DAY {
            return Err(3600);
        }
        q.push_back(now);
        Ok(())
    }
}

fn padded_response(status: StatusCode, mut v: Value) -> Response {
    let len = serde_json::to_vec(&v).map_or(0, |b| b.len());
    let total = (len + 9).div_ceil(BODY_BYTES).max(1) * BODY_BYTES;
    v["pad"] = json!(" ".repeat(total - len - 9));
    let mut r = (status, Json(v)).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// Errors of chat ops are padded like successes (chat.md §4.1: refusal and success have the
/// same size on the wire).
fn padded_error(e: ApiError) -> Response {
    let mut body = json!({ "error": { "code": e.code, "message": e.message } });
    if let Some(d) = e.details {
        body["error"]["details"] = json!(d);
    }
    let mut r = padded_response(e.status, body);
    if let Some(s) = e.retry_after {
        r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(s));
    }
    r
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum ChatOp {
    Chat {
        mint: String,
        text: String,
        #[serde(rename = "showCreatorBadge", default)]
        show_creator_badge: bool,
        #[serde(default)]
        slow: bool,
    },
    ChatDelete {
        id: String,
    },
    ChatHide {
        id: String,
    },
    ChatReport {
        id: String,
        reason: ReportReason,
    },
    Noop {},
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReportReason {
    Spam,
    Scam,
    Abuse,
}

fn msg_id(s: &str) -> ApiResult<[u8; 16]> {
    (s.len() == 32 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
        .then(|| hex::decode(s).ok())
        .flatten()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(ApiError::not_found)
}

fn mint_bytes(mint: &str) -> ApiResult<[u8; 32]> {
    bs58::decode(mint)
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("mint: not a Solana address"))
}

fn not_creator() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "not_creator", "not the creator of this mint")
}

/// R5: account value ≥ threshold, else 403 without amounts. Also 423 for frozen balances.
async fn admit(st: &AppState, pk: &[u8; 32]) -> ApiResult<()> {
    let sell = match st.rate.get().await {
        Ok(r) => {
            let spread = if r.stale {
                st.cfg.rate.spread_bps.saturating_mul(2)
            } else {
                st.cfg.rate.spread_bps
            };
            Some(apply_spread(r.lamports_per_zec, spread, false))
        }
        Err(_) => None,
    };
    let (value, frozen) = st.ledger.chat_account_value(pk, sell).await?;
    if frozen {
        return Err(unzeen_ledger::LedgerError::Frozen.into());
    }
    if value < st.cfg.chat.min_account_zat {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "chat_not_eligible",
            "account below PoolInfo.chat.minAccountZat",
        ));
    }
    Ok(())
}

async fn frozen_check(st: &AppState, pk: &[u8; 32]) -> ApiResult<()> {
    if st.ledger.balance(pk).await?.is_some_and(|b| b.frozen) {
        return Err(unzeen_ledger::LedgerError::Frozen.into());
    }
    Ok(())
}

/// `POST /api/actions` with a chat / noop op. Always a 1024-padded answer.
pub async fn submit(st: &AppState, raw: Value, body_len: usize, n: NonceCtx) -> Response {
    match submit_inner(st, raw, body_len, n).await {
        Ok(v) => padded_response(StatusCode::OK, v),
        Err(e) => padded_error(e),
    }
}

pub(crate) async fn submit_inner(st: &AppState, raw: Value, body_len: usize, n: NonceCtx) -> ApiResult<Value> {
    let is_noop = raw.get("op").and_then(Value::as_str) == Some("noop");
    let enabled = if is_noop { st.cfg.chat.noop } else { st.cfg.chat.enabled };
    if !enabled {
        // Flag off: exactly what an unknown op gets.
        return Err(ApiError::bad_request("invalid action body"));
    }
    if body_len != BODY_BYTES {
        return Err(ApiError::bad_request("chat bodies are exactly 1024 bytes"));
    }
    let op: ChatOp = serde_json::from_value(raw).map_err(|_| ApiError::bad_request("invalid action body"))?;
    if let Some(v) = st.ledger.chat_replay(&n).await? {
        return Ok(v);
    }
    let pk = n.pk;
    if let ChatOp::Noop {} = op {
        return Ok(st.ledger.noop(&n).await?);
    }
    let key = st.cfg.chat.key.as_ref().ok_or_else(ApiError::internal)?.0;
    let chain = st.cfg.policy.chain;
    match op {
        ChatOp::Chat {
            mint,
            text,
            show_creator_badge,
            slow,
        } => {
            let mint = solana_address(&mint, "mint")?;
            let mb = mint_bytes(&mint)?;
            if !st.ledger.chat_mint_listed(&mint).await? {
                return Err(ApiError::not_found());
            }
            if let Err(p) = pc::check_text(&text) {
                return Err(ApiError {
                    details: Some(p.code()),
                    ..ApiError::new(StatusCode::BAD_REQUEST, "chat_text_invalid", "text rejected")
                });
            }
            admit(st, &pk).await?;
            if show_creator_badge && !st.ledger.chat_is_creator(&pk, &mint).await? {
                return Err(not_creator());
            }
            st.chat_limit.check(&pk).map_err(ApiError::rate_limited)?;
            let delay = if slow {
                SLOW_MIN_SECS
                    + (SLOW_MAX_SECS - SLOW_MIN_SECS) * ((rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64)
            } else {
                0.0
            };
            let post = ChatPost {
                nick: pc::nick(&key, chain, &mb, &pk, show_creator_badge),
                mint,
                is_creator: show_creator_badge,
                text,
                delay_secs: delay,
            };
            Ok(st.ledger.chat_post(&n, &post).await?)
        }
        ChatOp::ChatDelete { id } => {
            let id = msg_id(&id)?;
            frozen_check(st, &pk).await?;
            let m = st
                .ledger
                .chat_message_meta(&id)
                .await?
                .ok_or_else(ApiError::not_found)?;
            let mb = mint_bytes(&m.mint)?;
            if pc::nick(&key, chain, &mb, &pk, m.is_creator) != m.nick {
                // Not the author: indistinguishable from an unknown id.
                return Err(ApiError::not_found());
            }
            st.chat_limit.check(&pk).map_err(ApiError::rate_limited)?;
            Ok(st.ledger.chat_request(&n, &id, ChatRequest::Delete).await?)
        }
        ChatOp::ChatHide { id } => {
            let id = msg_id(&id)?;
            frozen_check(st, &pk).await?;
            let m = st
                .ledger
                .chat_message_meta(&id)
                .await?
                .ok_or_else(ApiError::not_found)?;
            if !st.ledger.chat_is_creator(&pk, &m.mint).await? {
                return Err(not_creator());
            }
            st.chat_limit.check(&pk).map_err(ApiError::rate_limited)?;
            Ok(st.ledger.chat_request(&n, &id, ChatRequest::Hide).await?)
        }
        ChatOp::ChatReport { id, reason } => {
            let _ = matches!(reason, ReportReason::Spam | ReportReason::Scam | ReportReason::Abuse);
            let id = msg_id(&id)?;
            admit(st, &pk).await?;
            let m = st
                .ledger
                .chat_message_meta(&id)
                .await?
                .ok_or_else(ApiError::not_found)?;
            let mb = mint_bytes(&m.mint)?;
            let own =
                pc::nick(&key, chain, &mb, &pk, false) == m.nick || pc::nick(&key, chain, &mb, &pk, true) == m.nick;
            st.chat_limit.check(&pk).map_err(ApiError::rate_limited)?;
            let tag = pc::report_tag(&key, &id, &pk);
            Ok(st.ledger.chat_report(&n, &id, &tag, own, REPORT_HIDE_THRESHOLD).await?)
        }
        ChatOp::Noop {} => unreachable!("handled above"),
    }
}

fn cursor(q: &HashMap<String, String>, k: &str) -> ApiResult<Option<i64>> {
    match q.get(k) {
        None => Ok(None),
        Some(s) if !s.is_empty() && s.len() <= 19 && s.bytes().all(|c| c.is_ascii_digit()) => s
            .parse::<i64>()
            .map(Some)
            .map_err(|_| ApiError::bad_request("cursor: decimal string")),
        Some(_) => Err(ApiError::bad_request("cursor: decimal string")),
    }
}

/// `GET /api/tokens/:mint/chat` — public, the same for everyone, padded to 4096.
pub async fn page(
    State(st): State<AppState>,
    Path(mint): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    if !st.cfg.chat.enabled {
        return Err(ApiError::not_found());
    }
    let mint = solana_address(&mint, "mint")?;
    let limit = match q.get("limit") {
        None => 50,
        Some(s) => s
            .parse::<i64>()
            .ok()
            .filter(|v| (1..=100).contains(v))
            .ok_or_else(|| ApiError::bad_request("limit: 1..100"))?,
    };
    let (after, before) = (cursor(&q, "after")?, cursor(&q, "before")?);
    let query = match (after, before) {
        (Some(_), Some(_)) => return Err(ApiError::bad_request("after and before are exclusive")),
        (Some(seq), None) => ChatQuery::After { seq },
        (None, Some(seq)) => ChatQuery::Before { seq, limit },
        (None, None) => ChatQuery::Latest { limit },
    };
    let body = if st.ledger.chat_mint_listed(&mint).await? {
        let (messages, removed, cursor, more) = st.ledger.chat_page(&mint, query).await?;
        json!({ "messages": messages, "removed": removed, "cursor": cursor.to_string(), "more": more })
    } else {
        json!({ "messages": [], "removed": [], "cursor": "0", "more": false })
    };
    Ok(public_padded(body))
}

fn public_padded(mut v: Value) -> Response {
    let len = serde_json::to_vec(&v).map_or(0, |b| b.len());
    let total = (len + 9).div_ceil(4096).max(1) * 4096;
    v["pad"] = json!(" ".repeat(total - len - 9));
    let mut r = Json(v).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=5"));
    r
}

/// Publication on the SAME boundaries as Delayed trades (R3): sleep until the next boundary of
/// the shared schedule, publish, repeat.
pub async fn publisher_loop(st: AppState) {
    loop {
        let wait = st.epochs.delay(false);
        tokio::time::sleep(Duration::from_secs_f64(wait.max(0.05))).await;
        if let Err(e) = st.ledger.chat_publish().await {
            tracing::warn!(error = %e, "chat publication failed");
        }
    }
}

/// Hourly retention (tombstones 24 h, messages 30 days / 1000 per mint, reports 7 days).
pub async fn janitor_loop(st: AppState) {
    let mut every = tokio::time::interval(Duration::from_secs(3600));
    loop {
        every.tick().await;
        if let Err(e) = st.ledger.chat_janitor().await {
            tracing::warn!(error = %e, "chat janitor failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_windows() {
        let l = ChatLimiter::default();
        let pk = [1u8; 32];
        let t0 = Instant::now();
        assert!(l.check_at(&pk, t0).is_ok());
        assert!(l.check_at(&pk, t0 + Duration::from_secs(5)).is_err(), "10 s spacing");
        for i in 1..20 {
            assert!(l.check_at(&pk, t0 + Duration::from_secs(10 * i)).is_ok());
        }
        assert_eq!(l.check_at(&pk, t0 + Duration::from_secs(200)), Err(600), "20 per hour");
        assert!(l.check_at(&[2u8; 32], t0).is_ok(), "per key");
    }
}

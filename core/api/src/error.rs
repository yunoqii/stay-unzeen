//! `ApiError` → `{ "error": { "code", "message" } }` (docs/API.md, «Ошибки»).

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;
use unzeen_ledger::LedgerError;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
    /// `error.details` (API.md «Ошибки»): a stable machine code, never user data.
    pub details: Option<&'static str>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after: None,
            details: None,
        }
    }

    pub fn bad_request(m: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", m)
    }
    pub fn unauthorized(m: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", m)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "not found")
    }
    pub fn replay() -> Self {
        Self::new(StatusCode::CONFLICT, "replay", "nonce already used")
    }
    pub fn graduated() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "graduated",
            "token left the bonding curve of this venue",
        )
    }
    pub fn below_minimum(m: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "below_minimum", m)
    }
    pub fn venue_unavailable(m: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "venue_unavailable", m)
    }
    pub fn feature_disabled(m: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "feature_disabled", m)
    }
    pub fn creator_cap() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "creator_cap",
            "creator position through the pool would exceed PoolInfo.launchRules.capBps",
        )
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
    }
    pub fn rate_limited(retry_after: u64) -> Self {
        Self {
            retry_after: Some(retry_after.max(1)),
            ..Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "too many requests")
        }
    }
}

impl From<LedgerError> for ApiError {
    fn from(e: LedgerError) -> Self {
        match e {
            LedgerError::InsufficientBalance => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "insufficient_balance",
                "insufficient balance",
            ),
            LedgerError::BelowMinimum => Self::below_minimum("amount below PoolInfo.minActionZat"),
            LedgerError::Frozen => Self::new(StatusCode::LOCKED, "balance_frozen", "balance frozen pending review"),
            LedgerError::Replay => Self::replay(),
            LedgerError::Range => Self::bad_request("amount out of range"),
            LedgerError::NotFound => Self::not_found(),
            LedgerError::CreatorLocked => Self::new(
                StatusCode::LOCKED,
                "creator_locked",
                "the creator's initial-buy tokens are locked (PoolInfo.launchRules.lockSecs)",
            ),
            LedgerError::CreatorCap => Self::creator_cap(),
            LedgerError::LaunchClosed => Self::new(
                StatusCode::CONFLICT,
                "launch_closed",
                "the bid window of this launch is closed",
            ),
            LedgerError::OrderLimit => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "order_limit",
                "too many open orders (PoolInfo.orders.maxOpenPerKey / maxOpenPerMint)",
            ),
            LedgerError::LaunchFull => Self::new(
                StatusCode::CONFLICT,
                "launch_full",
                "this launch has reached its bid cap",
            ),
            LedgerError::OrderNotOpen => Self::new(StatusCode::CONFLICT, "order_not_open", "the order is not open"),
            LedgerError::OrdersFull => Self::venue_unavailable("orders are not available right now"),
            LedgerError::ChatMuted => Self::new(StatusCode::FORBIDDEN, "chat_muted", "muted in this chat"),
            LedgerError::ChatFull => Self::rate_limited(30),
            LedgerError::AlreadyBid => Self::new(
                StatusCode::CONFLICT,
                "already_bid",
                "this key already has a sealed bid on this launch (fl_cancel first)",
            ),
            LedgerError::Db(_) | LedgerError::Pool(_) => {
                // Display of LedgerError carries only SQLSTATE / a coarse kind (N3).
                tracing::error!(error = %e, "ledger failure");
                Self::internal()
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": { "code": self.code, "message": self.message } });
        if let Some(d) = self.details {
            body["error"]["details"] = json!(d);
        }
        let mut res = (self.status, Json(body)).into_response();
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(s) = self.retry_after {
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(s));
        }
        res
    }
}

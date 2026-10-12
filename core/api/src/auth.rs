//! Signed requests (docs/API.md, «Подпись запросов anon-ключом»).
//!
//! The signature covers the RAW request-target as received (`uri.path_and_query()` of the
//! request line, before any routing), the raw body bytes (which are exactly the bytes that
//! get parsed afterwards) and the network `chain_id`.

use axum::http::{HeaderMap, Method, Uri};
use unzeen_protocol::api_auth::{self, AuthError, Authenticated, H_NONCE, H_PUBKEY, H_SIG, H_TS, SignedHeaders};

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    rate::now_ms,
};

fn one_header(h: &HeaderMap, name: &'static str) -> ApiResult<String> {
    let mut it = h.get_all(name).iter();
    let v = it
        .next()
        .ok_or_else(|| ApiError::unauthorized(format!("missing {name} header")))?;
    if it.next().is_some() {
        return Err(ApiError::unauthorized(format!("duplicate {name} header")));
    }
    v.to_str()
        .map(str::to_owned)
        .map_err(|_| ApiError::unauthorized(format!("malformed {name} header")))
}

/// Raw request-target (`/path?query`) exactly as sent.
pub fn request_target(uri: &Uri) -> &str {
    uri.path_and_query().map_or_else(|| uri.path(), |pq| pq.as_str())
}

/// Verify a signed request. For signed GETs (`consume_nonce = true`) the nonce is consumed
/// here; `POST /api/actions` consumes it inside the ledger transaction instead.
pub async fn verify(
    st: &AppState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
    consume_nonce: bool,
) -> ApiResult<Authenticated> {
    let sh = SignedHeaders {
        pubkey: one_header(headers, H_PUBKEY)?,
        nonce: one_header(headers, H_NONCE)?,
        ts: one_header(headers, H_TS)?,
        sig: one_header(headers, H_SIG)?,
    };
    let a = api_auth::verify_request(
        st.cfg.policy.chain,
        &sh,
        method.as_str(),
        request_target(uri),
        body,
        now_ms(),
    )
    .map_err(|e| match e {
        AuthError::Header(h) => ApiError::unauthorized(format!("malformed {h} header")),
        AuthError::Stale => ApiError::unauthorized("timestamp outside the 60 s window"),
        AuthError::BadSignature => ApiError::unauthorized("signature does not verify"),
    })?;
    st.key_limit.check(&a.pubkey).map_err(ApiError::rate_limited)?;
    if consume_nonce && !st.ledger.use_api_nonce(&a.pubkey, &a.nonce, a.ts_ms).await? {
        return Err(ApiError::replay());
    }
    Ok(a)
}

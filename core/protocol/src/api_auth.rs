//! Signed HTTP requests (docs/API.md, "Подпись запросов anon-ключом").
//!
//! Signed message (UTF-8, `\n`-separated, no trailing newline):
//! ```text
//! unzeen/api/v1
//! <chain_id hex>      (2 bytes as 4 lowercase hex chars, e.g. "0202"; binds the request to one network)
//! <METHOD>
//! <path?query>
//! <hex(sha256(body))>
//! <nonce>
//! <ts>
//! ```
//! This module checks format, signature and the timestamp window. Replay protection
//! (`(pubkey, nonce)` remembered for [`NONCE_TTL_MS`]) is the server's job (ledger table
//! `api_nonces`).

use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::ChainId;

pub const DOMAIN: &str = "unzeen/api/v1";
pub const H_PUBKEY: &str = "x-unzeen-pubkey";
pub const H_NONCE: &str = "x-unzeen-nonce";
pub const H_TS: &str = "x-unzeen-ts";
pub const H_SIG: &str = "x-unzeen-sig";
/// Allowed |now - ts|.
pub const TS_WINDOW_MS: u64 = 60_000;
/// How long a used nonce must be remembered (> 2 * window).
pub const NONCE_TTL_MS: u64 = 120_000;

/// Raw header values as received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedHeaders {
    pub pubkey: String,
    pub nonce: String,
    pub ts: String,
    pub sig: String,
}

/// Successfully authenticated request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authenticated {
    pub pubkey: [u8; 32],
    pub nonce: [u8; 16],
    pub ts_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("malformed {0} header")]
    Header(&'static str),
    #[error("timestamp outside the allowed window")]
    Stale,
    #[error("signature does not verify")]
    BadSignature,
}

pub fn body_hash_hex(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

/// The exact string that gets signed. `method` is upper-cased; `path_query` is used
/// verbatim as sent on the wire (path plus `?query` if any). `chain` is the network of the
/// API instance (same bytes as the memo `chain_id`), so a request signed for devnet is
/// rejected by the mainnet API and vice versa.
pub fn signing_message(
    chain: ChainId,
    method: &str,
    path_query: &str,
    body: &[u8],
    nonce_hex: &str,
    ts_ms: u64,
) -> String {
    format!(
        "{DOMAIN}\n{}\n{}\n{path_query}\n{}\n{nonce_hex}\n{ts_ms}",
        hex::encode(chain.to_bytes()),
        method.to_ascii_uppercase(),
        body_hash_hex(body)
    )
}

/// Client side (used for tests / vectors and by dev tools).
pub fn sign_request(
    chain: ChainId,
    sk: &SigningKey,
    method: &str,
    path_query: &str,
    body: &[u8],
    nonce: [u8; 16],
    ts_ms: u64,
) -> SignedHeaders {
    let nonce_hex = hex::encode(nonce);
    let msg = signing_message(chain, method, path_query, body, &nonce_hex, ts_ms);
    SignedHeaders {
        pubkey: bs58::encode(sk.verifying_key().to_bytes()).into_string(),
        nonce: nonce_hex,
        ts: ts_ms.to_string(),
        sig: bs58::encode(sk.sign(msg.as_bytes()).to_bytes()).into_string(),
    }
}

/// Server side. Header formats are strict so a request has exactly one signed form:
/// nonce = 32 lowercase hex chars, ts = canonical decimal (no sign, no leading zeros).
pub fn verify_request(
    chain: ChainId,
    h: &SignedHeaders,
    method: &str,
    path_query: &str,
    body: &[u8],
    now_ms: u64,
) -> Result<Authenticated, AuthError> {
    let pubkey: [u8; 32] = crate::pubkey_from_b58(&h.pubkey).ok_or(AuthError::Header(H_PUBKEY))?;

    if h.nonce.len() != 32 || !h.nonce.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(AuthError::Header(H_NONCE));
    }
    let nonce: [u8; 16] = hex::decode(&h.nonce)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(AuthError::Header(H_NONCE))?;

    let ts_ms: u64 = h.ts.parse().map_err(|_| AuthError::Header(H_TS))?;
    if ts_ms.to_string() != h.ts {
        return Err(AuthError::Header(H_TS));
    }
    if now_ms.abs_diff(ts_ms) > TS_WINDOW_MS {
        return Err(AuthError::Stale);
    }

    let sig: [u8; 64] = bs58::decode(&h.sig)
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(AuthError::Header(H_SIG))?;
    let vk = VerifyingKey::from_bytes(&pubkey).map_err(|_| AuthError::Header(H_PUBKEY))?;
    let msg = signing_message(chain, method, path_query, body, &h.nonce, ts_ms);
    vk.verify_strict(msg.as_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| AuthError::BadSignature)?;
    Ok(Authenticated { pubkey, nonce, ts_ms })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SolanaCluster, ZcashNet};

    const C: ChainId = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
    const M: ChainId = ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta);

    const NOW: u64 = 1_760_000_000_000;

    fn signed() -> SignedHeaders {
        let sk = SigningKey::from_bytes(&[5u8; 32]);
        sign_request(C, &sk, "post", "/api/actions", br#"{"op":"claim"}"#, [0xab; 16], NOW)
    }

    #[test]
    fn roundtrip() {
        let h = signed();
        let a = verify_request(C, &h, "POST", "/api/actions", br#"{"op":"claim"}"#, NOW + 59_000).unwrap();
        assert_eq!(a.nonce, [0xab; 16]);
        assert_eq!(a.ts_ms, NOW);
    }

    #[test]
    fn other_network_rejected() {
        let h = signed();
        assert_eq!(
            verify_request(M, &h, "POST", "/api/actions", br#"{"op":"claim"}"#, NOW),
            Err(AuthError::BadSignature)
        );
        assert!(signing_message(C, "get", "/x", b"", "n", 1).starts_with("unzeen/api/v1\n0202\nGET\n"));
    }

    #[test]
    fn empty_body_hash() {
        assert_eq!(
            body_hash_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn tampering_fails() {
        let h = signed();
        let body = br#"{"op":"claim"}"#;
        assert_eq!(
            verify_request(C, &h, "GET", "/api/actions", body, NOW),
            Err(AuthError::BadSignature)
        );
        assert_eq!(
            verify_request(C, &h, "POST", "/api/actions?x=1", body, NOW),
            Err(AuthError::BadSignature)
        );
        assert_eq!(
            verify_request(C, &h, "POST", "/api/actions", b"{}", NOW),
            Err(AuthError::BadSignature)
        );
        let mut h2 = h.clone();
        h2.ts = (NOW + 1).to_string();
        assert_eq!(
            verify_request(C, &h2, "POST", "/api/actions", body, NOW),
            Err(AuthError::BadSignature)
        );
    }

    #[test]
    fn window_and_formats() {
        let h = signed();
        let body = br#"{"op":"claim"}"#;
        assert_eq!(
            verify_request(C, &h, "POST", "/api/actions", body, NOW + 60_001),
            Err(AuthError::Stale)
        );
        assert_eq!(
            verify_request(C, &h, "POST", "/api/actions", body, NOW - 60_001),
            Err(AuthError::Stale)
        );
        let mut u = h.clone();
        u.nonce = u.nonce.to_uppercase();
        assert_eq!(
            verify_request(C, &u, "POST", "/api/actions", body, NOW),
            Err(AuthError::Header(H_NONCE))
        );
        let mut z = h.clone();
        z.ts = format!("0{}", h.ts);
        assert_eq!(
            verify_request(C, &z, "POST", "/api/actions", body, NOW),
            Err(AuthError::Header(H_TS))
        );
        let mut p = h;
        p.pubkey = "abc".into();
        assert_eq!(
            verify_request(C, &p, "POST", "/api/actions", body, NOW),
            Err(AuthError::Header(H_PUBKEY))
        );
    }
}

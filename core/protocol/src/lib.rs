//! Unzeen wire formats shared by the scanner, the ledger and the API server.
//!
//! - [`memo`]: the binary `unz1` memo carried in shielded ZEC deposits (docs/API.md,
//!   "Формат memo `unz1`").
//! - [`api_auth`]: ed25519-signed HTTP requests (`x-unzeen-*` headers).
//! - [`anon_key`]: anon-key derivation (BIP-39 seed → SLIP-0010, one key per network).
//!
//! Test vectors for both formats live in `core/testdata/unz1-vectors.json`; the web
//! client checks its implementation against the same file.

pub mod anon_key;
pub mod api_auth;
pub mod chat;
pub mod memo;
pub mod verify;

pub use ed25519_dalek::{SigningKey, VerifyingKey};

/// Network binding mixed into every memo signature (2 bytes, never transmitted).
///
/// Byte 0: Zcash network (1 mainnet, 2 testnet). Byte 1: Solana cluster (1 mainnet-beta,
/// 2 devnet). A memo signed for testnet cannot be replayed on mainnet and vice versa.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ChainId {
    pub zcash: ZcashNet,
    pub solana: SolanaCluster,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ZcashNet {
    Mainnet = 1,
    Testnet = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SolanaCluster {
    MainnetBeta = 1,
    Devnet = 2,
}

impl ChainId {
    pub const fn new(zcash: ZcashNet, solana: SolanaCluster) -> Self {
        Self { zcash, solana }
    }

    pub const fn to_bytes(self) -> [u8; 2] {
        [self.zcash as u8, self.solana as u8]
    }

    /// Lowercase hex of [`Self::to_bytes`], e.g. `"0202"` (PoolInfo.chainId).
    pub fn to_hex(self) -> String {
        hex::encode(self.to_bytes())
    }
}

impl std::str::FromStr for SolanaCluster {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "mainnet" | "mainnet-beta" => Ok(Self::MainnetBeta),
            "devnet" => Ok(Self::Devnet),
            other => Err(format!(
                "unknown Solana cluster {other:?} (expected devnet | mainnet-beta)"
            )),
        }
    }
}

/// Parse a 32-byte ed25519 public key from base58 (the API's text form).
pub fn pubkey_from_b58(s: &str) -> Option<[u8; 32]> {
    let v = bs58::decode(s).into_vec().ok()?;
    v.try_into().ok()
}

pub fn pubkey_to_b58(pk: &[u8; 32]) -> String {
    bs58::encode(pk).into_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_id_bytes() {
        assert_eq!(
            ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet).to_bytes(),
            [2, 2]
        );
        assert_eq!(
            ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta).to_bytes(),
            [1, 1]
        );
    }

    #[test]
    fn b58_roundtrip() {
        let pk = [9u8; 32];
        assert_eq!(pubkey_from_b58(&pubkey_to_b58(&pk)), Some(pk));
        assert_eq!(pubkey_from_b58("1111"), None);
        assert_eq!(pubkey_from_b58("0OIl"), None);
    }
}

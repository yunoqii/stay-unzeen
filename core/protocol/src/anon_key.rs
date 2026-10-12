//! anon-key derivation (docs/API.md, "Подпись запросов anon-ключом").
//!
//! BIP-39 seed (64 bytes, empty passphrase) → SLIP-0010 ed25519, path
//! `m/44'/133'/<net>'/0'`, where `<net>` = 0 for mainnet and 1 for devnet/testnet.
//! One phrase therefore yields a different anon identity per network.
//!
//! The web client derives keys; core implements the same function for test vectors and
//! dev tools only.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha512;

use crate::{ChainId, SigningKey, SolanaCluster, ZcashNet};

const HARDENED: u32 = 0x8000_0000;

/// Network index in the path: 0 = mainnet (Zcash mainnet + Solana mainnet-beta),
/// 1 = everything else (testnet / devnet).
pub fn network_index(chain: ChainId) -> u32 {
    if chain.zcash == ZcashNet::Mainnet && chain.solana == SolanaCluster::MainnetBeta {
        0
    } else {
        1
    }
}

/// Path segments (all hardened) for `chain`.
pub fn path(chain: ChainId) -> [u32; 4] {
    [44, 133, network_index(chain), 0]
}

pub fn path_string(chain: ChainId) -> String {
    let p = path(chain);
    format!("m/{}'/{}'/{}'/{}'", p[0], p[1], p[2], p[3])
}

fn hmac512(key: &[u8], parts: &[&[u8]]) -> [u8; 64] {
    let mut m = <Hmac<Sha512> as KeyInit>::new_from_slice(key).expect("any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// SLIP-0010 ed25519 master key + hardened derivation along `path` (indices < 2^31).
pub fn slip10_ed25519(seed: &[u8], path: &[u32]) -> [u8; 32] {
    let i = hmac512(b"ed25519 seed", &[seed]);
    let (mut k, mut c) = (
        <[u8; 32]>::try_from(&i[..32]).unwrap(),
        <[u8; 32]>::try_from(&i[32..]).unwrap(),
    );
    for idx in path {
        let ser = (idx | HARDENED).to_be_bytes();
        let i = hmac512(&c, &[&[0u8], &k, &ser]);
        k.copy_from_slice(&i[..32]);
        c.copy_from_slice(&i[32..]);
    }
    k
}

/// The anon signing key of `seed` (BIP-39 seed bytes) for the network `chain`.
pub fn derive(seed: &[u8], chain: ChainId) -> SigningKey {
    SigningKey::from_bytes(&slip10_ed25519(seed, &path(chain)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SLIP-0010 official test vector 1 for ed25519 (seed 000102…0f).
    #[test]
    fn slip10_official_vector() {
        let seed = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap();
        assert_eq!(
            hex::encode(slip10_ed25519(&seed, &[])),
            "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7"
        );
        assert_eq!(
            hex::encode(slip10_ed25519(&seed, &[0, 1, 2, 2, 1_000_000_000])),
            "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793"
        );
    }

    #[test]
    fn networks_differ() {
        let seed = [7u8; 64];
        let m = ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta);
        let t = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
        assert_eq!(path_string(m), "m/44'/133'/0'/0'");
        assert_eq!(path_string(t), "m/44'/133'/1'/0'");
        assert_ne!(derive(&seed, m).to_bytes(), derive(&seed, t).to_bytes());
    }
}

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
pub mod evm;
pub mod memo;
pub mod verify;

pub use ed25519_dalek::{SigningKey, VerifyingKey};

/// Network binding mixed into every memo / HTTP / chat / Verify signature (2 bytes, never
/// transmitted).
///
/// Byte 0: Zcash network (1 mainnet, 2 testnet). Byte 1: the trading chain and its network —
/// high nibble = chain (0 Solana, 1 Robinhood Chain), low nibble = network (1 mainnet,
/// 2 test): `01` Solana mainnet-beta, `02` devnet, `11` Robinhood Chain mainnet (EVM chain id
/// 4663), `12` Robinhood Chain testnet (46630). Only matching pairs exist: `0101`, `0202`,
/// `0111`, `0212` (API v0.18). A signature for one pair is invalid for every other.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ChainId {
    pub zcash: ZcashNet,
    pub trade: TradeNet,
}

/// Robinhood Chain (Arbitrum Orbit L2) network, v0.18 (`hood`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HoodNet {
    /// EVM chain id 4663.
    Mainnet = 0x11,
    /// EVM chain id 46630.
    Testnet = 0x12,
}

impl HoodNet {
    pub const fn evm_chain_id(self) -> u64 {
        match self {
            HoodNet::Mainnet => 4663,
            HoodNet::Testnet => 46630,
        }
    }
}

/// The chain the pool trades on (byte 1 of [`ChainId`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TradeNet {
    Solana(SolanaCluster),
    Hood(HoodNet),
}

impl TradeNet {
    pub const fn byte(self) -> u8 {
        match self {
            TradeNet::Solana(c) => c as u8,
            TradeNet::Hood(h) => h as u8,
        }
    }

    pub const fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x01 => Some(TradeNet::Solana(SolanaCluster::MainnetBeta)),
            0x02 => Some(TradeNet::Solana(SolanaCluster::Devnet)),
            0x11 => Some(TradeNet::Hood(HoodNet::Mainnet)),
            0x12 => Some(TradeNet::Hood(HoodNet::Testnet)),
            _ => None,
        }
    }

    pub const fn is_mainnet(self) -> bool {
        matches!(
            self,
            TradeNet::Solana(SolanaCluster::MainnetBeta) | TradeNet::Hood(HoodNet::Mainnet)
        )
    }

    /// `PoolInfo.chain.id`: `"solana"` | `"hood"`.
    pub const fn chain(self) -> &'static str {
        match self {
            TradeNet::Solana(_) => "solana",
            TradeNet::Hood(_) => "hood",
        }
    }

    /// DB `network` value / `PoolInfo.chain.network`: `mainnet-beta` | `devnet` | `hood` |
    /// `hood-testnet` (migration 0026).
    pub const fn network(self) -> &'static str {
        match self {
            TradeNet::Solana(SolanaCluster::MainnetBeta) => "mainnet-beta",
            TradeNet::Solana(SolanaCluster::Devnet) => "devnet",
            TradeNet::Hood(HoodNet::Mainnet) => "hood",
            TradeNet::Hood(HoodNet::Testnet) => "hood-testnet",
        }
    }
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
    /// Solana pair (`0101` / `0202`).
    pub const fn new(zcash: ZcashNet, solana: SolanaCluster) -> Self {
        Self {
            zcash,
            trade: TradeNet::Solana(solana),
        }
    }

    /// Robinhood Chain pair (`0111` / `0212`), v0.18.
    pub const fn hood(zcash: ZcashNet, hood: HoodNet) -> Self {
        Self {
            zcash,
            trade: TradeNet::Hood(hood),
        }
    }

    /// The Solana cluster, if this pool trades on Solana.
    pub const fn solana(self) -> Option<SolanaCluster> {
        match self.trade {
            TradeNet::Solana(c) => Some(c),
            TradeNet::Hood(_) => None,
        }
    }

    pub const fn to_bytes(self) -> [u8; 2] {
        [self.zcash as u8, self.trade.byte()]
    }

    /// Only the four valid pairs (mainnet with mainnet, test with test).
    pub const fn from_bytes(b: [u8; 2]) -> Option<Self> {
        let zcash = match b[0] {
            1 => ZcashNet::Mainnet,
            2 => ZcashNet::Testnet,
            _ => return None,
        };
        let Some(trade) = TradeNet::from_byte(b[1]) else {
            return None;
        };
        if trade.is_mainnet() != matches!(zcash, ZcashNet::Mainnet) {
            return None;
        }
        Some(Self { zcash, trade })
    }

    pub fn from_hex(s: &str) -> Option<Self> {
        let v = hex::decode(s).ok()?;
        Self::from_bytes(v.try_into().ok()?)
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
        // v0.18 Robinhood Chain.
        let hm = ChainId::hood(ZcashNet::Mainnet, HoodNet::Mainnet);
        let ht = ChainId::hood(ZcashNet::Testnet, HoodNet::Testnet);
        assert_eq!(hm.to_hex(), "0111");
        assert_eq!(ht.to_hex(), "0212");
        assert_eq!((hm.trade.network(), ht.trade.network()), ("hood", "hood-testnet"));
        assert_eq!(
            (HoodNet::Mainnet.evm_chain_id(), HoodNet::Testnet.evm_chain_id()),
            (4663, 46630)
        );
        assert_eq!(hm.solana(), None);
        for h in ["0101", "0202", "0111", "0212"] {
            assert_eq!(ChainId::from_hex(h).unwrap().to_hex(), h);
        }
        // Mixed networks and unknown chains never parse.
        for h in [
            "0102", "0201", "0112", "0211", "0103", "0113", "0301", "", "01", "010101",
        ] {
            assert!(ChainId::from_hex(h).is_none(), "{h}");
        }
    }

    #[test]
    fn b58_roundtrip() {
        let pk = [9u8; 32];
        assert_eq!(pubkey_from_b58(&pubkey_to_b58(&pk)), Some(pk));
        assert_eq!(pubkey_from_b58("1111"), None);
        assert_eq!(pubkey_from_b58("0OIl"), None);
    }
}

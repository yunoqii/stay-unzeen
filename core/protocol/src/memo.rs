//! `unz1` memo codec (docs/API.md, "Формат memo `unz1`").
//!
//! Text form: `unz1:` + base64url (no padding) of the binary layout below.
//!
//! ```text
//! off  len       field
//! 0    1         magic 0x55
//! 1    1         version = 1
//! 2    1         op: 5 deposit (1..4 reserved, rejected: actions are paid from the balance)
//! 3    1         venue: 0 none, 1 pumpfun, 2 meteora-dbc, 3 jupiter
//! 4    32        reserved, zeros
//! 36   8         reserved, 0
//! 44   32        anon_pubkey (ed25519)
//! 76   8         nonce (u64 LE)
//! 84   4         expiry (u32 LE, unix seconds)
//! 88   1         target_kind: 0 none, 1 shielded receiver (43), 2 Solana address (32)
//! 89   0|43      target (deposit: none or shielded refund receiver)
//! ..   64        sig = ed25519(sk, "unzeen/memo/v1" || chain_id || bytes[..sig])
//! ```

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};

use crate::ChainId;

pub const MAGIC: u8 = 0x55;
pub const VERSION: u8 = 1;
pub const PREFIX: &str = "unz1:";
pub const SIG_DOMAIN: &[u8] = b"unzeen/memo/v1";
/// Fixed part before the optional target.
pub const HEADER_LEN: usize = 89;
pub const SIG_LEN: usize = 64;
pub const SHIELDED_RECEIVER_LEN: usize = 43;
pub const SOLANA_ADDR_LEN: usize = 32;
/// Smallest valid memo (no target): 153 bytes.
pub const MIN_LEN: usize = HEADER_LEN + SIG_LEN;
/// Largest valid memo (shielded target): 196 bytes.
pub const MAX_LEN: usize = HEADER_LEN + SHIELDED_RECEIVER_LEN + SIG_LEN;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Op {
    Buy = 1,
    Sell = 2,
    Create = 3,
    Withdraw = 4,
    Deposit = 5,
}

impl Op {
    fn from_u8(b: u8) -> Option<Self> {
        Some(match b {
            1 => Op::Buy,
            2 => Op::Sell,
            3 => Op::Create,
            4 => Op::Withdraw,
            5 => Op::Deposit,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Buy => "buy",
            Op::Sell => "sell",
            Op::Create => "create",
            Op::Withdraw => "withdraw",
            Op::Deposit => "deposit",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Venue {
    None = 0,
    PumpFun = 1,
    MeteoraDbc = 2,
    Jupiter = 3,
}

impl Venue {
    fn from_u8(b: u8) -> Option<Self> {
        Some(match b {
            0 => Venue::None,
            1 => Venue::PumpFun,
            2 => Venue::MeteoraDbc,
            3 => Venue::Jupiter,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Venue::None => "none",
            Venue::PumpFun => "pumpfun",
            Venue::MeteoraDbc => "meteora-dbc",
            Venue::Jupiter => "jupiter",
        }
    }
}

/// Refund / withdrawal destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    None,
    /// Raw 43-byte Orchard/Ironwood receiver (d || pk_d).
    Shielded([u8; SHIELDED_RECEIVER_LEN]),
    Solana([u8; SOLANA_ADDR_LEN]),
}

impl Target {
    fn kind(&self) -> u8 {
        match self {
            Target::None => 0,
            Target::Shielded(_) => 1,
            Target::Solana(_) => 2,
        }
    }
    fn bytes(&self) -> &[u8] {
        match self {
            Target::None => &[],
            Target::Shielded(b) => b,
            Target::Solana(b) => b,
        }
    }
}

/// Everything the signature covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unz1Body {
    pub op: Op,
    pub venue: Venue,
    pub mint: [u8; 32],
    pub min_out: u64,
    pub anon_pubkey: [u8; 32],
    pub nonce: u64,
    pub expiry: u32,
    pub target: Target,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unz1 {
    pub body: Unz1Body,
    pub sig: [u8; SIG_LEN],
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("memo does not start with \"unz1:\"")]
    NotUnz1,
    #[error("invalid base64url payload")]
    Base64,
    #[error("bad length {0}")]
    Length(usize),
    #[error("bad magic")]
    Magic,
    #[error("unsupported version {0}")]
    Version(u8),
    #[error("unknown op {0}")]
    Op(u8),
    #[error("unknown venue {0}")]
    Venue(u8),
    #[error("unknown target kind {0}")]
    TargetKind(u8),
    #[error("op {0} is not allowed in a memo (only deposit)")]
    OpNotAllowed(u8),
    #[error("field invalid for op: {0}")]
    Semantic(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SigError {
    #[error("anon_pubkey is not a valid ed25519 point")]
    BadPubkey,
    #[error("signature does not verify")]
    BadSignature,
}

impl Unz1Body {
    /// Serialized body (everything before `sig`).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(MAX_LEN);
        b.push(MAGIC);
        b.push(VERSION);
        b.push(self.op as u8);
        b.push(self.venue as u8);
        b.extend_from_slice(&self.mint);
        b.extend_from_slice(&self.min_out.to_le_bytes());
        b.extend_from_slice(&self.anon_pubkey);
        b.extend_from_slice(&self.nonce.to_le_bytes());
        b.extend_from_slice(&self.expiry.to_le_bytes());
        b.push(self.target.kind());
        b.extend_from_slice(self.target.bytes());
        b
    }

    /// Exact bytes passed to ed25519: domain || chain_id || body.
    pub fn signing_payload(&self, chain: ChainId) -> Vec<u8> {
        let body = self.to_bytes();
        let mut m = Vec::with_capacity(SIG_DOMAIN.len() + 2 + body.len());
        m.extend_from_slice(SIG_DOMAIN);
        m.extend_from_slice(&chain.to_bytes());
        m.extend_from_slice(&body);
        m
    }

    /// Sign with the anon key. `anon_pubkey` is overwritten with the key's public half so
    /// the result always verifies.
    pub fn sign(mut self, sk: &SigningKey, chain: ChainId) -> Unz1 {
        self.anon_pubkey = sk.verifying_key().to_bytes();
        let sig = sk.sign(&self.signing_payload(chain)).to_bytes();
        Unz1 { body: self, sig }
    }

    /// v1 rules. Since 12.10 every action is paid from the account balance, so a memo may
    /// only be `op=deposit` (other op codes stay reserved and are rejected): venue 0,
    /// mint and min_out zero, optional shielded refund target.
    fn check_semantics(&self) -> Result<(), DecodeError> {
        use DecodeError::Semantic;
        if self.op != Op::Deposit {
            return Err(DecodeError::OpNotAllowed(self.op as u8));
        }
        if self.expiry == 0 {
            return Err(Semantic("expiry must be non-zero"));
        }
        if self.venue != Venue::None {
            return Err(Semantic("deposit: venue must be 0"));
        }
        if self.mint != [0; 32] || self.min_out != 0 {
            return Err(Semantic("deposit: mint and min_out must be zero"));
        }
        if matches!(self.target, Target::Solana(_)) {
            return Err(Semantic("deposit: refund target must be shielded"));
        }
        Ok(())
    }
}

impl Unz1 {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = self.body.to_bytes();
        b.extend_from_slice(&self.sig);
        b
    }

    /// Text memo: `unz1:` + base64url(no pad).
    pub fn encode(&self) -> String {
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(self.to_bytes()))
    }

    /// Structural decode of the binary form. Does NOT verify the signature.
    pub fn from_bytes(b: &[u8]) -> Result<Self, DecodeError> {
        if b.len() < MIN_LEN || b.len() > MAX_LEN {
            return Err(DecodeError::Length(b.len()));
        }
        if b[0] != MAGIC {
            return Err(DecodeError::Magic);
        }
        if b[1] != VERSION {
            return Err(DecodeError::Version(b[1]));
        }
        let op = Op::from_u8(b[2]).ok_or(DecodeError::Op(b[2]))?;
        let venue = Venue::from_u8(b[3]).ok_or(DecodeError::Venue(b[3]))?;
        let arr32 = |o: usize| -> [u8; 32] { b[o..o + 32].try_into().expect("len checked") };
        let u64le = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().expect("len checked"));
        let target_len = match b[88] {
            0 => 0,
            1 => SHIELDED_RECEIVER_LEN,
            2 => SOLANA_ADDR_LEN,
            k => return Err(DecodeError::TargetKind(k)),
        };
        if b.len() != HEADER_LEN + target_len + SIG_LEN {
            return Err(DecodeError::Length(b.len()));
        }
        let t = &b[HEADER_LEN..HEADER_LEN + target_len];
        let target = match b[88] {
            0 => Target::None,
            1 => Target::Shielded(t.try_into().expect("len checked")),
            _ => Target::Solana(t.try_into().expect("len checked")),
        };
        let body = Unz1Body {
            op,
            venue,
            mint: arr32(4),
            min_out: u64le(36),
            anon_pubkey: arr32(44),
            nonce: u64le(76),
            expiry: u32::from_le_bytes(b[84..88].try_into().expect("len checked")),
            target,
        };
        body.check_semantics()?;
        let sig = b[HEADER_LEN + target_len..].try_into().expect("len checked");
        Ok(Unz1 { body, sig })
    }

    /// Structural decode of the text form. Does NOT verify the signature.
    pub fn decode(memo: &str) -> Result<Self, DecodeError> {
        let payload = memo.strip_prefix(PREFIX).ok_or(DecodeError::NotUnz1)?;
        // URL_SAFE_NO_PAD rejects padding, standard-alphabet chars and non-canonical
        // trailing bits, so every memo has exactly one valid text form.
        let raw = URL_SAFE_NO_PAD.decode(payload).map_err(|_| DecodeError::Base64)?;
        Self::from_bytes(&raw)
    }

    /// Strict ed25519 verification (rejects small-order keys and malleable signatures).
    pub fn verify(&self, chain: ChainId) -> Result<(), SigError> {
        let vk = VerifyingKey::from_bytes(&self.body.anon_pubkey).map_err(|_| SigError::BadPubkey)?;
        let sig = Signature::from_bytes(&self.sig);
        vk.verify_strict(&self.body.signing_payload(chain), &sig)
            .map_err(|_| SigError::BadSignature)
    }

    /// `expiry` is the last second at which the command may still be executed.
    pub fn is_expired(&self, now_unix_sec: u64) -> bool {
        now_unix_sec > u64::from(self.body.expiry)
    }
}

/// What the scanner should do with an incoming note's memo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Signed, in time: credit the deposit.
    Valid(Unz1),
    /// Signed but past `expiry`: refund to target, else credit balance.
    Expired(Unz1),
    /// Parsed but the signature is bad: the pubkey cannot be trusted, freeze funds.
    BadSignature(Unz1),
    /// Not an `unz1` memo, malformed, or a non-deposit op: freeze funds.
    Malformed(DecodeError),
}

impl Verdict {
    pub fn label(&self) -> &'static str {
        match self {
            Verdict::Valid(_) => "valid",
            Verdict::Expired(_) => "expired",
            Verdict::BadSignature(_) => "bad_signature",
            Verdict::Malformed(_) => "malformed",
        }
    }
}

/// Decode + verify + expiry check in one go. `now_unix_sec` should be the block time of
/// the deposit (deterministic across rescans), not wall-clock time.
pub fn classify(memo: &str, chain: ChainId, now_unix_sec: u64) -> Verdict {
    let m = match Unz1::decode(memo) {
        Ok(m) => m,
        Err(e) => return Verdict::Malformed(e),
    };
    if m.verify(chain).is_err() {
        return Verdict::BadSignature(m);
    }
    if m.is_expired(now_unix_sec) {
        return Verdict::Expired(m);
    }
    Verdict::Valid(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SolanaCluster, ZcashNet};

    const TEST: ChainId = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
    const MAIN: ChainId = ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta);

    fn sk() -> SigningKey {
        SigningKey::from_bytes(&[1u8; 32])
    }

    fn deposit(target: Target) -> Unz1 {
        Unz1Body {
            op: Op::Deposit,
            venue: Venue::None,
            mint: [0; 32],
            min_out: 0,
            anon_pubkey: [0; 32],
            nonce: 7,
            expiry: 2_000_000_000,
            target,
        }
        .sign(&sk(), TEST)
    }

    #[test]
    fn sizes_match_spec() {
        assert_eq!(MIN_LEN, 153);
        assert_eq!(MAX_LEN, 196);
        assert_eq!(deposit(Target::None).to_bytes().len(), 153);
        let m = deposit(Target::Shielded([3; 43]));
        assert_eq!(m.to_bytes().len(), 196);
        // Fits a ZIP-302 text memo with a lot of room to spare.
        assert_eq!(m.encode().len(), 5 + 262);
        assert!(m.encode().as_bytes()[0] < 0xF5);
    }

    #[test]
    fn roundtrip_and_verify() {
        for t in [Target::None, Target::Shielded([3; 43])] {
            let m = deposit(t);
            let d = Unz1::decode(&m.encode()).unwrap();
            assert_eq!(d, m);
            d.verify(TEST).unwrap();
            assert!(matches!(classify(&m.encode(), TEST, 1_900_000_000), Verdict::Valid(_)));
        }
    }

    #[test]
    fn chain_binding() {
        let m = deposit(Target::None);
        assert_eq!(m.verify(MAIN), Err(SigError::BadSignature));
        assert!(matches!(classify(&m.encode(), MAIN, 0), Verdict::BadSignature(_)));
    }

    #[test]
    fn every_field_is_signed() {
        let m = deposit(Target::Shielded([3; 43]));
        let raw = m.to_bytes();
        // Flip one bit in each byte of the signed region; must never verify.
        for i in 0..raw.len() - SIG_LEN {
            let mut b = raw.clone();
            b[i] ^= 0x01;
            if let Ok(x) = Unz1::from_bytes(&b) {
                assert!(x.verify(TEST).is_err(), "byte {i} not covered by signature");
            }
        }
    }

    #[test]
    fn expiry_boundary() {
        let m = deposit(Target::None);
        assert!(!m.is_expired(2_000_000_000));
        assert!(m.is_expired(2_000_000_001));
        assert!(matches!(
            classify(&m.encode(), TEST, 2_000_000_001),
            Verdict::Expired(_)
        ));
    }

    #[test]
    fn rejects_malformed() {
        let good = deposit(Target::None).encode();
        assert_eq!(Unz1::decode("hello"), Err(DecodeError::NotUnz1));
        assert_eq!(Unz1::decode("unz1:!!!"), Err(DecodeError::Base64));
        assert_eq!(Unz1::decode(&format!("{good}=")), Err(DecodeError::Base64));
        assert!(matches!(
            Unz1::decode(&good[..good.len() - 4]),
            Err(DecodeError::Length(_))
        ));

        let raw = deposit(Target::None).to_bytes();
        let with = |i: usize, v: u8| {
            let mut b = raw.clone();
            b[i] = v;
            Unz1::from_bytes(&b)
        };
        assert_eq!(with(0, 0x54), Err(DecodeError::Magic));
        assert_eq!(with(1, 2), Err(DecodeError::Version(2)));
        assert_eq!(with(2, 9), Err(DecodeError::Op(9)));
        assert_eq!(with(2, 1), Err(DecodeError::OpNotAllowed(1)));
        assert_eq!(with(3, 4), Err(DecodeError::Venue(4)));
        assert_eq!(with(88, 3), Err(DecodeError::TargetKind(3)));
        // target_kind says 43 bytes follow but they don't.
        assert!(matches!(with(88, 1), Err(DecodeError::Length(_))));
        // deposit with a venue
        assert!(matches!(with(3, 1), Err(DecodeError::Semantic(_))));
    }

    #[test]
    fn small_order_pubkey_rejected() {
        let mut m = deposit(Target::None);
        m.body.anon_pubkey = [0; 32];
        m.body.anon_pubkey[0] = 1; // identity point
        assert!(m.verify(TEST).is_err());
    }
}

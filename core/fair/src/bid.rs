//! Sealed-bid plaintext (API.md v0.6), 64 bytes, fixed length:
//!
//! ```text
//! off len field
//! 0   4   magic "UZFL"
//! 4   1   version = 1
//! 5   2   chainId (PoolInfo.chainId bytes: 02 02 devnet, 01 01 mainnet)
//! 7   16  launchId
//! 23  32  anonPubkey (ed25519)
//! 55  8   amountZat (u64 LE)
//! 63  1   0x00
//! ```

pub const LEN: usize = 64;
pub const MAGIC: &[u8; 4] = b"UZFL";
pub const VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BidPlaintext {
    pub chain: [u8; 2],
    pub launch_id: [u8; 16],
    pub anon_pubkey: [u8; 32],
    pub amount_zat: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BidError {
    #[error("plaintext is not 64 bytes")]
    Length,
    #[error("bad magic")]
    Magic,
    #[error("unsupported version")]
    Version,
    #[error("reserved byte is not zero")]
    Reserved,
}

impl BidPlaintext {
    pub fn encode(&self) -> [u8; LEN] {
        let mut b = [0u8; LEN];
        b[0..4].copy_from_slice(MAGIC);
        b[4] = VERSION;
        b[5..7].copy_from_slice(&self.chain);
        b[7..23].copy_from_slice(&self.launch_id);
        b[23..55].copy_from_slice(&self.anon_pubkey);
        b[55..63].copy_from_slice(&self.amount_zat.to_le_bytes());
        b
    }

    pub fn decode(b: &[u8]) -> Result<Self, BidError> {
        let b: &[u8; LEN] = b.try_into().map_err(|_| BidError::Length)?;
        if &b[0..4] != MAGIC {
            return Err(BidError::Magic);
        }
        if b[4] != VERSION {
            return Err(BidError::Version);
        }
        if b[63] != 0 {
            return Err(BidError::Reserved);
        }
        Ok(Self {
            chain: [b[5], b[6]],
            launch_id: b[7..23].try_into().expect("16"),
            anon_pubkey: b[23..55].try_into().expect("32"),
            amount_zat: u64::from_le_bytes(b[55..63].try_into().expect("8")),
        })
    }
}

/// Why a decrypted bid is invalid (owner-visible status `invalid`; never published).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Invalid {
    Decrypt,
    Format,
    Chain,
    Launch,
    Author,
    Amount,
}

/// Validate a decrypted plaintext against the launch and the author of the bid.
pub fn validate(
    plaintext: &[u8],
    chain: [u8; 2],
    launch_id: &[u8; 16],
    author: &[u8; 32],
    min_zat: u64,
    hold_zat: u64,
) -> Result<u64, Invalid> {
    let p = BidPlaintext::decode(plaintext).map_err(|_| Invalid::Format)?;
    if p.chain != chain {
        return Err(Invalid::Chain);
    }
    if &p.launch_id != launch_id {
        return Err(Invalid::Launch);
    }
    if &p.anon_pubkey != author {
        return Err(Invalid::Author);
    }
    if p.amount_zat < min_zat || p.amount_zat > hold_zat {
        return Err(Invalid::Amount);
    }
    Ok(p.amount_zat)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BidPlaintext {
        BidPlaintext {
            chain: [2, 2],
            launch_id: core::array::from_fn(|i| i as u8),
            anon_pubkey: [9; 32],
            amount_zat: 12_345_678,
        }
    }

    #[test]
    fn roundtrip_and_layout() {
        let e = sample().encode();
        assert_eq!(&e[..4], b"UZFL");
        assert_eq!(e[4], 1);
        assert_eq!(&e[5..7], &[2, 2]);
        assert_eq!(&e[55..63], &12_345_678u64.to_le_bytes());
        assert_eq!(e[63], 0);
        assert_eq!(BidPlaintext::decode(&e).unwrap(), sample());
        let mut bad = e;
        bad[0] = b'X';
        assert_eq!(BidPlaintext::decode(&bad), Err(BidError::Magic));
        let mut bad = e;
        bad[4] = 2;
        assert_eq!(BidPlaintext::decode(&bad), Err(BidError::Version));
        let mut bad = e;
        bad[63] = 1;
        assert_eq!(BidPlaintext::decode(&bad), Err(BidError::Reserved));
        assert_eq!(BidPlaintext::decode(&e[..63]), Err(BidError::Length));
    }

    #[test]
    fn validation_rows() {
        let p = sample();
        let e = p.encode();
        let ok = |pt: &[u8], hold| validate(pt, [2, 2], &p.launch_id, &[9; 32], 100_000, hold);
        assert_eq!(ok(&e, 12_345_678), Ok(12_345_678));
        assert_eq!(ok(&e, 12_345_677), Err(Invalid::Amount));
        assert_eq!(
            validate(&e, [1, 1], &p.launch_id, &[9; 32], 0, u64::MAX),
            Err(Invalid::Chain)
        );
        assert_eq!(
            validate(&e, [2, 2], &[0; 16], &[9; 32], 0, u64::MAX),
            Err(Invalid::Launch)
        );
        assert_eq!(
            validate(&e, [2, 2], &p.launch_id, &[8; 32], 0, u64::MAX),
            Err(Invalid::Author)
        );
        assert_eq!(
            validate(&e, [2, 2], &p.launch_id, &[9; 32], 20_000_000, u64::MAX),
            Err(Invalid::Amount)
        );
        assert_eq!(ok(b"garbage", u64::MAX), Err(Invalid::Format));
    }
}

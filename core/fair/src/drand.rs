//! drand quicknet: round timing, beacon verification, tlock (age) header check and decryption.
//!
//! Order of operations on reveal (spec §1): fetch the beacon of round `R` → [`verify_beacon`]
//! → [`decrypt`]. `tlock_age` itself does not check the round signature (a wrong signature only
//! makes decryption fail), so a forged beacon would turn every bid "invalid". [`decrypt`]
//! therefore takes a [`VerifiedBeacon`], which only [`verify_beacon`] can construct.

use drand_verify::{G2PubkeyRfc, Pubkey};

/// Chain hash of drand quicknet (`bls-unchained-g1-rfc9380`, 3 s period).
pub const QUICKNET_CHAIN_HASH: [u8; 32] = hex_32("52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971");
/// Public key of quicknet (G2, compressed).
pub const QUICKNET_PUBLIC_KEY_HEX: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
pub const QUICKNET_CHAIN_HASH_HEX: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
/// Unix seconds of round 1.
pub const QUICKNET_GENESIS: u64 = 1_692_803_367;
pub const QUICKNET_PERIOD: u64 = 3;
pub const QUICKNET_SCHEME: &str = "bls-unchained-g1-rfc9380";
/// Largest accepted ciphertext (age armor of a 64-byte payload is ~600 bytes).
pub const MAX_CIPHERTEXT_BYTES: usize = 1024;
const ARMOR_BEGIN: &str = "-----BEGIN AGE ENCRYPTED FILE-----";

const fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("bad hex"),
    }
}

const fn hex_32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = hex_nibble(b[2 * i]) << 4 | hex_nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

fn public_key() -> [u8; 96] {
    let v = hex::decode(QUICKNET_PUBLIC_KEY_HEX).expect("constant");
    v.try_into().expect("96 bytes")
}

/// Round current at unix second `t`: `R(t) = floor((t − genesis) / period) + 1` (1 before genesis).
pub fn round_at(unix_secs: u64) -> u64 {
    unix_secs.saturating_sub(QUICKNET_GENESIS) / QUICKNET_PERIOD + 1
}

/// Unix ms at which round `r` is published: `t(R) = genesis + (R − 1) · period`.
pub fn round_time_ms(round: u64) -> u64 {
    (QUICKNET_GENESIS + round.saturating_sub(1) * QUICKNET_PERIOD) * 1000
}

/// Reveal round of a launch closing at `close_at_ms`: `R(closeAt) + 2`, strictly after the
/// close (by 3..6 s, a margin for clock skew). Invariant: `close_at_ms < round_time_ms(R)`.
pub fn reveal_round(close_at_ms: u64) -> u64 {
    round_at(close_at_ms / 1000) + 2
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BeaconError {
    #[error("signature is not 48 bytes")]
    Length,
    #[error("signature is not a valid G1 point")]
    Point,
    #[error("signature does not verify for this round")]
    Invalid,
}

/// A round signature checked against the quicknet public key. Only [`verify_beacon`] builds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedBeacon {
    round: u64,
    signature: [u8; 48],
}

impl VerifiedBeacon {
    pub fn round(&self) -> u64 {
        self.round
    }
    pub fn signature(&self) -> &[u8; 48] {
        &self.signature
    }
}

/// BLS check of `signature` for `round` (unchained: the message is `sha256(round_be)`).
pub fn verify_beacon(round: u64, signature: &[u8]) -> Result<VerifiedBeacon, BeaconError> {
    let sig: [u8; 48] = signature.try_into().map_err(|_| BeaconError::Length)?;
    let pk = G2PubkeyRfc::from_fixed(public_key()).expect("quicknet public key is a valid G2 point");
    match pk.verify(round, b"", &sig) {
        Ok(true) => Ok(VerifiedBeacon { round, signature: sig }),
        Ok(false) => Err(BeaconError::Invalid),
        Err(_) => Err(BeaconError::Point),
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CiphertextError {
    #[error("ciphertext larger than 1024 bytes")]
    TooLarge,
    #[error("not an age armor")]
    NotArmor,
    #[error("not a tlock age header")]
    Header,
    #[error("encrypted to another drand chain")]
    Chain,
    #[error("encrypted to another round")]
    Round,
    #[error("decryption failed")]
    Decrypt,
    #[error("plaintext too large")]
    Plaintext,
}

/// Round of a tlock ciphertext, checked to be quicknet. No secret is needed (header only).
pub fn header_round(armor: &str) -> Result<u64, CiphertextError> {
    if armor.len() > MAX_CIPHERTEXT_BYTES {
        return Err(CiphertextError::TooLarge);
    }
    if !armor.trim_start().starts_with(ARMOR_BEGIN) {
        return Err(CiphertextError::NotArmor);
    }
    let h = tlock_age::decrypt_header(armor.as_bytes()).map_err(|_| CiphertextError::Header)?;
    if h.hash() != QUICKNET_CHAIN_HASH {
        return Err(CiphertextError::Chain);
    }
    Ok(h.round())
}

/// Check a ciphertext at submission: quicknet and exactly `round`.
pub fn check_ciphertext(armor: &str, round: u64) -> Result<(), CiphertextError> {
    if header_round(armor)? != round {
        return Err(CiphertextError::Round);
    }
    Ok(())
}

/// Decrypt a tlock ciphertext with a verified beacon of its round. Returns at most 1 KiB.
pub fn decrypt(armor: &str, beacon: &VerifiedBeacon) -> Result<Vec<u8>, CiphertextError> {
    check_ciphertext(armor, beacon.round)?;
    let mut out = Vec::with_capacity(64);
    let mut limited = LimitedWriter(&mut out, MAX_CIPHERTEXT_BYTES);
    match tlock_age::decrypt(&mut limited, armor.as_bytes(), &QUICKNET_CHAIN_HASH, &beacon.signature) {
        Ok(()) => Ok(out),
        Err(_) if limited.1 == 0 => Err(CiphertextError::Plaintext),
        Err(_) => Err(CiphertextError::Decrypt),
    }
}

/// tlock-encrypt `plaintext` to `round` of quicknet as age armor (same format as tlock-js).
/// Tooling and tests only (demo bids, integration tests): the server never encrypts bids.
pub fn encrypt(round: u64, plaintext: &[u8]) -> String {
    let pk = public_key();
    let mut w = tlock_age::armor::ArmoredWriter::wrap_output(Vec::new()).expect("armor writer");
    tlock_age::encrypt(&mut w, plaintext, &QUICKNET_CHAIN_HASH, &pk, round).expect("tlock encrypt");
    String::from_utf8(w.finish().expect("armor finish")).expect("armor is ASCII")
}

/// Writer that refuses more than `n` bytes.
struct LimitedWriter<'a>(&'a mut Vec<u8>, usize);

impl std::io::Write for LimitedWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() > self.1 {
            self.1 = 0;
            return Err(std::io::Error::other("plaintext too large"));
        }
        self.1 -= buf.len();
        self.0.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Hex signature of a relay response (`"signature"` field), 48 bytes.
pub fn signature_from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() != 96 {
        return None;
    }
    hex::decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_math() {
        assert_eq!(round_at(QUICKNET_GENESIS), 1);
        assert_eq!(round_at(QUICKNET_GENESIS + 2), 1);
        assert_eq!(round_at(QUICKNET_GENESIS + 3), 2);
        assert_eq!(round_at(0), 1);
        assert_eq!(round_time_ms(1), QUICKNET_GENESIS * 1000);
        // Spec: latest = 33010614 at 2026-10-12 20:00:06 UTC (1791835206).
        assert_eq!(round_time_ms(33_010_614), 1_791_835_206_000);
        assert_eq!(round_at(1_791_835_206), 33_010_614);
        for close in [
            1_791_835_206_000u64,
            1_791_835_206_999,
            1_791_835_207_500,
            1_791_835_208_999,
        ] {
            let r = reveal_round(close);
            let t = round_time_ms(r);
            assert!(close < t, "closeAt < t(R): {close} {t}");
            assert!(t - close <= 6_000 + 999, "{}", t - close);
        }
    }

    #[test]
    fn beacon_check() {
        // drand-verify test vector (quicknet round 123) and spec round 1000.
        let s1000 = hex::decode(
            "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39",
        )
        .unwrap();
        let b = verify_beacon(1000, &s1000).unwrap();
        assert_eq!(b.round(), 1000);
        // Same signature, other round: rejected.
        assert_eq!(verify_beacon(1001, &s1000), Err(BeaconError::Invalid));
        // Bit flip: not a point or not valid.
        let mut bad = s1000.clone();
        bad[47] ^= 1;
        assert!(verify_beacon(1000, &bad).is_err());
        assert_eq!(verify_beacon(1000, &s1000[..47]), Err(BeaconError::Length));
        assert!(signature_from_hex(&hex::encode(&s1000)).is_some());
        assert!(signature_from_hex("zz").is_none());
    }

    #[test]
    fn rust_roundtrip() {
        let s1000 = hex::decode(
            "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39",
        )
        .unwrap();
        let b = verify_beacon(1000, &s1000).unwrap();
        let ct = encrypt(1000, &[7u8; 64]);
        assert!(ct.len() <= MAX_CIPHERTEXT_BYTES, "{}", ct.len());
        assert_eq!(header_round(&ct), Ok(1000));
        assert_eq!(decrypt(&ct, &b).unwrap(), vec![7u8; 64]);
        // Oversized plaintext is refused on decryption.
        let big = encrypt(1000, &[1u8; 2000]);
        assert!(decrypt(&big, &b).is_err());
    }

    #[test]
    fn junk_ciphertexts() {
        assert_eq!(header_round("hello"), Err(CiphertextError::NotArmor));
        assert_eq!(
            header_round(&"x".repeat(MAX_CIPHERTEXT_BYTES + 1)),
            Err(CiphertextError::TooLarge)
        );
        let junk = format!("{ARMOR_BEGIN}\nAAAA\n-----END AGE ENCRYPTED FILE-----\n");
        assert_eq!(header_round(&junk), Err(CiphertextError::Header));
    }
}

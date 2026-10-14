//! EVM signatures for Robinhood Chain (RELAYER v13): the hood relayer signs an `attest` root
//! with the attestation key as EIP-191 `personal_sign` over the 32 root bytes; core checks it
//! against the key's address (the job's `vault`) instead of ed25519.
//!
//! `hash = keccak256("\x19Ethereum Signed Message:\n32" ‖ msg32)`, `sig = r ‖ s ‖ v`
//! (65 bytes, `v` ∈ {27, 28} or {0, 1}), address = last 20 bytes of `keccak256(pubkey64)`.
//! High-s signatures are refused (one valid encoding per signature, like ed25519 strict).

use secp256k1::{
    Message,
    ecdsa::{RecoverableSignature, RecoveryId},
};
use sha3::{Digest, Keccak256};

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// EIP-191 digest of a 32-byte message.
pub fn eip191_hash32(msg: &[u8; 32]) -> [u8; 32] {
    let mut d = Keccak256::new();
    d.update(b"\x19Ethereum Signed Message:\n32");
    d.update(msg);
    d.finalize().into()
}

/// Address (20 bytes) of an uncompressed secp256k1 public key.
pub fn address_of(pk: &secp256k1::PublicKey) -> [u8; 20] {
    let raw = pk.serialize_uncompressed();
    keccak256(&raw[1..])[12..].try_into().expect("20")
}

/// Parse `0x` + 40 hex (any case) into 20 bytes.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    if h.len() != 40 {
        return None;
    }
    hex::decode(h).ok()?.try_into().ok()
}

/// EIP-55 checksum form (`0x` + mixed-case hex) of an address.
pub fn to_checksum(addr: &[u8; 20]) -> String {
    let lower = hex::encode(addr);
    let h = keccak256(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = (h[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
        out.push(if c.is_ascii_alphabetic() && nibble >= 8 {
            c.to_ascii_uppercase()
        } else {
            c
        });
    }
    out
}

/// Canonical EVM address of the API (`0x` + 40 hex, EIP-55). All-lowercase / all-uppercase
/// input is accepted (no checksum to check); mixed case must be a valid EIP-55 checksum.
pub fn canonical_address(s: &str) -> Option<String> {
    let a = parse_address(s)?;
    let c = to_checksum(&a);
    let h = &s[2..];
    let plain = h == h.to_ascii_lowercase() || h == h.to_ascii_uppercase();
    (plain || s == c).then_some(c)
}

/// 32-byte asset / mint id of an ERC-20 for 32-byte slots (Verify v3 `asset`, chat nick):
/// 12 zero bytes ‖ address. Never equal to a Solana mint of the same snapshot (other chain id).
pub fn asset32(addr: &[u8; 20]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(addr);
    out
}

/// secp256k1 group order / 2 (big-endian), for the low-s rule.
const HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x5d, 0x57, 0x6e,
    0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Does `sig_hex` (`0x` + 130 hex) sign `msg` (EIP-191) with the key of `address`?
pub fn verify_eip191(address: &str, sig_hex: &str, msg: &[u8; 32]) -> bool {
    verify_prehash(address, sig_hex, &eip191_hash32(msg))
}

/// Does `sig_hex` sign the 32-byte `hash` (already EIP-191 / EIP-712 encoded) with the key of
/// `address`? Low-s only, `v` ∈ {27, 28, 0, 1}.
pub fn verify_prehash(address: &str, sig_hex: &str, hash: &[u8; 32]) -> bool {
    let Some(addr) = parse_address(address) else {
        return false;
    };
    let Some(sig) = sig_hex
        .strip_prefix("0x")
        .and_then(|h| hex::decode(h).ok())
        .and_then(|v| <[u8; 65]>::try_from(v).ok())
    else {
        return false;
    };
    if sig[32..64] > HALF_N[..] {
        return false;
    }
    let v = match sig[64] {
        27 | 0 => 0,
        28 | 1 => 1,
        _ => return false,
    };
    let Ok(rid) = RecoveryId::try_from(v) else {
        return false;
    };
    let Ok(rs) = RecoverableSignature::from_compact(&sig[..64], rid) else {
        return false;
    };
    rs.recover(Message::from_digest(*hash))
        .is_ok_and(|pk| address_of(&pk) == addr)
}

/// `0x` + 130 hex (`r ‖ s ‖ v`, v = 27/28) signature of a 32-byte hash (tests, vectors).
pub fn sign_prehash(sk: &secp256k1::SecretKey, hash: &[u8; 32]) -> String {
    let rs = RecoverableSignature::sign_ecdsa_recoverable(Message::from_digest(*hash), sk);
    let (rid, compact) = rs.serialize_compact();
    let mut sig = compact.to_vec();
    sig.push(27 + rid.to_u8());
    format!("0x{}", hex::encode(sig))
}

fn u256(x: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

/// Verify v3 vault statement (EIP-712, adapters/src/evm/attest.ts):
/// domain `{name: "unzeen-verify", version: "1", chainId}`, primary type
/// `Snapshot(string snapshotId,address address,uint256 blockNumber)`, `snapshotId` = decimal
/// snapshot id, `blockNumber` = `VerifySnapshot.solanaSlot`. Returns the hash that is signed.
pub fn eip712_snapshot_hash(evm_chain_id: u64, snapshot_id: &str, address: &[u8; 20], block: u64) -> [u8; 32] {
    let domain_type = keccak256(b"EIP712Domain(string name,string version,uint256 chainId)");
    let mut d = Vec::with_capacity(128);
    d.extend_from_slice(&domain_type);
    d.extend_from_slice(&keccak256(b"unzeen-verify"));
    d.extend_from_slice(&keccak256(b"1"));
    d.extend_from_slice(&u256(evm_chain_id));
    let domain = keccak256(&d);
    let ty = keccak256(b"Snapshot(string snapshotId,address address,uint256 blockNumber)");
    let mut m = Vec::with_capacity(128);
    m.extend_from_slice(&ty);
    m.extend_from_slice(&keccak256(snapshot_id.as_bytes()));
    m.extend_from_slice(&asset32(address));
    m.extend_from_slice(&u256(block));
    let st = keccak256(&m);
    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(b"\x19\x01");
    out.extend_from_slice(&domain);
    out.extend_from_slice(&st);
    keccak256(&out)
}

/// Vault signature of a Verify v3 snapshot row.
pub fn verify_vault_eip712(evm_chain_id: u64, snapshot_id: u32, address: &str, block: u64, sig_hex: &str) -> bool {
    let Some(a) = parse_address(address) else {
        return false;
    };
    verify_prehash(
        address,
        sig_hex,
        &eip712_snapshot_hash(evm_chain_id, &snapshot_id.to_string(), &a, block),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::SecretKey;

    #[test]
    fn known_address_and_roundtrip() {
        // web3.js documentation account.
        let b: [u8; 32] = hex::decode("4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318")
            .unwrap()
            .try_into()
            .unwrap();
        let sk = SecretKey::from_secret_bytes(b).unwrap();
        let pk = secp256k1::PublicKey::from_secret_key(&sk);
        assert_eq!(hex::encode(address_of(&pk)), "2c7536e3605d9c16a7a3d7b1898e529396a65c23");
        let msg = [7u8; 32];
        let rs = RecoverableSignature::sign_ecdsa_recoverable(Message::from_digest(eip191_hash32(&msg)), &sk);
        let (rid, compact) = rs.serialize_compact();
        let mut sig = compact.to_vec();
        sig.push(27 + rid.to_u8());
        let sig_hex = format!("0x{}", hex::encode(&sig));
        let addr = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
        assert!(verify_eip191(addr, &sig_hex, &msg));
        assert!(!verify_eip191(addr, &sig_hex, &[8u8; 32]), "other message");
        assert!(!verify_eip191(
            "0x0000000000000000000000000000000000000001",
            &sig_hex,
            &msg
        ));
        assert!(!verify_eip191(addr, "0x00", &msg));
        assert!(
            !verify_eip191("2c7536e3605d9c16a7a3d7b1898e529396a65c23", &sig_hex, &msg),
            "needs 0x"
        );
    }

    #[test]
    fn eip55() {
        // EIP-55 test vectors.
        for a in [
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
            "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
        ] {
            assert_eq!(to_checksum(&parse_address(a).unwrap()), a);
            assert_eq!(canonical_address(&a.to_lowercase()).as_deref(), Some(a));
            assert_eq!(canonical_address(a).as_deref(), Some(a));
        }
        // Wrong mixed case is refused (typo protection).
        assert_eq!(canonical_address("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), None);
        assert_eq!(canonical_address("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA"), None);
        let a = parse_address("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").unwrap();
        assert_eq!(&asset32(&a)[..12], &[0u8; 12]);
    }
}

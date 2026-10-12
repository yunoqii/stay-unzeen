//! Cross-implementation test: ciphertexts produced by tlock-js@0.9.0 (browser library, static
//! quicknet ChainClient, no network) are decrypted here with tlock_age after the round
//! signature is verified with drand-verify. Fixture: core/testdata/fl-vectors.json.

use serde_json::Value;
use unzeen_fair::{
    bid::{self, BidPlaintext},
    drand::{self, CiphertextError},
};

fn vectors() -> Value {
    let s = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/fl-vectors.json")).unwrap();
    serde_json::from_str(&s).unwrap()
}

fn beacon(v: &Value, round: u64) -> drand::VerifiedBeacon {
    let b = v["beacons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["round"].as_u64() == Some(round))
        .unwrap();
    let sig = drand::signature_from_hex(b["signature"].as_str().unwrap()).unwrap();
    drand::verify_beacon(round, &sig).expect("fixture beacon verifies")
}

fn case<'a>(v: &'a Value, name: &str) -> &'a Value {
    v["tlockJs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
}

#[test]
fn constants_match_fixture() {
    let v = vectors();
    assert_eq!(v["drand"]["chainHash"], drand::QUICKNET_CHAIN_HASH_HEX);
    assert_eq!(v["drand"]["publicKey"], drand::QUICKNET_PUBLIC_KEY_HEX);
    assert_eq!(v["drand"]["genesis"].as_u64(), Some(drand::QUICKNET_GENESIS));
    assert_eq!(hex::encode(drand::QUICKNET_CHAIN_HASH), drand::QUICKNET_CHAIN_HASH_HEX);
}

#[test]
fn tlock_js_ciphertext_decrypts_in_rust() {
    let v = vectors();
    let b1000 = beacon(&v, 1000);
    for name in ["devnet_bid", "mainnet_bid"] {
        let c = case(&v, name);
        let ct = c["ciphertext"].as_str().unwrap();
        assert!(ct.len() <= drand::MAX_CIPHERTEXT_BYTES, "{} bytes", ct.len());
        // Header check at submission time: quicknet, round 1000.
        assert_eq!(drand::header_round(ct), Ok(1000));
        drand::check_ciphertext(ct, 1000).unwrap();
        assert_eq!(drand::check_ciphertext(ct, 1001), Err(CiphertextError::Round));
        // Reveal: verified beacon -> plaintext identical to what the browser encrypted.
        let pt = drand::decrypt(ct, &b1000).expect("tlock-js -> tlock_age");
        assert_eq!(hex::encode(&pt), c["plaintext"].as_str().unwrap(), "{name}");
        let p = BidPlaintext::decode(&pt).unwrap();
        assert_eq!(hex::encode(p.chain), c["chainId"].as_str().unwrap());
        assert_eq!(hex::encode(p.launch_id), c["launchId"].as_str().unwrap());
        assert_eq!(p.amount_zat.to_string(), c["amountZat"].as_str().unwrap());
        // anonPubkey = ed25519 public key of the fixture seed (same key derivation as the API).
        let seed: [u8; 32] = hex::decode(c["anonSeed"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let pk = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        assert_eq!(p.anon_pubkey, pk);
        assert_eq!(hex::encode(pk), c["anonPubkey"].as_str().unwrap());
        // Rust encoder produces the same 64 bytes as the JS one.
        assert_eq!(hex::encode(p.encode()), c["plaintext"].as_str().unwrap());
        let amount = bid::validate(&pt, p.chain, &p.launch_id, &pk, 1, u64::MAX).unwrap();
        assert_eq!(amount, p.amount_zat);
    }
}

#[test]
fn wrong_round_beacon_never_decrypts() {
    let v = vectors();
    let c = case(&v, "wrong_round");
    let ct = c["ciphertext"].as_str().unwrap();
    assert_eq!(drand::header_round(ct), Ok(1001));
    // A verified beacon of round 1000 is refused before decryption.
    assert_eq!(drand::decrypt(ct, &beacon(&v, 1000)), Err(CiphertextError::Round));
    // With its own round it decrypts.
    let pt = drand::decrypt(ct, &beacon(&v, 1001)).unwrap();
    assert_eq!(hex::encode(pt), c["plaintext"].as_str().unwrap());
}

#[test]
fn forged_beacon_is_rejected_before_decryption() {
    let v = vectors();
    let sig = drand::signature_from_hex(v["beacons"][1]["signature"].as_str().unwrap()).unwrap();
    // Signature of round 1001 offered as round 1000: verification fails, so no
    // VerifiedBeacon exists and no bid can be judged invalid.
    assert!(drand::verify_beacon(1000, &sig).is_err());
}

#[test]
fn tampered_ciphertext_fails_to_decrypt() {
    let v = vectors();
    let ct = case(&v, "devnet_bid")["ciphertext"].as_str().unwrap();
    // Flip one base64 char in the payload line (last body line before END).
    let lines: Vec<&str> = ct.lines().collect();
    let k = lines.len() - 2;
    let mut bad: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
    let mut chars: Vec<char> = bad[k].chars().collect();
    chars[3] = if chars[3] == 'A' { 'B' } else { 'A' };
    bad[k] = chars.into_iter().collect();
    let bad = bad.join("\n") + "\n";
    assert!(drand::decrypt(&bad, &beacon(&v, 1000)).is_err());
}

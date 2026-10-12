//! Shared test vectors: `core/testdata/unz1-vectors.json`.
//!
//! The file is generated deterministically from the cases below (ed25519 is
//! deterministic). This test fails if the committed file drifts from the code; set
//! `UNZEEN_REGEN_VECTORS=1` to rewrite it after an intentional format change.
//! Independently of generation, every case is re-checked through the public
//! decode/verify API, the way a consumer (scanner, API server, web client) would use it.

use std::path::PathBuf;

use serde_json::{Value, json};
use unzeen_protocol::{
    ChainId, SigningKey, SolanaCluster, ZcashNet, anon_key, api_auth,
    memo::{Op, Target, Unz1, Unz1Body, Venue, classify},
    pubkey_to_b58,
};

const TESTNET: ChainId = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
const MAINNET: ChainId = ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta);
/// "Now" used to classify memo vectors (2026-10-12T00:00:00Z).
const NOW_SEC: u64 = 1_791_763_200;
const EXPIRY_OK: u32 = 1_791_849_600; // NOW + 1 day
const EXPIRY_PAST: u32 = 1_791_676_800; // NOW - 1 day

fn path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/unz1-vectors.json")
}

fn key(n: u8) -> SigningKey {
    // Deterministic test secrets: 32 bytes, each = n. NEVER use outside tests.
    SigningKey::from_bytes(&[n; 32])
}

/// Example Solana mint (arbitrary 32 bytes, rendered in base58 too).
fn mint() -> [u8; 32] {
    let mut m = [0u8; 32];
    for (i, b) in m.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(7).wrapping_add(11);
    }
    m
}

/// Example raw shielded receiver (structure only; not a real address).
fn receiver() -> [u8; 43] {
    let mut r = [0u8; 43];
    for (i, b) in r.iter_mut().enumerate() {
        *b = 0xA0 ^ (i as u8);
    }
    r
}

fn target_json(t: &Target) -> (u8, String) {
    match t {
        Target::None => (0, String::new()),
        Target::Shielded(b) => (1, hex::encode(b)),
        Target::Solana(b) => (2, hex::encode(b)),
    }
}

struct MemoCase {
    name: &'static str,
    note: &'static str,
    sk: SigningKey,
    sign_chain: ChainId,
    verify_chain: ChainId,
    body: Unz1Body,
    tamper_sig: bool,
    expect: &'static str,
}

fn memo_cases() -> Vec<MemoCase> {
    let base = |op, venue, mint, min_out, nonce, expiry, target| Unz1Body {
        op,
        venue,
        mint,
        min_out,
        anon_pubkey: [0; 32],
        nonce,
        expiry,
        target,
    };
    vec![
        MemoCase {
            name: "valid_deposit",
            note: "op=deposit, no refund target. Credits the note value to anon_pubkey's balance.",
            sk: key(1),
            sign_chain: TESTNET,
            verify_chain: TESTNET,
            body: base(Op::Deposit, Venue::None, [0; 32], 0, 1, EXPIRY_OK, Target::None),
            tamper_sig: false,
            expect: "valid",
        },
        MemoCase {
            name: "valid_deposit_refund",
            note: "op=deposit with a shielded refund receiver (raw 43 bytes). Credits the balance.",
            sk: key(2),
            sign_chain: TESTNET,
            verify_chain: TESTNET,
            body: base(
                Op::Deposit,
                Venue::None,
                [0; 32],
                0,
                42,
                EXPIRY_OK,
                Target::Shielded(receiver()),
            ),
            tamper_sig: false,
            expect: "valid",
        },
        MemoCase {
            name: "op_not_allowed_buy",
            note: "Correctly signed op=buy. Since 12.10 memos may only be deposits: rejected as malformed, funds frozen.",
            sk: key(2),
            sign_chain: TESTNET,
            verify_chain: TESTNET,
            body: base(
                Op::Buy,
                Venue::PumpFun,
                mint(),
                1_234_567_890_123,
                43,
                EXPIRY_OK,
                Target::Shielded(receiver()),
            ),
            tamper_sig: false,
            expect: "malformed",
        },
        MemoCase {
            name: "bad_signature",
            note: "valid_deposit fields, first signature byte XOR 0x01. Funds are frozen.",
            sk: key(1),
            sign_chain: TESTNET,
            verify_chain: TESTNET,
            body: base(Op::Deposit, Venue::None, [0; 32], 0, 2, EXPIRY_OK, Target::None),
            tamper_sig: true,
            expect: "bad_signature",
        },
        MemoCase {
            name: "wrong_chain",
            note: "Signed for mainnet (chain_id 0101), checked on testnet (0202): signature must fail.",
            sk: key(1),
            sign_chain: MAINNET,
            verify_chain: TESTNET,
            body: base(Op::Deposit, Venue::None, [0; 32], 0, 3, EXPIRY_OK, Target::None),
            tamper_sig: false,
            expect: "bad_signature",
        },
        MemoCase {
            name: "expired",
            note: "Correctly signed deposit whose expiry is before `now`. Not executed: refund to target, or credit if no target.",
            sk: key(1),
            sign_chain: TESTNET,
            verify_chain: TESTNET,
            body: base(
                Op::Deposit,
                Venue::None,
                [0; 32],
                0,
                4,
                EXPIRY_PAST,
                Target::Shielded(receiver()),
            ),
            tamper_sig: false,
            expect: "expired",
        },
    ]
}

fn build_memo_case(c: &MemoCase) -> Value {
    let mut m = c.body.clone().sign(&c.sk, c.sign_chain);
    if c.tamper_sig {
        m.sig[0] ^= 0x01;
    }
    let b = &m.body;
    let (tk, th) = target_json(&b.target);
    let v = json!({
        "name": c.name,
        "note": c.note,
        "secretKeyHex": hex::encode(c.sk.to_bytes()),
        "anonPubkeyHex": hex::encode(b.anon_pubkey),
        "anonPubkeyB58": pubkey_to_b58(&b.anon_pubkey),
        "signChainIdHex": hex::encode(c.sign_chain.to_bytes()),
        "verifyChainIdHex": hex::encode(c.verify_chain.to_bytes()),
        "now": NOW_SEC,
        "fields": {
            "op": b.op.as_str(),
            "opCode": b.op as u8,
            "venue": b.venue.as_str(),
            "venueCode": b.venue as u8,
            "mintHex": hex::encode(b.mint),
            "mintB58": pubkey_to_b58(&b.mint),
            "minOut": b.min_out.to_string(),
            "nonce": b.nonce.to_string(),
            "expiry": b.expiry,
            "targetKind": tk,
            "targetHex": th,
        },
        "signingPayloadHex": hex::encode(b.signing_payload(c.sign_chain)),
        "sigHex": hex::encode(m.sig),
        "bytesHex": hex::encode(m.to_bytes()),
        "byteLength": m.to_bytes().len(),
        "memo": m.encode(),
        "expect": c.expect,
    });
    v
}

struct ApiCase {
    chain: ChainId,
    verify_chain: ChainId,
    name: &'static str,
    sk: SigningKey,
    method: &'static str,
    path_query: String,
    body: &'static str,
    nonce: [u8; 16],
    ts: u64,
    now: u64,
    tamper: Option<&'static str>,
    expect: &'static str,
}

fn api_cases() -> Vec<ApiCase> {
    let ts = NOW_SEC * 1000;
    vec![
        ApiCase {
            chain: TESTNET,
            verify_chain: TESTNET,
            name: "get_portfolio",
            sk: key(1),
            method: "GET",
            path_query: "/api/portfolio".into(),
            body: "",
            nonce: [0x11; 16],
            ts,
            now: ts + 5_000,
            tamper: None,
            expect: "ok",
        },
        ApiCase {
            chain: TESTNET,
            verify_chain: TESTNET,
            name: "post_action_buy",
            sk: key(2),
            method: "POST",
            path_query: "/api/actions".into(),
            body: r#"{"op":"buy","venue":"pumpfun","mint":"So11111111111111111111111111111111111111112","zecIn":"1000000","minOut":"123456789"}"#,
            nonce: [0x22; 16],
            ts,
            now: ts - 30_000,
            tamper: None,
            expect: "ok",
        },
        ApiCase {
            chain: TESTNET,
            verify_chain: TESTNET,
            name: "stale_ts",
            sk: key(1),
            method: "GET",
            path_query: "/api/orders?status=open".into(),
            body: "",
            nonce: [0x33; 16],
            ts,
            now: ts + 60_001,
            tamper: None,
            expect: "stale",
        },
        ApiCase {
            chain: TESTNET,
            verify_chain: TESTNET,
            name: "bad_signature_body_changed",
            sk: key(2),
            method: "POST",
            path_query: "/api/actions".into(),
            body: r#"{"op":"claim"}"#,
            nonce: [0x44; 16],
            ts,
            now: ts,
            tamper: Some(r#"{"op":"claim","mint":"x"}"#),
            expect: "bad_signature",
        },
        ApiCase {
            chain: MAINNET,
            verify_chain: MAINNET,
            name: "mainnet_get_portfolio",
            sk: key(1),
            method: "GET",
            path_query: "/api/portfolio".into(),
            body: "",
            nonce: [0x55; 16],
            ts,
            now: ts,
            tamper: None,
            expect: "ok",
        },
        ApiCase {
            chain: MAINNET,
            verify_chain: TESTNET,
            name: "wrong_network",
            sk: key(1),
            method: "GET",
            path_query: "/api/portfolio".into(),
            body: "",
            nonce: [0x66; 16],
            ts,
            now: ts,
            tamper: None,
            expect: "bad_signature",
        },
    ]
}

fn build_api_case(c: &ApiCase) -> Value {
    let h = api_auth::sign_request(
        c.chain,
        &c.sk,
        c.method,
        &c.path_query,
        c.body.as_bytes(),
        c.nonce,
        c.ts,
    );
    let sent_body = c.tamper.unwrap_or(c.body);
    json!({
        "name": c.name,
        "secretKeyHex": hex::encode(c.sk.to_bytes()),
        "chainIdHex": c.chain.to_hex(),
        "verifyChainIdHex": c.verify_chain.to_hex(),
        "method": c.method,
        "pathQuery": c.path_query,
        "signedBody": c.body,
        "sentBody": sent_body,
        "bodySha256Hex": api_auth::body_hash_hex(c.body.as_bytes()),
        "message": api_auth::signing_message(c.chain, c.method, &c.path_query, c.body.as_bytes(), &h.nonce, c.ts),
        "headers": {
            api_auth::H_PUBKEY: h.pubkey,
            api_auth::H_NONCE: h.nonce,
            api_auth::H_TS: h.ts,
            api_auth::H_SIG: h.sig,
        },
        "now": c.now,
        "expect": c.expect,
    })
}

fn build() -> Value {
    json!({
        "version": 1,
        "description": "Unzeen test vectors (docs/API.md). Generated by core/protocol/tests/vectors.rs. Test keys only.",
        "memo": {
            "domain": "unzeen/memo/v1",
            "prefix": "unz1:",
            "encoding": "base64url, no padding",
            "signature": "ed25519(sk, utf8(domain) || chainId(2 bytes) || bytes[..len-64])",
            "chainId": "byte0: zcash 1=mainnet 2=testnet; byte1: solana 1=mainnet-beta 2=devnet",
            "expiryRule": "expired iff now > expiry (unix seconds; backend uses block time)",
            "cases": memo_cases().iter().map(build_memo_case).collect::<Vec<_>>(),
        },
        "api": {
            "domain": api_auth::DOMAIN,
            "message": "domain \\n chainIdHex \\n METHOD \\n pathQuery \\n hex(sha256(body)) \\n nonce \\n ts  (no trailing newline)",
            "tsWindowMs": api_auth::TS_WINDOW_MS,
            "cases": api_cases().iter().map(build_api_case).collect::<Vec<_>>(),
        },
        "anonKey": {
            "derivation": "BIP-39 (English, empty passphrase) -> 64-byte seed -> SLIP-0010 ed25519, all segments hardened",
            "path": "m/44'/133'/<net>'/0'  (net: 0 = mainnet [chainId 0101], 1 = devnet/testnet)",
            "cases": anon_key_cases(),
        }
    })
}

const MNEMONICS: [&str; 2] = [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
];

fn seed_of(phrase: &str) -> [u8; 64] {
    let m = bip0039::Mnemonic::<bip0039::English>::from_phrase(phrase).unwrap();
    m.to_seed("")
}

fn anon_key_cases() -> Vec<Value> {
    let mut out = vec![];
    for phrase in MNEMONICS {
        let seed = seed_of(phrase);
        for chain in [MAINNET, TESTNET] {
            let sk = anon_key::derive(&seed, chain);
            out.push(json!({
                "mnemonic": phrase,
                "seedHex": hex::encode(seed),
                "chainIdHex": chain.to_hex(),
                "path": anon_key::path_string(chain),
                "secretKeyHex": hex::encode(sk.to_bytes()),
                "pubkey": pubkey_to_b58(&sk.verifying_key().to_bytes()),
            }));
        }
    }
    out
}

#[test]
fn vectors_file_matches_code() {
    let expected = serde_json::to_string_pretty(&build()).unwrap() + "\n";
    let p = path();
    if std::env::var("UNZEEN_REGEN_VECTORS").as_deref() == Ok("1") {
        std::fs::write(&p, &expected).unwrap();
    }
    let actual = std::fs::read_to_string(&p).unwrap_or_default();
    assert!(
        actual == expected,
        "{} is out of date; rerun with UNZEEN_REGEN_VECTORS=1 if the change is intentional",
        p.display()
    );
}

/// Consumer-side check: parse the committed JSON and verify each case via the public API.
#[test]
fn vectors_verify_as_consumer() {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path()).unwrap()).unwrap();
    let chain = |h: &str| {
        let b = hex::decode(h).unwrap();
        let z = if b[0] == 1 {
            ZcashNet::Mainnet
        } else {
            ZcashNet::Testnet
        };
        let s = if b[1] == 1 {
            SolanaCluster::MainnetBeta
        } else {
            SolanaCluster::Devnet
        };
        ChainId::new(z, s)
    };
    let cases = v["memo"]["cases"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let memo = c["memo"].as_str().unwrap();
        let verdict = classify(
            memo,
            chain(c["verifyChainIdHex"].as_str().unwrap()),
            c["now"].as_u64().unwrap(),
        );
        assert_eq!(verdict.label(), c["expect"].as_str().unwrap(), "case {}", c["name"]);
        if c["expect"] == "malformed" {
            continue;
        }
        let d = Unz1::decode(memo).unwrap();
        assert_eq!(hex::encode(d.to_bytes()), c["bytesHex"].as_str().unwrap());
        assert_eq!(d.body.nonce.to_string(), c["fields"]["nonce"].as_str().unwrap());
    }
    for c in v["api"]["cases"].as_array().unwrap() {
        let h = &c["headers"];
        let headers = api_auth::SignedHeaders {
            pubkey: h[api_auth::H_PUBKEY].as_str().unwrap().into(),
            nonce: h[api_auth::H_NONCE].as_str().unwrap().into(),
            ts: h[api_auth::H_TS].as_str().unwrap().into(),
            sig: h[api_auth::H_SIG].as_str().unwrap().into(),
        };
        let r = api_auth::verify_request(
            chain(c["verifyChainIdHex"].as_str().unwrap()),
            &headers,
            c["method"].as_str().unwrap(),
            c["pathQuery"].as_str().unwrap(),
            c["sentBody"].as_str().unwrap().as_bytes(),
            c["now"].as_u64().unwrap(),
        );
        let got = match r {
            Ok(_) => "ok",
            Err(api_auth::AuthError::Stale) => "stale",
            Err(api_auth::AuthError::BadSignature) => "bad_signature",
            Err(api_auth::AuthError::Header(_)) => "bad_header",
        };
        assert_eq!(got, c["expect"].as_str().unwrap(), "api case {}", c["name"]);
    }
    let keys = v["anonKey"]["cases"].as_array().unwrap();
    assert_eq!(keys.len(), 4);
    for c in keys {
        let seed = seed_of(c["mnemonic"].as_str().unwrap());
        assert_eq!(hex::encode(seed), c["seedHex"].as_str().unwrap());
        let sk = anon_key::derive(&seed, chain(c["chainIdHex"].as_str().unwrap()));
        assert_eq!(
            pubkey_to_b58(&sk.verifying_key().to_bytes()),
            c["pubkey"].as_str().unwrap()
        );
    }
}

/// Cross-implementation check against the web client's independently generated vectors
/// (read-only; skipped if the web tree is absent).
#[test]
fn web_vectors_cross_check() {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/lib/crypto/testdata/unz1-web-vectors.json");
    let Ok(raw) = std::fs::read_to_string(&p) else {
        eprintln!("skip: {} not found", p.display());
        return;
    };
    let v: Value = serde_json::from_str(&raw).unwrap();
    let mut checked = 0;
    for c in v["vectors"].as_array().unwrap() {
        let bytes = hex::decode(c["memoHex"].as_str().unwrap()).unwrap();
        let ch = c["chainId"].as_array().unwrap();
        let chain = ChainId::new(
            if ch[0] == 1 {
                ZcashNet::Mainnet
            } else {
                ZcashNet::Testnet
            },
            if ch[1] == 1 {
                SolanaCluster::MainnetBeta
            } else {
                SolanaCluster::Devnet
            },
        );
        match Unz1::from_bytes(&bytes) {
            Ok(m) => {
                assert_eq!(c["op"], "deposit", "{}", c["name"]);
                assert_eq!(m.body.nonce.to_string(), c["nonce"].as_str().unwrap());
                m.verify(chain).unwrap_or_else(|e| panic!("{}: {e}", c["name"]));
            }
            Err(unzeen_protocol::memo::DecodeError::OpNotAllowed(_)) => assert_ne!(c["op"], "deposit"),
            Err(e) => panic!("{}: {e}", c["name"]),
        }
        checked += 1;
    }
    assert!(checked > 0);
}

//! v0.18 chain ids (`core/testdata/chain-vectors.json`): the four valid `chainId` pairs,
//! Robinhood Chain anon keys (`m/44'/133'/2'|3'/0'`) and one signed HTTP request per pair, so
//! the web client can check its hood support before any hood backend exists.
//! `UNZEEN_REGEN_VECTORS=1` rewrites the file after an intentional change.

use std::path::PathBuf;

use serde_json::{Value, json};
use unzeen_protocol::{
    ChainId, HoodNet, SolanaCluster, ZcashNet, anon_key,
    api_auth::{SignedHeaders, sign_request, verify_request},
    pubkey_to_b58,
};

const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn chains() -> [ChainId; 4] {
    [
        ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta),
        ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet),
        ChainId::hood(ZcashNet::Mainnet, HoodNet::Mainnet),
        ChainId::hood(ZcashNet::Testnet, HoodNet::Testnet),
    ]
}

fn build() -> Value {
    let seed = bip0039::Mnemonic::<bip0039::English>::from_phrase(MNEMONIC)
        .unwrap()
        .to_seed("");
    let cases: Vec<Value> = chains()
        .into_iter()
        .map(|c| {
            let sk = anon_key::derive(&seed, c);
            let body = br#"{"op":"noop"}"#;
            let h = sign_request(c, &sk, "POST", "/api/actions", body, [7; 16], 1_791_763_200_000);
            json!({
                "chainIdHex": c.to_hex(),
                "chain": c.trade.chain(),
                "network": c.trade.network(),
                "evmChainId": match c.trade { unzeen_protocol::TradeNet::Hood(h) => json!(h.evm_chain_id()), _ => Value::Null },
                "anonKeyPath": anon_key::path_string(c),
                "pubkey": pubkey_to_b58(&sk.verifying_key().to_bytes()),
                "request": {
                    "method": "POST", "pathQuery": "/api/actions", "body": std::str::from_utf8(body).unwrap(),
                    "nonce": h.nonce, "ts": h.ts, "sig": h.sig,
                },
            })
        })
        .collect();
    json!({
        "description": "API v0.18 chain ids: byte 0 = Zcash (1 main, 2 test); byte 1 = trading chain (0x01 Solana mainnet-beta, 0x02 devnet, 0x11 Robinhood Chain 4663, 0x12 Robinhood Chain testnet 46630). Only 0101, 0202, 0111, 0212 are valid.",
        "mnemonic": MNEMONIC,
        "invalid": ["0102", "0201", "0112", "0211", "0103", "0113"],
        "cases": cases,
    })
}

#[test]
fn chain_vectors() {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/chain-vectors.json");
    let v = build();
    if std::env::var("UNZEEN_REGEN_VECTORS").as_deref() == Ok("1") || !p.exists() {
        std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    }
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(file, v, "chain-vectors.json is stale (UNZEEN_REGEN_VECTORS=1)");
    for c in file["cases"].as_array().unwrap() {
        let chain = ChainId::from_hex(c["chainIdHex"].as_str().unwrap()).unwrap();
        let r = &c["request"];
        let h = SignedHeaders {
            pubkey: c["pubkey"].as_str().unwrap().into(),
            nonce: r["nonce"].as_str().unwrap().into(),
            ts: r["ts"].as_str().unwrap().into(),
            sig: r["sig"].as_str().unwrap().into(),
        };
        let body = r["body"].as_str().unwrap().as_bytes();
        let now = 1_791_763_200_000;
        assert!(verify_request(chain, &h, "POST", "/api/actions", body, now).is_ok());
        // A signature of one pair never verifies on another.
        for other in chains().into_iter().filter(|o| *o != chain) {
            assert!(verify_request(other, &h, "POST", "/api/actions", body, now).is_err());
        }
    }
    for bad in file["invalid"].as_array().unwrap() {
        assert!(ChainId::from_hex(bad.as_str().unwrap()).is_none());
    }
}

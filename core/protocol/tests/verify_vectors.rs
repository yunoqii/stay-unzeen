//! Verify vectors (API.md v0.7): core/testdata/verify-vectors.json. The frontend must match
//! these byte for byte. Regenerate (only when the format changes on purpose):
//!   UNZEEN_WRITE_VECTORS=1 cargo test -p unzeen-protocol --test verify_vectors

use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use unzeen_protocol::verify::{self, Node, SnapshotHeader};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/verify-vectors.json");

fn generate() -> Value {
    let chain = [2u8, 2];
    let snapshot_id = 7u32;
    let mint = "So11111111111111111111111111111111111111112";
    let mint_b: [u8; 32] = bs58::decode(mint).into_vec().unwrap().try_into().unwrap();
    // 8-leaf ZEC tree: leaves 0..3 real (two keys, two pieces each), 4..7 dummies.
    let mut leaves_json = Vec::new();
    let mut nodes = Vec::new();
    for i in 0..8u8 {
        let real = i < 4;
        let sk = SigningKey::from_bytes(&[i / 2 + 1; 32]);
        let pk: [u8; 32] = if real {
            sk.verifying_key().to_bytes()
        } else {
            [0xA0 + i; 32]
        };
        let piece = if real { i % 2 } else { 0 };
        let value: u64 = if real { 100_000 * (u64::from(i) + 1) } else { 0 };
        let blind = [0x10 + i; 32];
        let h = verify::leaf_hash(chain, snapshot_id, &verify::ZEC_ASSET, &pk, piece, value, &blind);
        nodes.push(Node {
            hash: h,
            sum: value as u128,
        });
        leaves_json.push(json!({
            "index": i, "dummy": !real, "anonPubkey": hex::encode(pk), "piece": piece,
            "value": value.to_string(), "blind": hex::encode(blind), "leaf": hex::encode(h),
        }));
    }
    let levels = verify::build(nodes.clone());
    let root = levels.last().unwrap()[0];
    let idx = 5usize;
    let path: Vec<Value> = verify::path(&levels, idx)
        .iter()
        .map(|n| json!({"hash": hex::encode(n.hash), "sum": n.sum.to_string()}))
        .collect();
    let n01 = verify::node(&nodes[0], &nodes[1]);
    // A mint leaf (asset = base58-decoded mint).
    let mpk = SigningKey::from_bytes(&[1; 32]).verifying_key().to_bytes();
    let mint_leaf = verify::leaf_hash(chain, snapshot_id, &mint_b, &mpk, 2, 3_000_000, &[0x33; 32]);
    let header = SnapshotHeader {
        chain,
        snapshot_id,
        taken_at_sec: 1_791_849_600,
        leaves: 8,
        solana_slot: 400_000_123,
        zcash_height: 3_100_200,
        zec_reserve_zat: 1_230_000_000,
    };
    let mint_root = Node {
        hash: mint_leaf,
        sum: 3_000_000,
    };
    let digest = verify::roots_digest(&header, &[(mint_b, mint_root), (verify::ZEC_ASSET, root)]);
    let op = SigningKey::from_bytes(&[9; 32]);
    let vault = SigningKey::from_bytes(&[5; 32]);
    let vault_addr = bs58::encode(vault.verifying_key().to_bytes()).into_string();
    let msg = verify::vault_message("0202", snapshot_id, &vault_addr);
    json!({
        "_comment": "Verify vectors (API.md v0.7). Integers big-endian. Signing keys are ed25519 seeds of repeated bytes (TEST ONLY).",
        "chainId": "0202",
        "snapshotId": snapshot_id,
        "zecTree": {
            "asset": hex::encode(verify::ZEC_ASSET),
            "leaves": leaves_json,
            "node01": {"hash": hex::encode(n01.hash), "sum": n01.sum.to_string()},
            "root": {"hash": hex::encode(root.hash), "sum": root.sum.to_string()},
            "proof": {"leafIndex": idx, "path": path},
        },
        "mintLeaf": {
            "mint": mint, "asset": hex::encode(mint_b), "anonPubkey": hex::encode(mpk), "piece": 2,
            "value": "3000000", "blind": hex::encode([0x33u8; 32]), "leaf": hex::encode(mint_leaf),
        },
        "snapshot": {
            "takenAtSec": header.taken_at_sec, "leaves": header.leaves, "solanaSlot": header.solana_slot,
            "zcashHeight": header.zcash_height, "zecReserveZat": header.zec_reserve_zat.to_string(),
            "trees": [
                {"asset": hex::encode(verify::ZEC_ASSET), "root": hex::encode(root.hash), "sum": root.sum.to_string()},
                {"asset": hex::encode(mint_b), "root": hex::encode(mint_leaf), "sum": "3000000"}
            ],
            "rootsDigest": hex::encode(digest),
            "operatorSeed": hex::encode([9u8; 32]),
            "operatorPubkey": bs58::encode(op.verifying_key().to_bytes()).into_string(),
            "operatorSig": bs58::encode(op.sign(&digest).to_bytes()).into_string(),
        },
        "vault": {
            "seed": hex::encode([5u8; 32]), "address": vault_addr, "message": msg,
            "sig": bs58::encode(vault.sign(msg.as_bytes()).to_bytes()).into_string(),
        },
    })
}

#[test]
fn verify_vectors_match() {
    let v = generate();
    if std::env::var("UNZEEN_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::write(PATH, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    }
    let file: Value = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
    assert_eq!(file, v, "verify-vectors.json differs from the implementation");
    // The pinned proof verifies against the pinned root.
    let t = &file["zecTree"];
    let idx = t["proof"]["leafIndex"].as_u64().unwrap() as usize;
    let l = &t["leaves"][idx];
    let h = |s: &Value| -> [u8; 32] { hex::decode(s.as_str().unwrap()).unwrap().try_into().unwrap() };
    let leaf = Node {
        hash: h(&l["leaf"]),
        sum: l["value"].as_str().unwrap().parse().unwrap(),
    };
    let path: Vec<Node> = t["proof"]["path"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| Node {
            hash: h(&n["hash"]),
            sum: n["sum"].as_str().unwrap().parse().unwrap(),
        })
        .collect();
    let root = verify::root_from_path(&leaf, idx, &path);
    assert_eq!(hex::encode(root.hash), t["root"]["hash"].as_str().unwrap());
    assert_eq!(root.sum.to_string(), t["root"]["sum"].as_str().unwrap());
}

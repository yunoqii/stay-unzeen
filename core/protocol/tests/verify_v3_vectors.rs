//! Verify v3 vectors (API.md v0.20, Robinhood Chain): core/testdata/verify-v3-vectors.json.
//! The browser check must match these byte for byte. Regenerate on purpose only:
//!   UNZEEN_WRITE_VECTORS=1 cargo test -p unzeen-protocol --test verify_v3_vectors

use serde_json::{Value, json};
use unzeen_protocol::{
    evm,
    verify::{self, Node, QuoteAssetFact, SnapshotHeader, TreeVersion},
};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/verify-v3-vectors.json");

fn tree(
    chain: [u8; 2],
    sid: u32,
    asset: &[u8; 32],
    real: &[([u8; 32], u8, u128, [u8; 32])],
    n: usize,
) -> (Vec<Value>, Vec<Vec<Node>>) {
    let mut nodes = Vec::new();
    let mut js = Vec::new();
    for i in 0..n {
        let (pk, piece, value, blind, dummy) = match real.get(i) {
            Some((pk, piece, value, blind)) => (*pk, *piece, *value, *blind, false),
            None => ([0xD0 + i as u8; 32], 0, 0, [0xE0 + i as u8; 32], true),
        };
        let h = verify::leaf_hash_v3(chain, sid, asset, &pk, piece, value, &blind);
        nodes.push(Node { hash: h, sum: value });
        js.push(json!({
            "index": i, "dummy": dummy, "anonPubkey": hex::encode(pk), "piece": piece,
            "value": value.to_string(), "blind": hex::encode(blind), "leaf": hex::encode(h),
        }));
    }
    (js, verify::build_v(TreeVersion::V3, nodes))
}

fn build() -> Value {
    let chain = [2u8, 0x12]; // 0212: Zcash testnet + Robinhood Chain testnet
    let sid = 3u32;
    let token = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    let asset = evm::asset32(&evm::parse_address(token).unwrap());
    let (a, b) = ([0xA1u8; 32], [0xB2u8; 32]);
    let e27 = 10u128.pow(27);
    // ZEC: granule 0.001 ZEC; ERC-20: granule 1, values far beyond u64.
    let zec_real = [(a, 0u8, 60_000_000u128, [0x41u8; 32]), (b, 0, 20_000_000, [0x44; 32])];
    let tok_real = [
        (a, 0u8, 7 * e27 / 10, [0x51u8; 32]),
        (a, 1, 3 * e27 / 10 + 1, [0x52; 32]),
        (b, 0, 18_446_744_073_709_551_616, [0x53; 32]), // u64::MAX + 1
    ];
    let (zec_leaves, zec_levels) = tree(chain, sid, &verify::ZEC_ASSET, &zec_real, 4);
    let (tok_leaves, tok_levels) = tree(chain, sid, &asset, &tok_real, 4);
    let (zr, tr) = (zec_levels.last().unwrap()[0], tok_levels.last().unwrap()[0]);
    // Proof of leaf 1 of the token tree (path bottom-up, sibling hashes and sums).
    let path = verify::path(&tok_levels, 1);
    let back = verify::root_from_path_v(TreeVersion::V3, &tok_levels[0][1], 1, &path);
    assert_eq!(back, tr);
    let header = SnapshotHeader {
        chain,
        snapshot_id: sid,
        taken_at_sec: 1_792_022_400,
        leaves: 4,
        solana_slot: 12_345_678, // block number on Robinhood Chain
        zcash_height: 3_110_000,
        zec_reserve_zat: 90_000_000,
    };
    let quotes: [QuoteAssetFact; 0] = [];
    let digest = verify::roots_digest_v3(&header, &[(verify::ZEC_ASSET, zr), (asset, tr)], &quotes);
    // Same leaf under v1 rules differs (tags are versioned).
    json!({
        "description": "Verify v3 (API v0.20): u128 leaf values, ERC-20 asset = 12 zero bytes ‖ address, v3 tags for leaf/node/snapshot. Integers big-endian; value u128 = 16 bytes.",
        "tags": { "leaf": "unzeen/verify/v3/leaf", "node": "unzeen/verify/v3/node", "snapshot": "unzeen/verify/v3/snapshot" },
        "chainId": hex::encode(chain),
        "snapshotId": sid,
        "token": token,
        "tokenAsset32": hex::encode(asset),
        "trees": {
            "ZEC": { "leaves": zec_leaves, "root": hex::encode(zr.hash), "sum": zr.sum.to_string() },
            token: { "leaves": tok_leaves, "root": hex::encode(tr.hash), "sum": tr.sum.to_string() },
        },
        "proof": {
            "asset": token, "leafIndex": 1,
            "path": path.iter().map(|n| json!({ "hash": hex::encode(n.hash), "sum": n.sum.to_string() })).collect::<Vec<_>>(),
        },
        "header": {
            "takenAtSec": header.taken_at_sec, "leaves": header.leaves, "blockNumber": header.solana_slot,
            "zcashHeight": header.zcash_height, "zecReserveZat": header.zec_reserve_zat.to_string(), "quoteAssets": [],
        },
        "rootsDigest": hex::encode(digest),
    })
}

#[test]
fn verify_v3_vectors() {
    let v = build();
    if std::env::var("UNZEEN_WRITE_VECTORS").as_deref() == Ok("1") || !std::path::Path::new(PATH).exists() {
        std::fs::write(PATH, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    }
    let file: Value = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
    assert_eq!(file, v, "verify-v3-vectors.json is stale (UNZEEN_WRITE_VECTORS=1)");
    // v1 and v3 leaves of the same data differ.
    let v1 = verify::leaf_hash(
        [2, 0x12],
        3,
        &verify::ZEC_ASSET,
        &[0xA1; 32],
        0,
        60_000_000,
        &[0x41; 32],
    );
    let v3 = verify::leaf_hash_v3(
        [2, 0x12],
        3,
        &verify::ZEC_ASSET,
        &[0xA1; 32],
        0,
        60_000_000,
        &[0x41; 32],
    );
    assert_ne!(v1, v3);
}

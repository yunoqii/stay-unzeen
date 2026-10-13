//! Verify vectors (API.md v0.7): core/testdata/verify-vectors.json. The frontend must match
//! these byte for byte. Regenerate (only when the format changes on purpose):
//!   UNZEEN_WRITE_VECTORS=1 cargo test -p unzeen-protocol --test verify_vectors

use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use unzeen_protocol::verify::{self, Node, SnapshotHeader};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/verify-vectors.json");

/// One tree from fixed (pubkey, piece, value, blind) leaves padded with dummies to `n`.
fn tree(
    chain: [u8; 2],
    sid: u32,
    asset: &[u8; 32],
    real: &[([u8; 32], u8, u64, [u8; 32])],
    n: usize,
) -> (Vec<Value>, Node) {
    let mut nodes = Vec::new();
    let mut js = Vec::new();
    for i in 0..n {
        let (pk, piece, value, blind, dummy) = match real.get(i) {
            Some((pk, piece, value, blind)) => (*pk, *piece, *value, *blind, false),
            None => ([0xD0 + i as u8; 32], 0, 0, [0xE0 + i as u8; 32], true),
        };
        let h = verify::leaf_hash(chain, sid, asset, &pk, piece, value, &blind);
        nodes.push(Node {
            hash: h,
            sum: value as u128,
        });
        js.push(json!({
            "index": i, "dummy": dummy, "anonPubkey": hex::encode(pk), "piece": piece,
            "value": value.to_string(), "blind": hex::encode(blind), "leaf": hex::encode(h),
        }));
    }
    let root = verify::build(nodes).last().unwrap()[0];
    (js, root)
}

/// API v0.10 (review-day8 E1/E5/E6/E9): a snapshot where a creator's claimable lamports (two
/// mints) are part of their ZEC value at the buy rate, mint granule 1, no SOL tree, solvency.
fn creator_snapshot() -> Value {
    let chain = [2u8, 2];
    let sid = 8u32;
    let (mint, mint2) = (
        "So11111111111111111111111111111111111111112",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    );
    let mint_b: [u8; 32] = bs58::decode(mint).into_vec().unwrap().try_into().unwrap();
    let a = SigningKey::from_bytes(&[1; 32]).verifying_key().to_bytes();
    let b = SigningKey::from_bytes(&[2; 32]).verifying_key().to_bytes();
    let (rate_buy, rate_sell) = (9_950_000_000u64, 10_050_000_000u64);
    // Key A: 1.2 ZEC + creator fees 0.03 + 0.02 SOL (two mints, one value for the key).
    let claim_lamports = 30_000_000u64 + 20_000_000;
    let claim_zat = verify::claimable_zat(claim_lamports, rate_buy).unwrap();
    let a_value = 120_000_000 + claim_zat;
    let a_rounded = verify::round_up(a_value, verify::ZEC_GRANULE);
    let zec_real = [
        (a, 0u8, 60_000_000u64, [0x41u8; 32]),
        (a, 1, 0, [0x42; 32]),
        (a, 2, a_rounded - 60_000_000, [0x43; 32]),
        (b, 0, 20_000_000, [0x44; 32]),
        (b, 1, 30_000_000, [0x45; 32]),
    ];
    let (zec_leaves, zec_root) = tree(chain, sid, &verify::ZEC_ASSET, &zec_real, 8);
    // Mint: granule 1 base unit, exact balances (1.5 and 1.500001 tokens).
    let mint_real = [
        (a, 0u8, 1_000_000u64, [0x51u8; 32]),
        (a, 1, 500_000, [0x52; 32]),
        (b, 0, 1_500_001, [0x53; 32]),
        (b, 1, 0, [0x54; 32]),
    ];
    let (mint_leaves, mint_root) = tree(chain, sid, &mint_b, &mint_real, 8);
    let header = SnapshotHeader {
        chain,
        snapshot_id: sid,
        taken_at_sec: 1_792_022_400,
        leaves: 8,
        solana_slot: 400_100_000,
        zcash_height: 3_110_000,
        zec_reserve_zat: 1_000_000_000,
    };
    let digest = verify::roots_digest(&header, &[(verify::ZEC_ASSET, zec_root), (mint_b, mint_root)]);
    let op = SigningKey::from_bytes(&[9; 32]);
    let vault_lamports = 2_000_000_000u64;
    let committed = 2_000_000u64; // withdrawal gas only (E9)
    let cover_zat = ((vault_lamports - committed) as u128 * 100_000_000 / rate_sell as u128) as u64;
    json!({
        "_comment": "API v0.10: creator fees inside the ZEC leaf (ceil(lamports*1e8/rateBuy), summed per key), mint granule 1, no SOL tree. Solvency: mint sum <= vault tokens; ZEC sum <= zecReserve + floor((lamports - committed)*1e8/rateSell).",
        "chainId": "0202",
        "snapshotId": sid,
        "rateLamportsPerZecBuy": rate_buy.to_string(),
        "rateLamportsPerZecSell": rate_sell.to_string(),
        "creator": {
            "anonPubkey": hex::encode(a),
            "balanceZat": "120000000",
            "claimable": [{"mint": mint, "lamports": "30000000"}, {"mint": mint2, "lamports": "20000000"}],
            "claimableZat": claim_zat.to_string(),
            "valueZat": a_value.to_string(),
            "roundedZat": a_rounded.to_string(),
        },
        "zecTree": {"granule": verify::ZEC_GRANULE.to_string(), "leaves": zec_leaves,
                    "root": {"hash": hex::encode(zec_root.hash), "sum": zec_root.sum.to_string()}},
        "mintTree": {"mint": mint, "asset": hex::encode(mint_b), "granule": verify::MINT_GRANULE.to_string(),
                     "leaves": mint_leaves,
                     "root": {"hash": hex::encode(mint_root.hash), "sum": mint_root.sum.to_string()}},
        "snapshot": {
            "takenAtSec": header.taken_at_sec, "leaves": header.leaves, "solanaSlot": header.solana_slot,
            "zcashHeight": header.zcash_height, "zecReserveZat": header.zec_reserve_zat.to_string(),
            "rootsDigest": hex::encode(digest),
            "operatorPubkey": bs58::encode(op.verifying_key().to_bytes()).into_string(),
            "operatorSig": bs58::encode(op.sign(&digest).to_bytes()).into_string(),
            "vaults": [{"lamports": vault_lamports.to_string(), "tokens": [{"mint": mint, "amount": "3000001"}]}],
            "committedLamports": committed.to_string(),
        },
        "solvency": {
            "mint": {"liabilities": mint_root.sum.to_string(), "assets": "3000001", "covered": true},
            "zec": {"liabilities": zec_root.sum.to_string(), "reserveZat": "1000000000",
                    "solCoverZat": cover_zat.to_string(),
                    "covered": zec_root.sum <= 1_000_000_000u128 + cover_zat as u128},
        },
    })
}

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
    // API v0.17: v2 digest, same header and trees, plus the snapshot's quoteAssets.
    let quotes_json = json!([
        {"mint": "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "quote": "ZEC", "decimals": 8,
         "bridged": true, "counted": true, "dustBelow": "100000"},
        {"mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "quote": "USDC", "decimals": 6,
         "bridged": false, "counted": false, "dustBelow": "10000"},
    ]);
    let quotes: Vec<verify::QuoteAssetFact> = quotes_json
        .as_array()
        .unwrap()
        .iter()
        .map(|q| verify::QuoteAssetFact {
            mint: bs58::decode(q["mint"].as_str().unwrap())
                .into_vec()
                .unwrap()
                .try_into()
                .unwrap(),
            decimals: q["decimals"].as_u64().unwrap() as u8,
            bridged: q["bridged"].as_bool().unwrap(),
            counted: q["counted"].as_bool().unwrap(),
            dust_below: q["dustBelow"].as_str().unwrap().parse().unwrap(),
        })
        .collect();
    let digest_v2 = verify::roots_digest_v2(&header, &[(mint_b, mint_root), (verify::ZEC_ASSET, root)], &quotes);
    let vault = SigningKey::from_bytes(&[5; 32]);
    let vault_addr = bs58::encode(vault.verifying_key().to_bytes()).into_string();
    let msg = verify::vault_message("0202", snapshot_id, &vault_addr);
    json!({
        "_comment": "Verify vectors (API.md v0.7; creatorSnapshot: v0.10; snapshotV2: v0.17). Integers big-endian. Signing keys are ed25519 seeds of repeated bytes (TEST ONLY).",
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
        "creatorSnapshot": creator_snapshot(),
        "snapshotV2": {
            "_comment": "API v0.17: digestVersion 2 = the `snapshot` above (same header and trees) under the v2 tag, then u32(Q) and per quote asset by ascending mint bytes: mint[32] u8(decimals) u8(bridged) u8(counted) u64(dustBelow).",
            "digestVersion": 2,
            "quoteAssets": quotes_json,
            "rootsDigest": hex::encode(digest_v2),
            "operatorSig": bs58::encode(op.sign(&digest_v2).to_bytes()).into_string(),
            "quoteBytes": quotes.iter().map(|q| {
                let mut b = q.mint.to_vec();
                b.extend([q.decimals, u8::from(q.bridged), u8::from(q.counted)]);
                b.extend(q.dust_below.to_be_bytes());
                hex::encode(b)
            }).collect::<Vec<_>>(),
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

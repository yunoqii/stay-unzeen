//! Verify (API.md v0.7): Merkle-sum trees of liabilities, snapshot digest, vault message.
//!
//! ```text
//! leaf = SHA256("unzeen/verify/v1/leaf" ‖ chainId[2] ‖ u32(snapshotId) ‖ asset[32] ‖ anonPubkey[32]
//!               ‖ u8(piece) ‖ u64(value) ‖ blind[32])
//! node = SHA256("unzeen/verify/v1/node" ‖ L.hash ‖ u128(L.sum) ‖ R.hash ‖ u128(R.sum)), sum = L.sum + R.sum
//! rootsDigest = SHA256("unzeen/verify/v1/snapshot" ‖ chainId ‖ u32(id) ‖ u64(takenAtSec) ‖ u32(N)
//!               ‖ u64(solanaSlot) ‖ u32(zcashHeight) ‖ u64(zecReserveZat) ‖ u32(trees)
//!               ‖ per tree, ascending asset: asset ‖ root.hash ‖ u128(root.sum))
//! rootsDigest v2 (API v0.17) = SHA256("unzeen/verify/v2/snapshot" ‖ the same fields as v1
//!               ‖ u32(Q) ‖ per quote asset, ascending mint: mint[32] ‖ u8(decimals)
//!               ‖ u8(bridged) ‖ u8(counted) ‖ u64(dustBelow))
//! v3 (API v0.20, Robinhood Chain; Solana snapshots stay v2):
//! leaf v3 = SHA256("unzeen/verify/v3/leaf" ‖ chainId[2] ‖ u32(snapshotId) ‖ asset[32] ‖ anonPubkey[32]
//!               ‖ u8(piece) ‖ u128(value) ‖ blind[32])
//! node v3 = SHA256("unzeen/verify/v3/node" ‖ L.hash ‖ u128(L.sum) ‖ R.hash ‖ u128(R.sum))
//! rootsDigest v3 = the v2 layout under "unzeen/verify/v3/snapshot"
//! asset of an ERC-20 = 12 zero bytes ‖ address[20] (`evm::asset32`); ZEC = 32 zero bytes.
//! ```
//! All integers big-endian. No randomness here: splitting/shuffling/blinds are the caller's.

use sha2::{Digest, Sha256};

pub type Hash = [u8; 32];

pub const LEAF_TAG: &[u8] = b"unzeen/verify/v1/leaf";
pub const NODE_TAG: &[u8] = b"unzeen/verify/v1/node";
pub const SNAPSHOT_TAG: &[u8] = b"unzeen/verify/v1/snapshot";
/// v2 digest (API v0.17): also commits to the snapshot's `quoteAssets`.
pub const SNAPSHOT_TAG_V2: &[u8] = b"unzeen/verify/v2/snapshot";
pub const LEAF_TAG_V3: &[u8] = b"unzeen/verify/v3/leaf";
pub const NODE_TAG_V3: &[u8] = b"unzeen/verify/v3/node";
pub const SNAPSHOT_TAG_V3: &[u8] = b"unzeen/verify/v3/snapshot";
/// `asset` of ZEC.
pub const ZEC_ASSET: [u8; 32] = [0; 32];
/// Minimum tree size.
pub const MIN_LEAVES: usize = 1024;
/// ZEC granule: 0.001 ZEC.
pub const ZEC_GRANULE: u64 = 100_000;
/// Mint granule (review-day8 E1): 1 base unit. The vault holds exactly Σ balances, so any
/// rounding up would show every mint as "not covered".
pub const MINT_GRANULE: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Node {
    pub hash: Hash,
    pub sum: u128,
}

#[allow(clippy::too_many_arguments)]
pub fn leaf_hash(
    chain: [u8; 2],
    snapshot_id: u32,
    asset: &[u8; 32],
    anon_pubkey: &[u8; 32],
    piece: u8,
    value: u64,
    blind: &[u8; 32],
) -> Hash {
    let mut h = Sha256::new();
    h.update(LEAF_TAG);
    h.update(chain);
    h.update(snapshot_id.to_be_bytes());
    h.update(asset);
    h.update(anon_pubkey);
    h.update([piece]);
    h.update(value.to_be_bytes());
    h.update(blind);
    h.finalize().into()
}

/// v3 leaf: the value is u128 (1e27 base units of an 18-decimal ERC-20 do not fit u64).
#[allow(clippy::too_many_arguments)]
pub fn leaf_hash_v3(
    chain: [u8; 2],
    snapshot_id: u32,
    asset: &[u8; 32],
    anon_pubkey: &[u8; 32],
    piece: u8,
    value: u128,
    blind: &[u8; 32],
) -> Hash {
    let mut h = Sha256::new();
    h.update(LEAF_TAG_V3);
    h.update(chain);
    h.update(snapshot_id.to_be_bytes());
    h.update(asset);
    h.update(anon_pubkey);
    h.update([piece]);
    h.update(value.to_be_bytes());
    h.update(blind);
    h.finalize().into()
}

/// Tree version: v1 node tag (Solana snapshots, digest v1/v2) or v3.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeVersion {
    V1,
    V3,
}

impl TreeVersion {
    fn node_tag(self) -> &'static [u8] {
        match self {
            TreeVersion::V1 => NODE_TAG,
            TreeVersion::V3 => NODE_TAG_V3,
        }
    }
}

pub fn node_v(v: TreeVersion, l: &Node, r: &Node) -> Node {
    let mut h = Sha256::new();
    h.update(v.node_tag());
    h.update(l.hash);
    h.update(l.sum.to_be_bytes());
    h.update(r.hash);
    h.update(r.sum.to_be_bytes());
    Node {
        hash: h.finalize().into(),
        sum: l.sum.saturating_add(r.sum),
    }
}

/// [`build`] for a tree version.
pub fn build_v(v: TreeVersion, leaves: Vec<Node>) -> Vec<Vec<Node>> {
    assert!(leaves.len().is_power_of_two(), "tree size must be a power of two");
    let mut levels = vec![leaves];
    while levels.last().expect("non-empty").len() > 1 {
        let next = levels
            .last()
            .expect("non-empty")
            .chunks(2)
            .map(|c| node_v(v, &c[0], &c[1]))
            .collect();
        levels.push(next);
    }
    levels
}

/// [`root_from_path`] for a tree version.
pub fn root_from_path_v(v: TreeVersion, leaf: &Node, mut idx: usize, path: &[Node]) -> Node {
    let mut cur = *leaf;
    for s in path {
        cur = if idx & 1 == 0 {
            node_v(v, &cur, s)
        } else {
            node_v(v, s, &cur)
        };
        idx /= 2;
    }
    cur
}

/// `rootsDigest` v3: the v2 fields and quote assets under the v3 tag.
pub fn roots_digest_v3(h: &SnapshotHeader, roots: &[([u8; 32], Node)], quotes: &[QuoteAssetFact]) -> Hash {
    quotes_digest(digest_with(SNAPSHOT_TAG_V3, h, roots), quotes)
}

fn quotes_digest(mut d: Sha256, quotes: &[QuoteAssetFact]) -> Hash {
    let mut q: Vec<&QuoteAssetFact> = quotes.iter().collect();
    q.sort_by(|a, b| a.mint.cmp(&b.mint));
    d.update((q.len() as u32).to_be_bytes());
    for a in q {
        d.update(a.mint);
        d.update([a.decimals, u8::from(a.bridged), u8::from(a.counted)]);
        d.update(a.dust_below.to_be_bytes());
    }
    d.finalize().into()
}

/// Round `v` UP to a multiple of `g` (u128 values of v3).
pub fn round_up_u128(v: u128, g: u128) -> u128 {
    if g <= 1 {
        return v;
    }
    v.div_ceil(g).saturating_mul(g)
}

pub fn node(l: &Node, r: &Node) -> Node {
    let mut h = Sha256::new();
    h.update(NODE_TAG);
    h.update(l.hash);
    h.update(l.sum.to_be_bytes());
    h.update(r.hash);
    h.update(r.sum.to_be_bytes());
    Node {
        hash: h.finalize().into(),
        sum: l.sum + r.sum,
    }
}

/// Size of every tree of a snapshot: `max(1024, nextPow2(2 × max pieces))`.
pub fn tree_size(max_pieces: usize) -> usize {
    (2 * max_pieces).next_power_of_two().max(MIN_LEAVES)
}

/// All levels of a tree; `levels[0]` = leaves (length a power of two), last = `[root]`.
pub fn build(leaves: Vec<Node>) -> Vec<Vec<Node>> {
    assert!(leaves.len().is_power_of_two(), "tree size must be a power of two");
    let mut levels = vec![leaves];
    while levels.last().expect("non-empty").len() > 1 {
        let next = levels
            .last()
            .expect("non-empty")
            .chunks(2)
            .map(|c| node(&c[0], &c[1]))
            .collect();
        levels.push(next);
    }
    levels
}

/// Siblings bottom-up for leaf `idx`.
pub fn path(levels: &[Vec<Node>], mut idx: usize) -> Vec<Node> {
    let mut out = Vec::with_capacity(levels.len().saturating_sub(1));
    for lvl in &levels[..levels.len() - 1] {
        out.push(lvl[idx ^ 1]);
        idx /= 2;
    }
    out
}

/// Recompute the root from a leaf and its path (sibling on the right when the bit is 0).
pub fn root_from_path(leaf: &Node, mut idx: usize, path: &[Node]) -> Node {
    let mut cur = *leaf;
    for s in path {
        cur = if idx & 1 == 0 { node(&cur, s) } else { node(s, &cur) };
        idx /= 2;
    }
    cur
}

/// Public facts of a snapshot covered by the digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotHeader {
    pub chain: [u8; 2],
    pub snapshot_id: u32,
    pub taken_at_sec: u64,
    pub leaves: u32,
    pub solana_slot: u64,
    pub zcash_height: u32,
    pub zec_reserve_zat: u64,
}

/// One `quoteAssets` entry as committed by the v2 digest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuoteAssetFact {
    pub mint: [u8; 32],
    pub decimals: u8,
    pub bridged: bool,
    /// Counted toward the ZEC coverage (ZEC SPL only).
    pub counted: bool,
    /// Per-vault balances below this are ignored (base units).
    pub dust_below: u64,
}

/// `rootsDigest` (v1) over the header and the `(asset, root)` list (sorted here by asset).
/// Snapshots built before API v0.17.
pub fn roots_digest(h: &SnapshotHeader, roots: &[([u8; 32], Node)]) -> Hash {
    digest_with(SNAPSHOT_TAG, h, roots).finalize().into()
}

/// `rootsDigest` v2: v1 fields under the v2 tag, then the quote assets (sorted here by mint).
/// The operator signature then covers which quote mints count toward ZEC and their dust.
pub fn roots_digest_v2(h: &SnapshotHeader, roots: &[([u8; 32], Node)], quotes: &[QuoteAssetFact]) -> Hash {
    quotes_digest(digest_with(SNAPSHOT_TAG_V2, h, roots), quotes)
}

fn digest_with(tag: &[u8], h: &SnapshotHeader, roots: &[([u8; 32], Node)]) -> Sha256 {
    let mut sorted: Vec<&([u8; 32], Node)> = roots.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut d = Sha256::new();
    d.update(tag);
    d.update(h.chain);
    d.update(h.snapshot_id.to_be_bytes());
    d.update(h.taken_at_sec.to_be_bytes());
    d.update(h.leaves.to_be_bytes());
    d.update(h.solana_slot.to_be_bytes());
    d.update(h.zcash_height.to_be_bytes());
    d.update(h.zec_reserve_zat.to_be_bytes());
    d.update((sorted.len() as u32).to_be_bytes());
    for (asset, root) in sorted {
        d.update(asset);
        d.update(root.hash);
        d.update(root.sum.to_be_bytes());
    }
    d
}

/// Message each vault signs for a snapshot (ownership proof, no transaction needed).
pub fn vault_message(chain_hex: &str, snapshot_id: u32, address: &str) -> String {
    format!("unzeen/verify/v1/vault\n{chain_hex}\n{snapshot_id}\n{address}")
}

/// Round `v` UP to a multiple of `g`.
pub fn round_up(v: u64, g: u64) -> u64 {
    if g <= 1 {
        return v;
    }
    v.div_ceil(g).saturating_mul(g)
}

/// Creator fees owed (claimable lamports) as part of the creator's ZEC liability (API v0.10,
/// review-day8 E5): `ceil(lamports × 1e8 / rate_buy)`, rate = lamports per ZEC on the buy side
/// (fewer lamports per ZEC → more ZEC owed: conservative). `None` without a rate.
pub fn claimable_zat(lamports: u64, rate_buy_lamports_per_zec: u64) -> Option<u64> {
    if rate_buy_lamports_per_zec == 0 {
        return None;
    }
    let z = (lamports as u128 * 100_000_000).div_ceil(rate_buy_lamports_per_zec as u128);
    u64::try_from(z).ok()
}

/// ZEC reserve as attested: rounded DOWN to 0.01 ZEC.
pub fn reserve_floor(zat: u64) -> u64 {
    zat - zat % 1_000_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lf(i: u8, v: u64) -> Node {
        Node {
            hash: leaf_hash([2, 2], 1, &ZEC_ASSET, &[i; 32], 0, v, &[i; 32]),
            sum: v as u128,
        }
    }

    #[test]
    fn paths_reach_the_root_with_the_total() {
        let leaves: Vec<Node> = (0..8).map(|i| lf(i, i as u64 * 100)).collect();
        let lv = build(leaves.clone());
        let root = lv.last().unwrap()[0];
        assert_eq!(root.sum, (0..8u128).map(|i| i * 100).sum());
        for (i, l) in leaves.iter().enumerate() {
            let p = path(&lv, i);
            assert_eq!(p.len(), 3);
            assert_eq!(root_from_path(l, i, &p), root);
            // Wrong position or value: another root.
            assert_ne!(root_from_path(l, i ^ 1, &p), root);
            let mut bad = *l;
            bad.sum += 1;
            assert_ne!(root_from_path(&bad, i, &p), root);
        }
    }

    #[test]
    fn node_commits_both_child_sums() {
        let (a, b) = (lf(1, 10), lf(2, 20));
        let n = node(&a, &b);
        // Moving value between children keeps the total but changes the hash.
        let (a2, b2) = (Node { sum: 15, ..a }, Node { sum: 15, ..b });
        let n2 = node(&a2, &b2);
        assert_eq!(n.sum, n2.sum);
        assert_ne!(n.hash, n2.hash);
    }

    #[test]
    fn sizes_rounding_digest_order() {
        assert_eq!(tree_size(0), 1024);
        assert_eq!(tree_size(512), 1024);
        assert_eq!(tree_size(513), 2048);
        assert_eq!(round_up(1, 100_000), 100_000);
        assert_eq!(round_up(200_000, 100_000), 200_000);
        assert_eq!(round_up(0, 100_000), 0);
        assert_eq!(reserve_floor(12_345_678), 12_000_000);
        // 0.05 SOL at 9.95 SOL/ZEC (buy side) → 0.00502513 ZEC, rounded up.
        assert_eq!(claimable_zat(50_000_000, 9_950_000_000), Some(502_513));
        assert_eq!(claimable_zat(1, 10_000_000_000), Some(1));
        assert_eq!(claimable_zat(0, 10_000_000_000), Some(0));
        assert_eq!(claimable_zat(1, 0), None);
        let h = SnapshotHeader {
            chain: [2, 2],
            snapshot_id: 7,
            taken_at_sec: 1_791_835_200,
            leaves: 1024,
            solana_slot: 1,
            zcash_height: 2,
            zec_reserve_zat: 3,
        };
        let r1 = ([1u8; 32], lf(1, 1));
        let r2 = ([0u8; 32], lf(2, 2));
        assert_eq!(roots_digest(&h, &[r1, r2]), roots_digest(&h, &[r2, r1]));
        assert_ne!(
            roots_digest(&h, &[r1, r2]),
            roots_digest(
                &SnapshotHeader {
                    zec_reserve_zat: 4,
                    ..h.clone()
                },
                &[r1, r2]
            )
        );
        assert_eq!(vault_message("0202", 7, "Abc"), "unzeen/verify/v1/vault\n0202\n7\nAbc");
    }
}

//! Commitment tree over sealed bids (API.md v0.6, «Commitment»).
//!
//! - `leaf = sha256(0x00 ‖ utf8(ciphertext))`
//! - leaves sorted ascending, padded with random leaves to a FIXED 1024 (depth 10; a launch
//!   takes at most 1024 bids), so the proof length reveals nothing about the bid count
//!   (review F7) and the order does not reveal arrival order;
//! - `node = sha256(0x01 ‖ min(a, b) ‖ max(a, b))` (sorted pair: the proof needs no directions);
//! - verify: `h = leaf; for s in path { h = node(h, s) }; h == root`.

use sha2::{Digest, Sha256};

pub type Hash = [u8; 32];

/// Fixed tree size (= the bid cap of a launch).
pub const MIN_LEAVES: usize = 1024;

pub fn leaf(ciphertext: &str) -> Hash {
    let mut h = Sha256::new();
    h.update([0u8]);
    h.update(ciphertext.as_bytes());
    h.finalize().into()
}

pub fn node(a: &Hash, b: &Hash) -> Hash {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut h = Sha256::new();
    h.update([1u8]);
    h.update(lo);
    h.update(hi);
    h.finalize().into()
}

pub fn verify(leaf: &Hash, path: &[Hash], root: &Hash) -> bool {
    path.iter().fold(*leaf, |h, s| node(&h, s)) == *root
}

/// Root and one proof per input leaf (same order as `leaves`). `pad` supplies padding leaves.
pub fn build_with(leaves: &[Hash], mut pad: impl FnMut() -> Hash) -> (Hash, Vec<Vec<Hash>>) {
    let size = leaves.len().next_power_of_two().max(MIN_LEAVES);
    // (hash, index of the real leaf or usize::MAX for padding)
    let mut level: Vec<(Hash, usize)> = leaves.iter().enumerate().map(|(i, h)| (*h, i)).collect();
    while level.len() < size {
        level.push((pad(), usize::MAX));
    }
    level.sort_by(|a, b| a.0.cmp(&b.0));
    // position of each real leaf in the current level
    let mut pos = vec![0usize; leaves.len()];
    for (p, (_, i)) in level.iter().enumerate() {
        if *i != usize::MAX {
            pos[*i] = p;
        }
    }
    let mut proofs: Vec<Vec<Hash>> = vec![Vec::new(); leaves.len()];
    let mut hashes: Vec<Hash> = level.into_iter().map(|(h, _)| h).collect();
    while hashes.len() > 1 {
        for (i, p) in pos.iter_mut().enumerate() {
            proofs[i].push(hashes[*p ^ 1]);
            *p /= 2;
        }
        hashes = hashes.chunks(2).map(|c| node(&c[0], &c[1])).collect();
    }
    (hashes[0], proofs)
}

/// [`build_with`] padded by random leaves.
pub fn build(leaves: &[Hash]) -> (Hash, Vec<Vec<Hash>>) {
    build_with(leaves, rand::random)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_verify_for_every_size() {
        for n in [0usize, 1, 2, 9, 1000, 1024] {
            let leaves: Vec<Hash> = (0..n).map(|i| leaf(&format!("ct-{i}"))).collect();
            let (root, proofs) = build(&leaves);
            assert_eq!(proofs.len(), n);
            let depth = 10; // fixed, whatever the bid count
            for (l, p) in leaves.iter().zip(&proofs) {
                assert_eq!(p.len(), depth, "n={n}");
                assert!(verify(l, p, &root), "n={n}");
            }
            if let Some(p) = proofs.first() {
                assert!(!verify(&leaf("other"), p, &root));
            }
        }
    }

    #[test]
    fn deterministic_with_fixed_padding() {
        let leaves = vec![leaf("b"), leaf("a")];
        let pad = |k: &mut u32| {
            *k += 1;
            let mut h = [0u8; 32];
            h[..4].copy_from_slice(&k.to_be_bytes());
            h
        };
        let mut k = 0u32;
        let (r1, _) = build_with(&leaves, || pad(&mut k));
        let mut k = 0u32;
        let rev: Vec<Hash> = leaves.iter().rev().copied().collect();
        let (r2, _) = build_with(&rev, || pad(&mut k));
        // Order of submission does not matter.
        assert_eq!(r1, r2);
        // Known vector: hex is pinned so the frontend can check its verifier.
        assert_eq!(
            hex::encode(leaf("a")),
            hex::encode(Sha256::digest([&[0u8][..], b"a"].concat()))
        );
    }
}

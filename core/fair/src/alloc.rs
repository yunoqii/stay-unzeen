//! Allocation math of a fair launch (spec §4). All integers; no floats except the D10 shave.
//!
//! ```text
//! L_i = floor(b_i · r / 1e8)                 lamport equivalent of bid i (r = lamports per ZEC, buy)
//!       creator: L_c = min(L_c, creatorMax)  (5 % cap, spec §4 proof)
//! Σ   = Σ L_i;  if Σ > maxTotal: e_i = floor(L_i · maxTotal / Σ) else e_i = L_i
//! E   = Σ e_i;  lamports_in = D10(E)         (shave 0–1 %, round down to 0.001 SOL)
//! after the tx: T tokens for S lamports (S ≤ lamports_in ≤ E)
//! t_i      = floor(T · e_i / E)
//! spent_i  = ceil(S · e_i / E)               ≤ e_i ≤ L_i
//! charge_i = ceil(spent_i · 1e8 / r)         ≤ b_i ≤ hold_i
//! ```

/// 1 ZEC in zatoshis.
pub const ZAT_PER_ZEC: u128 = 100_000_000;
/// D10 rounding step of buys: 0.001 SOL.
pub const LAMPORTS_STEP: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValidBid {
    pub amount_zat: u64,
    pub is_creator: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Effective lamports per bid (same order as the input).
    pub effective: Vec<u64>,
    /// `E = Σ effective`.
    pub total: u64,
    pub oversubscribed: bool,
}

pub fn zat_to_lamports(zat: u64, rate: u64) -> u64 {
    ((zat as u128) * (rate as u128) / ZAT_PER_ZEC).min(u64::MAX as u128) as u64
}

/// Effective lamports of every valid bid.
pub fn plan(bids: &[ValidBid], rate: u64, max_total: u64, creator_max: u64) -> Plan {
    let l: Vec<u64> = bids
        .iter()
        .map(|b| {
            let v = zat_to_lamports(b.amount_zat, rate);
            if b.is_creator { v.min(creator_max) } else { v }
        })
        .collect();
    let sum: u128 = l.iter().map(|v| *v as u128).sum();
    let oversubscribed = sum > max_total as u128;
    let effective: Vec<u64> = if oversubscribed {
        l.iter()
            .map(|v| ((*v as u128) * (max_total as u128) / sum) as u64)
            .collect()
    } else {
        l
    };
    let total = effective.iter().sum();
    Plan {
        effective,
        total,
        oversubscribed,
    }
}

/// D10 for the launch buy: shave `0..1 %` (`u` uniform in [0, 1)) and round DOWN to 0.001 SOL.
pub fn fuzz_lamports(lamports: u64, u: f64) -> u64 {
    let shaved = (lamports as f64 * (1.0 - 0.01 * u.clamp(0.0, 1.0))) as u64;
    shaved.min(lamports) / LAMPORTS_STEP * LAMPORTS_STEP
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Share {
    pub tokens: u64,
    pub spent_lamports: u64,
    pub charge_zat: u64,
}

/// Share of one participant once the launch tx is confirmed with `tokens_total` (T) for
/// `lamports_spent` (S). `charge_zat` is capped by `amount_zat` (never needed by the math, but
/// a hold must never be overdrawn).
pub fn share(e_i: u64, total_e: u64, tokens_total: u64, lamports_spent: u64, rate: u64, amount_zat: u64) -> Share {
    if total_e == 0 || rate == 0 {
        return Share {
            tokens: 0,
            spent_lamports: 0,
            charge_zat: 0,
        };
    }
    let (e, big_e) = (e_i as u128, total_e as u128);
    let tokens = ((tokens_total as u128) * e / big_e) as u64;
    let spent = ((lamports_spent as u128) * e).div_ceil(big_e) as u64;
    let charge = ((spent as u128) * ZAT_PER_ZEC)
        .div_ceil(rate as u128)
        .min(amount_zat as u128) as u64;
    Share {
        tokens,
        spent_lamports: spent,
        charge_zat: charge,
    }
}

/// Tokens a buy of `lamports` gets from a fresh constant-product curve (upper bound, no fees).
pub fn curve_tokens_out(virtual_sol: u64, virtual_tokens: u64, lamports: u64) -> u64 {
    let (s, t) = (virtual_sol as u128, virtual_tokens as u128);
    if s == 0 {
        return 0;
    }
    let left = (s * t).div_ceil(s + lamports as u128);
    (t - left.min(t)) as u64
}

/// Largest multiple of 0.001 SOL whose fresh-curve output stays within `cap` tokens.
pub fn curve_max_lamports(virtual_sol: u64, virtual_tokens: u64, cap: u64) -> u64 {
    let (s, t) = (virtual_sol as u128, virtual_tokens as u128);
    if cap as u128 >= t {
        return u64::MAX - u64::MAX % LAMPORTS_STEP;
    }
    let x = (s * t / (t - cap as u128)).saturating_sub(s).min(u64::MAX as u128) as u64;
    x - x % LAMPORTS_STEP
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 10 SOL per ZEC.
    const R: u64 = 10_000_000_000;

    fn bid(z: u64) -> ValidBid {
        ValidBid {
            amount_zat: z,
            is_creator: false,
        }
    }

    #[test]
    fn pro_rata_without_oversubscription() {
        let p = plan(&[bid(10_000_000), bid(30_000_000)], R, u64::MAX, u64::MAX);
        assert_eq!(p.effective, vec![1_000_000_000, 3_000_000_000]);
        assert_eq!(p.total, 4_000_000_000);
        assert!(!p.oversubscribed);
    }

    #[test]
    fn oversubscription_scales_everyone_equally() {
        // 4 SOL of bids, cap 2 SOL: everyone gets half.
        let p = plan(&[bid(10_000_000), bid(30_000_000)], R, 2_000_000_000, u64::MAX);
        assert!(p.oversubscribed);
        assert_eq!(p.effective, vec![500_000_000, 1_500_000_000]);
        assert!(p.total <= 2_000_000_000);
    }

    #[test]
    fn creator_is_capped() {
        let c = ValidBid {
            amount_zat: 50_000_000,
            is_creator: true,
        };
        let p = plan(&[c, bid(50_000_000)], R, u64::MAX, 1_466_000_000);
        assert_eq!(p.effective, vec![1_466_000_000, 5_000_000_000]);
    }

    #[test]
    fn creator_share_within_cap_by_concavity() {
        // devnet-like curve: 1 SOL virtual, 1.073e15 virtual tokens; 5 % of 1e15 supply.
        let (vs, vt, supply) = (1_000_000_000u64, 1_073_000_000_000_000u64, 1_000_000_000_000_000u64);
        let cap = supply / 20;
        let creator_max = curve_max_lamports(vs, vt, cap);
        let c = ValidBid {
            amount_zat: 1_000_000_000,
            is_creator: true,
        };
        let others = [bid(3_000_000), bid(7_000_000), bid(1_000_000_000)];
        let mut all = vec![c];
        all.extend_from_slice(&others);
        let max_total = curve_max_lamports(vs, vt, supply / 4);
        let p = plan(&all, R, max_total, creator_max);
        let l_tx = fuzz_lamports(p.total, 0.7);
        let t = curve_tokens_out(vs, vt, l_tx);
        let s = share(p.effective[0], p.total, t, l_tx, R, c.amount_zat);
        assert!(s.tokens <= cap, "{} > {cap}", s.tokens);
        assert!(t <= supply / 4);
    }

    #[test]
    fn rounding_invariants() {
        let mut seed = 0x1234_5678_9abc_def0u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..500 {
            let n = (next() % 9 + 1) as usize;
            let rate = 1_000_000_000 + next() % 20_000_000_000;
            let bids: Vec<ValidBid> = (0..n)
                .map(|i| ValidBid {
                    amount_zat: 100_000 + next() % 1_000_000_000,
                    is_creator: i == 0,
                })
                .collect();
            let max_total = 100_000_000 + next() % 20_000_000_000;
            let p = plan(&bids, rate, max_total, 1_466_000_000);
            assert!(p.total <= max_total || !p.oversubscribed);
            let l_tx = fuzz_lamports(p.total, (next() % 1000) as f64 / 1000.0);
            assert!(l_tx <= p.total && l_tx.is_multiple_of(LAMPORTS_STEP));
            let t = next() % 1_000_000_000_000_000;
            let s_spent = l_tx - (next() % (l_tx / 100 + 1));
            let mut tok = 0u128;
            for (b, e) in bids.iter().zip(&p.effective) {
                let sh = share(*e, p.total, t, s_spent, rate, b.amount_zat);
                tok += sh.tokens as u128;
                assert!(sh.spent_lamports <= *e, "spent ≤ e");
                // charge ≤ amount without the cap (math, not clamp)
                let raw = ((sh.spent_lamports as u128) * ZAT_PER_ZEC).div_ceil(rate as u128);
                assert!(raw <= b.amount_zat as u128, "charge ≤ bid");
            }
            assert!(tok <= t as u128, "Σ t_i ≤ T");
        }
    }

    #[test]
    fn curve_helpers_match_api_launch_math() {
        // mainnet Global: 30 SOL; 5 % → 1.466 SOL (as core/api/src/launch.rs); 25 % ≈ 9.11 SOL.
        let (vs, vt) = (30_000_000_000u64, 1_073_000_000_000_000u64);
        assert_eq!(curve_max_lamports(vs, vt, 50_000_000_000_000), 1_466_000_000);
        let q = curve_max_lamports(vs, vt, 250_000_000_000_000);
        assert!((9_100_000_000..9_120_000_000).contains(&q), "{q}");
        // devnet Global: 1 SOL → 25 % ≈ 0.304 SOL.
        let d = curve_max_lamports(1_000_000_000, vt, 250_000_000_000_000);
        assert!((303_000_000..305_000_000).contains(&d), "{d}");
        assert_eq!(fuzz_lamports(999_999, 0.0), 0);
        assert_eq!(fuzz_lamports(5_766_050_000, 0.0), 5_766_000_000);
    }
}

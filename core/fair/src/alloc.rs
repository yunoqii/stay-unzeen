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
pub const LAMPORTS_STEP: u128 = 1_000_000;

/// `floor(a × b / d)` with a 256-bit intermediate product (v0.20: wei × 1e27-token products
/// pass u128). `None` if `d = 0` or the quotient does not fit u128.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    mul_div_rem(a, b, d).map(|x| x.0)
}

/// `ceil(a × b / d)`, 256-bit intermediate.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let (q, r) = mul_div_rem(a, b, d)?;
    if r == 0 { Some(q) } else { q.checked_add(1) }
}

/// (quotient, remainder) of `a × b / d`.
fn mul_div_rem(a: u128, b: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 {
        return None;
    }
    const M: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & M, b >> 64, b & M);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    if hi >= d {
        return None;
    }
    let (mut rem, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    Some((q, rem))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValidBid {
    pub amount_zat: u64,
    pub is_creator: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Effective native units (lamports / wei) per bid (same order as the input).
    pub effective: Vec<u128>,
    /// `E = Σ effective`.
    pub total: u128,
    pub oversubscribed: bool,
}

pub fn zat_to_lamports(zat: u64, rate: u64) -> u128 {
    (zat as u128) * (rate as u128) / ZAT_PER_ZEC
}

/// Effective native units of every valid bid.
pub fn plan(bids: &[ValidBid], rate: u64, max_total: u128, creator_max: u128) -> Plan {
    let l: Vec<u128> = bids
        .iter()
        .map(|b| {
            let v = zat_to_lamports(b.amount_zat, rate);
            if b.is_creator { v.min(creator_max) } else { v }
        })
        .collect();
    let sum: u128 = l.iter().fold(0u128, |a, v| a.saturating_add(*v));
    let oversubscribed = sum > max_total;
    let effective: Vec<u128> = if oversubscribed {
        l.iter().map(|v| mul_div(*v, max_total, sum).unwrap_or(0)).collect()
    } else {
        l
    };
    let total = effective.iter().fold(0u128, |a, v| a.saturating_add(*v));
    Plan {
        effective,
        total,
        oversubscribed,
    }
}

/// D10 for the launch buy: shave `0..1 %` (`u` uniform in [0, 1)) and round DOWN to 0.001 SOL.
pub fn fuzz_lamports(lamports: u128, u: f64) -> u128 {
    fuzz_step(lamports, u, LAMPORTS_STEP)
}

/// [`fuzz_lamports`] with another step (0.0001 ETH = 1e14 wei on Robinhood Chain).
pub fn fuzz_step(units: u128, u: f64, step: u128) -> u128 {
    let shaved = (units as f64 * (1.0 - 0.01 * u.clamp(0.0, 1.0))) as u128;
    let step = step.max(1);
    shaved.min(units) / step * step
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Share {
    pub tokens: u128,
    pub spent_lamports: u128,
    pub charge_zat: u64,
}

/// Share of one participant once the launch tx is confirmed with `tokens_total` (T) for
/// `lamports_spent` (S). `charge_zat` is capped by `amount_zat` (never needed by the math, but
/// a hold must never be overdrawn).
pub fn share(e_i: u128, total_e: u128, tokens_total: u128, lamports_spent: u128, rate: u64, amount_zat: u64) -> Share {
    if total_e == 0 || rate == 0 {
        return Share {
            tokens: 0,
            spent_lamports: 0,
            charge_zat: 0,
        };
    }
    let tokens = mul_div(tokens_total, e_i, total_e).unwrap_or(0);
    let spent = mul_div_ceil(lamports_spent, e_i, total_e).unwrap_or(0);
    let charge = mul_div_ceil(spent, ZAT_PER_ZEC, rate as u128)
        .unwrap_or(u128::MAX)
        .min(amount_zat as u128) as u64;
    Share {
        tokens,
        spent_lamports: spent,
        charge_zat: charge,
    }
}

/// Tokens a buy of `lamports` gets from a fresh constant-product curve (upper bound, no fees):
/// `T − ceil(S·T / (S + x)) = floor(T·x / (S + x))`.
pub fn curve_tokens_out(virtual_sol: u128, virtual_tokens: u128, lamports: u128) -> u128 {
    if virtual_sol == 0 {
        return 0;
    }
    mul_div(virtual_tokens, lamports, virtual_sol.saturating_add(lamports)).unwrap_or(0)
}

/// Largest multiple of `step` whose fresh-curve output stays within `cap` tokens.
pub fn curve_max_units(virtual_sol: u128, virtual_tokens: u128, cap: u128, step: u128) -> u128 {
    let step = step.max(1);
    if cap >= virtual_tokens {
        return u128::MAX - u128::MAX % step;
    }
    let x = mul_div(virtual_sol, virtual_tokens, virtual_tokens - cap)
        .unwrap_or(u128::MAX)
        .saturating_sub(virtual_sol);
    x - x % step
}

/// [`curve_max_units`] in 0.001 SOL steps.
pub fn curve_max_lamports(virtual_sol: u128, virtual_tokens: u128, cap: u128) -> u128 {
    curve_max_units(virtual_sol, virtual_tokens, cap, LAMPORTS_STEP)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 10 SOL per ZEC.
    const R: u64 = 10_000_000_000;
    const MAXU: u128 = u128::MAX;

    fn bid(z: u64) -> ValidBid {
        ValidBid {
            amount_zat: z,
            is_creator: false,
        }
    }

    #[test]
    fn pro_rata_without_oversubscription() {
        let p = plan(&[bid(10_000_000), bid(30_000_000)], R, MAXU, MAXU);
        assert_eq!(p.effective, vec![1_000_000_000, 3_000_000_000]);
        assert_eq!(p.total, 4_000_000_000);
        assert!(!p.oversubscribed);
    }

    #[test]
    fn oversubscription_scales_everyone_equally() {
        // 4 SOL of bids, cap 2 SOL: everyone gets half.
        let p = plan(&[bid(10_000_000), bid(30_000_000)], R, 2_000_000_000, MAXU);
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
        let p = plan(&[c, bid(50_000_000)], R, MAXU, 1_466_000_000);
        assert_eq!(p.effective, vec![1_466_000_000, 5_000_000_000]);
    }

    #[test]
    fn creator_share_within_cap_by_concavity() {
        // devnet-like curve: 1 SOL virtual, 1.073e15 virtual tokens; 5 % of 1e15 supply.
        let (vs, vt, supply) = (1_000_000_000u128, 1_073_000_000_000_000u128, 1_000_000_000_000_000u128);
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
            let max_total = (100_000_000 + next() % 20_000_000_000) as u128;
            let p = plan(&bids, rate, max_total, 1_466_000_000);
            assert!(p.total <= max_total || !p.oversubscribed);
            let l_tx = fuzz_lamports(p.total, (next() % 1000) as f64 / 1000.0);
            assert!(l_tx <= p.total && l_tx.is_multiple_of(LAMPORTS_STEP));
            let t = (next() % 1_000_000_000_000_000) as u128;
            let s_spent = l_tx - (next() as u128 % (l_tx / 100 + 1));
            let mut tok = 0u128;
            for (b, e) in bids.iter().zip(&p.effective) {
                let sh = share(*e, p.total, t, s_spent, rate, b.amount_zat);
                tok += sh.tokens;
                assert!(sh.spent_lamports <= *e, "spent ≤ e");
                // charge ≤ amount without the cap (math, not clamp)
                let raw = (sh.spent_lamports * ZAT_PER_ZEC).div_ceil(rate as u128);
                assert!(raw <= b.amount_zat as u128, "charge ≤ bid");
            }
            assert!(tok <= t, "Σ t_i ≤ T");
        }
    }

    #[test]
    fn curve_helpers_match_api_launch_math() {
        // mainnet Global: 30 SOL; 5 % → 1.466 SOL (as core/api/src/launch.rs); 25 % ≈ 9.11 SOL.
        let (vs, vt) = (30_000_000_000u128, 1_073_000_000_000_000u128);
        assert_eq!(curve_max_lamports(vs, vt, 50_000_000_000_000), 1_466_000_000);
        let q = curve_max_lamports(vs, vt, 250_000_000_000_000);
        assert!((9_100_000_000..9_120_000_000).contains(&q), "{q}");
        // devnet Global: 1 SOL → 25 % ≈ 0.304 SOL.
        let d = curve_max_lamports(1_000_000_000, vt, 250_000_000_000_000);
        assert!((303_000_000..305_000_000).contains(&d), "{d}");
        assert_eq!(fuzz_lamports(999_999, 0.0), 0);
        assert_eq!(fuzz_lamports(5_766_050_000, 0.0), 5_766_000_000);
    }

    #[test]
    fn wide_math_and_wei_scale() {
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), Some(u128::MAX));
        assert_eq!(
            mul_div(10u128.pow(27), 10u128.pow(20), 10u128.pow(20)),
            Some(10u128.pow(27))
        );
        assert_eq!(mul_div(u128::MAX, 2, 1), None);
        assert_eq!(mul_div(7, 3, 2), Some(10));
        assert_eq!(mul_div_ceil(7, 3, 2), Some(11));
        assert_eq!(mul_div_ceil(6, 3, 2), Some(9));
        assert_eq!(
            mul_div_ceil(10u128.pow(30), 10u128.pow(20), 10u128.pow(20)),
            Some(10u128.pow(30))
        );
        assert_eq!(
            mul_div_ceil(10u128.pow(25) + 1, 10u128.pow(13), 3),
            Some(33333333333333333333333336666666666667)
        );
        assert_eq!(mul_div(10u128.pow(30) + 1, 10u128.pow(20), 3), None, "quotient > u128");
        // A Pons-sized curve: 1e27 tokens, 1.5 ETH virtual; 1 ETH buy ≈ 40 % of the tokens.
        let (vs, vt) = (1_500_000_000_000_000_000u128, 10u128.pow(27));
        let out = curve_tokens_out(vs, vt, 10u128.pow(18));
        assert_eq!(out, 400_000_000_000_000_000_000_000_000);
        let cap = 5 * 10u128.pow(25);
        let x = curve_max_units(vs, vt, cap, 100_000_000_000_000);
        assert!(curve_tokens_out(vs, vt, x) <= cap && curve_tokens_out(vs, vt, x + 100_000_000_000_000) > cap);
        // Shares at wei scale stay exact sums.
        let p = plan(
            &[bid(50_000_000), bid(150_000_000)],
            485_000_000_000_000_000,
            MAXU,
            MAXU,
        );
        let sh = share(
            p.effective[1],
            p.total,
            10u128.pow(27),
            p.total,
            485_000_000_000_000_000,
            150_000_000,
        );
        assert_eq!(sh.tokens, 750_000_000_000_000_000_000_000_000);
        assert_eq!(sh.charge_zat, 150_000_000);
    }
}

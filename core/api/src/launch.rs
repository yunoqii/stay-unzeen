//! Creator rules of Unzeen launches (API v0.5): token estimates for the creator cap.
//!
//! The launch curve is a constant-product virtual-reserve curve (pump.fun bonding curve:
//! `tokens_out = T - k / (S + x)`, `k = S * T`). The initial state gives the cheapest price
//! the curve can ever have, so `tokens_out` from the initial state is an UPPER bound of what
//! any buy of `x` lamports can get on that curve (fees only lower it). The cap check uses
//! upper bounds, so it can only refuse too much, never let a buy past the cap.

use crate::rate::LAMPORTS_STEP;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    /// Initial virtual SOL reserves, lamports.
    pub virtual_sol: u64,
    /// Initial virtual token reserves, base units.
    pub virtual_tokens: u64,
}

impl Curve {
    /// Tokens (base units) a buy of `lamports` gets from the initial curve state, fees ignored.
    pub fn tokens_out_initial(&self, lamports: u64) -> u64 {
        let (s, t) = (self.virtual_sol as u128, self.virtual_tokens as u128);
        if s == 0 {
            return 0;
        }
        let k = s * t;
        let left = k.div_ceil(s + lamports as u128);
        (t - left.min(t)) as u64
    }

    /// Largest multiple of 0.001 SOL whose initial-curve output stays within `cap` tokens.
    pub fn max_lamports_within(&self, cap: u64) -> u64 {
        let (s, t) = (self.virtual_sol as u128, self.virtual_tokens as u128);
        if cap as u128 >= t {
            return u64::MAX - u64::MAX % LAMPORTS_STEP;
        }
        // s + x <= k / (t - cap)  <=>  k / (s + x) >= t - cap  <=>  out <= cap
        let x = (s * t / (t - cap as u128)).saturating_sub(s);
        let x = x.min(u64::MAX as u128) as u64;
        let x = x - x % LAMPORTS_STEP;
        debug_assert!(self.tokens_out_initial(x) <= cap);
        x
    }
}

/// Tokens a buy of `lamports` gets at the spot price `lamports_per_whole` (SOL per whole token
/// in lamports): an upper bound while the price only rises during the buy.
pub fn tokens_at_spot(lamports: u64, lamports_per_whole: u64, decimals: i16) -> Option<u64> {
    if lamports_per_whole == 0 {
        return None;
    }
    let scale = 10u128.checked_pow(u32::try_from(decimals).ok()?)?;
    let v = (lamports as u128).checked_mul(scale)? / lamports_per_whole as u128;
    Some(v.min(u64::MAX as u128) as u64)
}

/// Upper-bound estimate of a buy for the creator cap: the smaller of the initial-curve and
/// spot bounds, never below the signed `min_out` (the buy fails below it anyway).
pub fn buy_gain_estimate(curve: &Curve, lamports: u64, spot: Option<u64>, min_out: u64) -> u64 {
    let initial = curve.tokens_out_initial(lamports);
    spot.map_or(initial, |s| s.min(initial)).max(min_out)
}

/// Public rule ids of an Unzeen launch (`TokenSafety.unzeen.rules`).
pub fn rule_ids(lock_secs: u64, cap_bps: u64, authorities_revoked: bool) -> Vec<String> {
    let mut out = Vec::new();
    if lock_secs > 0 {
        out.push(format!("creator_initial_buy_locked_{}h", lock_secs.div_ceil(3600)));
    }
    if cap_bps > 0 {
        out.push(if cap_bps.is_multiple_of(100) {
            format!("initial_buy_cap_{}pct", cap_bps / 100)
        } else {
            format!("initial_buy_cap_{cap_bps}bps")
        });
    }
    if authorities_revoked {
        out.push("authorities_revoked".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUMP: Curve = Curve {
        virtual_sol: 30_000_000_000,
        virtual_tokens: 1_073_000_000_000_000,
    };
    /// 5 % of 1e9 tokens with 6 decimals.
    const CAP: u64 = 50_000_000_000_000;

    #[test]
    fn initial_curve_output() {
        assert_eq!(PUMP.tokens_out_initial(0), 0);
        // 1 SOL from the initial state: ~34.6M tokens (pump.fun UI shows ~34.6M before fees).
        let one = PUMP.tokens_out_initial(1_000_000_000);
        assert!((34_600_000_000_000..34_700_000_000_000).contains(&one), "{one}");
        // Monotone in the amount.
        assert!(PUMP.tokens_out_initial(2_000_000_000) > one);
        // Never more than the virtual reserves.
        assert!(PUMP.tokens_out_initial(u64::MAX) < PUMP.virtual_tokens);
    }

    #[test]
    fn max_initial_buy_for_5pct() {
        let x = PUMP.max_lamports_within(CAP);
        // 30 SOL * 50 / 1023 = 1.4663 SOL, rounded down to 0.001 SOL.
        assert_eq!(x, 1_466_000_000);
        assert!(PUMP.tokens_out_initial(x) <= CAP);
        assert!(PUMP.tokens_out_initial(x + LAMPORTS_STEP) > CAP);
        assert_eq!(x % LAMPORTS_STEP, 0);
    }

    #[test]
    fn gain_estimate_is_an_upper_bound() {
        let l = 1_000_000_000;
        let initial = PUMP.tokens_out_initial(l);
        // Price 10x the initial one: spot bound is the smaller.
        let spot = tokens_at_spot(l, 279, 6).unwrap(); // ~2.79e-7 SOL per token
        assert!(spot < initial);
        assert_eq!(buy_gain_estimate(&PUMP, l, Some(spot), 0), spot);
        // Unknown price: the initial curve.
        assert_eq!(buy_gain_estimate(&PUMP, l, None, 0), initial);
        // Never below the signed minOut.
        assert_eq!(buy_gain_estimate(&PUMP, l, Some(10), 1_000), 1_000);
        assert_eq!(tokens_at_spot(l, 0, 6), None);
        assert_eq!(tokens_at_spot(1_000, 1_000_000_000, 6), Some(1)); // 1e-6 SOL at 1 SOL per token
    }

    #[test]
    fn rules() {
        assert_eq!(
            rule_ids(86_400, 500, true),
            vec![
                "creator_initial_buy_locked_24h",
                "initial_buy_cap_5pct",
                "authorities_revoked"
            ]
        );
        assert_eq!(rule_ids(0, 250, false), vec!["initial_buy_cap_250bps"]);
        assert_eq!(rule_ids(3_601, 0, false), vec!["creator_initial_buy_locked_2h"]);
        assert!(rule_ids(0, 0, false).is_empty());
    }
}

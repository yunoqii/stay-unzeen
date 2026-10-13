//! Creator rules of Unzeen launches (API v0.5): token estimates for the creator cap.
//!
//! The launch curve is a constant-product virtual-reserve curve (pump.fun bonding curve:
//! `tokens_out = T - k / (S + x)`, `k = S * T`). The initial state gives the cheapest price
//! the curve can ever have, so `tokens_out` from the initial state is an UPPER bound of what
//! any buy of `x` lamports can get on that curve (fees only lower it). The cap check uses
//! upper bounds, so it can only refuse too much, never let a buy past the cap.

use unzeen_fair::alloc::mul_div;

/// D10 step of SOL launches (0.001 SOL); Robinhood Chain uses `rate::WEI_STEP`.
pub const LAMPORTS_STEP: u128 = crate::rate::LAMPORTS_STEP as u128;

/// Native units are lamports on Solana and wei on Robinhood Chain; token amounts are base units
/// (an 18-decimal Pons supply is 1e27). All u128 with 256-bit intermediates (API v0.20).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    /// Initial virtual native reserves.
    pub virtual_sol: u128,
    /// Initial virtual token reserves, base units.
    pub virtual_tokens: u128,
}

impl Curve {
    /// Tokens (base units) a buy of `units` gets from the initial curve state, fees ignored:
    /// `floor(T·x / (S + x))` (= `T − ceil(S·T / (S + x))`).
    pub fn tokens_out_initial(&self, units: u128) -> u128 {
        unzeen_fair::alloc::curve_tokens_out(self.virtual_sol, self.virtual_tokens, units)
    }

    /// Largest multiple of 0.001 SOL whose initial-curve output stays within `cap` tokens.
    pub fn max_lamports_within(&self, cap: u128) -> u128 {
        self.max_units_within(cap, LAMPORTS_STEP)
    }

    /// Largest multiple of `step` whose initial-curve output stays within `cap` tokens.
    pub fn max_units_within(&self, cap: u128, step: u128) -> u128 {
        let x = unzeen_fair::alloc::curve_max_units(self.virtual_sol, self.virtual_tokens, cap, step);
        debug_assert!(x == u128::MAX - u128::MAX % step.max(1) || self.tokens_out_initial(x) <= cap);
        x
    }
}

/// Tokens a buy of `units` gets at the spot price `units_per_whole` (native units per whole
/// token): an upper bound while the price only rises during the buy.
pub fn tokens_at_spot(units: u128, units_per_whole: u128, decimals: i16) -> Option<u128> {
    if units_per_whole == 0 {
        return None;
    }
    let scale = 10u128.checked_pow(u32::try_from(decimals).ok()?)?;
    Some(mul_div(units, scale, units_per_whole).unwrap_or(u128::MAX))
}

/// Upper-bound estimate of a buy for the creator cap: the smaller of the initial-curve and
/// spot bounds, never below the signed `min_out` (the buy fails below it anyway).
pub fn buy_gain_estimate(curve: &Curve, units: u128, spot: Option<u128>, min_out: u128) -> u128 {
    let initial = curve.tokens_out_initial(units);
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
    const CAP: u128 = 50_000_000_000_000;

    #[test]
    fn initial_curve_output() {
        assert_eq!(PUMP.tokens_out_initial(0), 0);
        // 1 SOL from the initial state: ~34.6M tokens (pump.fun UI shows ~34.6M before fees).
        let one = PUMP.tokens_out_initial(1_000_000_000);
        assert!((34_600_000_000_000..34_700_000_000_000).contains(&one), "{one}");
        // Monotone in the amount.
        assert!(PUMP.tokens_out_initial(2_000_000_000) > one);
        // Never more than the virtual reserves.
        assert!(PUMP.tokens_out_initial(u64::MAX as u128) < PUMP.virtual_tokens);
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

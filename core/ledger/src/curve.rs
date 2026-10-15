//! Price impact of a trade on a pump.fun-style bonding curve (devnet run 15.10, B2).
//!
//! The curve is constant product over virtual reserves: `S · T = k` with `k = S0 · T0` fixed by
//! the venue's launch parameters (`launch_curves`, written by the relayer from the pump Global).
//! The spot price is `p = S / T` (lamports per token base unit), so the current reserves follow
//! from the spot price alone: `S = √(k·p)`, `T = √(k/p)`. A sell of `a` base units then returns
//! `S·a / (T + a)` lamports and a buy of `x` lamports returns `T·x / (S + x)` base units
//! (venue fees ignored: the slippage tolerance covers them, as it did with the spot estimate).
//!
//! A spot estimate ignores the impact: selling 100 % of a position on the 0.3 SOL devnet curve
//! landed 6.7 % below it. Only for SOL-paired curve tokens of the venue the row describes; any
//! overflow or missing input gives `None` and the caller keeps the spot estimate.

use unzeen_fair::alloc::mul_div;

/// Lamports have 9 decimals; prices are decimal SOL per whole token × 1e18.
const NATIVE_DECIMALS: u32 = 9;

/// Initial virtual reserves of the venue's curve (`launch_curves`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurveParams {
    pub virtual_sol: u128,
    pub virtual_tokens: u128,
}

/// Integer square root (floor).
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << (n.ilog2() / 2 + 1);
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

impl CurveParams {
    /// Current `(S lamports, T base units)` at the spot price `price_e18` (SOL per whole token
    /// × 1e18) of a token with `decimals`.
    pub fn reserves_at(&self, price_e18: u128, decimals: u32) -> Option<(u128, u128)> {
        if price_e18 == 0 || self.virtual_sol == 0 || self.virtual_tokens == 0 {
            return None;
        }
        let k = self.virtual_sol.checked_mul(self.virtual_tokens)?;
        // p = price_e18 / 10^(18 − 9 + decimals) lamports per base unit.
        let den = 10u128.checked_pow(18 - NATIVE_DECIMALS + decimals)?;
        let s = isqrt(mul_div(k, price_e18, den)?);
        if s == 0 {
            return None;
        }
        Some((s, k / s))
    }

    /// Lamports a sell of `amount` base units returns at spot `price_e18`, impact included.
    pub fn sell_out(&self, price_e18: u128, decimals: u32, amount: u128) -> Option<u128> {
        let (s, t) = self.reserves_at(price_e18, decimals)?;
        mul_div(s, amount, t.checked_add(amount)?)
    }

    /// Base units a buy of `lamports` returns at spot `price_e18`, impact included.
    pub fn buy_out(&self, price_e18: u128, decimals: u32, lamports: u128) -> Option<u128> {
        let (s, t) = self.reserves_at(price_e18, decimals)?;
        mul_div(t, lamports, s.checked_add(lamports)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// pump.fun devnet Global on 15.10: 0.3 SOL / 1.073e15 base units (6 decimals).
    const DEVNET: CurveParams = CurveParams {
        virtual_sol: 300_000_000,
        virtual_tokens: 1_073_000_000_000_000,
    };

    fn price_e18(s: u128, t: u128, decimals: u32) -> u128 {
        // SOL per whole token × 1e18 = S/T · 10^(decimals) / 1e9 · 1e18
        mul_div(s, 10u128.pow(decimals + 9), t).unwrap()
    }

    #[test]
    fn isqrt_floor() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 10u128.pow(30), u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n, "{n}");
            assert!((r + 1).checked_mul(r + 1).is_none_or(|q| q > n), "{n}");
        }
    }

    #[test]
    fn devnet_curve_matches_exact_amm_math() {
        // A fresh token after a 0.013 SOL creator buy, then a 0.57 SOL buy (the run's a3):
        // reserves recovered from the spot price equal the true reserves within rounding.
        let k = DEVNET.virtual_sol * DEVNET.virtual_tokens;
        for spent in [0u128, 13_000_000, 583_000_000] {
            let s = DEVNET.virtual_sol + spent;
            let t = k / s;
            let (s2, t2) = DEVNET.reserves_at(price_e18(s, t, 6), 6).unwrap();
            assert!(s2.abs_diff(s) * 1_000_000 <= s, "S {s2} vs {s}");
            assert!(t2.abs_diff(t) * 1_000_000 <= t, "T {t2} vs {t}");
            // Sell of a big position: exact AMM output vs the estimate.
            let a = 640_000_000_000_000u128.min(t / 2);
            let exact = s * a / (t + a);
            let est = DEVNET.sell_out(price_e18(s, t, 6), 6, a).unwrap();
            assert!(est.abs_diff(exact) * 10_000 <= exact, "{est} vs {exact}");
            let spot = a * s / t;
            assert!(est < spot, "impact lowers the sell");
            // Buy: exact vs estimate.
            let x = 570_000_000u128;
            let exact = t * x / (s + x);
            let est = DEVNET.buy_out(price_e18(s, t, 6), 6, x).unwrap();
            assert!(est.abs_diff(exact) * 10_000 <= exact, "{est} vs {exact}");
        }
    }

    #[test]
    fn run_15_10_round_trip_sells_at_what_the_buy_paid() {
        // a3: a 0.57 SOL buy on a ~0.35 SOL curve, then a sell of everything it bought. Fees
        // aside, the curve returns the 0.57 SOL; the spot estimate after the buy says > 2x that.
        let k = DEVNET.virtual_sol * DEVNET.virtual_tokens;
        let s0 = 350_000_000u128;
        let t0 = k / s0;
        let x = 570_000_000u128;
        let bought = DEVNET.buy_out(price_e18(s0, t0, 6), 6, x).unwrap();
        let (s1, t1) = (s0 + x, k / (s0 + x));
        let p1 = price_e18(s1, t1, 6);
        let est = DEVNET.sell_out(p1, 6, bought).unwrap();
        assert!(est.abs_diff(x) * 1_000 <= x, "{est} vs {x}");
        let spot = bought * s1 / t1;
        assert!(spot > 2 * est, "spot {spot} vs curve {est}");
    }

    #[test]
    fn none_on_bad_input() {
        assert_eq!(DEVNET.reserves_at(0, 6), None);
        let zero = CurveParams {
            virtual_sol: 0,
            virtual_tokens: 1,
        };
        assert_eq!(zero.sell_out(10, 6, 1), None);
        let huge = CurveParams {
            virtual_sol: u128::MAX,
            virtual_tokens: 2,
        };
        assert_eq!(huge.sell_out(10, 6, 1), None);
    }
}

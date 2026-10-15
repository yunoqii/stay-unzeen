//! Price impact of a trade on a pump.fun-style bonding curve (devnet run 15.10, B2).
//!
//! The curve is constant product over virtual reserves: `S · T = k` with `k = S0 · T0` fixed by
//! the venue's launch parameters (`launch_curves`, written by the relayer from the pump Global).
//! The spot price is `p = S / T` (lamports per token base unit), so the current reserves follow
//! from the spot price alone: `S = √(k·p)`, `T = √(k/p)`. A sell of `a` base units then returns
//! `S·a / (T + a)` lamports and a buy of `x` lamports returns `T·x / (S + x)` base units
//! (API v0.26: minus the venue's trade fee `fee_bps`, the same number `PoolInfo.venues[].curve`
//! publishes, so the server and the UI estimate alike).
//!
//! A spot estimate ignores the impact: selling 100 % of a position on the 0.3 SOL devnet curve
//! landed 6.7 % below it. Only for SOL-paired curve tokens of the venue the row describes; any
//! overflow or missing input gives `None` and the caller keeps the spot estimate.

use unzeen_fair::alloc::mul_div;

/// Lamports have 9 decimals; prices are decimal SOL per whole token × 1e18.
const NATIVE_DECIMALS: u32 = 9;

/// Initial virtual reserves of the venue's curve (`launch_curves`) and its trade fee.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurveParams {
    pub virtual_sol: u128,
    pub virtual_tokens: u128,
    /// Venue trade fee, b.p. of the SOL side (pump.fun: protocol + creator). 0 = fees ignored.
    pub fee_bps: u32,
}

/// pump.fun bonding-curve trade fee assumed by core (0.95 % protocol + 0.30 % creator):
/// default of `UNZEEN_TRADE_FEE_BPS_PUMPFUN`.
pub const PUMPFUN_TRADE_FEE_BPS: u32 = 125;

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

/// One market-cap tier of the venue's trade fee (`launch_curves.fee_tiers`, 0034): from
/// `market_cap_lamports` up (pump.fun FeeConfig `feeTiers`: protocol + creator bps).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeTier {
    pub market_cap_lamports: u128,
    pub bps: u32,
}

/// `launch_curves.fee_tiers` JSON → tiers, thresholds ascending; `None` if malformed or empty.
pub fn parse_fee_tiers(v: &serde_json::Value) -> Option<Vec<FeeTier>> {
    let mut out = Vec::new();
    for t in v.as_array()? {
        let m: u128 = t["marketCapLamports"].as_str()?.parse().ok()?;
        let bps = u32::try_from(t["bps"].as_u64()?).ok().filter(|b| *b <= 5_000)?;
        if out.last().is_some_and(|p: &FeeTier| p.market_cap_lamports >= m) {
            return None;
        }
        out.push(FeeTier {
            market_cap_lamports: m,
            bps,
        });
    }
    (!out.is_empty()).then_some(out)
}

/// The tier a curve at `market_cap` lamports pays, as pump's `calculateFeeTier`: the last tier
/// whose threshold is ≤ the market cap, the first one below every threshold.
pub fn tier_bps(tiers: &[FeeTier], market_cap: u128) -> Option<u32> {
    let first = tiers.first()?;
    Some(
        tiers
            .iter()
            .rev()
            .find(|t| market_cap >= t.market_cap_lamports)
            .unwrap_or(first)
            .bps,
    )
}

impl CurveParams {
    /// Market cap in lamports (`S · supply / T`, as pump's `bondingCurveMarketCap`) at spot
    /// `price_e18`, for a token supply in base units.
    pub fn market_cap_at(&self, price_e18: u128, decimals: u32, supply: u128) -> Option<u128> {
        let (s, t) = self.reserves_at(price_e18, decimals)?;
        mul_div(s, supply, t)
    }

    /// This curve with the fee of the tier its market cap falls in (no tiers: unchanged).
    pub fn with_tier_fee(self, tiers: Option<&[FeeTier]>, price_e18: u128, decimals: u32, supply: u128) -> Self {
        let fee = tiers
            .and_then(|t| tier_bps(t, self.market_cap_at(price_e18, decimals, supply).unwrap_or(0)))
            .unwrap_or(self.fee_bps);
        Self { fee_bps: fee, ..self }
    }

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

    /// Lamports a sell of `amount` base units returns at spot `price_e18`, impact included,
    /// minus the fee (taken from the SOL out).
    pub fn sell_out(&self, price_e18: u128, decimals: u32, amount: u128) -> Option<u128> {
        let (s, t) = self.reserves_at(price_e18, decimals)?;
        let gross = mul_div(s, amount, t.checked_add(amount)?)?;
        mul_div(gross, 10_000 - u128::from(self.fee_bps.min(10_000)), 10_000)
    }

    /// Base units a buy spending `lamports` in total returns at spot `price_e18`, impact
    /// included; the fee comes on top of the curve input (`lamports = net · (1 + fee)`).
    pub fn buy_out(&self, price_e18: u128, decimals: u32, lamports: u128) -> Option<u128> {
        let (s, t) = self.reserves_at(price_e18, decimals)?;
        let net = mul_div(lamports, 10_000, 10_000 + u128::from(self.fee_bps))?;
        mul_div(t, net, s.checked_add(net)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// pump.fun devnet Global on 15.10: 0.3 SOL / 1.073e15 base units (6 decimals).
    const DEVNET: CurveParams = CurveParams {
        virtual_sol: 300_000_000,
        virtual_tokens: 1_073_000_000_000_000,
        fee_bps: 0,
    };

    #[test]
    fn fee_tiers_parse_and_select() {
        let v = serde_json::json!([{"marketCapLamports":"0","bps":125},{"marketCapLamports":"420000000000","bps":105}]);
        let t = parse_fee_tiers(&v).unwrap();
        assert_eq!(tier_bps(&t, 0), Some(125));
        assert_eq!(tier_bps(&t, 419_999_999_999), Some(125));
        assert_eq!(tier_bps(&t, 420_000_000_000), Some(105));
        let below = [
            FeeTier {
                market_cap_lamports: 10,
                bps: 90,
            },
            FeeTier {
                market_cap_lamports: 20,
                bps: 80,
            },
        ];
        assert_eq!(tier_bps(&below, 5), Some(90), "below the first threshold: first tier");
        assert!(parse_fee_tiers(&serde_json::json!([])).is_none());
        assert!(
            parse_fee_tiers(&serde_json::json!([{"marketCapLamports":"5","bps":1},{"marketCapLamports":"5","bps":2}]))
                .is_none()
        );
        assert!(parse_fee_tiers(&serde_json::json!([{"marketCapLamports":"0","bps":9000}])).is_none());
        // Market cap of the fresh devnet curve: 0.3 SOL × 1e15 / 1.073e15 ≈ 0.2796 SOL.
        let p = price_e18(DEVNET.virtual_sol, DEVNET.virtual_tokens, 6);
        let m = DEVNET.market_cap_at(p, 6, 1_000_000_000_000_000).unwrap();
        assert!(m.abs_diff(279_589_934) < 1_000, "{m}");
        assert_eq!(DEVNET.with_tier_fee(Some(&t), p, 6, 1_000_000_000_000_000).fee_bps, 125);
        assert_eq!(DEVNET.with_tier_fee(None, p, 6, 1).fee_bps, 0);
    }

    /// Devnet 15.10, tx 4s5DKdb8 (a buy of 0.011 SOL) and ERSUoF7t (a sell): the pump TradeEvent
    /// reported fee 95 bps + creator fee 30 bps; the formula reproduces what the chain charged.
    #[test]
    fn matches_devnet_trades() {
        let fee = CurveParams { fee_bps: 125, ..DEVNET };
        // buy: 11 000 000 lamports spent, 10 864 197 into the curve (event solAmount).
        let net = mul_div(11_000_000, 10_000, 10_125).unwrap();
        assert!(net.abs_diff(10_864_197) <= 1, "{net}");
        // sell: event solAmount (gross) 560 356 234, the vault got 553 351 780.
        let out = mul_div(560_356_234, 10_000 - u128::from(fee.fee_bps), 10_000).unwrap();
        assert!(out.abs_diff(553_351_780) <= 2, "{out}");
    }

    #[test]
    fn fee_lowers_both_sides() {
        let k = DEVNET.virtual_sol * DEVNET.virtual_tokens;
        let (s, t) = (400_000_000u128, k / 400_000_000);
        let p = price_e18(s, t, 6);
        let fee = CurveParams { fee_bps: 125, ..DEVNET };
        let (a, x) = (10_000_000_000_000u128, 50_000_000u128);
        let sell0 = DEVNET.sell_out(p, 6, a).unwrap();
        assert_eq!(fee.sell_out(p, 6, a).unwrap(), sell0 * 9_875 / 10_000);
        // buy: 0.05 SOL in total, 0.04938 SOL of it into the curve.
        let net = x * 10_000 / 10_125;
        assert_eq!(fee.buy_out(p, 6, x).unwrap(), DEVNET.buy_out(p, 6, net).unwrap());
        assert!(fee.buy_out(p, 6, x).unwrap() < DEVNET.buy_out(p, 6, x).unwrap());
    }

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
            fee_bps: 0,
        };
        assert_eq!(zero.sell_out(10, 6, 1), None);
        let huge = CurveParams {
            virtual_sol: u128::MAX,
            virtual_tokens: 2,
            fee_bps: 0,
        };
        assert_eq!(huge.sell_out(10, 6, 1), None);
    }
}

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

/// How a buy pays the venue fee (API v0.28 `TokenCurve.buyFee`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum BuyFee {
    /// On top of the SOL into the curve: `x = net · (1 + f)` (pump.fun).
    #[default]
    Added,
    /// Deducted from the SOL in: `net = x · (1 − f)` (DBC with the fee in quote, LaunchLab).
    Input,
    /// Deducted from the tokens out (DBC with the fee in the base token).
    Output,
}

impl BuyFee {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "added" => Some(Self::Added),
            "input" => Some(Self::Input),
            "output" => Some(Self::Output),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Input => "input",
            Self::Output => "output",
        }
    }
}

/// Virtual reserves of a constant-product curve (`S · T = k`) and its trade fee: either the
/// venue's launch curve (`launch_curves`, v0.26) or, v0.28, the token's own curve state on the
/// last indexer tick (`intel_prices.curve`: current reserves of the curve / DBC segment).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CurveParams {
    pub virtual_sol: u128,
    pub virtual_tokens: u128,
    /// Venue trade fee, b.p. of the SOL side (pump.fun: protocol + creator). 0 = fees ignored.
    pub fee_bps: u32,
    /// v0.28: how a buy pays the fee.
    pub buy_fee: BuyFee,
    /// v0.28: net lamports the curve (or the DBC segment) still takes, from the token's tick
    /// state; a larger buy fills only this much (pump, DBC) — the estimate is capped there.
    pub buy_limit: Option<u128>,
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
    /// included. The fee per [`BuyFee`]: on top of the curve input (`lamports = net · (1 + f)`,
    /// pump.fun), out of the input (`net = lamports · (1 − f)`) or out of the tokens. v0.28: the
    /// net into the curve is capped at `buy_limit` (the rest is not filled).
    pub fn buy_out(&self, price_e18: u128, decimals: u32, lamports: u128) -> Option<u128> {
        let (s, t) = self.reserves_at(price_e18, decimals)?;
        let f = u128::from(self.fee_bps.min(10_000));
        let net = match self.buy_fee {
            BuyFee::Added => mul_div(lamports, 10_000, 10_000 + f)?,
            BuyFee::Input | BuyFee::Output => {
                if self.buy_fee == BuyFee::Input {
                    mul_div(lamports, 10_000 - f, 10_000)?
                } else {
                    lamports
                }
            }
        };
        let net = self.buy_limit.map_or(net, |l| net.min(l));
        let out = mul_div(t, net, s.checked_add(net)?)?;
        if self.buy_fee == BuyFee::Output {
            mul_div(out, 10_000 - f, 10_000)
        } else {
            Some(out)
        }
    }
}

/// v0.28 (API `TokenCurve`, INTEL v4): a token's curve state on the last indexer tick
/// (`intel_prices.curve`, 0035) — the current reserves of its curve (DBC: of the segment the
/// price is in), the fee now and how a buy pays it. `fee_bps = None`: pump.fun, the fee is the
/// FeeConfig tier core resolves ([`load_token_curve`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenCurve {
    pub virtual_sol: u128,
    pub virtual_tokens: u128,
    pub fee_bps: Option<u32>,
    pub buy_fee: BuyFee,
    pub buy_limit: Option<u128>,
    pub sell_limit: Option<u128>,
}

/// A tick's curve state is used for estimates only this long (orders: the same tick age bound).
pub const TOKEN_CURVE_MAX_AGE_MS: i64 = 180_000;

/// `intel_prices.curve` JSON → state; `None` if malformed (the indexer is a separate process:
/// every field is checked).
pub fn parse_token_curve(v: &serde_json::Value) -> Option<TokenCurve> {
    let n = |k: &str| -> Option<Option<u128>> {
        match v.get(k) {
            None | Some(serde_json::Value::Null) => Some(None),
            Some(x) => x
                .as_str()
                .filter(|s| s.len() <= 39 && s.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|s| s.parse().ok())
                .map(Some),
        }
    };
    let virtual_sol = n("virtualSol")?.filter(|x| *x > 0)?;
    let virtual_tokens = n("virtualTokens")?.filter(|x| *x > 0)?;
    let fee_bps = match v.get("feeBps") {
        None | Some(serde_json::Value::Null) => None,
        Some(x) => Some(u32::try_from(x.as_u64()?).ok().filter(|b| *b <= 9_900)?),
    };
    Some(TokenCurve {
        virtual_sol,
        virtual_tokens,
        fee_bps,
        buy_fee: BuyFee::parse(v.get("buyFee")?.as_str()?)?,
        buy_limit: n("buyLimitLamports")?,
        sell_limit: n("sellLimitTokens")?,
    })
}

impl TokenCurve {
    /// Estimate parameters (the fee must be resolved: `fee_bps` set).
    pub fn params(&self) -> CurveParams {
        CurveParams {
            virtual_sol: self.virtual_sol,
            virtual_tokens: self.virtual_tokens,
            fee_bps: self.fee_bps.unwrap_or(0),
            buy_fee: self.buy_fee,
            buy_limit: self.buy_limit,
        }
    }

    /// API v0.28 `TokenCurve` JSON (fee resolved), `as_of` = tick ms.
    pub fn to_json(&self, as_of: i64) -> serde_json::Value {
        let mut v = serde_json::json!({
            "virtualSol": self.virtual_sol.to_string(),
            "virtualTokens": self.virtual_tokens.to_string(),
            "feeBps": self.fee_bps.unwrap_or(0),
            "buyFee": self.buy_fee.as_str(),
            "asOf": as_of,
        });
        if let Some(l) = self.buy_limit {
            v["buyLimitLamports"] = serde_json::json!(l.to_string());
        }
        if let Some(l) = self.sell_limit {
            v["sellLimitTokens"] = serde_json::json!(l.to_string());
        }
        v
    }
}

/// The token's fresh curve state (tick not older than [`TOKEN_CURVE_MAX_AGE_MS`] at `now_ms`,
/// still on the curve, not a pair to a non-SOL quote), with the fee resolved: the indexer's
/// fee (DBC, LaunchLab), or for pump.fun the FeeConfig tier of its market cap
/// (`launch_curves.fee_tiers`, v0.27), else `pump_fee_bps`. Returns the tick time too.
pub async fn load_token_curve<C: deadpool_postgres::GenericClient>(
    c: &C,
    network: &str,
    mint: &str,
    now_ms: i64,
    pump_fee_bps: u32,
) -> Result<Option<(TokenCurve, i64)>, tokio_postgres::Error> {
    let Some(r) = c
        .query_opt(
            "SELECT p.curve, p.tick_at, lc.fee_tiers, lc.token_total_supply
               FROM intel_prices p
               LEFT JOIN launch_curves lc ON lc.network = $1 AND lc.venue = 'pumpfun'
              WHERE p.mint = $2 AND p.status = 'curve' AND p.curve IS NOT NULL AND p.tick_at >= $3
                AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.mint = $2 AND t.quote_mint IS NOT NULL)",
            &[&network, &mint, &(now_ms - TOKEN_CURVE_MAX_AGE_MS)],
        )
        .await?
    else {
        return Ok(None);
    };
    let Some(mut tc) = r
        .get::<_, Option<serde_json::Value>>(0)
        .as_ref()
        .and_then(parse_token_curve)
    else {
        return Ok(None);
    };
    if tc.fee_bps.is_none() {
        let tiers = r
            .get::<_, Option<serde_json::Value>>(2)
            .and_then(|v| parse_fee_tiers(&v));
        let supply = r
            .get::<_, Option<crate::Num>>(3)
            .and_then(|n| n.to_u128().ok())
            .unwrap_or(0);
        let cap = mul_div(tc.virtual_sol, supply, tc.virtual_tokens).unwrap_or(0);
        tc.fee_bps = Some(tiers.and_then(|t| tier_bps(&t, cap)).unwrap_or(pump_fee_bps));
    }
    Ok(Some((tc, r.get(1))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// pump.fun devnet Global on 15.10: 0.3 SOL / 1.073e15 base units (6 decimals).
    const DEVNET: CurveParams = CurveParams {
        virtual_sol: 300_000_000,
        virtual_tokens: 1_073_000_000_000_000,
        fee_bps: 0,
        buy_fee: BuyFee::Added,
        buy_limit: None,
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

    /// v0.28: the three buy-fee modes and the buy limit, at the tick price (reserves exact).
    #[test]
    fn buy_fee_modes_and_limit() {
        let (s, t) = (31_000_000_000u128, 1_038_000_000_000_000u128);
        let p = price_e18(s, t, 6);
        let base = CurveParams {
            virtual_sol: s,
            virtual_tokens: t,
            fee_bps: 100,
            ..Default::default()
        };
        let x = 1_000_000_000u128;
        let (s2, t2) = base.reserves_at(p, 6).unwrap();
        let cp = |net: u128| t2 * net / (s2 + net);
        let added = base.buy_out(p, 6, x).unwrap();
        assert!(added.abs_diff(cp(x * 10_000 / 10_100)) <= 1);
        let input = CurveParams {
            buy_fee: BuyFee::Input,
            ..base
        }
        .buy_out(p, 6, x)
        .unwrap();
        assert!(input.abs_diff(cp(x * 9_900 / 10_000)) <= 1);
        let output = CurveParams {
            buy_fee: BuyFee::Output,
            ..base
        }
        .buy_out(p, 6, x)
        .unwrap();
        assert!(output.abs_diff(cp(x) * 9_900 / 10_000) <= 1);
        assert!(input < added && output < cp(x));
        // limit: the net into the curve never exceeds what the curve still takes
        let lim = CurveParams {
            buy_fee: BuyFee::Input,
            buy_limit: Some(500_000_000),
            ..base
        };
        assert_eq!(lim.buy_out(p, 6, 10 * x), lim.buy_out(p, 6, 600_000_000));
        assert!(lim.buy_out(p, 6, 400_000_000) < lim.buy_out(p, 6, 600_000_000));
        // sell is the same for every mode
        assert_eq!(
            CurveParams {
                buy_fee: BuyFee::Output,
                ..base
            }
            .sell_out(p, 6, 10u128.pow(12)),
            base.sell_out(p, 6, 10u128.pow(12))
        );
    }

    #[test]
    fn token_curve_json_round_trip() {
        let v = serde_json::json!({"virtualSol":"31000000000","virtualTokens":"1038000000000000","feeBps":100,
                                   "buyFee":"input","buyLimitLamports":"54000000000"});
        let tc = parse_token_curve(&v).unwrap();
        assert_eq!(tc.fee_bps, Some(100));
        assert_eq!(tc.buy_fee, BuyFee::Input);
        assert_eq!(tc.buy_limit, Some(54_000_000_000));
        assert_eq!(tc.sell_limit, None);
        let out = tc.to_json(1_000);
        assert_eq!(out["asOf"], 1_000);
        assert_eq!(out["buyLimitLamports"], "54000000000");
        assert!(out.get("sellLimitTokens").is_none());
        let pump =
            parse_token_curve(&serde_json::json!({"virtualSol":"1","virtualTokens":"2","buyFee":"added"})).unwrap();
        assert_eq!(pump.fee_bps, None);
        for bad in [
            serde_json::json!({"virtualSol":"0","virtualTokens":"2","buyFee":"added"}),
            serde_json::json!({"virtualSol":"1","virtualTokens":"2","buyFee":"other"}),
            serde_json::json!({"virtualSol":1,"virtualTokens":"2","buyFee":"added"}),
            serde_json::json!({"virtualSol":"-1","virtualTokens":"2","buyFee":"added"}),
            serde_json::json!({"virtualSol":"1","virtualTokens":"2","buyFee":"added","feeBps":9901}),
            serde_json::json!({"virtualSol":"1","virtualTokens":"2","buyFee":"added","buyLimitLamports":"1e3"}),
        ] {
            assert!(parse_token_curve(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn none_on_bad_input() {
        assert_eq!(DEVNET.reserves_at(0, 6), None);
        let zero = CurveParams {
            virtual_sol: 0,
            virtual_tokens: 1,
            fee_bps: 0,
            ..Default::default()
        };
        assert_eq!(zero.sell_out(10, 6, 1), None);
        let huge = CurveParams {
            virtual_sol: u128::MAX,
            virtual_tokens: 2,
            fee_bps: 0,
            ..Default::default()
        };
        assert_eq!(huge.sell_out(10, 6, 1), None);
    }
}

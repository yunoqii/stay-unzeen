//! Integer amounts stored as `NUMERIC(78,0)` (migration 0026, API v0.18).
//!
//! Token and quote amounts of any chain go through [`Num`]: an ERC-20 with 18 decimals and a
//! 1e9 supply is 1e27 base units, beyond `BIGINT`/`u64` (1.8e19). In Rust the value is an
//! `i128` (±1.7e38, deltas included); a non-negative amount is a `u128` at the API edge
//! ([`Num::to_u128`]). Zatoshis, gas, slots and rates stay `BIGINT` (they always fit).
//!
//! Binary wire format of `NUMERIC` (src/backend/utils/adt/numeric.c, `numeric_send`):
//! `i16 ndigits, i16 weight, u16 sign, u16 dscale, ndigits × i16` base-10000 digits, most
//! significant first; value = Σ digit[i] · 10000^(weight − i). The decoder also accepts
//! `INT2/INT4/INT8` (so a column can be read the same way before and after the migration)
//! and rejects a non-zero fraction instead of truncating it (an SQL division left without
//! `floor()` must fail loudly, not round silently). The encoder writes `INT8` when Postgres
//! inferred a `BIGINT` parameter (error if the value does not fit) and `NUMERIC` otherwise.

use std::error::Error;

use bytes::{BufMut, BytesMut};
use tokio_postgres::types::{FromSql, IsNull, ToSql, Type, to_sql_checked};

use crate::{LedgerError, Result};

/// Integer amount for `NUMERIC(78,0)` columns (any sign; amounts are checked ≥ 0 by the
/// columns' CHECKs and by [`Num::to_u128`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Num(pub i128);

const NUMERIC_NEG: u16 = 0x4000;
const NUMERIC_NAN: u16 = 0xC000;
/// Base-10000 digits of `i128::MIN` (1.7e38 → 39 decimal digits → 10 base-10000 digits).
const MAX_DIGITS: usize = 10;

impl Num {
    pub const ZERO: Num = Num(0);

    /// A non-negative amount (`u128` above `i128::MAX` is out of range).
    pub fn from_u128(v: u128) -> Result<Num> {
        i128::try_from(v).map(Num).map_err(|_| LedgerError::Range)
    }

    pub fn from_u64(v: u64) -> Num {
        Num(i128::from(v))
    }

    /// Negative → [`LedgerError::Range`] (a stored amount is never negative).
    pub fn to_u128(self) -> Result<u128> {
        u128::try_from(self.0).map_err(|_| LedgerError::Range)
    }

    /// Lossy read for display/aggregates: negative → 0.
    pub fn u128_or_zero(self) -> u128 {
        u128::try_from(self.0).unwrap_or(0)
    }

    /// `u64` view where a protocol field is still 64-bit (Verify v1 leaves, Solana amounts).
    pub fn to_u64(self) -> Result<u64> {
        u64::try_from(self.0).map_err(|_| LedgerError::Range)
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }
}

impl From<u64> for Num {
    fn from(v: u64) -> Self {
        Num(i128::from(v))
    }
}

impl From<i64> for Num {
    fn from(v: i64) -> Self {
        Num(i128::from(v))
    }
}

impl std::fmt::Display for Num {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// `Option<u128>` → `Option<Num>` for nullable parameters.
pub fn opt_num(v: Option<u128>) -> Result<Option<Num>> {
    v.map(Num::from_u128).transpose()
}

/// Nullable column → `u128` (NULL and negatives → 0).
pub fn u128_of(v: Option<Num>) -> u128 {
    v.map_or(0, Num::u128_or_zero)
}

type BoxErr = Box<dyn Error + Sync + Send>;

fn decode_numeric(raw: &[u8]) -> std::result::Result<i128, BoxErr> {
    let rd = |i: usize| -> std::result::Result<u16, BoxErr> {
        raw.get(i..i + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
            .ok_or_else(|| "numeric: truncated".into())
    };
    let ndigits = rd(0)? as i16;
    let weight = rd(2)? as i16;
    let sign = rd(4)?;
    if sign == NUMERIC_NAN {
        return Err("numeric: NaN".into());
    }
    if sign != 0 && sign != NUMERIC_NEG {
        return Err("numeric: infinity or bad sign".into());
    }
    if ndigits < 0 || raw.len() != 8 + 2 * ndigits as usize {
        return Err("numeric: bad length".into());
    }
    let mut acc: i128 = 0;
    for i in 0..ndigits as usize {
        let d = rd(8 + 2 * i)?;
        if d >= 10_000 {
            return Err("numeric: bad digit".into());
        }
        // Position of this digit: weight − i. Negative positions are the fraction.
        if (weight as i32) - (i as i32) < 0 {
            if d != 0 {
                return Err("numeric: fractional value where an integer amount is expected".into());
            }
            continue;
        }
        acc = acc
            .checked_mul(10_000)
            .and_then(|a| a.checked_sub(i128::from(d)))
            .ok_or("numeric: out of i128 range")?;
    }
    // Trailing zero digits omitted by Postgres (weight beyond the last stored digit).
    let stored_int = (weight as i32 + 1).min(ndigits as i32).max(0);
    let missing = (weight as i32 + 1) - stored_int;
    if ndigits > 0 {
        for _ in 0..missing.max(0) {
            acc = acc.checked_mul(10_000).ok_or("numeric: out of i128 range")?;
        }
    }
    // acc is accumulated negatively (covers i128::MIN); flip for positives.
    if sign == NUMERIC_NEG {
        Ok(acc)
    } else {
        acc.checked_neg().ok_or_else(|| "numeric: out of i128 range".into())
    }
}

fn encode_numeric(v: i128, out: &mut BytesMut) {
    let neg = v < 0;
    let mut m = v.unsigned_abs();
    let mut digits: Vec<u16> = Vec::with_capacity(MAX_DIGITS);
    while m > 0 {
        digits.push((m % 10_000) as u16);
        m /= 10_000;
    }
    digits.reverse(); // most significant first
    let weight = digits.len() as i16 - 1;
    while digits.last() == Some(&0) {
        digits.pop();
    }
    out.put_i16(digits.len() as i16);
    out.put_i16(if digits.is_empty() { 0 } else { weight });
    out.put_u16(if neg { NUMERIC_NEG } else { 0 });
    out.put_u16(0); // dscale: integers only
    for d in digits {
        out.put_u16(d);
    }
}

impl<'a> FromSql<'a> for Num {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> std::result::Result<Self, BoxErr> {
        match *ty {
            Type::INT2 => i16::from_sql(ty, raw).map(|v| Num(i128::from(v))),
            Type::INT4 => i32::from_sql(ty, raw).map(|v| Num(i128::from(v))),
            Type::INT8 => i64::from_sql(ty, raw).map(|v| Num(i128::from(v))),
            _ => decode_numeric(raw).map(Num),
        }
    }

    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::INT2 | Type::INT4 | Type::INT8 | Type::NUMERIC)
    }
}

impl ToSql for Num {
    fn to_sql(&self, ty: &Type, out: &mut BytesMut) -> std::result::Result<IsNull, BoxErr> {
        if *ty == Type::INT8 {
            let v = i64::try_from(self.0).map_err(|_| "amount does not fit a BIGINT parameter")?;
            out.put_i64(v);
        } else {
            encode_numeric(self.0, out);
        }
        Ok(IsNull::No)
    }

    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::INT8 | Type::NUMERIC)
    }

    to_sql_checked!();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(v: i128) -> i128 {
        let mut b = BytesMut::new();
        encode_numeric(v, &mut b);
        decode_numeric(&b).unwrap()
    }

    #[test]
    fn roundtrip_boundaries() {
        let e27: i128 = 10i128.pow(27);
        for v in [
            0,
            1,
            -1,
            9_999,
            10_000,
            10_001,
            100_000_000,
            i64::MAX as i128,
            i64::MAX as i128 + 1,
            u64::MAX as i128,
            u64::MAX as i128 + 1,
            e27,
            e27 - 1,
            e27 + 1,
            -e27,
            4_200_000_000_000_000_000, // 4.2 ETH in wei (> i64::MAX)
            i128::MAX,
            i128::MIN,
        ] {
            assert_eq!(rt(v), v, "{v}");
        }
    }

    #[test]
    fn decodes_postgres_layout() {
        // 1e27 as Postgres sends it: 1e27 = 1000 · 10000^6 → ndigits 1, weight 6, digit 1000.
        let raw = [0, 1, 0, 6, 0, 0, 0, 0, 0x03, 0xE8];
        assert_eq!(decode_numeric(&raw).unwrap(), 10i128.pow(27));
        // 12.0000 (dscale 4, zero fraction digit) is accepted as 12.
        let raw = [0, 2, 0, 0, 0, 0, 0, 4, 0, 12, 0, 0];
        assert_eq!(decode_numeric(&raw).unwrap(), 12);
        // 12.5 is rejected (an integer amount was expected).
        let raw = [0, 2, 0, 0, 0, 0, 0, 1, 0, 12, 0x13, 0x88];
        assert!(decode_numeric(&raw).is_err());
        // 0.5 alone (weight −1).
        let raw = [0, 1, 0xFF, 0xFF, 0, 0, 0, 1, 0x13, 0x88];
        assert!(decode_numeric(&raw).is_err());
        // zero: ndigits 0.
        assert_eq!(decode_numeric(&[0, 0, 0, 0, 0, 0, 0, 0]).unwrap(), 0);
        // NaN.
        assert!(decode_numeric(&[0, 0, 0, 0, 0xC0, 0, 0, 0]).is_err());
        // 1e40 does not fit i128.
        let raw = [0, 1, 0, 10, 0, 0, 0, 0, 0, 1];
        assert!(decode_numeric(&raw).is_err());
    }

    #[test]
    fn unsigned_edges() {
        assert!(Num(-1).to_u128().is_err());
        assert_eq!(Num(5).to_u128().unwrap(), 5);
        assert!(Num::from_u128(u128::MAX).is_err());
        assert_eq!(Num::from_u128(10u128.pow(27)).unwrap().0, 10i128.pow(27));
        assert!(Num(u64::MAX as i128 + 1).to_u64().is_err());
    }
}

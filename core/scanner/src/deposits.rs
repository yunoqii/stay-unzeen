//! Read incoming (non-change) shielded notes of the Orchard family (Orchard + Ironwood)
//! from the wallet DB. Since NU6.3 (ZIP 258) new deposits land in Ironwood; legacy
//! Orchard notes are still listed.
//!
//! Uses the public `v_received_outputs` view of zcash_client_sqlite rather than
//! internal tables.

use rusqlite::{Connection, OpenFlags, named_params};
use serde::Serialize;
use zcash_primitives::transaction::TxId;

use crate::memo::MemoView;

/// `pool` codes used by zcash_client_sqlite views.
const POOL_ORCHARD: i64 = 3;
const POOL_IRONWOOD: i64 = 4;

fn pool_name(code: i64) -> &'static str {
    match code {
        POOL_ORCHARD => "orchard",
        POOL_IRONWOOD => "ironwood",
        _ => "other",
    }
}

#[derive(Debug, Serialize)]
pub struct Deposit {
    /// Internal row id (monotonic) — used to report only notes new since a given point.
    #[serde(skip)]
    pub row_id: i64,
    pub pool: &'static str,
    pub txid: String,
    pub action_index: u32,
    pub value_zat: u64,
    pub mined_height: Option<u32>,
    /// `None` = memo not yet fetched (tx not enhanced).
    pub memo: Option<MemoView>,
}

impl Deposit {
    pub fn value_zec(&self) -> String {
        format_zec(self.value_zat)
    }
}

pub fn format_zec(zat: u64) -> String {
    format!("{}.{:08}", zat / 100_000_000, zat % 100_000_000)
}

/// Per-pool cursor (row ids are per-pool-table).
#[derive(Clone, Copy, Debug, Default)]
pub struct Cursor {
    pub orchard: i64,
    pub ironwood: i64,
}

impl Cursor {
    pub fn advance(&mut self, d: &Deposit) {
        match d.pool {
            "orchard" => self.orchard = self.orchard.max(d.row_id),
            "ironwood" => self.ironwood = self.ironwood.max(d.row_id),
            _ => {}
        }
    }
}

pub fn list(db_path: &std::path::Path, after: Cursor) -> anyhow::Result<Vec<Deposit>> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(
        "SELECT ro.pool, ro.id_within_pool_table AS row_id, t.txid, ro.output_index, ro.value,
                t.mined_height, ro.memo
         FROM v_received_outputs ro
         JOIN transactions t ON t.id_tx = ro.transaction_id
         WHERE ro.is_change = 0
           AND ((ro.pool = :orchard AND ro.id_within_pool_table > :after_o)
             OR (ro.pool = :ironwood AND ro.id_within_pool_table > :after_i))
         ORDER BY t.mined_height IS NULL, t.mined_height, ro.pool, ro.id_within_pool_table",
    )?;
    let params = named_params! {
        ":orchard": POOL_ORCHARD, ":ironwood": POOL_IRONWOOD,
        ":after_o": after.orchard, ":after_i": after.ironwood,
    };
    let rows = stmt.query_map(params, |r| {
        let txid: Vec<u8> = r.get("txid")?;
        let memo: Option<Vec<u8>> = r.get("memo")?;
        Ok((
            r.get::<_, i64>("pool")?,
            r.get::<_, i64>("row_id")?,
            txid,
            r.get::<_, u32>("output_index")?,
            r.get::<_, i64>("value")?,
            r.get::<_, Option<u32>>("mined_height")?,
            memo,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (pool, row_id, txid, idx, value, h, memo) = row?;
        let txid: [u8; 32] = txid
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("bad txid length in DB"))?;
        out.push(Deposit {
            row_id,
            pool: pool_name(pool),
            txid: TxId::from_bytes(txid).to_string(),
            action_index: idx,
            value_zat: u64::try_from(value)?,
            mined_height: h,
            memo: memo.map(|m| MemoView::decode(&m)),
        });
    }
    Ok(out)
}

/// Cursor pointing past every note currently in the DB.
pub fn current_cursor(db_path: &std::path::Path) -> anyhow::Result<Cursor> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let q = |pool: i64| -> rusqlite::Result<i64> {
        conn.query_row(
            "SELECT COALESCE(MAX(id_within_pool_table), 0) FROM v_received_outputs WHERE pool = :pool",
            named_params! {":pool": pool},
            |r| r.get(0),
        )
    };
    Ok(Cursor { orchard: q(POOL_ORCHARD)?, ironwood: q(POOL_IRONWOOD)? })
}

#[cfg(test)]
mod tests {
    use super::format_zec;

    #[test]
    fn zec_formatting() {
        assert_eq!(format_zec(0), "0.00000000");
        assert_eq!(format_zec(1), "0.00000001");
        assert_eq!(format_zec(100_000_000), "1.00000000");
        assert_eq!(format_zec(123_456_789), "1.23456789");
        assert_eq!(format_zec(21_000_000 * 100_000_000), "21000000.00000000");
    }
}

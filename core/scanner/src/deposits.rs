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
    /// Internal row id (per pool table).
    #[serde(skip)]
    pub row_id: i64,
    /// Raw txid bytes (internal order) and pool code, for the ledger's note_ref.
    #[serde(skip)]
    pub txid_raw: [u8; 32],
    #[serde(skip)]
    pub pool_code: u8,
    /// Raw stored memo (zero-trimmed); `None` = not fetched yet.
    #[serde(skip)]
    pub memo_raw: Option<Vec<u8>>,
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

impl Deposit {
    /// Identity of what has been printed: a note is reported again when its memo arrives
    /// or its mined height changes (reorg), so nothing is silently skipped.
    pub fn print_key(&self) -> (u8, i64, bool, Option<u32>) {
        (self.pool_code, self.row_id, self.memo.is_some(), self.mined_height)
    }
}

/// All incoming (non-change) Orchard/Ironwood notes, mined or not.
pub fn list(db_path: &std::path::Path) -> anyhow::Result<Vec<Deposit>> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(
        "SELECT ro.pool, ro.id_within_pool_table AS row_id, t.txid, ro.output_index, ro.value,
                t.mined_height, ro.memo
         FROM v_received_outputs ro
         JOIN transactions t ON t.id_tx = ro.transaction_id
         WHERE ro.is_change = 0 AND ro.pool IN (:orchard, :ironwood)
         ORDER BY t.mined_height IS NULL, t.mined_height, ro.pool, ro.id_within_pool_table",
    )?;
    let params = named_params! { ":orchard": POOL_ORCHARD, ":ironwood": POOL_IRONWOOD };
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
            txid_raw: txid,
            pool_code: pool as u8,
            memo_raw: memo.clone(),
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

/// Header times (unix seconds) of the given heights, from the wallet's `blocks` table.
pub fn block_times(
    db_path: &std::path::Path,
    heights: impl IntoIterator<Item = u32>,
) -> anyhow::Result<std::collections::HashMap<u32, u64>> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("SELECT time FROM blocks WHERE height = ?1")?;
    let mut out = std::collections::HashMap::new();
    for h in heights {
        if out.contains_key(&h) {
            continue;
        }
        let t: Option<i64> = stmt.query_row([h], |r| r.get(0)).ok();
        if let Some(t) = t.and_then(|t| u64::try_from(t).ok()) {
            out.insert(h, t);
        }
    }
    Ok(out)
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

//! Compact-block sync against lightwalletd + full-tx enhancement (needed for memos:
//! compact blocks carry only the first 52 bytes of each Orchard ciphertext, so the
//! memo is only recoverable after fetching the full transaction).
//!
//! Flow mirrors zcash-devtool `wallet sync` + `wallet enhance`, minus TUI/transparent.

use std::collections::{BTreeSet, HashSet};

use anyhow::anyhow;
use futures_util::TryStreamExt;
use orchard::tree::MerkleHashOrchard;
use tonic::{Code, transport::Channel};
use tracing::{debug, info, warn};
use zcash_client_backend::{
    data_api::{
        TransactionDataRequest, TransactionStatus, WalletCommitmentTrees, WalletRead, WalletWrite,
        chain::{ChainState, CommitmentTreeRoot, error::Error as ChainError, scan_cached_blocks},
        scanning::ScanRange,
        wallet::decrypt_and_store_transaction,
    },
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
};
use zcash_client_sqlite::error::SqliteClientError;
use zcash_primitives::{
    merkle_tree::HashSer,
    transaction::{Transaction, TxId},
};
use zcash_protocol::consensus::{BlockHeight, BranchId};

use zcash_protocol::consensus::Network;

use crate::{
    blocks::MemBlocks,
    cover::{self, CoverCfg, CoverStats},
    wallet::Db,
};

type Client = CompactTxStreamerClient<Channel>;

/// Blocks per download/scan batch. Testnet blocks are small; keep memory bounded anyway.
const BATCH: u32 = 2_000;
const REORG_MARGIN: u32 = 10;
const MAX_RESTARTS: u32 = 20;

pub struct SyncReport {
    pub tip: u32,
    pub scanned_blocks: u64,
    pub enhanced_txs: usize,
    /// False if the scan was deferred (too many restarts after reorgs): wallet notes may
    /// look un-mined only because their blocks were rewound and not rescanned yet, so the
    /// ledger must not be fed from this pass (review-day3 N4).
    pub complete: bool,
    /// H1 cover-fetch counters (no txids).
    pub cover: CoverStats,
}

pub async fn sync(net: Network, client: &mut Client, db: &mut Db, cfg: &CoverCfg) -> anyhow::Result<SyncReport> {
    update_subtree_roots(client, db).await?;
    let mut cover = CoverStats::default();

    let mut scanned_blocks = 0u64;
    let mut restarts = 0u32;
    let mut complete = true;
    let tip = loop {
        let tip = update_chain_tip(client, db).await?;
        let restart = scan_all(net, client, db, cfg, &mut cover, tip, &mut scanned_blocks).await?;
        if !restart {
            break tip;
        }
        restarts += 1;
        if restarts >= MAX_RESTARTS {
            // Continue next pass instead of spinning forever on re-prioritized ranges.
            warn!(restarts, "scan restarted too many times in one pass; deferring");
            complete = false;
            break tip;
        }
    };

    let leftover = enhance_leftovers(net, client, db, cfg, tip, complete).await?;
    cover.add(&leftover);
    Ok(SyncReport {
        tip: u32::from(tip),
        scanned_blocks,
        enhanced_txs: cover.kept,
        complete,
        cover,
    })
}

async fn update_subtree_roots(client: &mut Client, db: &mut Db) -> anyhow::Result<()> {
    let mut req = service::GetSubtreeRootsArg::default();
    req.set_shielded_protocol(service::ShieldedProtocol::Sapling);
    let sapling_roots: Vec<CommitmentTreeRoot<sapling::Node>> = client
        .get_subtree_roots(req)
        .await?
        .into_inner()
        .map_err(anyhow::Error::from)
        .and_then(|r| async move {
            Ok(CommitmentTreeRoot::from_parts(
                BlockHeight::from_u32(r.completing_block_height as u32),
                sapling::Node::read(&r.root_hash[..])?,
            ))
        })
        .try_collect()
        .await?;
    db.put_sapling_subtree_roots(0, &sapling_roots)?;

    let mut req = service::GetSubtreeRootsArg::default();
    req.set_shielded_protocol(service::ShieldedProtocol::Orchard);
    let orchard_roots: Vec<CommitmentTreeRoot<MerkleHashOrchard>> = client
        .get_subtree_roots(req)
        .await?
        .into_inner()
        .map_err(anyhow::Error::from)
        .and_then(|r| async move {
            Ok(CommitmentTreeRoot::from_parts(
                BlockHeight::from_u32(r.completing_block_height as u32),
                MerkleHashOrchard::read(&r.root_hash[..])?,
            ))
        })
        .try_collect()
        .await?;
    db.put_orchard_subtree_roots(0, &orchard_roots)?;

    // Ironwood (NU6.3+, ZIP 258) is where new shielded deposits land; its note commitments are
    // Orchard-shaped. A server predating Ironwood streams none.
    let mut req = service::GetSubtreeRootsArg::default();
    req.set_shielded_protocol(service::ShieldedProtocol::Ironwood);
    let ironwood_roots: Vec<CommitmentTreeRoot<MerkleHashOrchard>> = client
        .get_subtree_roots(req)
        .await?
        .into_inner()
        .map_err(anyhow::Error::from)
        .and_then(|r| async move {
            Ok(CommitmentTreeRoot::from_parts(
                BlockHeight::from_u32(r.completing_block_height as u32),
                MerkleHashOrchard::read(&r.root_hash[..])?,
            ))
        })
        .try_collect()
        .await?;
    db.put_ironwood_subtree_roots(0, &ironwood_roots)?;
    info!(
        sapling = sapling_roots.len(),
        orchard = orchard_roots.len(),
        ironwood = ironwood_roots.len(),
        "subtree roots updated"
    );
    Ok(())
}

async fn update_chain_tip(client: &mut Client, db: &mut Db) -> anyhow::Result<BlockHeight> {
    let latest = client
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    let tip = BlockHeight::from_u32(u32::try_from(latest.height)?);
    db.update_chain_tip(tip)?;
    info!(tip = u32::from(tip), "chain tip");
    Ok(tip)
}

/// Scan every suggested range. Returns `true` if ranges were invalidated (reorg or a
/// higher-priority range appeared) and the caller should start over.
async fn scan_all(
    net: Network,
    client: &mut Client,
    db: &mut Db,
    cfg: &CoverCfg,
    stats: &mut CoverStats,
    tip: BlockHeight,
    scanned: &mut u64,
) -> anyhow::Result<bool> {
    let ranges = db.suggest_scan_ranges()?;
    debug!(?ranges, "suggested scan ranges");
    for range in ranges {
        let mut cur = range;
        while !cur.is_empty() {
            let (batch, rest) = match cur.split_at(cur.block_range().start + BATCH) {
                Some((a, b)) => (a, b),
                None => {
                    let end = cur.block_range().end;
                    (cur.clone(), ScanRange::from_parts(end..end, cur.priority()))
                }
            };
            cur = rest;
            if scan_batch(net, client, db, cfg, stats, &batch, tip).await? {
                return Ok(true);
            }
            *scanned += batch.len() as u64;
        }
    }
    Ok(false)
}

async fn scan_batch(
    net: Network,
    client: &mut Client,
    db: &mut Db,
    cfg: &CoverCfg,
    stats: &mut CoverStats,
    range: &ScanRange,
    tip: BlockHeight,
) -> anyhow::Result<bool> {
    let start = range.block_range().start;
    let end = range.block_range().end; // exclusive
    info!(from = u32::from(start), to = u32::from(end) - 1, priority = ?range.priority(), "scanning");

    let req = service::BlockRange {
        start: Some(service::BlockId {
            height: u64::from(start),
            hash: vec![],
        }),
        end: Some(service::BlockId {
            height: u64::from(end - 1),
            hash: vec![],
        }),
        pool_types: Default::default(),
    };
    let blocks: Vec<_> = client.get_block_range(req).await?.into_inner().try_collect().await?;
    let candidates = cover::shielded_txids(&blocks);
    let source = MemBlocks::new(blocks);

    let prior = start - 1;
    let chain_state: ChainState = client
        .get_tree_state(service::BlockId {
            height: u64::from(prior),
            hash: vec![],
        })
        .await?
        .into_inner()
        .to_chain_state()?;

    match scan_cached_blocks(&net, &source, db, start, &chain_state, source.len()) {
        Ok(_) => {
            drop(source);
            // H1: fetch ALL shielded txs of these blocks; keep only the ones the wallet wants.
            let st = enhance_from(net, client, db, cfg, candidates, tip).await?;
            stats.add(&st);
            let latest = db.suggest_scan_ranges()?;
            Ok(latest.first().is_some_and(|r| r.priority() > range.priority()))
        }
        Err(ChainError::Scan(err)) if err.is_continuity_error() => {
            let at = err.at_height();
            warn!(at = u32::from(at), "chain reorg detected, rewinding");
            rewind(db, at, tip)?;
            Ok(true)
        }
        Err(e) => Err(anyhow!("scan failed: {e:?}")),
    }
}

fn rewind(db: &mut Db, at: BlockHeight, tip: BlockHeight) -> anyhow::Result<()> {
    let requested = at.saturating_sub(REORG_MARGIN);
    match db.truncate_to_height(requested) {
        Ok(_) => {}
        Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
            db.truncate_to_height(at.saturating_sub(2))
                .map_err(|e| anyhow!("unrecoverable reorg at {at}: {e:?}; delete the wallet DB and re-init"))?;
        }
        Err(e) => return Err(e.into()),
    }
    db.update_chain_tip(tip)?;
    Ok(())
}

/// Txids the wallet wants full data for (memo recovery) and txids it wants a status for.
fn wanted(db: &Db) -> anyhow::Result<(HashSet<TxId>, Vec<TxId>)> {
    let mut enh = HashSet::new();
    let mut status = Vec::new();
    for r in db.transaction_data_requests()? {
        match r {
            TransactionDataRequest::Enhancement(t) => {
                enh.insert(t);
            }
            TransactionDataRequest::GetStatus(t) => status.push(t),
            #[allow(unreachable_patterns)]
            _ => {}
        }
    }
    Ok((enh, status))
}

/// H1: fetch every candidate (all shielded txs of some blocks), store the wanted ones.
async fn enhance_from(
    net: Network,
    client: &mut Client,
    db: &mut Db,
    cfg: &CoverCfg,
    candidates: Vec<TxId>,
    tip: BlockHeight,
) -> anyhow::Result<CoverStats> {
    let (want, _) = wanted(db)?;
    if candidates.is_empty() {
        return Ok(CoverStats::default());
    }
    let (kept, st) = cover::fetch_all(client, cfg, candidates, &want).await;
    for k in kept {
        let tx = Transaction::read(&k.raw[..], BranchId::for_height(&net, k.height.unwrap_or(tip)))?;
        decrypt_and_store_transaction(&net, db, &tx, k.height)?;
    }
    debug!(
        candidates = st.candidates,
        failed = st.failed,
        retries = st.retries,
        bytes = st.bytes,
        ms = st.ms,
        "cover fetch"
    );
    Ok(st)
}

/// Requests left after the per-batch cover fetch (e.g. a fetch that failed in an earlier
/// pass). Never a lone `GetTransaction` for our txid:
/// - `Enhancement` of a mined tx: cover-fetch its whole block again;
/// - `GetStatus`: our own txs are found by the compact scan (they spend our nullifiers),
///   so a tx still unmined after a complete scan is answered locally as not in the main chain.
async fn enhance_leftovers(
    net: Network,
    client: &mut Client,
    db: &mut Db,
    cfg: &CoverCfg,
    tip: BlockHeight,
    complete: bool,
) -> anyhow::Result<CoverStats> {
    let mut total = CoverStats::default();
    let (want, status) = wanted(db)?;
    // Only a complete scan up to `tip` proves "not mined".
    for t in status.into_iter().filter(|_| complete) {
        match db.get_tx_height(t)? {
            Some(h) => db.set_transaction_status(t, TransactionStatus::Mined(h))?,
            None => db.set_transaction_status(t, TransactionStatus::NotInMainChain)?,
        }
    }
    let mut heights = BTreeSet::new();
    let mut unknown = 0usize;
    for t in &want {
        match db.get_tx_height(*t)? {
            Some(h) => {
                heights.insert(u32::from(h));
            }
            None => unknown += 1,
        }
    }
    if unknown > 0 {
        // Unmined and not ours to broadcast: wait until the compact scan sees it mined.
        debug!(unknown, "enhancement requests without a mined height deferred");
    }
    for h in heights {
        let req = service::BlockRange {
            start: Some(service::BlockId {
                height: u64::from(h),
                hash: vec![],
            }),
            end: Some(service::BlockId {
                height: u64::from(h),
                hash: vec![],
            }),
            pool_types: Default::default(),
        };
        let blocks: Vec<_> = client.get_block_range(req).await?.into_inner().try_collect().await?;
        let st = enhance_from(net, client, db, cfg, cover::shielded_txids(&blocks), tip).await?;
        total.add(&st);
    }
    Ok(total)
}

async fn fetch_tx(
    net: Network,
    client: &mut Client,
    tip: BlockHeight,
    txid: TxId,
) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
    let req = service::TxFilter {
        hash: txid.as_ref().to_vec(),
        ..Default::default()
    };
    let raw = match client.get_transaction(req).await {
        Ok(r) => r.into_inner(),
        Err(s) if s.code() == Code::NotFound => return Ok(None),
        Err(s) => return Err(s.into()),
    };
    let mined = (raw.height > 0 && raw.height <= u64::from(u32::MAX)).then(|| BlockHeight::from_u32(raw.height as u32));
    let tx = Transaction::read(&raw.data[..], BranchId::for_height(&net, mined.unwrap_or(tip)))?;
    Ok(Some((tx, mined)))
}

/// Read-only probe of the H1 cover fetch: take the last `n` compact blocks, fetch ALL their
/// Orchard/Ironwood txs exactly as the scanner does (shuffled, paced, backoff) and parse a
/// sample of `parse_sample` of them with the network's branch id. No wallet needed; prints
/// counters only (no txids, no addresses, no values).
pub async fn probe(
    net: Network,
    client: &mut Client,
    n: u32,
    parse_sample: usize,
    cfg: &CoverCfg,
) -> anyhow::Result<ProbeReport> {
    let tip = u32::try_from(
        client
            .get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height,
    )?;
    let req = service::BlockRange {
        start: Some(service::BlockId {
            height: u64::from(tip.saturating_sub(n - 1)),
            hash: vec![],
        }),
        end: Some(service::BlockId {
            height: u64::from(tip),
            hash: vec![],
        }),
        pool_types: Default::default(),
    };
    let t0 = std::time::Instant::now();
    let blocks: Vec<_> = client.get_block_range(req).await?.into_inner().try_collect().await?;
    let compact_ms = t0.elapsed().as_millis() as u64;
    let compact_bytes: u64 = blocks.iter().map(|b| prost::Message::encoded_len(b) as u64).sum();
    let all_txs: usize = blocks.iter().map(|b| b.vtx.len()).sum();
    let candidates = cover::shielded_txids(&blocks);
    let sample: HashSet<TxId> = candidates.iter().take(parse_sample).copied().collect();
    let (kept, cover) = cover::fetch_all(client, cfg, candidates, &sample).await;
    let mut parsed_ok = 0;
    for k in &kept {
        let br = BranchId::for_height(&net, k.height.unwrap_or(BlockHeight::from_u32(tip)));
        if Transaction::read(&k.raw[..], br).is_ok() {
            parsed_ok += 1;
        }
    }
    Ok(ProbeReport {
        tip,
        blocks: blocks.len(),
        all_txs,
        compact_bytes,
        compact_ms,
        cover,
        parsed: kept.len(),
        parsed_ok,
    })
}

pub struct ProbeReport {
    pub tip: u32,
    pub blocks: usize,
    pub all_txs: usize,
    pub compact_bytes: u64,
    pub compact_ms: u64,
    pub cover: CoverStats,
    pub parsed: usize,
    pub parsed_ok: usize,
}

/// Fetch a full transaction from lightwalletd and trial-decrypt it with the wallet's
/// UFVKs, independently of what the wallet DB already knows. This is exactly the path
/// a user deposit's memo goes through. Returns (pool, action, value_zat, transfer, memo).
pub async fn inspect_tx(
    net: Network,
    client: &mut Client,
    db: &Db,
    txid_hex: &str,
) -> anyhow::Result<Vec<(&'static str, usize, u64, String, crate::memo::MemoView)>> {
    use zcash_client_backend::{DecryptedOutput, decrypt_transaction};

    let txid = TxId::from_hex(txid_hex).ok_or_else(|| anyhow!("bad txid (expected 64 hex chars)"))?;
    let tip = db.chain_height()?.ok_or_else(|| anyhow!("run sync first"))?;
    let (tx, mined) = fetch_tx(net, client, tip, txid)
        .await?
        .ok_or_else(|| anyhow!("tx not found by lightwalletd"))?;
    let ufvks = db.get_unified_full_viewing_keys()?;
    let d = decrypt_transaction(&net, mined, Some(tip), &tx, &ufvks);
    let mut out = Vec::new();
    for (pool, outs) in [("orchard", d.orchard_outputs()), ("ironwood", d.ironwood_outputs())] {
        for o in outs {
            let o: &DecryptedOutput<(orchard::Note, orchard::ValuePool), _> = o;
            out.push((
                pool,
                o.index(),
                o.note().0.value().inner(),
                format!("{:?}", o.transfer_type()),
                crate::memo::MemoView::decode(o.memo().as_slice()),
            ));
        }
    }
    Ok(out)
}

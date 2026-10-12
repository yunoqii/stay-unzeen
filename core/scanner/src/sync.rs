//! Compact-block sync against lightwalletd + full-tx enhancement (needed for memos:
//! compact blocks carry only the first 52 bytes of each Orchard ciphertext, so the
//! memo is only recoverable after fetching the full transaction).
//!
//! Flow mirrors zcash-devtool `wallet sync` + `wallet enhance`, minus TUI/transparent.

use std::collections::BTreeSet;

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

use crate::{blocks::MemBlocks, wallet::Db};

type Client = CompactTxStreamerClient<Channel>;

/// Blocks per download/scan batch. Testnet blocks are small; keep memory bounded anyway.
const BATCH: u32 = 2_000;
const REORG_MARGIN: u32 = 10;

pub struct SyncReport {
    pub tip: u32,
    pub scanned_blocks: u64,
    pub enhanced_txs: usize,
}

pub async fn sync(net: Network, client: &mut Client, db: &mut Db) -> anyhow::Result<SyncReport> {
    update_subtree_roots(client, db).await?;

    let mut scanned_blocks = 0u64;
    let tip = loop {
        let tip = update_chain_tip(client, db).await?;
        let restart = scan_all(net, client, db, tip, &mut scanned_blocks).await?;
        if !restart {
            break tip;
        }
    };

    let enhanced_txs = enhance(net, client, db, tip).await?;
    Ok(SyncReport { tip: u32::from(tip), scanned_blocks, enhanced_txs })
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
            if scan_batch(net, client, db, &batch, tip).await? {
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
    range: &ScanRange,
    tip: BlockHeight,
) -> anyhow::Result<bool> {
    let start = range.block_range().start;
    let end = range.block_range().end; // exclusive
    info!(from = u32::from(start), to = u32::from(end) - 1, priority = ?range.priority(), "scanning");

    let req = service::BlockRange {
        start: Some(service::BlockId { height: u64::from(start), hash: vec![] }),
        end: Some(service::BlockId { height: u64::from(end - 1), hash: vec![] }),
        pool_types: Default::default(),
    };
    let blocks: Vec<_> = client.get_block_range(req).await?.into_inner().try_collect().await?;
    let source = MemBlocks::new(blocks);

    let prior = start - 1;
    let chain_state: ChainState = client
        .get_tree_state(service::BlockId { height: u64::from(prior), hash: vec![] })
        .await?
        .into_inner()
        .to_chain_state()?;

    match scan_cached_blocks(&net, &source, db, start, &chain_state, source.len()) {
        Ok(_) => {
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
            db.truncate_to_height(at.saturating_sub(2)).map_err(|e| {
                anyhow!("unrecoverable reorg at {at}: {e:?}; delete the wallet DB and re-init")
            })?;
        }
        Err(e) => return Err(e.into()),
    }
    db.update_chain_tip(tip)?;
    Ok(())
}

/// Fetch full transactions the wallet asked for (to recover memos / statuses).
async fn enhance(net: Network, client: &mut Client, db: &mut Db, tip: BlockHeight) -> anyhow::Result<usize> {
    let mut done = BTreeSet::new();
    let mut enhanced = 0;
    loop {
        let mut progressed = false;
        for req in db.transaction_data_requests()? {
            if !done.insert(req.clone()) {
                continue;
            }
            progressed = true;
            match &req {
                TransactionDataRequest::GetStatus(txid) => {
                    let status = fetch_tx(net, client, tip, *txid).await?.map_or(
                        TransactionStatus::TxidNotRecognized,
                        |(_, h)| h.map_or(TransactionStatus::NotInMainChain, TransactionStatus::Mined),
                    );
                    db.set_transaction_status(*txid, status)?;
                }
                TransactionDataRequest::Enhancement(txid) => match fetch_tx(net, client, tip, *txid).await? {
                    None => db.set_transaction_status(*txid, TransactionStatus::TxidNotRecognized)?,
                    Some((tx, h)) => {
                        decrypt_and_store_transaction(&net, db, &tx, h)?;
                        enhanced += 1;
                    }
                },
                #[allow(unreachable_patterns)]
                _ => {}
            }
        }
        if !progressed {
            break;
        }
    }
    Ok(enhanced)
}

async fn fetch_tx(
    net: Network,
    client: &mut Client,
    tip: BlockHeight,
    txid: TxId,
) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
    let req = service::TxFilter { hash: txid.as_ref().to_vec(), ..Default::default() };
    let raw = match client.get_transaction(req).await {
        Ok(r) => r.into_inner(),
        Err(s) if s.code() == Code::NotFound => return Ok(None),
        Err(s) => return Err(s.into()),
    };
    let mined = (raw.height > 0 && raw.height <= u64::from(u32::MAX))
        .then(|| BlockHeight::from_u32(raw.height as u32));
    let tx = Transaction::read(&raw.data[..], BranchId::for_height(&net, mined.unwrap_or(tip)))?;
    Ok(Some((tx, mined)))
}

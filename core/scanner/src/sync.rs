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
const MAX_RESTARTS: u32 = 20;

pub struct SyncReport {
    pub tip: u32,
    pub scanned_blocks: u64,
    pub enhanced_txs: usize,
}

pub async fn sync(net: Network, client: &mut Client, db: &mut Db) -> anyhow::Result<SyncReport> {
    update_subtree_roots(client, db).await?;

    let mut scanned_blocks = 0u64;
    let mut restarts = 0u32;
    let tip = loop {
        let tip = update_chain_tip(client, db).await?;
        let restart = scan_all(net, client, db, tip, &mut scanned_blocks).await?;
        if !restart {
            break tip;
        }
        restarts += 1;
        if restarts >= MAX_RESTARTS {
            // Continue next pass instead of spinning forever on re-prioritized ranges.
            warn!(restarts, "scan restarted too many times in one pass; deferring");
            break tip;
        }
    };

    let enhanced_txs = enhance(net, client, db, tip).await?;
    Ok(SyncReport {
        tip: u32::from(tip),
        scanned_blocks,
        enhanced_txs,
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
                    let status = fetch_tx(net, client, tip, *txid)
                        .await?
                        .map_or(TransactionStatus::TxidNotRecognized, |(_, h)| {
                            h.map_or(TransactionStatus::NotInMainChain, TransactionStatus::Mined)
                        });
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

/// Read-only health check: fetch the last `n` compact blocks, pick txs with Orchard/Ironwood
/// actions, download the full txs and parse them with the network's consensus branch id.
/// Proves the memo path (`GetTransaction` → `Transaction::read`) works on the current chain.
/// Returns (shielded txs found, txs parsed OK). Prints no addresses/values.
pub async fn probe(net: Network, client: &mut Client, n: u32, max_txs: usize) -> anyhow::Result<(usize, usize)> {
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
    let blocks: Vec<_> = client.get_block_range(req).await?.into_inner().try_collect().await?;
    let mut found = 0;
    let mut ok = 0;
    for b in blocks.iter().rev() {
        for ctx in &b.vtx {
            if ctx.actions.is_empty() && ctx.ironwood_actions.is_empty() {
                continue;
            }
            found += 1;
            if found > max_txs {
                return Ok((found - 1, ok));
            }
            let mut id = [0u8; 32];
            id.copy_from_slice(&ctx.txid);
            let txid = TxId::from_bytes(id);
            match fetch_tx(net, client, BlockHeight::from_u32(tip), txid).await {
                Ok(Some((tx, h))) => {
                    ok += 1;
                    println!(
                        "OK  height={} txid={} version={:?} branch={:?} orchard_actions={} ironwood_actions={}",
                        h.map_or(0, u32::from),
                        txid,
                        tx.version(),
                        tx.consensus_branch_id(),
                        tx.orchard_bundle().map_or(0, |bd| bd.actions().len()),
                        tx.ironwood_bundle().map_or(0, |bd| bd.actions().len()),
                    );
                }
                Ok(None) => println!("??  txid={txid} not found by server"),
                Err(e) => println!("ERR height={} txid={txid}: {e:#}", b.height),
            }
        }
    }
    Ok((found, ok))
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

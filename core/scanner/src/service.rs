//! `serve`: long-running deposit scanner feeding the Postgres ledger.
//!
//! Privacy: writes deposits ONLY to Postgres. Logs carry heights, durations and
//! per-status counters; never txids, amounts, memos, anon keys or the UFVK.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use sha2::{Digest, Sha256};
use tracing::{info, warn};
use unzeen_ledger::{Ledger, MemoInput, NoteObs, NoteRefKey, Observed, Policy};
use unzeen_protocol::{ChainId, SolanaCluster};
use zcash_client_backend::data_api::WalletRead;

use crate::{config::Common, deposits, memo::MemoView, sync, wallet};

fn env_u64(key: &str, default: u64) -> anyhow::Result<u64> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v.parse().with_context(|| format!("{key} must be an integer")),
        _ => Ok(default),
    }
}

/// Ledger policy from env: UNZEEN_CONFIRMATIONS (3), MIN_DEPOSIT_ZAT (100000),
/// MIN_ACTION_ZAT (100000), UNZEEN_SOLANA_CLUSTER (devnet | mainnet-beta).
pub fn policy_from_env(c: &Common) -> anyhow::Result<Policy> {
    let cluster: SolanaCluster = std::env::var("UNZEEN_SOLANA_CLUSTER")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "devnet".into())
        .parse()
        .map_err(|e: String| anyhow!(e))?;
    let confirmations = u32::try_from(env_u64("UNZEEN_CONFIRMATIONS", 3)?)?.max(1);
    Ok(Policy {
        chain: ChainId::new(c.network.zcash_net(), cluster),
        confirmations,
        min_deposit_zat: env_u64("MIN_DEPOSIT_ZAT", 100_000)?,
        min_action_zat: env_u64("MIN_ACTION_ZAT", 100_000)?,
        credit_jitter: u32::try_from(env_u64("UNZEEN_CONFIRMATIONS_JITTER", 3)?)?.min(10),
    })
}

/// note_ref key = sha256(domain || UFVK). The UFVK lives only in the wallet DB, so the
/// ledger alone cannot be joined to on-chain txids.
pub fn note_ref_key(c: &Common, db: &wallet::Db) -> anyhow::Result<NoteRefKey> {
    let (_, ufvk) = db
        .get_unified_full_viewing_keys()?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no account in wallet DB"))?;
    let enc = ufvk
        .encode(&c.params())
        .map_err(|e| anyhow!("UFVK encoding failed: {e:?}"))?;
    let mut h = Sha256::new();
    h.update(b"unzeen/ledger/note-ref/v1");
    h.update(enc.as_bytes());
    Ok(NoteRefKey::new(h.finalize().into()))
}

pub fn memo_input(raw: &Option<Vec<u8>>) -> MemoInput {
    match raw {
        None => MemoInput::NotFetched,
        Some(b) => match MemoView::decode(b) {
            MemoView::Text(t) => MemoInput::Text(t),
            _ => MemoInput::NonText,
        },
    }
}

/// D3: does this deposit tx reveal its amount on chain? True if it spends transparent
/// inputs, or moves value out of Sapling or legacy Orchard into Ironwood (turnstile: a
/// positive value balance of those pools is public). Ironwood→Ironwood (only the fee leaves
/// the Ironwood pool) is private. Addresses are not looked at or stored.
pub fn public_source(tx: &zcash_primitives::transaction::Transaction) -> bool {
    tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty())
        || tx.sapling_bundle().is_some_and(|b| i64::from(*b.value_balance()) > 0)
        || tx.orchard_bundle().is_some_and(|b| i64::from(*b.value_balance()) > 0)
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// One pass over all wallet notes. Returns per-outcome counters.
pub async fn apply_wallet_notes(
    c: &Common,
    db: &wallet::Db,
    ledger: &Ledger,
    key: &NoteRefKey,
    tip: u32,
) -> anyhow::Result<BTreeMap<Observed, usize>> {
    let db_path = c.wallet_db_path();
    let notes = deposits::list(&db_path)?;
    let times = deposits::block_times(&db_path, notes.iter().filter_map(|n| n.mined_height))?;
    let now = now_unix();
    let mut counts = BTreeMap::new();
    let mut public_src: BTreeMap<[u8; 32], bool> = BTreeMap::new();
    for n in &notes {
        // D3: only look at the full tx once the memo is there (tx enhanced).
        let public_source = match (n.memo_raw.is_some(), public_src.get(&n.txid_raw)) {
            (_, Some(v)) => *v,
            (false, None) => false,
            (true, None) => {
                let v = db
                    .get_transaction(zcash_primitives::transaction::TxId::from_bytes(n.txid_raw))?
                    .is_some_and(|tx| public_source(&tx));
                public_src.insert(n.txid_raw, v);
                v
            }
        };
        let obs = NoteObs {
            note_ref: key.note_ref(&n.txid_raw, n.pool_code, n.action_index),
            amount_zat: n.value_zat,
            mined_height: n.mined_height,
            tip,
            block_time: n.mined_height.and_then(|h| times.get(&h).copied()),
            memo: memo_input(&n.memo_raw),
            public_source,
        };
        let r = ledger.observe_note(&obs, now).await?;
        if r == Observed::ReorgAlert {
            // Operator alert without identifying data; details are in the ledger row.
            warn!("ALERT: a credited deposit is no longer mined (reorg); owner balance frozen");
        }
        *counts.entry(r).or_insert(0) += 1;
    }
    Ok(counts)
}

pub async fn serve(c: &Common, interval_secs: u64, once: bool, payouts: bool) -> anyhow::Result<()> {
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required for serve")?;
    let policy = policy_from_env(c)?;
    let ledger = Ledger::connect(&database_url, policy)
        .await
        .context("connecting to the ledger")?;
    let mut db = wallet::open_db(c)?;
    let key = note_ref_key(c, &db)?;
    // Public facts for `GET /api/pool` (the API server has no wallet access).
    let ua = wallet::show(c)?.ua_orchard;
    ledger.set_pool_meta("network", c.network.as_str()).await?;
    ledger.set_pool_meta("pool_ua", &ua).await?;
    info!(
        network = c.network.as_str(),
        confirmations = policy.confirmations,
        min_deposit_zat = policy.min_deposit_zat,
        "scanner service started"
    );

    let cover_cfg = crate::cover::CoverCfg::from_env()?;
    let payout_cfg = if payouts {
        // Fail at start, not at the first payout, if the seed cannot be decrypted.
        drop(crate::seed::load_phrase(c).context("payouts need the pool seed key")?);
        Some(crate::payout::PayoutCfg::from_env()?)
    } else {
        None
    };
    let mut client = None;
    let mut backoff = 5u64;
    loop {
        let started = std::time::Instant::now();
        let res: anyhow::Result<()> = async {
            if client.is_none() {
                client = Some(c.connect().await?);
            }
            let cl = client.as_mut().expect("set above");
            let rep = sync::sync(c.params(), cl, &mut db, &cover_cfg).await?;
            if !rep.complete {
                warn!(
                    tip = rep.tip,
                    "scan incomplete (reorg rewind pending); ledger not updated this pass"
                );
                return Ok(());
            }
            let counts = apply_wallet_notes(c, &db, &ledger, &key, rep.tip).await?;
            // Verify (API v0.7): spendable (>= confirmations) balance of the pool wallet at this
            // tip, attested by the operator in the next snapshot. Core only; never logged.
            if let Some(summary) = db
                .get_wallet_summary(zcash_client_backend::data_api::wallet::ConfirmationsPolicy::default())
                .map_err(|e| anyhow!("wallet summary: {e}"))?
            {
                let zat: u64 = summary
                    .account_balances()
                    .values()
                    .map(|b| u64::from(b.spendable_value()))
                    .sum();
                ledger.set_pool_meta("reserve_zat", &zat.to_string()).await?;
                ledger.set_pool_meta("reserve_height", &rep.tip.to_string()).await?;
            }
            let changed: BTreeMap<String, usize> = counts
                .iter()
                .filter(|(k, _)| **k != Observed::Unchanged)
                .map(|(k, v)| (format!("{k:?}").to_lowercase(), *v))
                .collect();
            info!(
                tip = rep.tip,
                scanned = rep.scanned_blocks,
                enhanced = rep.enhanced_txs,
                cover_txs = rep.cover.fetched,
                cover_failed = rep.cover.failed,
                cover_kib = rep.cover.bytes / 1024,
                notes = counts.values().sum::<usize>(),
                changes = ?changed,
                ms = started.elapsed().as_millis() as u64,
                "scan pass"
            );
            if let Some(pc) = &payout_cfg {
                let cl = client.as_mut().expect("set above");
                let p = crate::payout::run(c, pc, &mut db, cl, &ledger, rep.tip, policy.confirmations).await?;
                if p.sent + p.confirmed + p.failed > 0 || p.requeued > 0 {
                    info!(
                        sent = p.sent,
                        confirmed = p.confirmed,
                        requeued = p.requeued,
                        failed = p.failed,
                        waiting = p.waiting,
                        "payouts"
                    );
                }
            }
            Ok(())
        }
        .await;
        match res {
            Ok(()) => {
                backoff = 5;
                if once {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_secs(interval_secs.max(5))).await;
            }
            Err(e) => {
                // Drop the connection: next pass reconnects (with fallbacks).
                client = None;
                // Never log Postgres DETAIL (row values): LedgerError prints SQLSTATE only.
                warn!(error = %unzeen_ledger::error_chain(e.as_ref()), retry_in_s = backoff, "scan pass failed");
                if once {
                    return Err(e);
                }
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(300);
            }
        }
    }
}

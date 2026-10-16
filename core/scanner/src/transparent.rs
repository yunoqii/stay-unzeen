//! GAP-2: the pool's own transparent refund address and `shield` (t -> Ironwood).
//!
//! 1Click takes ZEC only from/to transparent addresses, so a failed rebalance is refunded
//! to `UNZEEN_REBALANCE_REFUND_TADDR`. That address now belongs to the pool wallet itself:
//! an external-scope P2PKH receiver of the pool account (same seed). It is NOT part of the
//! published Orchard/Ironwood-only UA (`/api/pool`, QR) and is never shown in the UI.
//!
//! `shield` moves every UTXO of that address into the pool's own Ironwood (the account's
//! internal receiver, i.e. a change note): one tx, `OvkPolicy::Discard`, broadcast through
//! `LIGHTWALLETD_SEND_URL` when set. The note is change, so the deposit ledger never sees it
//! (no credit, no `frozen` row); it simply becomes spendable working capital again.
//!
//! Privacy: refund and shield are operator actions on pool money, never user money. The UTXO
//! query and the broadcast go to the broadcast server (A8), never to the scan server, so the
//! scan server cannot tie the pool's session to this address. Logs carry only counters and
//! amounts; the address is printed only by `address --transparent` (operator stdout).

use anyhow::{Context, anyhow, bail};
use transparent::{
    address::{Script, TransparentAddress},
    bundle::{OutPoint, TxOut},
    keys::TransparentKeyScope,
};
use zcash_client_backend::{
    data_api::{
        Account as _, CoinbaseFilter, WalletRead, WalletWrite,
        wallet::{ConfirmationsPolicy, input_selection::GreedyInputSelector, propose_shielding},
    },
    fees::{DustOutputPolicy, StandardFeeRule, zip317::SingleOutputChangeStrategy},
    proto::service,
    wallet::WalletTransparentOutput,
};
use zcash_keys::{encoding::AddressCodec as _, keys::UnifiedAddressRequest};
use zcash_protocol::{ShieldedPool, consensus::BlockHeight, value::Zatoshis};

use crate::{config::Common, send, wallet::Db};

/// Smallest total worth shielding (below it the ZIP-317 fee eats most of it).
pub const DEFAULT_MIN_SHIELD_ZAT: u64 = 20_000;

/// The pool's refund t-address: the lowest-index external transparent receiver of the pool
/// account. Wallets created before GAP-2 have none yet; one is generated (index from the
/// wallet, within the gap limit) and persisted, so the result is stable afterwards.
pub fn pool_taddr(db: &mut Db) -> anyhow::Result<TransparentAddress> {
    let account = *db
        .get_account_ids()?
        .first()
        .ok_or_else(|| anyhow!("no account in wallet DB"))?;
    if let Some(a) = lowest_external(db, account)? {
        return Ok(a);
    }
    let has_t = db
        .get_account(account)?
        .and_then(|a| a.ufvk().map(|k| k.p2pkh().is_some()))
        .unwrap_or(false);
    if !has_t {
        bail!(
            "this pool wallet was created before GAP-2 and has no transparent key: no refund t-address. \
             Mainnet pools must be initialised with this build (`init`); otherwise set UNZEEN_REBALANCE_REFUND_TADDR"
        );
    }
    let (ua, _) = db
        .get_next_available_address(account, UnifiedAddressRequest::TRANSPARENT_ONLY)?
        .ok_or_else(|| anyhow!("account vanished"))?;
    let t = *ua
        .transparent()
        .ok_or_else(|| anyhow!("wallet produced no transparent receiver"))?;
    Ok(t)
}

fn lowest_external(db: &Db, account: zcash_client_sqlite::AccountUuid) -> anyhow::Result<Option<TransparentAddress>> {
    let mut best: Option<(u32, TransparentAddress)> = None;
    for (addr, meta) in db.get_transparent_receivers(account, false, false)? {
        if meta.scope() != Some(TransparentKeyScope::EXTERNAL) {
            continue;
        }
        let Some(i) = meta.address_index() else { continue };
        let i = i.index();
        if best.is_none_or(|(b, _)| i < b) {
            best = Some((i, addr));
        }
    }
    Ok(best.map(|(_, a)| a))
}

pub fn encode(common: &Common, a: &TransparentAddress) -> String {
    a.encode(&common.params())
}

/// One UTXO as reported by lightwalletd, checked against our own address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utxo {
    pub txid: [u8; 32],
    pub index: u32,
    pub value_zat: u64,
    pub height: u32,
}

/// Validate a `GetAddressUtxos` reply: it must pay exactly our P2PKH script (a lying server
/// cannot make us sign for something else; it can only hide UTXOs). Value in 1..=21M ZEC.
pub fn check_reply(ours: &TransparentAddress, r: &service::GetAddressUtxosReply) -> anyhow::Result<Utxo> {
    let want = Script::from(ours.script());
    if r.script != want.0.0 {
        bail!("lightwalletd returned a UTXO for another script");
    }
    let txid: [u8; 32] = r.txid[..].try_into().map_err(|_| anyhow!("bad txid length"))?;
    let index = u32::try_from(r.index).map_err(|_| anyhow!("bad output index"))?;
    let value = u64::try_from(r.value_zat).map_err(|_| anyhow!("negative value"))?;
    if value == 0 || Zatoshis::from_u64(value).is_err() {
        bail!("value out of range");
    }
    let height = u32::try_from(r.height).map_err(|_| anyhow!("bad height"))?;
    Ok(Utxo {
        txid,
        index,
        value_zat: value,
        height,
    })
}

/// UTXOs that are confirmed at least `k` times at `tip` (the rest wait for the next run).
pub fn confirmed(utxos: &[Utxo], tip: u32, k: u32) -> (Vec<Utxo>, Vec<Utxo>) {
    utxos
        .iter()
        .cloned()
        .partition(|u| u.height > 0 && tip + 1 >= u.height + k.max(1))
}

#[derive(Debug, Default)]
pub struct ShieldReport {
    pub utxos_found: usize,
    pub utxos_waiting: usize,
    pub total_zat: u64,
    pub fee_zat: u64,
    pub shielded_zat: u64,
    /// `Some` after a successful broadcast.
    pub txid: Option<String>,
}

/// Fetch the refund address's UTXOs (broadcast server), store them in the wallet and shield
/// the confirmed ones to the pool's Ironwood. `dry_run`: report only, nothing built/sent.
pub async fn shield(common: &Common, db: &mut Db, k: u32, min_zat: u64, dry_run: bool) -> anyhow::Result<ShieldReport> {
    if !dry_run {
        send::mainnet_gate(common)?;
    }
    let net = common.params();
    let taddr = pool_taddr(db)?;
    let tip = u32::from(
        db.chain_height()?
            .ok_or_else(|| anyhow!("wallet not synced yet (run `serve --once` first)"))?,
    );
    let account = *db.get_account_ids()?.first().ok_or_else(|| anyhow!("no account"))?;
    let birthday = u32::from(db.get_account_birthday(account)?);

    // A8: ask the broadcast server, not the scan server.
    let mut client = common.connect_send().await?;
    let list = client
        .get_address_utxos(service::GetAddressUtxosArg {
            addresses: vec![encode(common, &taddr)],
            start_height: u64::from(birthday),
            max_entries: 0,
        })
        .await
        .context("GetAddressUtxos")?
        .into_inner();
    let mut utxos = Vec::new();
    for r in &list.address_utxos {
        utxos.push(check_reply(&taddr, r)?);
    }
    let (ready, waiting) = confirmed(&utxos, tip, k);
    let mut rep = ShieldReport {
        utxos_found: utxos.len(),
        utxos_waiting: waiting.len(),
        total_zat: ready.iter().map(|u| u.value_zat).sum(),
        ..Default::default()
    };
    tracing::info!(
        utxos = rep.utxos_found,
        waiting = rep.utxos_waiting,
        total_zat = rep.total_zat,
        "shield: refund address scanned"
    );
    if ready.is_empty() || rep.total_zat < min_zat {
        return Ok(rep);
    }

    for u in &ready {
        let out = WalletTransparentOutput::from_parts(
            OutPoint::new(u.txid, u.index),
            TxOut::new(Zatoshis::from_u64(u.value_zat)?, Script::from(taddr.script())),
            Some(BlockHeight::from_u32(u.height)),
            Some(account),
            None,
            None,
        )
        .ok_or_else(|| anyhow!("UTXO has no recipient address"))?;
        db.put_received_transparent_utxo(&out)?;
    }

    let change = SingleOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        ShieldedPool::Ironwood,
        DustOutputPolicy::default(),
    );
    let conf = ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::new(k.max(1)).expect("max(1)"), false);
    let proposal = propose_shielding::<_, _, _, _, std::convert::Infallible>(
        db,
        &net,
        &GreedyInputSelector::new(),
        &change,
        Zatoshis::from_u64(min_zat)?,
        &[taddr],
        account,
        conf,
        CoinbaseFilter::NonCoinbaseOnly,
        None,
    )
    .map_err(|e| anyhow!("shielding proposal failed: {e}"))?;
    if proposal.steps().len() != 1 {
        bail!("multi-transaction shielding proposals not supported");
    }
    let step = proposal.steps().first();
    rep.fee_zat = u64::from(step.balance().fee_required());
    rep.shielded_zat = step
        .balance()
        .proposed_change()
        .iter()
        .map(|c| u64::from(c.value()))
        .sum();
    if step
        .balance()
        .proposed_change()
        .iter()
        .any(|c| c.output_pool() != zcash_protocol::PoolType::Shielded(ShieldedPool::Ironwood))
    {
        bail!("shielding proposal does not land in Ironwood");
    }
    if dry_run {
        return Ok(rep);
    }
    let derivation = db
        .get_account(account)?
        .ok_or_else(|| anyhow!("account vanished"))?
        .source()
        .key_derivation()
        .ok_or_else(|| anyhow!("view-only account cannot spend"))?
        .account_index();
    let (txid, raw) = send::build_from_proposal(common, db, derivation, &proposal)?;
    let mut sc = common.connect_send().await?;
    send::broadcast(&mut sc, raw).await?;
    tracing::info!(
        utxos = ready.len(),
        shielded_zat = rep.shielded_zat,
        fee_zat = rep.fee_zat,
        "shield: broadcast"
    );
    rep.txid = Some(txid.to_string());
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::data_api::{AccountBirthday, WalletRead, WalletWrite};
    use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
    use zcash_keys::keys::UnifiedAddressRequest;
    use zcash_protocol::consensus::Network;

    /// Offline wallet: account born at `tip - 30`, empty compact blocks scanned up to `tip`.
    fn temp_wallet(net: Network) -> (tempdir::Dir, Db) {
        use zcash_client_backend::{
            data_api::chain::{ChainState, scan_cached_blocks},
            proto::compact_formats::{ChainMetadata, CompactBlock},
        };
        let dir = tempdir::Dir::new();
        let path = dir.0.join("wallet.sqlite");
        let mut db = WalletDb::for_path(&path, net, SystemClock, crate::wallet::OsRng).unwrap();
        let seed = secrecy::SecretVec::new(vec![7u8; 32]);
        init_wallet_db(&mut db, Some(secrecy::SecretVec::new(vec![7u8; 32]))).unwrap();
        let tip = tip(net);
        let start = tip - 30;
        let prior = ChainState::empty(start - 1, zcash_primitives::block::BlockHash([0; 32]));
        db.create_account("t", &seed, &AccountBirthday::from_parts(prior.clone(), None), None)
            .unwrap();
        db.update_chain_tip(tip).unwrap();
        let blocks: Vec<CompactBlock> = (u32::from(start)..=u32::from(tip))
            .map(|h| CompactBlock {
                height: u64::from(h),
                hash: hash(h),
                prev_hash: if h == u32::from(start) {
                    vec![0; 32]
                } else {
                    hash(h - 1)
                },
                chain_metadata: Some(ChainMetadata::default()),
                ..Default::default()
            })
            .collect();
        let n = blocks.len();
        scan_cached_blocks(&net, &crate::blocks::MemBlocks::new(blocks), &mut db, start, &prior, n)
            .map_err(|e| e.to_string())
            .unwrap();
        (dir, db)
    }

    fn hash(h: u32) -> Vec<u8> {
        let mut v = vec![0xab; 32];
        v[..4].copy_from_slice(&h.to_le_bytes());
        v
    }

    /// A height where Ironwood (NU6.3) is active on `net`.
    fn tip(net: Network) -> BlockHeight {
        use zcash_protocol::consensus::{NetworkUpgrade, Parameters};
        net.activation_height(NetworkUpgrade::Nu6_3).unwrap() + 100
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!("unzeen-t-{}", rand::random::<u64>()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn pool_taddr_is_stable_and_not_in_published_ua() {
        for net in [Network::MainNetwork, Network::TestNetwork] {
            let (_d, mut db) = temp_wallet(net);
            let account = db.get_account_ids().unwrap()[0];
            let (ua, _) = db
                .get_next_available_address(account, UnifiedAddressRequest::ORCHARD)
                .unwrap()
                .unwrap();
            assert!(
                ua.transparent().is_none(),
                "published UA must stay Orchard/Ironwood-only"
            );
            let a = pool_taddr(&mut db).unwrap();
            let b = pool_taddr(&mut db).unwrap();
            assert_eq!(a, b, "refund address must be stable across calls");
            let enc = a.encode(&net);
            match net {
                Network::MainNetwork => assert!(enc.starts_with("t1"), "{enc}"),
                Network::TestNetwork => assert!(enc.starts_with("tm"), "{enc}"),
            }
            assert!(crate::rebalance::is_transparent(&enc, &net));
            // Derived from the same seed: a second wallet with the same seed gets the same one.
            let (_d2, mut db2) = temp_wallet(net);
            assert_eq!(pool_taddr(&mut db2).unwrap(), a);
        }
    }

    fn reply(a: &TransparentAddress, value: i64, height: u64) -> service::GetAddressUtxosReply {
        service::GetAddressUtxosReply {
            address: String::new(),
            txid: vec![1; 32],
            index: 0,
            script: Script::from(a.script()).0.0,
            value_zat: value,
            height,
        }
    }

    #[test]
    fn check_reply_rejects_foreign_script_and_bad_values() {
        let ours = TransparentAddress::PublicKeyHash([1; 20]);
        let other = TransparentAddress::PublicKeyHash([2; 20]);
        assert_eq!(check_reply(&ours, &reply(&ours, 5000, 10)).unwrap().value_zat, 5000);
        assert!(check_reply(&ours, &reply(&other, 5000, 10)).is_err());
        assert!(check_reply(&ours, &reply(&ours, 0, 10)).is_err());
        assert!(check_reply(&ours, &reply(&ours, -1, 10)).is_err());
        let mut r = reply(&ours, 5000, 10);
        r.txid = vec![1; 31];
        assert!(check_reply(&ours, &r).is_err());
    }

    #[test]
    fn confirmations_split() {
        let u = |h| Utxo {
            txid: [0; 32],
            index: 0,
            value_zat: 1,
            height: h,
        };
        // tip 100, K = 3: heights <= 98 are confirmed 3 times.
        let (ok, wait) = confirmed(&[u(98), u(99), u(100), u(0)], 100, 3);
        assert_eq!(ok.iter().map(|u| u.height).collect::<Vec<_>>(), vec![98]);
        assert_eq!(wait.len(), 3);
    }

    /// End-to-end proposal offline: a fake refund UTXO is proposed into ONE Ironwood change
    /// output with the ZIP-317 fee, and no transparent output.
    #[test]
    fn shielding_proposal_lands_in_ironwood() {
        let net = Network::MainNetwork;
        let (_d, mut db) = temp_wallet(net);
        let account = db.get_account_ids().unwrap()[0];
        let taddr = pool_taddr(&mut db).unwrap();
        let tip = tip(net);
        let out = WalletTransparentOutput::from_parts(
            OutPoint::new([3; 32], 0),
            TxOut::new(Zatoshis::from_u64(1_000_000).unwrap(), Script::from(taddr.script())),
            Some(tip - 20),
            Some(account),
            None,
            None,
        )
        .unwrap();
        db.put_received_transparent_utxo(&out).unwrap();
        let change = SingleOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Ironwood,
            DustOutputPolicy::default(),
        );
        let conf = ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::new(3).unwrap(), false);
        let p = propose_shielding::<_, _, _, _, std::convert::Infallible>(
            &mut db,
            &net,
            &GreedyInputSelector::new(),
            &change,
            Zatoshis::from_u64(DEFAULT_MIN_SHIELD_ZAT).unwrap(),
            &[taddr],
            account,
            conf,
            CoinbaseFilter::NonCoinbaseOnly,
            None,
        )
        .map_err(|e| e.to_string())
        .unwrap();
        assert_eq!(p.steps().len(), 1);
        let s = p.steps().first();
        assert_eq!(s.transparent_inputs().len(), 1);
        let fee = u64::from(s.balance().fee_required());
        let change: u64 = s.balance().proposed_change().iter().map(|c| u64::from(c.value())).sum();
        assert!(fee > 0 && fee <= 20_000, "fee {fee}");
        assert_eq!(change + fee, 1_000_000);
        assert!(
            s.balance()
                .proposed_change()
                .iter()
                .all(|c| c.output_pool() == zcash_protocol::PoolType::Shielded(ShieldedPool::Ironwood))
        );
        assert!(s.payment_pools().is_empty(), "no payments: only the shielded change");
    }

    /// The real build path (prove + sign) offline: one transparent input, no transparent
    /// output, an Ironwood bundle, nothing in Orchard/Sapling; the UTXO is spent afterwards.
    #[test]
    #[ignore = "slow: Orchard/Ironwood proving, ~50 s in debug; run with --ignored"]
    fn shielding_tx_builds() {
        use zcash_client_backend::data_api::wallet::{SpendingKeys, create_proposed_transactions};
        let net = Network::MainNetwork;
        let (_d, mut db) = temp_wallet(net);
        let account = db.get_account_ids().unwrap()[0];
        let taddr = pool_taddr(&mut db).unwrap();
        let tip = tip(net);
        let out = WalletTransparentOutput::from_parts(
            OutPoint::new([4; 32], 1),
            TxOut::new(Zatoshis::from_u64(500_000).unwrap(), Script::from(taddr.script())),
            Some(tip - 10),
            Some(account),
            None,
            None,
        )
        .unwrap();
        db.put_received_transparent_utxo(&out).unwrap();
        let change = SingleOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Ironwood,
            DustOutputPolicy::default(),
        );
        let conf = ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::new(3).unwrap(), false);
        let p = propose_shielding::<_, _, _, _, std::convert::Infallible>(
            &mut db,
            &net,
            &GreedyInputSelector::new(),
            &change,
            Zatoshis::from_u64(DEFAULT_MIN_SHIELD_ZAT).unwrap(),
            &[taddr],
            account,
            conf,
            CoinbaseFilter::NonCoinbaseOnly,
            None,
        )
        .map_err(|e| e.to_string())
        .unwrap();
        let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(&net, &[7u8; 32], zip32::AccountId::ZERO).unwrap();
        let prover = zcash_proofs::prover::LocalTxProver::bundled();
        let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut db,
            &net,
            &SystemClock,
            &mut { crate::wallet::OsRng },
            &prover,
            &prover,
            &SpendingKeys::from_unified_spending_key(usk),
            zcash_client_backend::wallet::OvkPolicy::Discard,
            &p,
            None,
        )
        .map_err(|e| e.to_string())
        .unwrap();
        let tx = db.get_transaction(*txids.first()).unwrap().unwrap();
        let t = tx.transparent_bundle().expect("transparent input");
        assert_eq!(t.vin.len(), 1);
        assert!(t.vout.is_empty(), "nothing goes back to a transparent address");
        assert!(tx.ironwood_bundle().is_some(), "value lands in Ironwood");
        assert!(tx.orchard_bundle().is_none() && tx.sapling_bundle().is_none());
        // The UTXO is now spent by our own tx: a second shield finds nothing to do.
        let again = propose_shielding::<_, _, _, _, std::convert::Infallible>(
            &mut db,
            &net,
            &GreedyInputSelector::new(),
            &change,
            Zatoshis::from_u64(DEFAULT_MIN_SHIELD_ZAT).unwrap(),
            &[taddr],
            account,
            conf,
            CoinbaseFilter::NonCoinbaseOnly,
            None,
        );
        assert!(again.is_err(), "the refund UTXO must be marked spent");
    }
}

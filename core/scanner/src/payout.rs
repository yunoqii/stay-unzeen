//! `withdraw_zec` executor: `zec_payouts` → one shielded tx from the pool wallet.
//!
//! Runs inside `serve --payouts`, after each complete scan pass (the wallet DB is used by one
//! task only). Per pass:
//! 1. In-flight txs: mined with >= K confirmations → payouts confirmed (hold spent, recipient
//!    and txid erased). Expired without being mined → back to the queue (new tx later).
//!    Still pending → re-broadcast the SAME tx (idempotent). A new tx for a payout is built
//!    only after the old one provably cannot be mined: no double payouts.
//! 2. Ready payouts (API jitter `not_before` passed): up to `max_batch` of them go into ONE
//!    tx (several Ironwood outputs + change), `OvkPolicy::Discard`, each strictly to the
//!    Orchard/Ironwood receiver of the user's UA (t/Sapling receivers are dropped, M4).
//!    The txid is written to Postgres BEFORE broadcast.
//!
//! Mainnet: nothing is built unless `UNZEEN_ALLOW_MAINNET_SEND=1`, and a single payout above
//! `UNZEEN_MAX_PAYOUT_ZAT` waits for manual review.
//!
//! Privacy: logs carry counters only (no txids, amounts or addresses).

use anyhow::{Context, anyhow};
use tonic::transport::Channel;
use tracing::{info, warn};
use unzeen_ledger::{Ledger, PayoutRow};
use zcash_address::ZcashAddress;
use zcash_client_backend::{data_api::WalletRead, proto::service::compact_tx_streamer_client::CompactTxStreamerClient};
use zcash_keys::address::{Address, UnifiedAddress};
use zcash_primitives::transaction::TxId;
use zcash_protocol::{
    consensus::{Network, Parameters},
    value::Zatoshis,
};
use zip321::Payment;

use crate::{
    config::{Common, NetName},
    send::{self, ProposalError},
    wallet::Db,
};

type Client = CompactTxStreamerClient<Channel>;

#[derive(Clone, Copy, Debug)]
pub struct PayoutCfg {
    /// Payouts per tx.
    pub max_batch: usize,
    /// Mainnet: single payouts above this wait for manual review.
    pub max_payout_zat: u64,
    /// Re-queue delay after an expired tx (seconds, uniform).
    pub requeue_min_secs: f64,
    pub requeue_max_secs: f64,
}

impl PayoutCfg {
    pub fn from_env() -> anyhow::Result<Self> {
        let get = |k: &str, d: u64| -> anyhow::Result<u64> {
            match std::env::var(k).ok().filter(|v| !v.is_empty()) {
                Some(v) => v.parse().with_context(|| format!("{k} must be an integer")),
                None => Ok(d),
            }
        };
        Ok(Self {
            max_batch: get("UNZEEN_PAYOUT_BATCH", 5)?.clamp(1, 20) as usize,
            max_payout_zat: get("UNZEEN_MAX_PAYOUT_ZAT", 5_000_000)?,
            requeue_min_secs: get("ZEC_PAYOUT_DELAY_MIN_SECS", 60)? as f64,
            requeue_max_secs: get("ZEC_PAYOUT_DELAY_MAX_SECS", 600)? as f64,
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PayoutStats {
    pub confirmed: usize,
    pub requeued: u64,
    pub sent: usize,
    pub failed: usize,
    pub waiting: usize,
}

/// The user's UA reduced to its Orchard/Ironwood receiver (M4): the payout can only land in
/// the Orchard family, never in a transparent or Sapling receiver of the same UA.
pub fn orchard_only(ua: &str, net: &Network) -> anyhow::Result<ZcashAddress> {
    let Some(Address::Unified(u)) = Address::decode(net, ua) else {
        anyhow::bail!("not a unified address of this network");
    };
    let o = u.orchard().ok_or_else(|| anyhow!("no Orchard/Ironwood receiver"))?;
    let only = UnifiedAddress::from_receivers(Some(*o), None, None, None, None)
        .ok_or_else(|| anyhow!("cannot build an Orchard-only address"))?;
    Ok(only.to_zcash_address(net.network_type()))
}

fn jitter(min: f64, max: f64) -> f64 {
    min + (max - min).max(0.0) * ((rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64)
}

/// One executor step (see module docs). `tip` must come from a COMPLETE scan pass.
pub async fn run(
    c: &Common,
    cfg: &PayoutCfg,
    db: &mut Db,
    client: &mut Client,
    ledger: &Ledger,
    tip: u32,
    confirmations: u32,
) -> anyhow::Result<PayoutStats> {
    let mut st = PayoutStats::default();

    // 1. In flight.
    for p in ledger.inflight_payouts().await? {
        let txid = TxId::from_bytes(p.txid);
        match db.get_tx_height(txid)? {
            Some(h) if tip + 1 >= u32::from(h) + confirmations => {
                st.confirmed += ledger.confirm_payouts(&p.txid).await?;
            }
            Some(_) => st.waiting += p.ids.len(),
            None => match db.get_transaction(txid)? {
                Some(tx) if tip >= u32::from(tx.expiry_height()) && u32::from(tx.expiry_height()) > 0 => {
                    // Expired unmined at a fully scanned tip: it can never be mined.
                    st.requeued += ledger
                        .requeue_payouts(&p.txid, jitter(cfg.requeue_min_secs, cfg.requeue_max_secs))
                        .await?;
                }
                Some(tx) => {
                    st.waiting += p.ids.len();
                    let mut raw = Vec::new();
                    tx.write(&mut raw)?;
                    // Idempotent; "already in mempool" style rejections are expected.
                    let _ = send::broadcast(client, raw).await;
                }
                None => {
                    // Built tx missing from the wallet DB: cannot prove it will not be mined.
                    warn!("ALERT: in-flight payout tx missing from the wallet DB; manual review");
                    st.waiting += p.ids.len();
                }
            },
        }
    }

    // 2. New payouts. None while a Verify snapshot is freezing/collecting (review-day8 E8):
    // the reserve sampled during the freeze must already contain every payout in flight.
    if c.network == NetName::Main && send::mainnet_gate(c).is_err() {
        return Ok(st);
    }
    if ledger.verify_frozen().await? {
        return Ok(st);
    }
    let ready = ledger.ready_payouts(cfg.max_batch as i64).await?;
    if ready.is_empty() {
        return Ok(st);
    }
    let net = c.params();
    let mut batch: Vec<(PayoutRow, Payment)> = Vec::new();
    for p in ready {
        if c.network == NetName::Main && p.amount_zat > cfg.max_payout_zat {
            warn!("payout above UNZEEN_MAX_PAYOUT_ZAT waits for manual review");
            st.waiting += 1;
            continue;
        }
        let payment = orchard_only(&p.to_ua, &net).and_then(|to| {
            Payment::new(to, Some(Zatoshis::from_u64(p.amount_zat)?), None, None, None, vec![])
                .map_err(|e| anyhow!("{e:?}"))
        });
        match payment {
            Ok(pay) => batch.push((p, pay)),
            Err(_) => st.failed += ledger.fail_payouts(&[p.id], "bad_request").await?,
        }
    }
    if batch.is_empty() {
        return Ok(st);
    }

    // Whole batch first; if the pool cannot fund it (e.g. change still unconfirmed), try the
    // oldest payout alone; otherwise everything waits for the next pass.
    let attempts: Vec<usize> = if batch.len() > 1 { vec![batch.len(), 1] } else { vec![1] };
    for n in attempts {
        let payments: Vec<Payment> = batch[..n].iter().map(|(_, p)| p.clone()).collect();
        match send::build_tx(c, db, payments) {
            Ok((txid, raw)) => {
                let ids: Vec<i64> = batch[..n].iter().map(|(r, _)| r.id).collect();
                let txid_b: [u8; 32] = *txid.as_ref();
                if ledger.mark_payouts_sent(&ids, &txid_b).await? as usize != ids.len() {
                    // Rows changed under us: never broadcast (notes stay locked until expiry).
                    warn!("payout rows changed before broadcast; tx not sent");
                    return Ok(st);
                }
                if let Err(e) = send::broadcast(client, raw).await {
                    // Stays `sent`: re-broadcast next pass, re-queued only after expiry.
                    warn!(error = %e, "payout broadcast failed; will retry the same tx");
                }
                st.sent += ids.len();
                st.waiting += batch.len() - n;
                info!(payouts = ids.len(), "payout tx built and broadcast");
                return Ok(st);
            }
            Err(e) if e.downcast_ref::<ProposalError>().is_some() => continue,
            Err(e) => return Err(e),
        }
    }
    warn!(
        waiting = batch.len(),
        "payouts waiting: pool has not enough confirmed shielded funds"
    );
    st.waiting += batch.len();
    Ok(st)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_address::unified::{self, Container, Encoding};
    use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};

    fn ua(req: UnifiedAddressRequest, net: Network) -> String {
        let usk = UnifiedSpendingKey::from_seed(&net, &[9u8; 32], zip32::AccountId::ZERO).unwrap();
        let (ua, _) = usk.to_unified_full_viewing_key().default_address(req).unwrap();
        ua.encode(&net)
    }

    #[test]
    fn keeps_only_the_orchard_receiver() {
        let net = Network::TestNetwork;
        // A UA with Orchard + transparent receivers (what a wallet may hand out).
        let (_, _, base) = unified::Address::decode(&ua(UnifiedAddressRequest::ORCHARD, net)).unwrap();
        let orchard = base.items()[0].clone();
        let full = unified::Address::try_from_items(
            unified::Revision::R0,
            vec![
                unified::Uitem::Data(orchard),
                unified::Uitem::Data(unified::Receiver::P2pkh([1; 20])),
            ],
        )
        .unwrap()
        .encode(&zcash_protocol::consensus::NetworkType::Test);
        let only = orchard_only(&full, &net).unwrap().encode();
        let (_, _, a) = unified::Address::decode(&only).unwrap();
        let items = a.items();
        assert_eq!(items.len(), 1);
        assert!(matches!(items[0], unified::Receiver::Orchard(_)));
        assert_ne!(only, full);
    }

    #[test]
    fn rejects_other_network_and_non_ua() {
        let main = ua(UnifiedAddressRequest::ORCHARD, Network::MainNetwork);
        assert!(orchard_only(&main, &Network::TestNetwork).is_err());
        assert!(orchard_only("tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU", &Network::TestNetwork).is_err());
        assert!(orchard_only("garbage", &Network::TestNetwork).is_err());
    }
}

//! Shielded send from the pool wallet (with memo). Used today for the self-test
//! "send a memo to ourselves and read it back"; will become the payout path.
//!
//! SAFETY: refuses to run on mainnet unless `UNZEEN_ALLOW_MAINNET_SEND=1` is set
//! explicitly (mainnet spending needs the lead's approval and dust amounts only).

use std::str::FromStr;

use anyhow::{anyhow, bail};
use bip0039::{English, Mnemonic};
use secrecy::Zeroize;
use zcash_address::ZcashAddress;
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_client_backend::{
    data_api::{
        Account as _, WalletRead,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            input_selection::{GreedyInputSelector, SpendPolicy},
            propose_transfer,
        },
    },
    fees::{DustOutputPolicy, StandardFeeRule, zip317::SingleOutputChangeStrategy},
    proto::service,
    wallet::OvkPolicy,
};
use zcash_client_sqlite::util::SystemClock;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_primitives::transaction::TxId;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    ShieldedPool,
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zip321::{Payment, TransactionRequest};

type Client = CompactTxStreamerClient<tonic::transport::Channel>;

use crate::{
    config::{Common, NetName},
    wallet::{Db, OsRng},
};

/// Upper bound on a single send from this CLI (0.05 ZEC), whatever the network.
pub const MAX_SEND_ZAT: u64 = 5_000_000;

pub async fn send(
    common: &Common,
    db: &mut Db,
    to: &str,
    amount_zat: u64,
    memo: Option<&str>,
) -> anyhow::Result<String> {
    mainnet_gate(common)?;
    if amount_zat == 0 || amount_zat > MAX_SEND_ZAT {
        bail!("amount must be in 1..={MAX_SEND_ZAT} zat");
    }
    let recipient = ZcashAddress::from_str(to).map_err(|e| anyhow!("bad recipient address: {e}"))?;
    let memo = memo
        .map(|m| Memo::from_str(m).map(MemoBytes::from))
        .transpose()
        .map_err(|e| anyhow!("bad memo: {e:?}"))?;
    let payment = Payment::new(
        recipient,
        Some(Zatoshis::from_u64(amount_zat)?),
        memo,
        None,
        None,
        vec![],
    )
    .map_err(|e| anyhow!("invalid payment: {e:?}"))?;
    let (txid, raw) = build_tx(common, db, vec![payment])?;
    let mut client = common.connect().await?;
    broadcast(&mut client, raw).await?;
    Ok(txid.to_string())
}

/// Mainnet spending needs `UNZEEN_ALLOW_MAINNET_SEND=1` (lead approval).
pub fn mainnet_gate(common: &Common) -> anyhow::Result<()> {
    if common.network == NetName::Main && std::env::var("UNZEEN_ALLOW_MAINNET_SEND").as_deref() != Ok("1") {
        bail!("mainnet send is disabled; set UNZEEN_ALLOW_MAINNET_SEND=1 only with lead approval");
    }
    Ok(())
}

/// Error of [`build_tx`] at the proposal stage (not enough confirmed funds, bad request):
/// nothing was built and no notes were locked.
#[derive(Debug)]
pub struct ProposalError(pub String);

impl std::fmt::Display for ProposalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "proposal failed: {}", self.0)
    }
}

impl std::error::Error for ProposalError {}

/// Build, prove and store (in the wallet DB) ONE shielded tx paying all `payments`, with
/// Ironwood change and `OvkPolicy::Discard`. Not broadcast. Returns (txid, raw tx).
pub fn build_tx(common: &Common, db: &mut Db, payments: Vec<Payment>) -> anyhow::Result<(TxId, Vec<u8>)> {
    let net = common.params();
    let request = TransactionRequest::new(payments).map_err(|e| ProposalError(format!("{e:?}")))?;

    let account_id = *db
        .get_account_ids()?
        .first()
        .ok_or_else(|| anyhow!("no account in wallet"))?;
    let account = db.get_account(account_id)?.ok_or_else(|| anyhow!("account vanished"))?;
    let derivation = account
        .source()
        .key_derivation()
        .ok_or_else(|| anyhow!("view-only account cannot spend"))?;

    let change = SingleOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        ShieldedPool::Ironwood,
        DustOutputPolicy::default(),
    );
    // Propose first (no secrets needed): a failure here locks nothing.
    let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
        db,
        &net,
        account_id,
        &GreedyInputSelector::new(),
        &change,
        request,
        ConfirmationsPolicy::default(),
        &SpendPolicy::default(),
        None,
        None,
    )
    .map_err(|e| ProposalError(format!("{e}")))?;
    // Reject before building: built txs would lock notes in the wallet until expiry.
    if proposal.steps().len() > 1 {
        return Err(ProposalError("multi-transaction proposals not supported".into()).into());
    }

    let phrase = crate::seed::load_phrase(common)?;
    let mnemonic =
        <Mnemonic<English>>::from_phrase(phrase.as_str()).map_err(|_| anyhow!("bad seed (not a mnemonic)"))?;
    let mut seed = mnemonic.to_seed("");
    drop(mnemonic);
    let usk = UnifiedSpendingKey::from_seed(&net, &seed, derivation.account_index())
        .map_err(|e| anyhow!("key derivation failed: {e:?}"));
    seed.zeroize();
    let usk = usk?;

    let prover = LocalTxProver::bundled();
    let mut rng = OsRng;
    let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
        db,
        &net,
        &SystemClock,
        &mut rng,
        &prover,
        &prover,
        &SpendingKeys::from_unified_spending_key(usk),
        // Payouts must not be recoverable from the pool's OVK (C1): a future OVK/seed leak
        // must not reveal who was paid. Our own records live in the ledger.
        OvkPolicy::Discard,
        &proposal,
        None,
    )
    .map_err(|e| anyhow!("building tx failed: {e}"))?;
    let txid = *txids.first();
    let tx = db
        .get_transaction(txid)?
        .ok_or_else(|| anyhow!("built tx not found in DB"))?;
    let mut raw = Vec::new();
    tx.write(&mut raw)?;
    Ok((txid, raw))
}

/// Broadcast a raw tx. Re-sending the same tx is harmless (same txid).
pub async fn broadcast(client: &mut Client, raw: Vec<u8>) -> anyhow::Result<()> {
    let resp = client
        .send_transaction(service::RawTransaction { data: raw, height: 0 })
        .await?
        .into_inner();
    if resp.error_code != 0 {
        bail!("lightwalletd rejected tx: {} {}", resp.error_code, resp.error_message);
    }
    Ok(())
}

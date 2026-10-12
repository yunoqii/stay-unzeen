//! Shielded send from the pool wallet (with memo). Used today for the self-test
//! "send a memo to ourselves and read it back"; will become the payout path.
//!
//! SAFETY: refuses to run on mainnet unless `UNZEEN_ALLOW_MAINNET_SEND=1` is set
//! explicitly (mainnet spending needs the lead's approval and dust amounts only).

use std::str::FromStr;

use anyhow::{Context, anyhow, bail};
use bip0039::{English, Mnemonic};
use secrecy::Zeroize;
use zcash_address::ZcashAddress;
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
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    ShieldedPool,
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zip321::{Payment, TransactionRequest};

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
    if common.network == NetName::Main
        && std::env::var("UNZEEN_ALLOW_MAINNET_SEND").as_deref() != Ok("1")
    {
        bail!("mainnet send is disabled; set UNZEEN_ALLOW_MAINNET_SEND=1 only with lead approval");
    }
    if amount_zat == 0 || amount_zat > MAX_SEND_ZAT {
        bail!("amount must be in 1..={MAX_SEND_ZAT} zat");
    }
    let net = common.params();

    let recipient = ZcashAddress::from_str(to).map_err(|e| anyhow!("bad recipient address: {e}"))?;
    let memo = memo
        .map(|m| Memo::from_str(m).map(MemoBytes::from))
        .transpose()
        .map_err(|e| anyhow!("bad memo: {e:?}"))?;
    let payment = Payment::new(recipient, Some(Zatoshis::from_u64(amount_zat)?), memo, None, None, vec![])
        .map_err(|e| anyhow!("invalid payment: {e:?}"))?;
    let request = TransactionRequest::new(vec![payment]).map_err(|e| anyhow!("{e:?}"))?;

    let account_id = *db
        .get_account_ids()?
        .first()
        .ok_or_else(|| anyhow!("no account in wallet"))?;
    let account = db.get_account(account_id)?.ok_or_else(|| anyhow!("account vanished"))?;
    let derivation = account
        .source()
        .key_derivation()
        .ok_or_else(|| anyhow!("view-only account cannot spend"))?;

    let phrase = std::fs::read_to_string(common.seed_path())
        .with_context(|| format!("reading {}", common.seed_path().display()))?;
    let mnemonic = <Mnemonic<English>>::from_phrase(phrase.trim()).map_err(|e| anyhow!("bad seed file: {e:?}"))?;
    let mut seed = mnemonic.to_seed("");
    let usk = UnifiedSpendingKey::from_seed(&net, &seed, derivation.account_index())
        .map_err(|e| anyhow!("key derivation failed: {e:?}"));
    seed.zeroize();
    let usk = usk?;

    let change = SingleOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        ShieldedPool::Ironwood,
        DustOutputPolicy::default(),
    );
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
    .map_err(|e| anyhow!("proposal failed: {e}"))?;
    tracing::info!(steps = proposal.steps().len(), "proposal created");

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
        OvkPolicy::Sender,
        &proposal,
        None,
    )
    .map_err(|e| anyhow!("building tx failed: {e}"))?;
    if txids.len() > 1 {
        bail!("multi-transaction proposals not supported");
    }
    let txid = *txids.first();
    let tx = db.get_transaction(txid)?.ok_or_else(|| anyhow!("built tx not found in DB"))?;
    let mut raw = service::RawTransaction::default();
    tx.write(&mut raw.data)?;

    let mut client = common.connect().await?;
    let resp = client.send_transaction(raw).await?.into_inner();
    if resp.error_code != 0 {
        bail!("lightwalletd rejected tx: {} {}", resp.error_code, resp.error_message);
    }
    Ok(txid.to_string())
}

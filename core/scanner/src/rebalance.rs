//! Automatic pool rebalance ZEC → SOL through NEAR Intents 1Click (RELAYER.md v7).
//!
//! Runs inside `serve --rebalance`, after the payout step (the wallet DB has one user). Per pass
//! it advances the single live rebalance of the network (journal `pool_rebalances`):
//!
//! 1. **Trigger** (no live rebalance): free SOL of the pool = Σ vault lamports + undistributed
//!    lamports on the rebalance address − per-vault reserve − SOL promised to queued jobs
//!    (inventory written by the relayer, no Solana RPC from core). Below
//!    `UNZEEN_REBALANCE_MIN_FREE_LAMPORTS` → plan ONE fixed lot (`UNZEEN_REBALANCE_LOT_ZAT`)
//!    after a random delay. Daily cap + cooldown. The lot and the schedule never depend on a
//!    single user's deposit or action.
//! 2. **Due**: re-check the trigger (cancel if SOL recovered), check that the pool keeps every
//!    user's ZEC (spendable ≥ liabilities + lot + fee margin), then a 1Click quote (EXACT_INPUT
//!    ZEC → SOL, recipient = the pool's rebalance SOL address, refund = the pool's t-address).
//! 3. **Send**: one tx Ironwood → the quote's transparent deposit address, exactly `amountIn`,
//!    `OvkPolicy::Discard`, Ironwood change. The txid is written to Postgres BEFORE broadcast;
//!    a deposit address is funded at most once (UNIQUE, never re-quoted into).
//! 4. **Status**: K confirmations → poll 1Click; SUCCESS → relayer job `fund_vaults`
//!    (rebalance address → vaults) → `done` when the relayer confirms it.
//!
//! Mainnet only (1Click has no testnet). Anywhere else, or without
//! `UNZEEN_ALLOW_MAINNET_REBALANCE=1`, the same schedule runs in **dry-run**: a dry quote with
//! mainnet parameters is stored, nothing is sent.
//!
//! Privacy: logs carry the rebalance id and step only (no txids, addresses or amounts).

use std::str::FromStr;

use anyhow::{Context, anyhow, bail};
use tonic::transport::Channel;
use tracing::{info, warn};
use unzeen_ledger::{FundOutcome, Inventory, Ledger, LiveRebalance, RebalanceHistory};
use unzeen_protocol::SolanaCluster;
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{WalletRead, wallet::ConfirmationsPolicy},
    proto::service::compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_keys::address::Address;
use zcash_primitives::transaction::TxId;
use zcash_protocol::{consensus::Network, value::Zatoshis};
use zip321::Payment;

use crate::{
    config::{Common, NetName},
    oneclick::{self, OneClick, QuoteParams, QuoteReject},
    send::{self, ProposalError},
    wallet::Db,
};

/// Absolute ceiling of one lot whatever the env says (2 ZEC).
pub const HARD_MAX_LOT_ZAT: u64 = 200_000_000;

#[derive(Clone, Debug)]
pub struct RebalanceCfg {
    /// Solana cluster of this instance (`devnet` | `mainnet-beta`) = `relayer_jobs.network`.
    pub network: &'static str,
    /// `sol` (ZEC → SOL, vault SOL) | `zec_spl` (ZEC → ZEC SPL, quote stock of ZEC pairs; 0019).
    pub target: &'static str,
    pub zcash: NetName,
    pub allow_mainnet: bool,
    pub lot_zat: u64,
    pub max_lot_zat: u64,
    pub min_free_lamports: u64,
    pub vault_reserve_lamports: u64,
    pub inventory_max_age_secs: u64,
    pub delay_min_secs: f64,
    pub delay_max_secs: f64,
    pub cooldown_secs: u64,
    pub max_per_day: u32,
    pub slippage_bps: u32,
    pub max_deviation_bps: u32,
    pub quote_deadline_secs: u64,
    pub min_deadline_left_secs: u64,
    pub quote_max_age_secs: u64,
    pub poll_secs: u64,
    pub slow_alert_secs: u64,
    pub keep_lamports: u64,
    pub fund_delay_min_secs: f64,
    pub fund_delay_max_secs: f64,
    pub fund_max_attempts: u32,
    pub fund_retry_secs: f64,
    pub fee_margin_zat: u64,
    /// The pool's rebalance SOL address (base58), NOT a vault. Required for live mode.
    pub sol_address: Option<String>,
    /// The pool's mainnet transparent refund address. Required for live mode.
    pub refund_taddr: Option<String>,
}

fn env_u64(k: &str, d: u64) -> anyhow::Result<u64> {
    match std::env::var(k).ok().filter(|v| !v.is_empty()) {
        Some(v) => v.parse().with_context(|| format!("{k} must be an integer")),
        None => Ok(d),
    }
}

fn env_str(k: &str) -> Option<String> {
    std::env::var(k)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn cluster_str(c: SolanaCluster) -> &'static str {
    match c {
        SolanaCluster::MainnetBeta => "mainnet-beta",
        SolanaCluster::Devnet => "devnet",
    }
}

/// Base58 of exactly 32 bytes (a Solana address).
pub fn valid_sol_address(s: &str) -> bool {
    bs58::decode(s).into_vec().is_ok_and(|v| v.len() == 32)
}

/// A transparent address (P2PKH/P2SH) of `net`. 1Click accepts ZEC only there.
pub fn is_transparent(s: &str, net: &Network) -> bool {
    matches!(Address::decode(net, s), Some(Address::Transparent(_)))
}

impl RebalanceCfg {
    pub fn from_env(c: &Common, cluster: SolanaCluster) -> anyhow::Result<Self> {
        let cfg = Self {
            network: cluster_str(cluster),
            target: "sol",
            zcash: c.network,
            allow_mainnet: std::env::var("UNZEEN_ALLOW_MAINNET_REBALANCE").as_deref() == Ok("1"),
            lot_zat: env_u64("UNZEEN_REBALANCE_LOT_ZAT", 50_000_000)?,
            max_lot_zat: env_u64("UNZEEN_REBALANCE_MAX_LOT_ZAT", 50_000_000)?.min(HARD_MAX_LOT_ZAT),
            min_free_lamports: env_u64("UNZEEN_REBALANCE_MIN_FREE_LAMPORTS", 2_000_000_000)?,
            vault_reserve_lamports: env_u64("UNZEEN_REBALANCE_VAULT_RESERVE_LAMPORTS", 5_000_000)?,
            inventory_max_age_secs: env_u64("UNZEEN_REBALANCE_INVENTORY_MAX_AGE_SECS", 900)?,
            delay_min_secs: env_u64("UNZEEN_REBALANCE_DELAY_MIN_SECS", 600)? as f64,
            delay_max_secs: env_u64("UNZEEN_REBALANCE_DELAY_MAX_SECS", 3600)? as f64,
            cooldown_secs: env_u64("UNZEEN_REBALANCE_COOLDOWN_SECS", 3600)?,
            max_per_day: u32::try_from(env_u64("UNZEEN_REBALANCE_MAX_PER_DAY", 4)?)?,
            slippage_bps: u32::try_from(env_u64("UNZEEN_REBALANCE_SLIPPAGE_BPS", 100)?.min(1000))?,
            max_deviation_bps: u32::try_from(env_u64("UNZEEN_REBALANCE_MAX_DEVIATION_BPS", 300)?.min(2000))?,
            quote_deadline_secs: env_u64("UNZEEN_REBALANCE_QUOTE_DEADLINE_SECS", 7200)?.max(3600),
            min_deadline_left_secs: 1800,
            quote_max_age_secs: env_u64("UNZEEN_REBALANCE_QUOTE_MAX_AGE_SECS", 300)?,
            poll_secs: env_u64("UNZEEN_REBALANCE_POLL_SECS", 60)?.max(15),
            slow_alert_secs: 3 * 3600,
            keep_lamports: env_u64("UNZEEN_REBALANCE_KEEP_LAMPORTS", 10_000_000)?,
            fund_delay_min_secs: env_u64("UNZEEN_REBALANCE_FUND_DELAY_MIN_SECS", 60)? as f64,
            fund_delay_max_secs: env_u64("UNZEEN_REBALANCE_FUND_DELAY_MAX_SECS", 600)? as f64,
            fund_max_attempts: 5,
            fund_retry_secs: 600.0,
            fee_margin_zat: env_u64("UNZEEN_REBALANCE_FEE_MARGIN_ZAT", 100_000)?,
            sol_address: env_str("UNZEEN_REBALANCE_SOL_ADDRESS"),
            refund_taddr: env_str("UNZEEN_REBALANCE_REFUND_TADDR"),
        };
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        if self.lot_zat < oneclick::MIN_LOT_ZAT {
            bail!(
                "UNZEEN_REBALANCE_LOT_ZAT below the 1Click minimum ({} zat)",
                oneclick::MIN_LOT_ZAT
            );
        }
        if self.delay_max_secs < self.delay_min_secs || self.fund_delay_max_secs < self.fund_delay_min_secs {
            bail!("rebalance delay max < min");
        }
        if let Some(a) = &self.sol_address
            && !valid_sol_address(a)
        {
            bail!("UNZEEN_REBALANCE_SOL_ADDRESS is not a Solana address");
        }
        if let Some(t) = &self.refund_taddr
            && !is_transparent(t, &Network::MainNetwork)
        {
            bail!("UNZEEN_REBALANCE_REFUND_TADDR must be a mainnet transparent (t1/t3) address");
        }
        Ok(())
    }

    /// `None` = live sends allowed; `Some(reason)` = dry-run.
    pub fn dry_reason(&self) -> Option<&'static str> {
        if self.zcash != NetName::Main || self.network != "mainnet-beta" {
            return Some("not mainnet (1Click has no testnet)");
        }
        if !self.allow_mainnet {
            return Some("UNZEEN_ALLOW_MAINNET_REBALANCE is not 1");
        }
        if self.lot_zat > self.max_lot_zat {
            return Some("lot above UNZEEN_REBALANCE_MAX_LOT_ZAT");
        }
        if self.sol_address.is_none() {
            return Some("UNZEEN_REBALANCE_SOL_ADDRESS not set");
        }
        if self.refund_taddr.is_none() {
            return Some("UNZEEN_REBALANCE_REFUND_TADDR not set");
        }
        None
    }

    /// The ZEC → ZEC SPL flavour (API v0.13 / RELAYER v8): same gates, own lot and threshold
    /// (UNZEEN_REBALANCE_ZEC_SPL_LOT_ZAT, _MIN_FREE_ZAT), free = ZEC SPL on vaults + rebalance
    /// address − queued ZEC-pair buys.
    pub fn zec_spl(&self) -> anyhow::Result<Self> {
        let c = Self {
            target: "zec_spl",
            lot_zat: env_u64("UNZEEN_REBALANCE_ZEC_SPL_LOT_ZAT", 50_000_000)?,
            min_free_lamports: env_u64("UNZEEN_REBALANCE_ZEC_SPL_MIN_FREE_ZAT", 20_000_000)?,
            vault_reserve_lamports: 0,
            keep_lamports: 0,
            ..self.clone()
        };
        c.validate()?;
        Ok(c)
    }

    pub fn destination(&self) -> &'static str {
        if self.target == "zec_spl" {
            oneclick::ZEC_SPL_ASSET
        } else {
            oneclick::SOL_ASSET
        }
    }

    fn params(&self, dry: bool, now_unix: u64) -> QuoteParams<'_> {
        QuoteParams {
            destination: self.destination(),
            dry,
            amount_zat: self.lot_zat,
            refund_to: self.refund_taddr.as_deref().unwrap_or(oneclick::DUMMY_ZEC_REFUND),
            recipient: self.sol_address.as_deref().unwrap_or(oneclick::DUMMY_SOL_RECIPIENT),
            slippage_bps: self.slippage_bps,
            deadline_unix: now_unix + self.quote_deadline_secs,
        }
    }
}

// ---------------------------------------------------------------- trigger

/// Free SOL of the pool (see module docs). Saturating.
pub fn free_lamports(cfg: &RebalanceCfg, inv: &Inventory, committed: u64) -> u64 {
    let reserve = u64::from(inv.vault_count).saturating_mul(cfg.vault_reserve_lamports);
    inv.vault_lamports
        .saturating_add(inv.rebalance_lamports)
        .saturating_sub(reserve)
        .saturating_sub(committed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    Need { free: u64 },
    Enough { free: u64 },
    NoInventory,
    StaleInventory,
    DailyCap,
    Cooldown,
}

/// Should a NEW rebalance be planned? (`hist = None`: only the SOL condition, for re-checks.)
pub fn evaluate(
    cfg: &RebalanceCfg,
    inv: Option<&Inventory>,
    committed: u64,
    hist: Option<&RebalanceHistory>,
) -> Trigger {
    evaluate_free(cfg, inv.map(|i| (free_lamports(cfg, i, committed), i.age_secs)), hist)
}

/// [`evaluate`] on an already computed `(free, inventory age)` (any target).
pub fn evaluate_free(cfg: &RebalanceCfg, free_age: Option<(u64, u64)>, hist: Option<&RebalanceHistory>) -> Trigger {
    let Some((free, age)) = free_age else {
        return Trigger::NoInventory;
    };
    if age > cfg.inventory_max_age_secs {
        return Trigger::StaleInventory;
    }
    if free >= cfg.min_free_lamports {
        return Trigger::Enough { free };
    }
    if let Some(h) = hist {
        if h.last_24h >= cfg.max_per_day {
            return Trigger::DailyCap;
        }
        if h.since_last_secs.is_some_and(|s| s < cfg.cooldown_secs) {
            return Trigger::Cooldown;
        }
    }
    Trigger::Need { free }
}

pub async fn current_trigger(cfg: &RebalanceCfg, ledger: &Ledger, with_history: bool) -> anyhow::Result<Trigger> {
    let hist = if with_history {
        Some(ledger.rebalance_history(cfg.network, cfg.target).await?)
    } else {
        None
    };
    if cfg.target == "zec_spl" {
        let inv = ledger
            .quote_inventory(cfg.network, unzeen_ledger::rebalance::ZEC_SPL_MINT)
            .await?;
        let committed = ledger.committed_zec_spl(cfg.network).await?;
        let free_age = inv.map(|(total, age)| {
            let total = u64::try_from(total).unwrap_or(u64::MAX);
            (total.saturating_sub(committed), age)
        });
        return Ok(evaluate_free(cfg, free_age, hist.as_ref()));
    }
    let inv = ledger.sol_inventory(cfg.network).await?;
    let committed = ledger.committed_sol(cfg.network).await?;
    Ok(evaluate(cfg, inv.as_ref(), committed, hist.as_ref()))
}

fn jitter(min: f64, max: f64) -> f64 {
    min + (max - min).max(0.0) * ((rand::random::<u64>() >> 11) as f64 / (1u64 << 53) as f64)
}

// ---------------------------------------------------------------- wallet seam

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxState {
    Mined(u32),
    Pending,
    /// Expiry height passed at a fully scanned tip without the tx: it can never be mined.
    Expired,
    /// Not in the wallet DB: cannot prove anything.
    Missing,
}

/// The pool wallet operations the rebalance needs (mocked in tests).
#[allow(async_fn_in_trait)]
pub trait PoolWallet {
    /// Spendable shielded ZEC with K confirmations.
    fn spendable_zat(&mut self, confirmations: u32) -> anyhow::Result<u64>;
    /// Build, prove and store (NOT broadcast) one tx paying exactly `zat` to transparent `to`.
    /// Returns (txid, expiry height, raw). A [`ProposalError`] = funds not available yet.
    fn build_transparent(&mut self, to: &str, zat: u64) -> anyhow::Result<([u8; 32], u32, Vec<u8>)>;
    fn tx_state(&mut self, txid: &[u8; 32], tip: u32) -> anyhow::Result<TxState>;
    fn raw_tx(&mut self, txid: &[u8; 32]) -> anyhow::Result<Option<Vec<u8>>>;
    async fn broadcast(&mut self, raw: Vec<u8>) -> anyhow::Result<()>;
}

pub struct LiveWallet<'a> {
    pub common: &'a Common,
    pub db: &'a mut Db,
    pub client: &'a mut CompactTxStreamerClient<Channel>,
}

impl PoolWallet for LiveWallet<'_> {
    fn spendable_zat(&mut self, confirmations: u32) -> anyhow::Result<u64> {
        let k = std::num::NonZeroU32::new(confirmations.max(1)).expect("max(1)");
        let summary = self
            .db
            .get_wallet_summary(ConfirmationsPolicy::new_symmetrical(k))
            .map_err(|e| anyhow!("wallet summary: {e}"))?;
        Ok(summary.map_or(0, |s| {
            s.account_balances()
                .values()
                .map(|b| u64::from(b.spendable_value()))
                .sum()
        }))
    }

    fn build_transparent(&mut self, to: &str, zat: u64) -> anyhow::Result<([u8; 32], u32, Vec<u8>)> {
        let net = self.common.params();
        if !is_transparent(to, &net) {
            bail!("rebalance deposit address is not a transparent address of this network");
        }
        let recipient = ZcashAddress::from_str(to).map_err(|e| anyhow!("bad deposit address: {e}"))?;
        let payment = Payment::new(recipient, Some(Zatoshis::from_u64(zat)?), None, None, None, vec![])
            .map_err(|e| anyhow!("invalid payment: {e:?}"))?;
        let (txid, raw) = send::build_tx(self.common, self.db, vec![payment])?;
        let expiry = self
            .db
            .get_transaction(txid)?
            .map(|t| u32::from(t.expiry_height()))
            .ok_or_else(|| anyhow!("built tx not found in DB"))?;
        Ok((*txid.as_ref(), expiry, raw))
    }

    fn tx_state(&mut self, txid: &[u8; 32], tip: u32) -> anyhow::Result<TxState> {
        let id = TxId::from_bytes(*txid);
        if let Some(h) = self.db.get_tx_height(id)? {
            return Ok(TxState::Mined(u32::from(h)));
        }
        Ok(match self.db.get_transaction(id)? {
            Some(tx) => {
                let exp = u32::from(tx.expiry_height());
                if exp > 0 && tip >= exp {
                    TxState::Expired
                } else {
                    TxState::Pending
                }
            }
            None => TxState::Missing,
        })
    }

    fn raw_tx(&mut self, txid: &[u8; 32]) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(match self.db.get_transaction(TxId::from_bytes(*txid))? {
            Some(tx) => {
                let mut raw = Vec::new();
                tx.write(&mut raw)?;
                Some(raw)
            }
            None => None,
        })
    }

    async fn broadcast(&mut self, raw: Vec<u8>) -> anyhow::Result<()> {
        send::broadcast(self.client, raw).await
    }
}

/// Explorer (display) hex of a txid.
pub fn txid_display(txid: &[u8; 32]) -> String {
    TxId::from_bytes(*txid).to_string()
}

// ---------------------------------------------------------------- step

/// Chain view of this pass.
#[derive(Clone, Copy, Debug)]
pub struct Chain {
    pub tip: u32,
    pub confirmations: u32,
    pub now_unix: u64,
}

/// One rebalance step. Returns a short label of what happened (for counters/logs).
pub async fn step<O: OneClick, W: PoolWallet>(
    cfg: &RebalanceCfg,
    ledger: &Ledger,
    oc: &O,
    w: &mut W,
    ch: Chain,
) -> anyhow::Result<&'static str> {
    let Some(live) = ledger.live_rebalance(cfg.network, cfg.target).await? else {
        return maybe_plan(cfg, ledger).await;
    };
    match live.status.as_str() {
        "planned" => planned(cfg, ledger, oc, w, ch, &live).await,
        "quoted" => send_quoted(cfg, ledger, oc, w, ch, &live).await,
        "sending" => sending(cfg, ledger, oc, w, ch, &live).await,
        "deposited" => deposited(cfg, ledger, oc, &live).await,
        "distributing" => {
            let out = ledger
                .rebalance_fund_step(live.id, cfg.fund_max_attempts, cfg.fund_retry_secs)
                .await?;
            Ok(match out {
                FundOutcome::Waiting => "distributing",
                FundOutcome::Done => {
                    info!(id = live.id, "rebalance done");
                    "done"
                }
                FundOutcome::Retried => {
                    warn!(id = live.id, "rebalance: fund_vaults failed; re-queued");
                    "fund_retry"
                }
                FundOutcome::Attention => {
                    warn!(
                        id = live.id,
                        "ALERT: rebalance distribution keeps failing; operator needed"
                    );
                    "attention"
                }
            })
        }
        _ => {
            // attention: remind at most every 10 minutes.
            if live.polled_age_secs.is_none_or(|s| s >= 600) {
                warn!(
                    id = live.id,
                    "ALERT: rebalance needs the operator (`unzeen-scanner rebalance status` / `close`)"
                );
                ledger
                    .rebalance_polled(live.id, live.oc_status.as_deref().unwrap_or("-"))
                    .await?;
            }
            Ok("attention")
        }
    }
}

async fn maybe_plan(cfg: &RebalanceCfg, ledger: &Ledger) -> anyhow::Result<&'static str> {
    match current_trigger(cfg, ledger, true).await? {
        Trigger::Need { .. } => {
            let dry = cfg.dry_reason().is_some();
            let delay = jitter(cfg.delay_min_secs, cfg.delay_max_secs);
            match ledger
                .plan_rebalance(cfg.network, cfg.target, cfg.lot_zat, delay, dry, false)
                .await?
            {
                Some(id) => {
                    info!(
                        id,
                        dry_run = dry,
                        target = cfg.target,
                        "rebalance planned (pool stock below threshold)"
                    );
                    Ok("planned")
                }
                None => Ok("idle"),
            }
        }
        Trigger::StaleInventory => Ok("stale_inventory"),
        Trigger::NoInventory => Ok("no_inventory"),
        _ => Ok("idle"),
    }
}

async fn fail(ledger: &Ledger, id: i64, from: &str, status: &str, code: &str) -> anyhow::Result<&'static str> {
    ledger.rebalance_finish(id, &[from], status, Some(code)).await?;
    warn!(id, code, status, "rebalance stopped");
    Ok("failed")
}

/// Quote + reference price check.
async fn quote<O: OneClick>(
    cfg: &RebalanceCfg,
    oc: &O,
    p: &QuoteParams<'_>,
    now_unix: u64,
) -> anyhow::Result<Result<(serde_json::Value, oneclick::ParsedQuote), &'static str>> {
    let v = match oc.quote(&oneclick::quote_request(p)).await {
        Ok(v) => v,
        Err(e) => {
            warn!(error = %e, "rebalance: 1Click quote failed");
            return Ok(Err("quote_failed"));
        }
    };
    let q = match oneclick::check_quote(&v, p, now_unix, cfg.min_deadline_left_secs) {
        Ok(q) => q,
        Err(r) => return Ok(Err(r.code())),
    };
    if !p.dry {
        let addr = q.deposit_address.as_deref().unwrap_or_default();
        if !is_transparent(addr, &Network::MainNetwork) {
            return Ok(Err(QuoteReject::BadDepositAddress.code()));
        }
    }
    let expected = if cfg.target == "zec_spl" {
        // ZEC → ZEC SPL: parity, both 8 decimals.
        p.amount_zat
    } else {
        let Ok(tokens) = oc.tokens().await else {
            return Ok(Err(QuoteReject::NoPrice.code()));
        };
        let Some(e) = oneclick::expected_lamports(&tokens, p.amount_zat) else {
            return Ok(Err(QuoteReject::NoPrice.code()));
        };
        e
    };
    if !oneclick::price_ok(q.min_amount_out, expected, cfg.max_deviation_bps) {
        return Ok(Err(QuoteReject::PriceDeviation.code()));
    }
    Ok(Ok((v, q)))
}

async fn planned<O: OneClick, W: PoolWallet>(
    cfg: &RebalanceCfg,
    ledger: &Ledger,
    oc: &O,
    w: &mut W,
    ch: Chain,
    live: &LiveRebalance,
) -> anyhow::Result<&'static str> {
    if !live.due {
        return Ok("waiting");
    }
    if !live.forced {
        match current_trigger(cfg, ledger, false).await? {
            Trigger::Need { .. } => {}
            Trigger::Enough { .. } => {
                ledger
                    .rebalance_finish(live.id, &["planned"], "cancelled", Some("not_needed"))
                    .await?;
                info!(id = live.id, "rebalance cancelled: pool SOL recovered");
                return Ok("cancelled");
            }
            _ => return Ok("waiting"), // inventory missing/stale: wait for the relayer
        }
    }
    if live.dry_run {
        let p = cfg.params(true, ch.now_unix);
        return match quote(cfg, oc, &p, ch.now_unix).await? {
            Ok((v, q)) => {
                ledger
                    .rebalance_dry_run_done(live.id, &v, q.amount_out, q.min_amount_out)
                    .await?;
                info!(
                    id = live.id,
                    reason = cfg.dry_reason().unwrap_or("planned as dry-run"),
                    "rebalance dry-run: quote stored, nothing sent"
                );
                Ok("dry_run")
            }
            Err(code) => fail(ledger, live.id, "planned", "failed", code).await,
        };
    }
    if cfg.dry_reason().is_some() || live.lot_zat != cfg.lot_zat {
        return fail(ledger, live.id, "planned", "cancelled", "mode_changed").await;
    }
    if ledger.verify_frozen().await? {
        return Ok("waiting");
    }
    if let Some(sol) = &cfg.sol_address
        && ledger.is_vault(cfg.network, sol).await?
    {
        warn!("ALERT: UNZEEN_REBALANCE_SOL_ADDRESS is a trading vault; refusing");
        return fail(ledger, live.id, "planned", "failed", "recipient_is_vault").await;
    }
    // The pool spends only its own ZEC: users' balances stay fully covered.
    let liabilities = ledger.zec_liabilities().await?;
    let spendable = w.spendable_zat(ch.confirmations)?;
    let need = liabilities
        .saturating_add(live.lot_zat)
        .saturating_add(cfg.fee_margin_zat);
    if spendable < need {
        warn!(id = live.id, "ALERT: rebalance skipped: pool ZEC surplus below the lot");
        return fail(ledger, live.id, "planned", "failed", "reserve_short").await;
    }
    let p = cfg.params(false, ch.now_unix);
    let (v, q) = match quote(cfg, oc, &p, ch.now_unix).await? {
        Ok(x) => x,
        Err(code) => return fail(ledger, live.id, "planned", "failed", code).await,
    };
    let addr = q.deposit_address.clone().unwrap_or_default();
    let deadline = q.deadline_unix.unwrap_or(0);
    if !ledger
        .rebalance_quoted(live.id, &addr, &v, q.amount_out, q.min_amount_out, deadline)
        .await?
    {
        return Ok("waiting");
    }
    info!(id = live.id, "rebalance quoted");
    let Some(live) = ledger.live_rebalance(cfg.network, cfg.target).await? else {
        return Ok("quoted");
    };
    send_quoted(cfg, ledger, oc, w, ch, &live).await
}

async fn send_quoted<O: OneClick, W: PoolWallet>(
    cfg: &RebalanceCfg,
    ledger: &Ledger,
    oc: &O,
    w: &mut W,
    _ch: Chain,
    live: &LiveRebalance,
) -> anyhow::Result<&'static str> {
    let Some(addr) = live.deposit_address.clone() else {
        return fail(ledger, live.id, "quoted", "attention", "no_deposit_address").await;
    };
    let too_old = live.quote_age_secs.is_none_or(|a| a > cfg.quote_max_age_secs);
    let too_late = live
        .deadline_left_secs
        .is_none_or(|d| d < cfg.min_deadline_left_secs as i64);
    if too_old || too_late {
        // The address was never funded; it is abandoned, never reused.
        return fail(ledger, live.id, "quoted", "expired", "quote_expired").await;
    }
    if cfg.dry_reason().is_some() {
        return fail(ledger, live.id, "quoted", "cancelled", "mode_changed").await;
    }
    if ledger.verify_frozen().await? {
        return Ok("waiting");
    }
    if !is_transparent(&addr, &Network::MainNetwork) {
        return fail(ledger, live.id, "quoted", "failed", "quote_bad_address").await;
    }
    let (txid, expiry, raw) = match w.build_transparent(&addr, live.lot_zat) {
        Ok(x) => x,
        Err(e) if e.downcast_ref::<ProposalError>().is_some() => {
            warn!(id = live.id, "rebalance waiting: not enough confirmed shielded funds");
            return Ok("waiting");
        }
        Err(e) => {
            warn!(id = live.id, error = %e, "rebalance tx build failed");
            return fail(ledger, live.id, "quoted", "failed", "build_failed").await;
        }
    };
    if !ledger.rebalance_sending(live.id, &txid, expiry).await? {
        // Rows changed under us: never broadcast (notes stay locked until expiry).
        warn!(id = live.id, "rebalance row changed before broadcast; tx not sent");
        return Ok("waiting");
    }
    if let Err(e) = w.broadcast(raw).await {
        warn!(id = live.id, error = %e, "rebalance broadcast failed; will retry the same tx");
        return Ok("sent");
    }
    if oc.submit_deposit(&txid_display(&txid), &addr).await.is_ok() {
        ledger.rebalance_submitted(live.id).await?;
    }
    info!(id = live.id, "rebalance deposit tx broadcast");
    Ok("sent")
}

async fn sending<O: OneClick, W: PoolWallet>(
    _cfg: &RebalanceCfg,
    ledger: &Ledger,
    oc: &O,
    w: &mut W,
    ch: Chain,
    live: &LiveRebalance,
) -> anyhow::Result<&'static str> {
    let Some(txid) = live.txid else {
        return fail(ledger, live.id, "sending", "attention", "no_txid").await;
    };
    match w.tx_state(&txid, ch.tip)? {
        TxState::Mined(h) if ch.tip + 1 >= h + ch.confirmations => {
            ledger.rebalance_mined(live.id, h).await?;
            info!(id = live.id, "rebalance deposit confirmed");
            Ok("mined")
        }
        TxState::Mined(_) => Ok("waiting"),
        TxState::Pending => {
            if let Some(raw) = w.raw_tx(&txid)? {
                // Idempotent; "already in mempool" style rejections are expected.
                let _ = w.broadcast(raw).await;
            }
            if !live.submitted
                && let Some(addr) = &live.deposit_address
                && oc.submit_deposit(&txid_display(&txid), addr).await.is_ok()
            {
                ledger.rebalance_submitted(live.id).await?;
            }
            Ok("waiting")
        }
        TxState::Expired => {
            // Never mined, never will be: the deposit address got nothing. Not reused.
            fail(ledger, live.id, "sending", "failed", "send_expired").await
        }
        TxState::Missing => {
            warn!(
                id = live.id,
                "ALERT: rebalance tx missing from the wallet DB; manual review"
            );
            fail(ledger, live.id, "sending", "attention", "tx_missing").await
        }
    }
}

async fn deposited<O: OneClick>(
    cfg: &RebalanceCfg,
    ledger: &Ledger,
    oc: &O,
    live: &LiveRebalance,
) -> anyhow::Result<&'static str> {
    if live.polled_age_secs.is_some_and(|s| s < cfg.poll_secs) {
        return Ok("waiting");
    }
    let Some(addr) = &live.deposit_address else {
        return fail(ledger, live.id, "deposited", "attention", "no_deposit_address").await;
    };
    if !live.submitted
        && let Some(txid) = &live.txid
        && oc.submit_deposit(&txid_display(txid), addr).await.is_ok()
    {
        ledger.rebalance_submitted(live.id).await?;
    }
    let st = match oc.status(addr).await {
        Ok(v) => oneclick::parse_status(&v),
        Err(e) => {
            warn!(id = live.id, error = %e, "rebalance: 1Click status failed");
            None
        }
    };
    let Some(st) = st else {
        ledger
            .rebalance_polled(live.id, live.oc_status.as_deref().unwrap_or("-"))
            .await?;
        return Ok("waiting");
    };
    ledger.rebalance_polled(live.id, &st.status).await?;
    match st.status.as_str() {
        "SUCCESS" => {
            let Some(out) = st.amount_out else {
                return Ok("waiting");
            };
            if live.min_amount_out.is_some_and(|m| out < m) {
                warn!(id = live.id, "rebalance delivered less than the quote minimum");
            }
            let fund = out.saturating_sub(cfg.keep_lamports);
            let delay = jitter(cfg.fund_delay_min_secs, cfg.fund_delay_max_secs);
            ledger
                .rebalance_success(live.id, cfg.network, out, st.dest_tx.as_deref(), fund, delay)
                .await?;
            info!(id = live.id, "rebalance: SOL delivered; distribution queued");
            Ok("success")
        }
        "REFUNDED" => {
            warn!(
                id = live.id,
                "ALERT: rebalance refunded to the pool t-address; shield it back manually"
            );
            fail(ledger, live.id, "deposited", "refunded", "oc_refunded").await
        }
        "FAILED" => fail(ledger, live.id, "deposited", "attention", "oc_failed").await,
        "INCOMPLETE_DEPOSIT" => fail(ledger, live.id, "deposited", "attention", "oc_incomplete").await,
        _ => {
            if live.deposited_age_secs.is_some_and(|s| s > cfg.slow_alert_secs) {
                warn!(id = live.id, "ALERT: rebalance pending at 1Click for over 3 h");
            }
            Ok("waiting")
        }
    }
}

/// Operator `rebalance quote`: a dry quote of the configured lot with mainnet parameters and
/// the reference price check. Read-only (no deposit address is created).
pub async fn dry_quote<O: OneClick>(
    cfg: &RebalanceCfg,
    oc: &O,
    now_unix: u64,
) -> anyhow::Result<(oneclick::ParsedQuote, Option<u64>)> {
    let p = cfg.params(true, now_unix);
    let v = oc
        .quote(&oneclick::quote_request(&p))
        .await
        .map_err(|e| anyhow!("{e}"))?;
    let q = oneclick::check_quote(&v, &p, now_unix, 0).map_err(|r| anyhow!("quote refused: {}", r.code()))?;
    let expected = if cfg.target == "zec_spl" {
        Some(p.amount_zat)
    } else {
        match oc.tokens().await {
            Ok(t) => oneclick::expected_lamports(&t, p.amount_zat),
            Err(_) => None,
        }
    };
    Ok((q, expected))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use unzeen_ledger::{PgConfig, Policy, tokio_postgres};
    use unzeen_protocol::{ChainId, ZcashNet};
    use zcash_address::ToAddress;
    use zcash_protocol::consensus::NetworkType;

    use super::*;
    use crate::oneclick::{OcError, SOL_ASSET, ZEC_ASSET};

    fn taddr(n: u8) -> String {
        ZcashAddress::from_transparent_p2pkh(NetworkType::Main, [n; 20]).encode()
    }

    fn cfg(live: bool) -> RebalanceCfg {
        RebalanceCfg {
            network: if live { "mainnet-beta" } else { "devnet" },
            target: "sol",
            zcash: if live { NetName::Main } else { NetName::Test },
            allow_mainnet: live,
            lot_zat: 50_000_000,
            max_lot_zat: 50_000_000,
            min_free_lamports: 2_000_000_000,
            vault_reserve_lamports: 5_000_000,
            inventory_max_age_secs: 900,
            delay_min_secs: 0.0,
            delay_max_secs: 0.0,
            cooldown_secs: 0,
            max_per_day: 10,
            slippage_bps: 100,
            max_deviation_bps: 300,
            quote_deadline_secs: 7200,
            min_deadline_left_secs: 1800,
            quote_max_age_secs: 300,
            poll_secs: 0,
            slow_alert_secs: 3 * 3600,
            keep_lamports: 10_000_000,
            fund_delay_min_secs: 0.0,
            fund_delay_max_secs: 0.0,
            fund_max_attempts: 2,
            fund_retry_secs: 0.0,
            fee_margin_zat: 100_000,
            sol_address: live.then(|| bs58::encode([7u8; 32]).into_string()),
            refund_taddr: live.then(|| taddr(9)),
        }
    }

    fn inv(vault_lamports: u64) -> Inventory {
        Inventory {
            vault_lamports,
            vault_count: 4,
            rebalance_lamports: 0,
            age_secs: 10,
        }
    }

    #[test]
    fn trigger_rules() {
        let c = cfg(false);
        // 4 vaults × 0.005 reserve = 0.02 SOL; committed 0.1 SOL.
        assert_eq!(free_lamports(&c, &inv(3_000_000_000), 100_000_000), 2_880_000_000);
        assert_eq!(free_lamports(&c, &inv(1_000), 100_000_000), 0);
        assert_eq!(evaluate(&c, None, 0, None), Trigger::NoInventory);
        let stale = Inventory {
            age_secs: 901,
            ..inv(0)
        };
        assert_eq!(evaluate(&c, Some(&stale), 0, None), Trigger::StaleInventory);
        assert!(matches!(
            evaluate(&c, Some(&inv(3_000_000_000)), 0, None),
            Trigger::Enough { .. }
        ));
        assert!(matches!(
            evaluate(&c, Some(&inv(1_000_000_000)), 0, None),
            Trigger::Need { .. }
        ));
        // Undistributed SOL on the rebalance address counts as free.
        let parked = Inventory {
            rebalance_lamports: 5_000_000_000,
            ..inv(0)
        };
        assert!(matches!(evaluate(&c, Some(&parked), 0, None), Trigger::Enough { .. }));
        let cap = RebalanceHistory {
            last_24h: 10,
            since_last_secs: None,
        };
        assert_eq!(evaluate(&c, Some(&inv(0)), 0, Some(&cap)), Trigger::DailyCap);
        let c2 = RebalanceCfg {
            cooldown_secs: 3600,
            ..c
        };
        let recent = RebalanceHistory {
            last_24h: 1,
            since_last_secs: Some(100),
        };
        assert_eq!(evaluate(&c2, Some(&inv(0)), 0, Some(&recent)), Trigger::Cooldown);
    }

    #[test]
    fn mainnet_gating() {
        assert!(cfg(true).dry_reason().is_none());
        assert!(cfg(false).dry_reason().is_some());
        assert!(
            RebalanceCfg {
                allow_mainnet: false,
                ..cfg(true)
            }
            .dry_reason()
            .is_some()
        );
        assert!(
            RebalanceCfg {
                lot_zat: 60_000_000,
                ..cfg(true)
            }
            .dry_reason()
            .is_some()
        );
        assert!(
            RebalanceCfg {
                sol_address: None,
                ..cfg(true)
            }
            .dry_reason()
            .is_some()
        );
        assert!(
            RebalanceCfg {
                refund_taddr: None,
                ..cfg(true)
            }
            .dry_reason()
            .is_some()
        );
        assert!(
            RebalanceCfg {
                zcash: NetName::Test,
                ..cfg(true)
            }
            .dry_reason()
            .is_some()
        );
        assert!(
            RebalanceCfg {
                lot_zat: 1000,
                ..cfg(true)
            }
            .validate()
            .is_err()
        );
        assert!(
            RebalanceCfg {
                refund_taddr: Some("tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU".into()),
                ..cfg(true)
            }
            .validate()
            .is_err()
        );
        assert!(is_transparent(&taddr(1), &Network::MainNetwork));
        assert!(!is_transparent(&taddr(1), &Network::TestNetwork));
    }

    // ------------------------------------------------------------ mocks

    #[derive(Default)]
    struct OcState {
        quotes: u32,
        submits: u32,
        statuses: u32,
        next_addr: u8,
        status: String,
        amount_out: Option<String>,
    }

    #[derive(Default)]
    struct MockOc(Mutex<OcState>);

    impl OneClick for MockOc {
        async fn quote(&self, req: &Value) -> Result<Value, OcError> {
            let mut s = self.0.lock().unwrap();
            s.quotes += 1;
            // ZEC → ZEC SPL is near parity; ZEC → SOL ~11.2 SOL/ZEC.
            let (out, min) = if req["destinationAsset"] == json!(crate::oneclick::ZEC_SPL_ASSET) {
                let a: u64 = req["amount"].as_str().unwrap().parse().unwrap();
                ((a - 24_000).to_string(), ((a - 24_000) * 99 / 100).to_string())
            } else {
                ("5600000000".to_string(), "5544000000".to_string())
            };
            let mut q = json!({
                "amountIn": req["amount"], "amountInFormatted": "0.5", "amountInUsd": "608",
                "minAmountIn": req["amount"], "amountOut": out, "amountOutFormatted": "x",
                "amountOutUsd": "606", "minAmountOut": min, "timeEstimate": 452,
            });
            if req["dry"] == json!(false) {
                s.next_addr += 1;
                q["depositAddress"] = json!(taddr(100 + s.next_addr));
                q["deadline"] = req["deadline"].clone();
            }
            Ok(
                json!({"correlationId": "c", "timestamp": "t", "signature": "ed25519:s", "quoteRequest": req, "quote": q}),
            )
        }
        async fn status(&self, _a: &str) -> Result<Value, OcError> {
            let mut s = self.0.lock().unwrap();
            s.statuses += 1;
            Ok(json!({"status": s.status, "swapDetails": {"amountOut": s.amount_out,
                "destinationChainTxHashes": [{"hash": "5sol", "explorerUrl": "x"}]}}))
        }
        async fn submit_deposit(&self, _h: &str, _a: &str) -> Result<(), OcError> {
            self.0.lock().unwrap().submits += 1;
            Ok(())
        }
        async fn tokens(&self) -> Result<Value, OcError> {
            Ok(json!([{"assetId": ZEC_ASSET, "price": 1217.53}, {"assetId": SOL_ASSET, "price": 108.32}]))
        }
    }

    struct MockWallet {
        ledger: Ledger,
        network: &'static str,
        target: &'static str,
        spendable: u64,
        proposal_error: bool,
        builds: u32,
        broadcasts: u32,
        state: TxState,
    }

    impl PoolWallet for MockWallet {
        fn spendable_zat(&mut self, _k: u32) -> anyhow::Result<u64> {
            Ok(self.spendable)
        }
        fn build_transparent(&mut self, to: &str, zat: u64) -> anyhow::Result<([u8; 32], u32, Vec<u8>)> {
            assert!(is_transparent(to, &Network::MainNetwork));
            assert_eq!(zat, 50_000_000, "exactly the lot");
            if self.proposal_error {
                return Err(ProposalError("not enough".into()).into());
            }
            self.builds += 1;
            Ok(([self.builds as u8; 32], 1_000, vec![1, 2, 3]))
        }
        fn tx_state(&mut self, _t: &[u8; 32], _tip: u32) -> anyhow::Result<TxState> {
            Ok(self.state)
        }
        fn raw_tx(&mut self, _t: &[u8; 32]) -> anyhow::Result<Option<Vec<u8>>> {
            Ok(Some(vec![1, 2, 3]))
        }
        async fn broadcast(&mut self, _raw: Vec<u8>) -> anyhow::Result<()> {
            // The txid must already be in Postgres when the tx leaves.
            let live = self
                .ledger
                .live_rebalance(self.network, self.target)
                .await?
                .expect("live");
            assert_eq!(live.status, "sending");
            assert!(live.txid.is_some());
            self.broadcasts += 1;
            Ok(())
        }
    }

    struct Db {
        ledger: Ledger,
        admin: tokio_postgres::Client,
        schema: String,
    }

    async fn setup() -> Option<Db> {
        let _ = dotenvy::from_path(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env"));
        let required = std::env::var("REQUIRE_PG").as_deref() == Ok("1");
        let Ok(url) = std::env::var("DATABASE_URL") else {
            assert!(!required, "REQUIRE_PG=1 but DATABASE_URL is not set");
            eprintln!("skip: DATABASE_URL not set");
            return None;
        };
        let (admin, conn) = match tokio_postgres::connect(&url, tokio_postgres::NoTls).await {
            Ok(x) => x,
            Err(e) => {
                assert!(!required, "cannot connect: {e}");
                eprintln!("skip: cannot connect to DATABASE_URL");
                return None;
            }
        };
        tokio::spawn(conn);
        let schema = format!("t_{}", hex::encode(rand::random::<[u8; 6]>()));
        admin.batch_execute(&format!("CREATE SCHEMA {schema}")).await.unwrap();
        let mut pc: PgConfig = url.parse().unwrap();
        pc.options(format!("-c search_path={schema}"));
        let policy = Policy {
            chain: ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta),
            confirmations: 3,
            min_deposit_zat: 100_000,
            min_action_zat: 50_000,
            credit_jitter: 0,
        };
        let ledger = Ledger::connect_with(pc, policy).await.unwrap();
        Some(Db { ledger, admin, schema })
    }

    impl Db {
        async fn sql(&self, q: &str) {
            self.admin
                .batch_execute(&format!("SET search_path = {}; {q}", self.schema))
                .await
                .unwrap();
        }
        async fn one(&self, q: &str) -> tokio_postgres::Row {
            self.admin
                .batch_execute(&format!("SET search_path = {}", self.schema))
                .await
                .unwrap();
            self.admin.query_one(q, &[]).await.unwrap()
        }
        async fn drop(self) {
            let _ = self
                .admin
                .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema))
                .await;
        }
    }

    fn ch() -> Chain {
        Chain {
            tip: 100,
            confirmations: 3,
            now_unix: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }

    fn wallet(db: &Db, network: &'static str) -> MockWallet {
        MockWallet {
            ledger: db.ledger.clone(),
            network,
            target: "sol",
            spendable: 100_000_000,
            proposal_error: false,
            builds: 0,
            broadcasts: 0,
            state: TxState::Pending,
        }
    }

    #[tokio::test]
    async fn dry_run_schedule_and_cancel() {
        let Some(db) = setup().await else { return };
        let c = cfg(false);
        let oc = MockOc::default();
        let mut w = wallet(&db, "devnet");
        let l = &db.ledger;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "no_inventory");
        db.sql("INSERT INTO pool_sol_inventory (network, vault_lamports, vault_count, slot) VALUES ('devnet', 500000000, 4, 1)")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "dry_run");
        let r = db
            .one("SELECT status, dry_run, amount_out_quote, deposit_address FROM pool_rebalances")
            .await;
        assert_eq!(r.get::<_, String>(0), "dry_run");
        assert!(r.get::<_, bool>(1));
        assert_eq!(r.get::<_, i64>(2), 5_600_000_000);
        assert_eq!(
            r.get::<_, Option<String>>(3),
            None,
            "dry quotes never create a deposit address"
        );
        assert_eq!((w.builds, w.broadcasts), (0, 0), "dry-run never touches the wallet");
        // Plans again (cooldown 0); SOL recovers before it is due → cancelled.
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        db.sql("UPDATE pool_sol_inventory SET vault_lamports = 9000000000")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "cancelled");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "idle");
        // Daily cap counts dry runs too.
        let capped = RebalanceCfg {
            max_per_day: 1,
            ..cfg(false)
        };
        db.sql("UPDATE pool_sol_inventory SET vault_lamports = 0").await;
        assert_eq!(step(&capped, l, &oc, &mut w, ch()).await.unwrap(), "idle");
        db.drop().await;
    }

    #[tokio::test]
    async fn live_happy_path_with_fund_retry() {
        let Some(db) = setup().await else { return };
        let c = cfg(true);
        let oc = MockOc::default();
        let mut w = wallet(&db, "mainnet-beta");
        let l = &db.ledger;
        db.sql("INSERT INTO pool_sol_inventory (network, vault_lamports, vault_count, slot) VALUES ('mainnet-beta', 0, 2, 1)")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "sent");
        assert_eq!((w.builds, w.broadcasts), (1, 1));
        assert_eq!(oc.0.lock().unwrap().submits, 1);
        // Pending: re-broadcast of the SAME tx, never a new build.
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "waiting");
        assert_eq!((w.builds, w.broadcasts), (1, 2));
        w.state = TxState::Mined(99); // 2 confirmations at tip 100
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "waiting");
        w.state = TxState::Mined(98);
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "mined");
        oc.0.lock().unwrap().status = "PROCESSING".into();
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "waiting");
        {
            let mut s = oc.0.lock().unwrap();
            s.status = "SUCCESS".into();
            s.amount_out = Some("5590000000".into());
        }
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "success");
        let j = db
            .one("SELECT j.id, j.op, j.lamports_in, j.action_id IS NULL, j.exec_mode FROM relayer_jobs j")
            .await;
        assert_eq!(j.get::<_, String>(1), "fund_vaults");
        assert_eq!(
            j.get::<_, i64>(2),
            5_580_000_000,
            "amount out minus the kept fee buffer"
        );
        assert!(j.get::<_, bool>(3));
        assert_eq!(j.get::<_, Option<String>>(4).as_deref(), Some("delayed"));
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "distributing");
        db.sql("UPDATE relayer_jobs SET status = 'failed', error_code = 'internal'")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "fund_retry");
        db.sql("UPDATE relayer_jobs SET status = 'confirmed', signature = 's', slot = 5 WHERE settled_at IS NULL")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "done");
        let r = db
            .one(
                "SELECT (SELECT count(*) FROM relayer_jobs WHERE settled_at IS NULL),
                        (SELECT status FROM pool_rebalances), (SELECT amount_out FROM pool_rebalances),
                        (SELECT quote ? 'signature' FROM pool_rebalances)",
            )
            .await;
        assert_eq!(r.get::<_, i64>(0), 0, "core settles fund_vaults jobs");
        assert_eq!(r.get::<_, String>(1), "done");
        assert_eq!(r.get::<_, i64>(2), 5_590_000_000);
        assert!(r.get::<_, bool>(3), "1Click quote signature kept for disputes");
        assert_eq!((w.builds, oc.0.lock().unwrap().quotes), (1, 1));
        db.drop().await;
    }

    #[tokio::test]
    async fn live_guards_expiry_and_single_use_addresses() {
        let Some(db) = setup().await else { return };
        let c = cfg(true);
        let oc = MockOc::default();
        let mut w = wallet(&db, "mainnet-beta");
        let l = &db.ledger;
        db.sql("INSERT INTO pool_sol_inventory (network, vault_lamports, vault_count, slot) VALUES ('mainnet-beta', 0, 2, 1)")
            .await;
        // Users' ZEC must stay covered: liabilities 0.6 ZEC, spendable 1 ZEC < 0.6 + 0.5 lot.
        db.sql("INSERT INTO balances (anon_pubkey, available_zat, held_zat) VALUES (decode(repeat('01', 32), 'hex'), 50000000, 10000000)")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "failed");
        assert_eq!(oc.0.lock().unwrap().quotes, 0, "no quote when the surplus is short");
        db.sql("DELETE FROM balances").await;
        // Funds not confirmed yet: quoted, nothing built; an old quote is abandoned, not reused.
        w.proposal_error = true;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "waiting");
        db.sql("UPDATE pool_rebalances SET quoted_at = now() - interval '1 hour' WHERE status = 'quoted'")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "failed");
        w.proposal_error = false;
        // Sent tx expires unmined → failed; the next rebalance gets a NEW deposit address.
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "sent");
        w.state = TxState::Expired;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "failed");
        let r = db
            .one(
                "SELECT count(*), count(DISTINCT deposit_address), string_agg(status || ':' || COALESCE(error_code, ''), ',' ORDER BY id)
                 FROM pool_rebalances WHERE deposit_address IS NOT NULL",
            )
            .await;
        assert_eq!(r.get::<_, i64>(0), r.get::<_, i64>(1));
        assert_eq!(r.get::<_, String>(2), "expired:quote_expired,failed:send_expired");
        // Refund at 1Click is terminal; FAILED needs the operator and blocks new plans.
        w.state = TxState::Mined(90);
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "sent");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "mined");
        oc.0.lock().unwrap().status = "FAILED".into();
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "failed");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "attention");
        let id: i64 = db
            .one("SELECT id FROM pool_rebalances WHERE status = 'attention'")
            .await
            .get(0);
        assert!(l.close_rebalance(id, "failed").await.unwrap());
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        // A recipient that is a trading vault is refused.
        let vault = c.sol_address.clone().unwrap();
        db.sql(&format!(
            "INSERT INTO relayer_vault_usage (network, vault, last_used_at) VALUES ('mainnet-beta', '{vault}', now())"
        ))
        .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "failed");
        db.drop().await;
    }

    #[tokio::test]
    async fn zec_spl_rebalance_spreads_stock_with_fund_quote() {
        let Some(db) = setup().await else { return };
        let c = cfg(true).zec_spl().unwrap();
        assert_eq!((c.target, c.destination()), ("zec_spl", crate::oneclick::ZEC_SPL_ASSET));
        let oc = MockOc::default();
        let mut w = MockWallet {
            target: "zec_spl",
            ..wallet(&db, "mainnet-beta")
        };
        let l = &db.ledger;
        let zec = unzeen_ledger::rebalance::ZEC_SPL_MINT;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "no_inventory");
        // SOL inventory is plenty: the SOL target stays idle, the ZEC SPL one plans.
        db.sql(&format!(
            "INSERT INTO pool_sol_inventory (network, vault_lamports, vault_count, slot) VALUES ('mainnet-beta', 90000000000, 2, 1);
             INSERT INTO pool_quote_inventory (network, quote_mint, vault_amount, reserve_amount, vault_count, slot)
               VALUES ('mainnet-beta', '{zec}', 1000000, 0, 2, 1);
             INSERT INTO relayer_vault_usage (network, vault, last_used_at) VALUES
               ('mainnet-beta', 'VaultOne1111111111111111111111111111111111', now()),
               ('mainnet-beta', 'VaultTwo1111111111111111111111111111111111', now());"
        ))
        .await;
        assert_eq!(step(&cfg(true), l, &oc, &mut w, ch()).await.unwrap(), "idle");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "planned");
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "sent");
        w.state = TxState::Mined(90);
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "mined");
        {
            let mut s = oc.0.lock().unwrap();
            s.status = "SUCCESS".into();
            s.amount_out = Some("49976005".into());
        }
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "success");
        let r = db
            .one(&format!(
                "SELECT count(*), count(*) FILTER (WHERE meta->>'quote' = '{zec}' AND action_id IS NULL AND exec_mode = 'delayed')
                 FROM relayer_jobs WHERE op = 'fund_quote'"
            ))
            .await;
        assert_eq!(
            (r.get::<_, i64>(0), r.get::<_, i64>(1)),
            (2, 2),
            "one fund_quote per vault"
        );
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "distributing");
        // Stock already within bounds → confirmed without a tx (CHECK allows it for fund_quote).
        db.sql("UPDATE relayer_jobs SET status = 'confirmed', out_token_amount = 0, out_lamports = 0 WHERE op = 'fund_quote'")
            .await;
        assert_eq!(step(&c, l, &oc, &mut w, ch()).await.unwrap(), "done");
        let t = db
            .one("SELECT target, status, amount_out FROM pool_rebalances WHERE target = 'zec_spl'")
            .await;
        assert_eq!(
            (t.get::<_, String>(0), t.get::<_, String>(1), t.get::<_, i64>(2)),
            ("zec_spl".into(), "done".into(), 49_976_005)
        );
        db.drop().await;
    }
}

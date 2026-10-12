//! Unzeen private ledger on Postgres (tokio-postgres + deadpool).
//!
//! - Deposits: one row per shielded note, keyed by `note_ref` (keyed hash of
//!   `(txid, pool, action_index)`), status `seen -> confirmed -> credited | ...`.
//! - Balances per anon key: `available` + `held` (reserved by queued actions).
//! - Holds: the debit is one conditional `UPDATE ... WHERE available_zat >= x`, in the same
//!   transaction that consumes the request nonce (`actions` unique `(anon_pubkey, nonce)`).
//! - Journal: every balance change is appended to `ledger_ops`.
//!
//! Privacy: nothing here logs keys, amounts or refs. Callers must not either.

pub mod actions;
pub mod creator;
pub mod creator_fees;
pub mod decide;
pub mod fair;
mod migrate;
pub mod orders;
pub mod payouts;
pub mod stats;
pub mod verify;

use deadpool_postgres::{GenericClient, Manager, ManagerConfig, Pool, RecyclingMethod};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tokio_postgres::NoTls;

pub use actions::{
    ActionBrief, ActionView, DepositRow, JanitorReport, JobOp, NewAction, NewJob, NewPayout, RateUsed, TokenHolding,
};
pub use deadpool_postgres;
pub use decide::{MemoInput, NoteObs, Outcome, Policy, Stage, evaluate};
pub use payouts::{InflightPayout, PayoutRow};
pub use tokio_postgres;
pub use tokio_postgres::Config as PgConfig;

/// Errors never carry row values: Postgres errors are reduced to their SQLSTATE (the
/// `DETAIL` of a constraint violation contains whole rows, e.g. anon keys and amounts).
#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("database error (SQLSTATE {0})")]
    Db(String),
    #[error("connection pool: {0}")]
    Pool(String),
    #[error("insufficient balance")]
    InsufficientBalance,
    #[error("balance frozen pending review")]
    Frozen,
    #[error("amount below minimum")]
    BelowMinimum,
    #[error("nonce already used for a different request")]
    Replay,
    #[error("amount out of range")]
    Range,
    #[error("not found")]
    NotFound,
    /// The action would touch the creator's locked initial-buy tokens (API 423 creator_locked).
    #[error("creator tokens locked")]
    CreatorLocked,
    /// The creator's position through the pool would exceed the cap (API 422 creator_cap).
    #[error("creator position cap")]
    CreatorCap,
    /// Fair launch: the bid window is closed or the launch is not open (API 409 launch_closed).
    #[error("launch closed")]
    LaunchClosed,
    /// Fair launch: the key already has a sealed bid on this launch (API 409 already_bid).
    #[error("already bid")]
    AlreadyBid,
    /// Fair launch: the launch reached its bid cap (API 409 launch_full).
    #[error("launch full")]
    LaunchFull,
    /// Orders: too many open orders for the key / key+mint (API 422 order_limit).
    #[error("order limit")]
    OrderLimit,
    /// Orders: cancel of an order that is not open (API 409 order_not_open).
    #[error("order not open")]
    OrderNotOpen,
    /// Orders: the pool-wide open order limit (API 503 venue_unavailable).
    #[error("orders full")]
    OrdersFull,
}

/// SQLSTATE of a Postgres error, or a coarse kind for client-side errors. Safe to log.
pub fn sqlstate(e: &tokio_postgres::Error) -> String {
    match e.code() {
        Some(c) => c.code().to_string(),
        None if e.is_closed() => "connection-closed".into(),
        None => "client".into(),
    }
}

impl From<tokio_postgres::Error> for LedgerError {
    fn from(e: tokio_postgres::Error) -> Self {
        LedgerError::Db(sqlstate(&e))
    }
}

impl From<deadpool_postgres::PoolError> for LedgerError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        use deadpool_postgres::PoolError as P;
        match e {
            P::Backend(e) => e.into(),
            P::Timeout(_) => LedgerError::Pool("timeout".into()),
            P::Closed => LedgerError::Pool("closed".into()),
            _ => LedgerError::Pool("unavailable".into()),
        }
    }
}

impl LedgerError {
    /// Stable short label for logs/metrics.
    pub fn kind(&self) -> &'static str {
        match self {
            LedgerError::Db(_) => "db",
            LedgerError::Pool(_) => "pool",
            LedgerError::InsufficientBalance => "insufficient_balance",
            LedgerError::Frozen => "frozen",
            LedgerError::BelowMinimum => "below_minimum",
            LedgerError::Replay => "replay",
            LedgerError::Range => "range",
            LedgerError::NotFound => "not_found",
            LedgerError::CreatorLocked => "creator_locked",
            LedgerError::CreatorCap => "creator_cap",
            LedgerError::LaunchClosed => "launch_closed",
            LedgerError::AlreadyBid => "already_bid",
            LedgerError::LaunchFull => "launch_full",
            LedgerError::OrderLimit => "order_limit",
            LedgerError::OrderNotOpen => "order_not_open",
            LedgerError::OrdersFull => "orders_full",
        }
    }
}

/// Render an error chain for logs, replacing any Postgres error by its SQLSTATE.
pub fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = Vec::new();
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = cur {
        match err.downcast_ref::<tokio_postgres::Error>() {
            Some(pg) => {
                out.push(format!("postgres SQLSTATE {}", sqlstate(pg)));
                break;
            }
            None => out.push(err.to_string()),
        }
        cur = err.source();
    }
    out.join(": ")
}

pub type Result<T> = std::result::Result<T, LedgerError>;

/// Key for `note_ref`. Derive it from a pool secret that is NOT stored in Postgres.
#[derive(Clone)]
pub struct NoteRefKey([u8; 32]);

impl NoteRefKey {
    pub fn new(k: [u8; 32]) -> Self {
        Self(k)
    }

    /// `HMAC-SHA256(k, txid(32, internal byte order) || pool(1) || action_index(u32 LE))`.
    pub fn note_ref(&self, txid: &[u8; 32], pool: u8, action_index: u32) -> [u8; 32] {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.0).expect("any key length");
        mac.update(txid);
        mac.update(&[pool]);
        mac.update(&action_index.to_le_bytes());
        mac.finalize().into_bytes().into()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Balance {
    pub available_zat: u64,
    pub held_zat: u64,
    pub frozen: bool,
}

/// What `observe_note` did (for counters; carries no identifying data).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Observed {
    Unchanged,
    Seen,
    Confirmed,
    Credited,
    Frozen,
    Dust,
    /// A finalized deposit is no longer mined: balance frozen, operator alert.
    ReorgAlert,
    /// A reorged deposit is mined again with >= K confirmations: flag cleared, and the
    /// balance unfrozen if no other deposit of the key is still reorged.
    ReorgCleared,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionReceipt {
    pub id: [u8; 16],
    pub status: String,
    /// The same signed request was submitted before; this is the original receipt.
    pub replayed: bool,
    /// ZEC→SOL rate fixed for this action (buy / sell / create / withdraw_token).
    pub rate: Option<actions::RateUsed>,
}

/// Rules the ledger enforces on creators of tokens launched through Unzeen (API v0.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreatorRules {
    /// Lock of the initial-buy tokens, seconds (0 = off). The end is rounded UP to the hour.
    pub lock_secs: u64,
    /// Max position of the creator through the pool, token base units (0 = off).
    pub cap_tokens: u64,
    /// Upper bound of the venue creator fee on the launch buy, bps of the lamports paid
    /// (fees included), used when the relayer did not report the exact fee (API v0.9).
    pub launch_fee_bps_pumpfun: u32,
    pub launch_fee_bps_dbc: u32,
}

impl Default for CreatorRules {
    /// 24 h lock; 5 % of a pump.fun supply (1e9 tokens, 6 decimals).
    fn default() -> Self {
        Self {
            lock_secs: 86_400,
            cap_tokens: 50_000_000_000_000,
            launch_fee_bps_pumpfun: 30,
            launch_fee_bps_dbc: 40,
        }
    }
}

#[derive(Clone)]
pub struct Ledger {
    pool: Pool,
    policy: Policy,
    rules: CreatorRules,
}

pub(crate) fn to_i64(v: u64) -> Result<i64> {
    i64::try_from(v).map_err(|_| LedgerError::Range)
}

pub(crate) fn to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// Final statuses whose disappearance in a reorg must freeze the owner's balance.
const FINAL_AFFECTING: [&str; 2] = ["credited", "refund_pending"];

impl Ledger {
    /// Connect (e.g. `postgres://user:pass@127.0.0.1:5432/unzeen`) and apply migrations.
    pub async fn connect(database_url: &str, policy: Policy) -> Result<Self> {
        let cfg: PgConfig = database_url.parse()?;
        Self::connect_with(cfg, policy).await
    }

    pub async fn connect_with(cfg: PgConfig, policy: Policy) -> Result<Self> {
        let mgr = Manager::from_config(
            cfg,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(mgr)
            .max_size(8)
            .build()
            .map_err(|_| LedgerError::Pool("build".into()))?;
        let mut c = pool.get().await?;
        migrate::run(&mut c).await?;
        drop(c);
        Ok(Self {
            pool,
            policy,
            rules: CreatorRules::default(),
        })
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    /// Same ledger with other creator rules (API config).
    pub fn with_creator_rules(mut self, rules: CreatorRules) -> Self {
        self.rules = rules;
        self
    }

    pub fn creator_rules(&self) -> CreatorRules {
        self.rules
    }

    /// The connection pool, for read-only public queries (feed, tokens) of the API server.
    pub fn pg(&self) -> &Pool {
        &self.pool
    }

    pub async fn balance(&self, pk: &[u8; 32]) -> Result<Option<Balance>> {
        let c = self.pool.get().await?;
        let row = c
            .query_opt(
                "SELECT available_zat, held_zat, frozen FROM balances WHERE anon_pubkey = $1",
                &[&&pk[..]],
            )
            .await?;
        Ok(row.map(|r| Balance {
            available_zat: to_u64(r.get(0)),
            held_zat: to_u64(r.get(1)),
            frozen: r.get(2),
        }))
    }

    /// Feed one wallet note. Idempotent: call it for every note on every scan.
    pub async fn observe_note(&self, obs: &NoteObs, fallback_now: u64) -> Result<Observed> {
        let stage = evaluate(obs, &self.policy, fallback_now);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let note_ref: &[u8] = &obs.note_ref;
        let existing = tx
            .query_opt(
                "SELECT id, status, reorged, anon_pubkey FROM deposits WHERE note_ref = $1 FOR UPDATE",
                &[&note_ref],
            )
            .await?
            .map(|r| {
                (
                    r.get::<_, i64>(0),
                    r.get::<_, String>(1),
                    r.get::<_, bool>(2),
                    r.get::<_, Option<Vec<u8>>>(3),
                )
            });
        let height: Option<i32> = obs.mined_height.map(|h| h as i32);
        let amount = to_i64(obs.amount_zat)?;

        let out = match (&stage, existing) {
            // Reorg after finalization: flag + freeze the owner's balance, never go negative.
            (Stage::Unmined, Some((id, status, reorged, pk))) => {
                tx.execute(
                    "UPDATE deposits SET mined_height = NULL, updated_at = now() WHERE id = $1",
                    &[&id],
                )
                .await?;
                if FINAL_AFFECTING.contains(&status.as_str()) && !reorged {
                    tx.execute("UPDATE deposits SET reorged = TRUE WHERE id = $1", &[&id])
                        .await?;
                    if let Some(pk) = pk {
                        tx.execute(
                            "INSERT INTO balances (anon_pubkey, frozen) VALUES ($1, TRUE)
                             ON CONFLICT (anon_pubkey) DO UPDATE SET frozen = TRUE, updated_at = now()",
                            &[&pk],
                        )
                        .await?;
                    }
                    Observed::ReorgAlert
                } else {
                    Observed::Unchanged
                }
            }
            (Stage::Unmined, None) => Observed::Unchanged,
            (Stage::Seen | Stage::Confirmed, Some((id, status, reorged, pk))) => {
                if status == "seen" || status == "confirmed" {
                    let new_status = pending_status(&stage);
                    tx.execute(
                        "UPDATE deposits SET status = $2, mined_height = $3, updated_at = now() WHERE id = $1",
                        &[&id, &new_status, &height],
                    )
                    .await?;
                    if status == new_status {
                        Observed::Unchanged
                    } else {
                        stage_observed(&stage)
                    }
                } else {
                    // Already final (e.g. re-mined after a shallow reorg): keep the decision.
                    tx.execute(
                        "UPDATE deposits SET mined_height = $2, updated_at = now()
                         WHERE id = $1 AND anon_pubkey IS NULL",
                        &[&id, &height],
                    )
                    .await?;
                    if reorged && stage == Stage::Confirmed {
                        clear_reorg(&tx, id, pk.as_deref()).await?
                    } else {
                        Observed::Unchanged
                    }
                }
            }
            (Stage::Seen | Stage::Confirmed, None) => {
                tx.execute(
                    "INSERT INTO deposits (note_ref, amount_zat, mined_height, status) VALUES ($1, $2, $3, $4)",
                    &[&note_ref, &amount, &height, &pending_status(&stage)],
                )
                .await?;
                stage_observed(&stage)
            }
            (Stage::Final(_), Some((id, status, reorged, pk))) if status != "seen" && status != "confirmed" => {
                tx.execute(
                    "UPDATE deposits SET mined_height = $2
                     WHERE id = $1 AND anon_pubkey IS NULL AND mined_height IS DISTINCT FROM $2",
                    &[&id, &height],
                )
                .await?;
                if reorged {
                    clear_reorg(&tx, id, pk.as_deref()).await?
                } else {
                    Observed::Unchanged
                }
            }
            (Stage::Final(outcome), existing) => {
                let id: i64 = match existing {
                    Some((id, ..)) => id,
                    None => tx
                        .query_one(
                            "INSERT INTO deposits (note_ref, amount_zat, mined_height, status)
                             VALUES ($1, $2, $3, 'confirmed') RETURNING id",
                            &[&note_ref, &amount, &height],
                        )
                        .await?
                        .get(0),
                };
                finalize(&tx, id, amount, height, outcome).await?
            }
        };
        if obs.public_source {
            tx.execute(
                "UPDATE deposits SET public_source = TRUE WHERE note_ref = $1 AND NOT public_source",
                &[&note_ref],
            )
            .await?;
        }
        tx.commit().await?;
        Ok(out)
    }

    /// Reserve `hold_zat` for a signed API action without relayer work (see [`Self::submit`]).
    ///
    /// Same `(pk, nonce)` + same `request_hash` returns the original receipt (client retry);
    /// same nonce with a different request is [`LedgerError::Replay`].
    pub async fn submit_action(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        kind: &str,
        hold_zat: u64,
    ) -> Result<ActionReceipt> {
        let a = NewAction {
            kind: kind.into(),
            amount_zat: hold_zat,
            fee_zat: 0,
            token_hold: None,
            rate: None,
            network: String::new(),
            jobs: vec![],
            payout: None,
            gain: None,
        };
        self.submit(pk, nonce, request_hash, &a).await
    }

    /// Action executed on-chain: the hold is spent.
    pub async fn settle_action(&self, id: &[u8; 16]) -> Result<()> {
        self.close_action(id, true, None).await
    }

    /// Action failed: the hold returns to `available`.
    pub async fn fail_action(&self, id: &[u8; 16], error: &str) -> Result<()> {
        self.close_action(id, false, Some(error)).await
    }

    async fn close_action(&self, id: &[u8; 16], ok: bool, error: Option<&str>) -> Result<()> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        if !payouts::close_in(&tx, id, ok, error).await? {
            return Err(LedgerError::NotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    /// Consume the nonce of a signed non-action request (e.g. signed GET).
    /// Returns `false` if already used. Kept until `ts + NONCE_TTL_MS`.
    pub async fn use_api_nonce(&self, pk: &[u8; 32], nonce: &[u8; 16], ts_ms: u64) -> Result<bool> {
        let keep_until_ms = to_i64(ts_ms.saturating_add(unzeen_protocol::api_auth::NONCE_TTL_MS))?;
        let (pk_s, nonce_s): (&[u8], &[u8]) = (pk, nonce);
        let c = self.pool.get().await?;
        let n = c
            .execute(
                "INSERT INTO api_nonces (anon_pubkey, nonce, expires_at)
                 VALUES ($1, $2, to_timestamp($3::float8 / 1000)) ON CONFLICT DO NOTHING",
                &[&pk_s, &nonce_s, &(keep_until_ms as f64)],
            )
            .await?;
        Ok(n == 1)
    }

    pub async fn purge_api_nonces(&self) -> Result<u64> {
        let c = self.pool.get().await?;
        Ok(c.execute("DELETE FROM api_nonces WHERE expires_at < now()", &[])
            .await?)
    }

    /// Counts by deposit status (operator health output; no identifying data).
    pub async fn deposit_stats(&self) -> Result<Vec<(String, i64)>> {
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT status, count(*) FROM deposits GROUP BY status ORDER BY status",
                &[],
            )
            .await?;
        Ok(rows.into_iter().map(|r| (r.get(0), r.get(1))).collect())
    }
}

/// N4: a reorged final deposit is mined again with >= K confirmations. Clear its flag and
/// unfreeze the owner unless another of their deposits is still reorged.
async fn clear_reorg<C: GenericClient>(tx: &C, id: i64, pk: Option<&[u8]>) -> Result<Observed> {
    tx.execute(
        "UPDATE deposits SET reorged = FALSE, updated_at = now() WHERE id = $1",
        &[&id],
    )
    .await?;
    if let Some(pk) = pk {
        tx.execute(
            "UPDATE balances SET frozen = FALSE, updated_at = now()
             WHERE anon_pubkey = $1 AND frozen
               AND NOT EXISTS (SELECT 1 FROM deposits WHERE anon_pubkey = $1 AND reorged)",
            &[&pk],
        )
        .await?;
    }
    Ok(Observed::ReorgCleared)
}

fn pending_status(s: &Stage) -> &'static str {
    if *s == Stage::Seen { "seen" } else { "confirmed" }
}

fn stage_observed(s: &Stage) -> Observed {
    match s {
        Stage::Seen => Observed::Seen,
        Stage::Confirmed => Observed::Confirmed,
        _ => Observed::Unchanged,
    }
}

async fn finalize<C: GenericClient>(
    tx: &C,
    id: i64,
    amount: i64,
    height: Option<i32>,
    outcome: &Outcome,
) -> Result<Observed> {
    let set = |status: &'static str,
               reason: Option<&'static str>,
               pk: Option<Vec<u8>>,
               op: Option<i16>,
               credited: i64| async move {
        tx.execute(
            "UPDATE deposits SET status = $2, reason = $3, anon_pubkey = $4, op = $5, credited_zat = $6,
                    mined_height = $7, updated_at = now() WHERE id = $1",
            &[&id, &status, &reason, &pk, &op, &credited, &height],
        )
        .await
    };
    Ok(match outcome {
        Outcome::Dust => {
            set("dust", None, None, None, 0).await?;
            Observed::Dust
        }
        Outcome::Frozen { reason } => {
            // The pubkey of an unverified memo is untrusted: do not store it.
            set("frozen", Some(reason), None, None, 0).await?;
            Observed::Frozen
        }
        Outcome::Credit { pk, op, reason } => {
            set("credited", *reason, Some(pk.to_vec()), Some(*op as i16), amount).await?;
            tx.execute(
                "INSERT INTO balances (anon_pubkey, available_zat) VALUES ($1, $2)
                 ON CONFLICT (anon_pubkey) DO UPDATE
                   SET available_zat = balances.available_zat + EXCLUDED.available_zat, updated_at = now()",
                &[&&pk[..], &amount],
            )
            .await?;
            journal(tx, &pk[..], "deposit_credit", amount, 0, Some(id), None).await?;
            Observed::Credited
        }
    })
}

pub(crate) async fn journal<C: GenericClient>(
    tx: &C,
    pk: &[u8],
    kind: &str,
    d_avail: i64,
    d_held: i64,
    deposit_id: Option<i64>,
    action_id: Option<&[u8]>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO ledger_ops (anon_pubkey, kind, delta_available, delta_held, deposit_id, action_id)
         VALUES ($1, $2, $3, $4, $5, $6)",
        &[&pk, &kind, &d_avail, &d_held, &deposit_id, &action_id],
    )
    .await?;
    Ok(())
}

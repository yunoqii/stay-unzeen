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

pub mod decide;
mod migrate;

use deadpool_postgres::{GenericClient, Manager, ManagerConfig, Pool, RecyclingMethod};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use tokio_postgres::NoTls;

pub use decide::{MemoInput, NoteObs, Outcome, Policy, Stage, evaluate};
pub use tokio_postgres::Config as PgConfig;

#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("database: {0}")]
    Db(#[from] tokio_postgres::Error),
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
}

impl From<deadpool_postgres::PoolError> for LedgerError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        LedgerError::Pool(e.to_string())
    }
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
    RefundPending,
    Frozen,
    Dust,
    /// A finalized deposit is no longer mined: balance frozen, operator alert.
    ReorgAlert,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionReceipt {
    pub id: [u8; 16],
    pub status: String,
    /// The same signed request was submitted before; this is the original receipt.
    pub replayed: bool,
}

#[derive(Clone)]
pub struct Ledger {
    pool: Pool,
    policy: Policy,
}

fn to_i64(v: u64) -> Result<i64> {
    i64::try_from(v).map_err(|_| LedgerError::Range)
}

fn to_u64(v: i64) -> u64 {
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
            .map_err(|e| LedgerError::Pool(e.to_string()))?;
        let mut c = pool.get().await?;
        migrate::run(&mut c).await?;
        drop(c);
        Ok(Self { pool, policy })
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
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
            (Stage::Seen | Stage::Confirmed, Some((id, status, _, _))) => {
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
                        "UPDATE deposits SET mined_height = $2, updated_at = now() WHERE id = $1",
                        &[&id, &height],
                    )
                    .await?;
                    Observed::Unchanged
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
            (Stage::Final(_), Some((id, status, _, _))) if status != "seen" && status != "confirmed" => {
                tx.execute(
                    "UPDATE deposits SET mined_height = $2 WHERE id = $1 AND mined_height IS DISTINCT FROM $2",
                    &[&id, &height],
                )
                .await?;
                Observed::Unchanged
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
        tx.commit().await?;
        Ok(out)
    }

    /// Reserve funds for a signed API action, consuming its nonce in the same transaction.
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
        if hold_zat > 0 && hold_zat < self.policy.min_action_zat {
            return Err(LedgerError::BelowMinimum);
        }
        let hold = to_i64(hold_zat)?;
        let id: [u8; 16] = rand::random();
        let (pk_s, nonce_s, hash_s, id_s): (&[u8], &[u8], &[u8], &[u8]) = (pk, nonce, request_hash, &id);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let inserted = tx
            .execute(
                "INSERT INTO actions (id, anon_pubkey, nonce, request_hash, kind, hold_zat, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'queued')
                 ON CONFLICT (anon_pubkey, nonce) DO NOTHING",
                &[&id_s, &pk_s, &nonce_s, &hash_s, &kind, &hold],
            )
            .await?
            == 1;
        if !inserted {
            let r = tx
                .query_one(
                    "SELECT id, request_hash, status FROM actions WHERE anon_pubkey = $1 AND nonce = $2",
                    &[&pk_s, &nonce_s],
                )
                .await?;
            let prev_hash: Vec<u8> = r.get(1);
            if prev_hash != request_hash[..] {
                return Err(LedgerError::Replay);
            }
            let prev_id: Vec<u8> = r.get(0);
            return Ok(ActionReceipt {
                id: prev_id.try_into().map_err(|_| LedgerError::Range)?,
                status: r.get(2),
                replayed: true,
            });
        }
        if hold > 0 {
            let ok = tx
                .execute(
                    "UPDATE balances SET available_zat = available_zat - $2, held_zat = held_zat + $2,
                            updated_at = now()
                     WHERE anon_pubkey = $1 AND available_zat >= $2 AND NOT frozen",
                    &[&pk_s, &hold],
                )
                .await?
                == 1;
            if !ok {
                let frozen: Option<bool> = tx
                    .query_opt("SELECT frozen FROM balances WHERE anon_pubkey = $1", &[&pk_s])
                    .await?
                    .map(|r| r.get(0));
                // Dropping `tx` rolls back the action insert, so the nonce stays unused.
                return Err(if frozen == Some(true) {
                    LedgerError::Frozen
                } else {
                    LedgerError::InsufficientBalance
                });
            }
            journal(&tx, pk_s, "hold", -hold, hold, None, Some(id_s)).await?;
        }
        tx.commit().await?;
        Ok(ActionReceipt {
            id,
            status: "queued".into(),
            replayed: false,
        })
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
        let id_s: &[u8] = id;
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let status = if ok { "executed" } else { "failed" };
        let r = tx
            .query_opt(
                "UPDATE actions SET status = $2, error = $3, updated_at = now()
                 WHERE id = $1 AND status = 'queued' RETURNING anon_pubkey, hold_zat",
                &[&id_s, &status, &error],
            )
            .await?
            .ok_or(LedgerError::NotFound)?;
        let pk: Vec<u8> = r.get(0);
        let hold: i64 = r.get(1);
        if hold > 0 {
            if ok {
                tx.execute(
                    "UPDATE balances SET held_zat = held_zat - $2, updated_at = now() WHERE anon_pubkey = $1",
                    &[&pk, &hold],
                )
                .await?;
                journal(&tx, &pk, "settle", 0, -hold, None, Some(id_s)).await?;
            } else {
                tx.execute(
                    "UPDATE balances SET held_zat = held_zat - $2, available_zat = available_zat + $2,
                            updated_at = now() WHERE anon_pubkey = $1",
                    &[&pk, &hold],
                )
                .await?;
                journal(&tx, &pk, "release", hold, -hold, None, Some(id_s)).await?;
            }
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
        Outcome::RefundPending { pk, op } => {
            set(
                "refund_pending",
                Some("expired"),
                Some(pk.to_vec()),
                Some(*op as i16),
                0,
            )
            .await?;
            Observed::RefundPending
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

async fn journal<C: GenericClient>(
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

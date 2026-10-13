//! Scenarios (API.md v0.19, migration 0027, spec `docs/analysis/scenarios.md` §2–§4): storage,
//! status transitions, the step submit with a savepoint, cancel / expire, janitor.
//!
//! The plan logic (validation, amounts, guards, floors) lives in `unzeen-api`; this module
//! only keeps the rows consistent. Every step becomes an ordinary action through
//! [`Ledger::submit_in`] with a random nonce / request hash (like orders, E20), so nothing in
//! `actions` / `relayer_jobs` marks it as automated.
//!
//! Privacy: no logging; times coarse (trigger 0027); scrub 24 h after closing, delete after 48 h;
//! sealed blobs are deleted when their step is queued and whenever the plan closes.

use deadpool_postgres::GenericClient;
use serde_json::Value;

use crate::{ActionReceipt, Ledger, LedgerError, Result, actions::NewAction, fair::is_replay, orders::close_order};

/// Active plans per key / pool (`PoolInfo.scenarios.maxActivePerKey`; pool cap silent).
pub const MAX_ACTIVE_PER_KEY: i64 = 3;
pub const MAX_ACTIVE_GLOBAL: i64 = 500;

/// A plan to store (`scenario_create`).
#[derive(Clone, Debug)]
pub struct NewScenario {
    /// Echo form of the plan (sealed fields masked).
    pub plan: Value,
    pub ttl_secs: u64,
    /// The plan begins with `manual_start` → `waiting_start` until `scenario_start`.
    pub manual_start: bool,
    pub network: String,
    pub replaces: Option<[u8; 16]>,
    /// Initial executor state (`{sealId, steps: {}, out: {}}`).
    pub state: Value,
}

/// One locked plan row for the executor.
#[derive(Clone, Debug)]
pub struct ScenarioRow {
    pub id: [u8; 16],
    pub pk: [u8; 32],
    pub plan: Value,
    pub status: String,
    pub cursor: usize,
    pub phase: String,
    pub runs: u32,
    pub attempt: u32,
    pub state: Value,
    pub network: String,
    /// `next_at <= now()`.
    pub due: bool,
    /// `expires_at <= now()`.
    pub expired: bool,
}

/// One `scenario_runs` row: (seq, step, status, action_id, order_id, error).
pub type RunView = (i16, i16, String, Option<[u8; 16]>, Option<[u8; 16]>, Option<String>);

/// `Portfolio.scenarios` row.
#[derive(Clone, Debug)]
pub struct ScenarioView {
    pub id: [u8; 16],
    pub status: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub cursor: usize,
    pub plan: Value,
    pub state: Value,
    pub next_at_ms: Option<i64>,
    pub error: Option<String>,
    pub runs: Vec<RunView>,
}

fn id16(v: Vec<u8>) -> [u8; 16] {
    v.try_into().unwrap_or([0; 16])
}

const ROW_COLS: &str = "id, anon_pubkey, plan, status, cursor, phase, runs, attempt, state, network,
                        COALESCE(next_at <= now(), FALSE), expires_at <= now()";

fn row_of(r: &tokio_postgres::Row) -> ScenarioRow {
    ScenarioRow {
        id: id16(r.get(0)),
        pk: r.get::<_, Vec<u8>>(1).try_into().unwrap_or([0; 32]),
        plan: r.get::<_, Option<Value>>(2).unwrap_or(Value::Null),
        status: r.get(3),
        cursor: r.get::<_, i16>(4).max(0) as usize,
        phase: r.get(5),
        runs: r.get::<_, i16>(6).max(0) as u32,
        attempt: r.get::<_, i16>(7).max(0) as u32,
        state: r.get(8),
        network: r.get(9),
        due: r.get(10),
        expired: r.get(11),
    }
}

/// Close a plan inside `tx`: status, closed_at, sealed blobs gone; on cancel / expiry its open
/// orders are cancelled (hold back to the balance), on success they stay (owner decision 13.10).
pub async fn close_in<C: GenericClient>(tx: &C, id: &[u8], status: &str, error: Option<&str>) -> Result<()> {
    tx.execute(
        "UPDATE scenarios SET status = $2, error = $3, closed_at = now(), next_at = NULL, phase = 'ready'
         WHERE id = $1",
        &[&id, &status, &error],
    )
    .await?;
    tx.execute("DELETE FROM scenario_sealed WHERE scenario_id = $1", &[&id])
        .await?;
    if matches!(status, "cancelled" | "expired") {
        let open = tx
            .query(
                "SELECT o.id FROM orders o JOIN scenario_runs r ON r.order_id = o.id
                 WHERE r.scenario_id = $1 AND o.status = 'open' FOR UPDATE OF o",
                &[&id],
            )
            .await?;
        for o in open {
            let oid: Vec<u8> = o.get(0);
            close_order(tx, &oid, "cancelled", None).await?;
        }
    }
    Ok(())
}

impl Ledger {
    /// `scenario_create`: nonce + plan in one transaction (the receipt id is the plan id).
    /// `sealed` = (step, blob) encrypted by the API with K_scn.
    pub async fn scenario_create(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        s: &NewScenario,
        sealed: &[(i16, Vec<u8>)],
    ) -> Result<ActionReceipt> {
        let (pk_s, nonce_s): (&[u8], &[u8]) = (pk, nonce);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let a = NewAction {
            kind: "scenario_create".into(),
            ..NewAction::default()
        };
        if is_replay(&tx, pk_s, nonce_s).await? {
            let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
            let rid: &[u8] = &r.id;
            if let Some(row) = tx
                .query_opt("SELECT status FROM scenarios WHERE id = $1", &[&rid])
                .await?
            {
                r.status = row.get(0);
            }
            return Ok(r);
        }
        // Serialize creates (limits), like orders.
        tx.execute("SELECT pg_advisory_xact_lock(7566726966790027)", &[])
            .await?;
        if let Some(old) = &s.replaces {
            let old_s: &[u8] = old;
            let st = tx
                .query_opt(
                    "SELECT status FROM scenarios WHERE id = $1 AND anon_pubkey = $2 FOR UPDATE",
                    &[&old_s, &pk_s],
                )
                .await?
                .ok_or(LedgerError::NotFound)?;
            if !matches!(st.get::<_, &str>(0), "waiting_start" | "active") {
                return Err(LedgerError::ScenarioNotActive);
            }
        }
        let counts = tx
            .query_one(
                "SELECT count(*) FILTER (WHERE anon_pubkey = $1 AND id IS DISTINCT FROM $2), count(*)
                 FROM scenarios WHERE status IN ('waiting_start', 'active')",
                &[&pk_s, &s.replaces.as_ref().map(|r| r.to_vec())],
            )
            .await?;
        let (per_key, global): (i64, i64) = (counts.get(0), counts.get(1));
        if global >= MAX_ACTIVE_GLOBAL {
            return Err(LedgerError::OrdersFull);
        }
        if per_key >= MAX_ACTIVE_PER_KEY {
            return Err(LedgerError::ScenarioLimit);
        }
        let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
        let id: &[u8] = &r.id;
        if let Some(old) = &s.replaces {
            let old_s: &[u8] = old;
            close_in(&tx, old_s, "cancelled", None).await?;
        }
        let status = if s.manual_start { "waiting_start" } else { "active" };
        tx.execute(
            "INSERT INTO scenarios (id, anon_pubkey, network, plan, status, cursor, next_at, expires_at, state)
             VALUES ($1, $2, $3, $4, $5, 0, CASE WHEN $5 = 'active' THEN now() END,
                     date_trunc('hour', now() + make_interval(secs => $6) + interval '1 hour' - interval '1 microsecond'),
                     $7)",
            &[&id, &pk_s, &s.network, &s.plan, &status, &(s.ttl_secs as f64), &s.state],
        )
        .await?;
        for (step, blob) in sealed {
            tx.execute(
                "INSERT INTO scenario_sealed (scenario_id, step, blob) VALUES ($1, $2, $3)",
                &[&id, step, blob],
            )
            .await?;
        }
        tx.execute(
            "UPDATE actions SET status = 'executed', updated_at = now() WHERE id = $1",
            &[&id],
        )
        .await?;
        tx.commit().await?;
        r.status = status.into();
        Ok(r)
    }

    /// `scenario_start {id}`: `waiting_start` → `active`, cursor past `manual_start`, step 1 due
    /// now (a Now step there behaves like a manual Now action, P1).
    pub async fn scenario_start(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        id: &[u8; 16],
    ) -> Result<ActionReceipt> {
        let (pk_s, nonce_s, sid): (&[u8], &[u8], &[u8]) = (pk, nonce, id);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let a = NewAction {
            kind: "scenario_start".into(),
            ..NewAction::default()
        };
        if is_replay(&tx, pk_s, nonce_s).await? {
            let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
            r.status = "active".into();
            return Ok(r);
        }
        let st = tx
            .query_opt(
                "SELECT status, expires_at <= now() FROM scenarios WHERE id = $1 AND anon_pubkey = $2 FOR UPDATE",
                &[&sid, &pk_s],
            )
            .await?
            .ok_or(LedgerError::NotFound)?;
        if st.get::<_, &str>(0) != "waiting_start" || st.get::<_, bool>(1) {
            return Err(LedgerError::ScenarioNotActive);
        }
        let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
        tx.execute(
            "UPDATE scenarios SET status = 'active', cursor = 1, phase = 'ready', next_at = now(),
                    state = jsonb_set(state, '{started}', 'true')
             WHERE id = $1",
            &[&sid],
        )
        .await?;
        let rid: &[u8] = &r.id;
        tx.execute(
            "UPDATE actions SET status = 'executed', updated_at = now() WHERE id = $1",
            &[&rid],
        )
        .await?;
        tx.commit().await?;
        r.status = "active".into();
        Ok(r)
    }

    /// `scenario_cancel {id}` / `{all: true}` (`id = None`). Returns the receipt and the ids
    /// cancelled. A step already queued is not recalled (it finishes like a fired order).
    pub async fn scenario_cancel(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        id: Option<&[u8; 16]>,
    ) -> Result<(ActionReceipt, Vec<[u8; 16]>)> {
        let (pk_s, nonce_s): (&[u8], &[u8]) = (pk, nonce);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let a = NewAction {
            kind: "scenario_cancel".into(),
            ..NewAction::default()
        };
        if is_replay(&tx, pk_s, nonce_s).await? {
            let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
            r.status = "cancelled".into();
            return Ok((r, vec![]));
        }
        let ids: Vec<[u8; 16]> = match id {
            Some(one) => {
                let sid: &[u8] = one;
                let st = tx
                    .query_opt(
                        "SELECT status FROM scenarios WHERE id = $1 AND anon_pubkey = $2 FOR UPDATE",
                        &[&sid, &pk_s],
                    )
                    .await?
                    .ok_or(LedgerError::NotFound)?;
                if !matches!(st.get::<_, &str>(0), "waiting_start" | "active") {
                    return Err(LedgerError::ScenarioNotActive);
                }
                vec![*one]
            }
            None => tx
                .query(
                    "SELECT id FROM scenarios WHERE anon_pubkey = $1 AND status IN ('waiting_start', 'active')
                     ORDER BY id FOR UPDATE",
                    &[&pk_s],
                )
                .await?
                .into_iter()
                .map(|r| id16(r.get(0)))
                .collect(),
        };
        let mut r = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
        for sid in &ids {
            let s: &[u8] = sid;
            close_in(&tx, s, "cancelled", None).await?;
        }
        let rid: &[u8] = &r.id;
        tx.execute(
            "UPDATE actions SET status = 'executed', updated_at = now() WHERE id = $1",
            &[&rid],
        )
        .await?;
        tx.commit().await?;
        r.status = "cancelled".into();
        Ok((r, ids))
    }

    /// Plans the executor should look at now: active and due, in flight, or expired (random order).
    pub async fn scenarios_due(&self, network: &str, limit: i64) -> Result<Vec<[u8; 16]>> {
        let c = self.pool.get().await?;
        Ok(c.query(
            "SELECT id FROM scenarios
             WHERE network = $1 AND status IN ('active', 'waiting_start')
               AND (expires_at <= now() OR (status = 'active' AND (phase = 'in_flight' OR next_at <= now())))
             ORDER BY random() LIMIT $2",
            &[&network, &limit],
        )
        .await?
        .into_iter()
        .map(|r| id16(r.get(0)))
        .collect())
    }

    /// `Portfolio.scenarios`: ≤ 5, active first, then closed ones not yet scrubbed.
    pub async fn owner_scenarios(&self, pk: &[u8; 32]) -> Result<Vec<ScenarioView>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT id, status, (extract(epoch FROM created_at) * 1000)::bigint,
                        (extract(epoch FROM expires_at) * 1000)::bigint, cursor, plan, state,
                        (floor(extract(epoch FROM next_at) / 60) * 60000)::bigint, error
                 FROM scenarios WHERE anon_pubkey = $1 AND plan IS NOT NULL
                 ORDER BY (status IN ('waiting_start', 'active')) DESC, created_at DESC, id LIMIT 5",
                &[&pk_s],
            )
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let id = id16(r.get(0));
            let sid: &[u8] = &id;
            let runs = c
                .query(
                    "SELECT seq, step, status, action_id, order_id, error FROM scenario_runs
                     WHERE scenario_id = $1 ORDER BY seq",
                    &[&sid],
                )
                .await?
                .into_iter()
                .map(|x| {
                    (
                        x.get(0),
                        x.get(1),
                        x.get(2),
                        x.get::<_, Option<Vec<u8>>>(3).map(id16),
                        x.get::<_, Option<Vec<u8>>>(4).map(id16),
                        x.get(5),
                    )
                })
                .collect();
            out.push(ScenarioView {
                id,
                status: r.get(1),
                created_at_ms: r.get(2),
                expires_at_ms: r.get(3),
                cursor: r.get::<_, i16>(4).max(0) as usize,
                plan: r.get(5),
                state: r.get(6),
                next_at_ms: r.get(7),
                error: r.get(8),
                runs,
            });
        }
        Ok(out)
    }

    /// Mints with an indexer price tick among `mints` (P8 at create time).
    pub async fn priced_mints(&self, mints: &[String]) -> Result<Vec<String>> {
        let c = self.pool.get().await?;
        Ok(c.query("SELECT mint FROM intel_prices WHERE mint = ANY($1)", &[&mints])
            .await?
            .into_iter()
            .map(|r| r.get(0))
            .collect())
    }

    /// D1 for scenarios: closed + 24 h → plan/state/error and step links erased; + 48 h → deleted.
    /// Returns (scrubbed, deleted).
    pub async fn scenarios_janitor(&self) -> Result<(u64, u64)> {
        let c = self.pool.get().await?;
        let scrubbed = c
            .execute(
                "UPDATE scenarios SET plan = NULL, state = '{}', error = NULL, next_at = NULL, armed_at = NULL,
                        last_tick = NULL, armed_tick = NULL
                 WHERE closed_at IS NOT NULL AND closed_at < now() - interval '24 hours' AND plan IS NOT NULL",
                &[],
            )
            .await?;
        c.execute(
            "UPDATE scenario_runs r SET action_id = NULL, order_id = NULL, error = NULL
             FROM scenarios s WHERE s.id = r.scenario_id AND s.plan IS NULL
               AND (r.action_id IS NOT NULL OR r.order_id IS NOT NULL OR r.error IS NOT NULL)",
            &[],
        )
        .await?;
        c.execute(
            "DELETE FROM scenario_sealed x USING scenarios s
             WHERE s.id = x.scenario_id AND s.status NOT IN ('waiting_start', 'active')",
            &[],
        )
        .await?;
        let deleted = c
            .execute(
                "DELETE FROM scenarios WHERE closed_at IS NOT NULL AND closed_at < now() - interval '48 hours'",
                &[],
            )
            .await?;
        Ok((scrubbed, deleted))
    }
}

// ------------------------------------------------------------------ executor primitives
// The API's executor opens one transaction per plan (`Ledger::pg()`), locks the row and drives
// it with these functions; one plan never blocks another (SKIP LOCKED).

/// Lock a plan for one executor pass (`None`: gone or held by another pass).
pub async fn lock<C: GenericClient>(tx: &C, id: &[u8; 16]) -> Result<Option<ScenarioRow>> {
    let sid: &[u8] = id;
    Ok(tx
        .query_opt(
            &format!("SELECT {ROW_COLS} FROM scenarios WHERE id = $1 FOR UPDATE SKIP LOCKED"),
            &[&sid],
        )
        .await?
        .map(|r| row_of(&r)))
}

/// Persist the executor's view of a plan (cursor, phase, counters, state, next run time in
/// seconds from now; `None` = no timer).
pub async fn save<C: GenericClient>(tx: &C, row: &ScenarioRow, next_in_secs: Option<f64>) -> Result<()> {
    let sid: &[u8] = &row.id;
    tx.execute(
        "UPDATE scenarios SET cursor = $2, phase = $3, runs = $4, attempt = $5, state = $6,
                next_at = CASE WHEN $7::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $7::float8) END
         WHERE id = $1",
        &[
            &sid,
            &(row.cursor as i16),
            &row.phase,
            &(row.runs.min(40) as i16),
            &(row.attempt.min(3) as i16),
            &row.state,
            &next_in_secs,
        ],
    )
    .await?;
    Ok(())
}

/// Submit one step's action inside the plan's transaction behind a savepoint: a refusal
/// (`insufficient_balance`, …) rolls back only the step, never the plan's own update (spec
/// §3.3 p. 5 — `submit_in` may have written the `actions` row before refusing).
pub async fn submit_step<C: GenericClient>(
    ledger: &Ledger,
    tx: &C,
    pk: &[u8; 32],
    a: &NewAction,
) -> Result<ActionReceipt> {
    let nonce: [u8; 16] = rand::random();
    let hash: [u8; 32] = rand::random();
    tx.batch_execute("SAVEPOINT scenario_step").await?;
    match ledger.submit_in(tx, pk, &nonce, &hash, a).await {
        Ok(r) => {
            tx.batch_execute("RELEASE SAVEPOINT scenario_step").await?;
            Ok(r)
        }
        Err(e) => {
            tx.batch_execute("ROLLBACK TO SAVEPOINT scenario_step").await?;
            Err(e)
        }
    }
}

/// Record a run of a step (`seq` = next free number of the plan).
pub async fn insert_run<C: GenericClient>(
    tx: &C,
    id: &[u8; 16],
    step: usize,
    attempt: u32,
    status: &str,
    action_id: Option<&[u8; 16]>,
    error: Option<&str>,
) -> Result<()> {
    let sid: &[u8] = id;
    let aid: Option<&[u8]> = action_id.map(|a| &a[..]);
    tx.execute(
        "INSERT INTO scenario_runs (scenario_id, seq, step, attempt, status, action_id, error)
         VALUES ($1, (SELECT COALESCE(max(seq) + 1, 0) FROM scenario_runs WHERE scenario_id = $1),
                 $2, $3, $4, $5, $6)",
        &[&sid, &(step as i16), &(attempt as i16), &status, &aid, &error],
    )
    .await?;
    Ok(())
}

/// The queued run of the plan's current step: (seq, action_id).
pub async fn queued_run<C: GenericClient>(tx: &C, id: &[u8; 16]) -> Result<Option<(i16, [u8; 16])>> {
    let sid: &[u8] = id;
    Ok(tx
        .query_opt(
            "SELECT seq, action_id FROM scenario_runs WHERE scenario_id = $1 AND status = 'queued'
               AND action_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
            &[&sid],
        )
        .await?
        .map(|r| (r.get(0), id16(r.get(1)))))
}

pub async fn finish_run<C: GenericClient>(
    tx: &C,
    id: &[u8; 16],
    seq: i16,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let sid: &[u8] = id;
    tx.execute(
        "UPDATE scenario_runs SET status = $3, error = $4 WHERE scenario_id = $1 AND seq = $2",
        &[&sid, &seq, &status, &error],
    )
    .await?;
    Ok(())
}

/// Status, error and fill of the action a step created.
pub async fn action_outcome<C: GenericClient>(
    tx: &C,
    action_id: &[u8; 16],
) -> Result<Option<(String, Option<String>, Option<Value>)>> {
    let aid: &[u8] = action_id;
    Ok(tx
        .query_opt("SELECT status, error, fill FROM actions WHERE id = $1", &[&aid])
        .await?
        .map(|r| (r.get(0), r.get(1), r.get(2))))
}

/// Balance facts for `AmountSpec {of: "balance"}`: (available zat, frozen).
pub async fn zec_available<C: GenericClient>(tx: &C, pk: &[u8; 32]) -> Result<(u64, bool)> {
    let pk_s: &[u8] = pk;
    Ok(tx
        .query_opt(
            "SELECT available_zat, frozen FROM balances WHERE anon_pubkey = $1",
            &[&pk_s],
        )
        .await?
        .map_or((0, false), |r| {
            (u64::try_from(r.get::<_, i64>(0)).unwrap_or(0), r.get(1))
        }))
}

pub async fn token_available<C: GenericClient>(tx: &C, pk: &[u8; 32], mint: &str) -> Result<u128> {
    let pk_s: &[u8] = pk;
    Ok(tx
        .query_opt(
            "SELECT available FROM token_balances WHERE anon_pubkey = $1 AND mint = $2",
            &[&pk_s, &mint],
        )
        .await?
        .map_or(0, |r| r.get::<_, crate::num::Num>(0).u128_or_zero()))
}

/// Sealed blob of a step (S6 blocks), deleted by the caller once used.
pub async fn take_sealed<C: GenericClient>(tx: &C, id: &[u8; 16], step: usize) -> Result<Option<Vec<u8>>> {
    let sid: &[u8] = id;
    Ok(tx
        .query_opt(
            "DELETE FROM scenario_sealed WHERE scenario_id = $1 AND step = $2 RETURNING blob",
            &[&sid, &(step as i16)],
        )
        .await?
        .map(|r| r.get(0)))
}

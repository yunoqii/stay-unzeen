//! Fair launch in the ledger (API.md v0.6, spec docs/analysis/fair-launch.md §2–§4).
//! Internal until 28.10 23:59 UTC.
//!
//! Lifecycle: `fl_create` (fee hold) → open (bids: hold = tier) → close (commitment root +
//! `attest` job) → reveal (verified beacon → decrypt → validate → allocate → `fair_create`
//! job) → settle (tokens pro rata, charges, creator lock) | fail / cancel (everything released).
//!
//! Every user op is an `actions` row (nonce + idempotency, kind `fl_*`) plus fair rows, in ONE
//! transaction. Times are compared with `clock_timestamp()` inside the transaction that holds
//! the launch row lock, so a bid is either in the committed set or refused (`launch_closed`).
//!
//! Privacy: nothing here logs. Ciphertexts are erased at reveal/cancel and never returned.

use deadpool_postgres::GenericClient;
use serde_json::{Value, json};
use unzeen_fair::{alloc, bid, drand::VerifiedBeacon, merkle};

use crate::{
    ActionReceipt, Ledger, LedgerError, Result,
    actions::{NewAction, credit_tokens, mark_settled, minute_now_ms},
    journal,
    num::Num,
    to_i64, to_u64,
};

/// NUMERIC(78,0) → u128 (fair-launch math is u128 since API v0.20; negative → range error).
fn num_u128(v: Option<Num>) -> Result<u128> {
    v.unwrap_or_default().to_u128()
}

const MS: &str = "(extract(epoch FROM {}) * 1000)::bigint";

fn ms(col: &str) -> String {
    MS.replace("{}", col)
}

#[derive(Clone, Debug, PartialEq)]
pub struct NewFairLaunch {
    pub id: [u8; 16],
    pub network: String,
    pub venue: String,
    /// `{"name","symbol","image"?}` (validated by the API).
    pub meta: Value,
    pub window_secs: u32,
    pub published_at_ms: u64,
    pub close_at_ms: u64,
    pub round: u64,
    pub round_time_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FairReceipt {
    pub receipt: ActionReceipt,
    /// `fl_create`: the new launch id (also on replay).
    pub launch_id: Option<[u8; 16]>,
}

/// Facts the API needs before accepting a bid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidTarget {
    pub round: u64,
    pub is_creator: bool,
}

/// Public view of a launch (`FairLaunch`).
#[derive(Clone, Debug, PartialEq)]
pub struct LaunchRow {
    pub id: [u8; 16],
    pub venue: String,
    pub name: String,
    pub symbol: String,
    pub status: String,
    pub published_at_ms: u64,
    pub close_at_ms: u64,
    pub round: u64,
    pub round_time_ms: u64,
    pub beacon_sig: Option<Vec<u8>>,
    pub root: Option<Vec<u8>>,
    pub attestation: Option<Value>,
    /// Stored result (`bids` as a number; the API applies `minBidsForCount`).
    pub result: Option<Value>,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OwnerBid {
    pub launch_id: [u8; 16],
    pub hold_zat: u64,
    pub status: String,
    pub amount_zat: Option<u64>,
    pub tokens: Option<u128>,
    pub charge_zat: Option<u64>,
    pub released_zat: Option<u64>,
    pub leaf: Option<Vec<u8>>,
    pub proof: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerLaunch {
    pub launch_id: [u8; 16],
    /// `scheduled` before publication, else the launch status.
    pub status: String,
    pub published_at_ms: u64,
    pub close_at_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurveRow {
    pub virtual_sol: u128,
    pub virtual_tokens: u128,
    pub real_tokens: u128,
    pub total_supply: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevealTask {
    pub id: [u8; 16],
    pub round: u64,
    pub round_time_ms: u64,
}

/// Max sealed bids of one launch (review F6/F7: also the fixed commitment tree size).
pub const MAX_BIDS: i64 = 1024;

/// Inputs fixed at reveal time (computed by the API from the network curve and the rate).
/// `Debug` is hand-written: the mint secret must never reach a log (review F10).
#[derive(Clone, PartialEq)]
pub struct RevealParams {
    /// Lamports per ZEC, buy side (after spread), one for everybody.
    pub rate: u64,
    pub max_total_lamports: u128,
    pub creator_max_lamports: u128,
    /// Fresh-curve reserves for `min_out`.
    pub curve: CurveRow,
    /// Upper bound of venue fees for `min_out` (bps), plus `slippage_bps`.
    pub fee_bound_bps: u64,
    pub slippage_bps: u64,
    /// D10 shave, uniform in [0, 1).
    pub shave: f64,
    /// Mint keypair (seed 32 ‖ pubkey 32), the same on every relayer attempt.
    pub mint_secret: [u8; 64],
}

impl std::fmt::Debug for RevealParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RevealParams")
            .field("rate", &self.rate)
            .field("max_total_lamports", &self.max_total_lamports)
            .field("creator_max_lamports", &self.creator_max_lamports)
            .field("mint_secret", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RevealOutcome {
    /// `fair_create` job queued.
    Executing {
        valid: usize,
        invalid: usize,
        lamports_in: u128,
    },
    /// No valid bids / below 0.001 SOL: failed (no_bids), everything released.
    NoBids { invalid: usize },
    /// The launch is not in `revealing` any more (another worker, cancelled).
    Skipped,
    /// The bid set does not match the committed root: failed (`internal`), all released.
    Mismatch,
}

/// A sealed bid as read for reveal.
#[derive(Clone, Debug, PartialEq)]
pub struct SealedBid {
    pub id: i64,
    pub anon_pubkey: [u8; 32],
    pub hold_zat: u64,
    pub ciphertext: Option<String>,
    pub leaf: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RevealInputs {
    pub launch_id: [u8; 16],
    pub round: u64,
    pub chain: [u8; 2],
    pub min_action_zat: u64,
    pub creator: Option<[u8; 32]>,
    pub bids: Vec<SealedBid>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub bid_id: i64,
    /// `Some(amount)` valid, `None` invalid.
    pub amount: Option<u64>,
    pub is_creator: bool,
}

/// Result of [`judge_bids`]. Carries no ciphertext or plaintext.
#[derive(Clone, Debug, PartialEq)]
pub struct Judged {
    pub launch_id: [u8; 16],
    pub decisions: Vec<Decision>,
    /// A ciphertext no longer hashes to the leaf committed at close (review F13).
    pub mismatch: bool,
}

/// CPU part of reveal (run it in a blocking thread): commitment check, then decryption and
/// validation of every bid with a VERIFIED beacon. No I/O.
pub fn judge_bids(inp: &RevealInputs, beacon: &VerifiedBeacon) -> Judged {
    // F13: the set must be exactly the committed one — check every leaf before decrypting.
    let mismatch = inp.bids.iter().any(|b| match (&b.ciphertext, &b.leaf) {
        (Some(ct), Some(leaf)) => merkle::leaf(ct)[..] != leaf[..],
        _ => true,
    });
    if mismatch {
        return Judged {
            launch_id: inp.launch_id,
            decisions: inp
                .bids
                .iter()
                .map(|b| Decision {
                    bid_id: b.id,
                    amount: None,
                    is_creator: false,
                })
                .collect(),
            mismatch: true,
        };
    }
    let decisions = inp
        .bids
        .iter()
        .map(|b| {
            let amount = b
                .ciphertext
                .as_deref()
                .and_then(|ct| unzeen_fair::drand::decrypt(ct, beacon).ok())
                .and_then(|pt| {
                    bid::validate(
                        &pt,
                        inp.chain,
                        &inp.launch_id,
                        &b.anon_pubkey,
                        inp.min_action_zat,
                        b.hold_zat,
                    )
                    .ok()
                });
            Decision {
                bid_id: b.id,
                amount,
                is_creator: inp.creator == Some(b.anon_pubkey),
            }
        })
        .collect();
    Judged {
        launch_id: inp.launch_id,
        decisions,
        mismatch: false,
    }
}

/// Total tries of one leg's consolidation (first job + re-queues).
pub const CONSOLIDATE_MAX_TRIES: u64 = 6;

/// Distinct leg vaults of `bundle_legs` (`[{"sig","vault"}]`) other than vault A.
pub fn leg_vaults(bundle_legs: Option<&Value>, vault_a: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in bundle_legs.and_then(Value::as_array).into_iter().flatten() {
        if let Some(v) = l.get("vault").and_then(Value::as_str)
            && v != vault_a
            && !v.is_empty()
            && !out.iter().any(|x| x == v)
        {
            out.push(v.to_string());
        }
    }
    out
}

/// Internal job: move all `mint` tokens from leg vault `from` to vault A (`dest`).
async fn insert_consolidate<C: GenericClient>(
    tx: &C,
    network: &str,
    mint: &str,
    from: &str,
    dest: &str,
    try_no: u64,
    delay_secs: f64,
) -> Result<i64> {
    Ok(tx
        .query_one(
            "INSERT INTO relayer_jobs (op, mint, dest, meta, network, exec_mode, not_before)
             VALUES ('consolidate', $1, $2, $3, $4, 'delayed', now() + make_interval(secs => $5)) RETURNING id",
            &[
                &mint,
                &dest,
                &json!({ "from": from, "try": try_no }),
                &network,
                &delay_secs,
            ],
        )
        .await?
        .get(0))
}

fn id16(v: Vec<u8>) -> [u8; 16] {
    v.try_into().unwrap_or([0; 16])
}

fn is_unique_violation(e: &tokio_postgres::Error) -> bool {
    e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION)
}

/// Replay check under a transaction-scoped advisory lock on `(pk, nonce)` (review F15): two
/// identical requests in flight are serialized, so the second sees the first as a replay and
/// gets the original receipt instead of a conflict.
pub(crate) async fn is_replay<C: GenericClient>(tx: &C, pk: &[u8], nonce: &[u8]) -> Result<bool> {
    let key = format!("{}{}", hex::encode(pk), hex::encode(nonce));
    tx.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", &[&key])
        .await?;
    Ok(tx
        .query_opt(
            "SELECT 1 FROM actions WHERE anon_pubkey = $1 AND nonce = $2",
            &[&pk, &nonce],
        )
        .await?
        .is_some())
}

fn action(kind: &str, fee_zat: u64) -> NewAction {
    NewAction {
        kind: kind.into(),
        fee_zat,
        ..NewAction::default()
    }
}

/// Return a whole ZEC hold of an action to `available` and close the action as failed.
async fn release_action<C: GenericClient>(tx: &C, action_id: &[u8], error: &str) -> Result<i64> {
    let Some(r) = tx
        .query_opt(
            "SELECT anon_pubkey, hold_zat, status FROM actions WHERE id = $1 FOR UPDATE",
            &[&action_id],
        )
        .await?
    else {
        return Ok(0);
    };
    let (pk, hold, status): (Vec<u8>, i64, String) = (r.get(0), r.get(1), r.get(2));
    if status != "queued" {
        return Ok(0);
    }
    if hold > 0 {
        tx.execute(
            "UPDATE balances SET held_zat = held_zat - $2, available_zat = available_zat + $2, updated_at = now()
             WHERE anon_pubkey = $1",
            &[&pk, &hold],
        )
        .await?;
        journal(tx, &pk, "release", hold, -hold, None, Some(action_id)).await?;
    }
    tx.execute(
        "UPDATE actions SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
        &[&action_id, &error],
    )
    .await?;
    Ok(hold)
}

/// Spend `charge` of an action's hold, return the rest, close it as executed.
async fn settle_action<C: GenericClient>(tx: &C, action_id: &[u8], charge: i64, fill: Value) -> Result<()> {
    let Some(r) = tx
        .query_opt(
            "SELECT anon_pubkey, hold_zat, status FROM actions WHERE id = $1 FOR UPDATE",
            &[&action_id],
        )
        .await?
    else {
        return Ok(());
    };
    let (pk, hold, status): (Vec<u8>, i64, String) = (r.get(0), r.get(1), r.get(2));
    if status != "queued" {
        return Ok(());
    }
    let charge = charge.clamp(0, hold);
    let back = hold - charge;
    tx.execute(
        "UPDATE balances SET held_zat = held_zat - $2, available_zat = available_zat + $3, updated_at = now()
         WHERE anon_pubkey = $1",
        &[&pk, &hold, &back],
    )
    .await?;
    if charge > 0 {
        journal(tx, &pk, "settle", 0, -charge, None, Some(action_id)).await?;
    }
    if back > 0 {
        journal(tx, &pk, "refund", back, -back, None, Some(action_id)).await?;
    }
    tx.execute(
        "UPDATE actions SET status = 'executed', fill = $2, updated_at = now() WHERE id = $1",
        &[&action_id, &fill],
    )
    .await?;
    Ok(())
}

/// Release every open bid and the creator fee; final launch status + failure.
async fn finish_unsuccessful<C: GenericClient>(
    tx: &C,
    launch_id: &[u8],
    status: &str,
    failure: Option<&str>,
    bid_status: &str,
) -> Result<()> {
    let bids = tx
        .query(
            "SELECT id, action_id, hold_zat FROM fl_bids
             WHERE launch_id = $1 AND status IN ('sealed', 'revealed') FOR UPDATE",
            &[&launch_id],
        )
        .await?;
    let err = failure.unwrap_or("cancelled");
    for b in &bids {
        let (bid_id, aid, hold): (i64, Option<Vec<u8>>, i64) = (b.get(0), b.get(1), b.get(2));
        if let Some(aid) = aid {
            release_action(tx, &aid, err).await?;
        }
        tx.execute(
            "UPDATE fl_bids SET status = $2, ciphertext = NULL, released_zat = $3 WHERE id = $1",
            &[&bid_id, &bid_status, &hold],
        )
        .await?;
    }
    if let Some(aid) = tx
        .query_one("SELECT create_action_id FROM fl_launches WHERE id = $1", &[&launch_id])
        .await?
        .get::<_, Option<Vec<u8>>>(0)
    {
        release_action(tx, &aid, err).await?;
    }
    tx.execute(
        "UPDATE fl_launches SET status = $2, failure = $3, finished_at = date_trunc('hour', now()),
                meta = meta - 'image', next_try_at = NULL
         WHERE id = $1",
        &[&launch_id, &status, &failure],
    )
    .await?;
    Ok(())
}

/// `S/T` in UI units (SOL per whole token), trimmed decimal string.
pub fn price_sol(lamports: u128, tokens: u128, decimals: u32) -> String {
    if tokens == 0 {
        return "0".into();
    }
    // lamports · 10^dec · 1e18 / (tokens · 1e9), 18 fractional digits (256-bit intermediate).
    let scale = 10u128.pow(decimals.min(18)) * 1_000_000_000;
    let v = alloc::mul_div(lamports, scale, tokens).unwrap_or(u128::MAX);
    let (int, frac) = (v / 10u128.pow(18), v % 10u128.pow(18));
    let frac = format!("{frac:018}");
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        int.to_string()
    } else {
        format!("{int}.{frac}")
    }
}

impl Ledger {
    /// Curve parameters of the network written by the relayer (`launch_curves`), if any.
    pub async fn launch_curve(&self, network: &str, venue: &str) -> Result<Option<CurveRow>> {
        let c = self.pool.get().await?;
        let r = c
            .query_opt(
                "SELECT virtual_sol_lamports, virtual_token_reserves, real_token_reserves, token_total_supply
                 FROM launch_curves WHERE network = $1 AND venue = $2",
                &[&network, &venue],
            )
            .await?;
        Ok(r.and_then(|r| {
            Some(CurveRow {
                virtual_sol: num_u128(r.get(0)).ok()?,
                virtual_tokens: num_u128(r.get(1)).ok()?,
                real_tokens: num_u128(r.get(2)).ok()?,
                total_supply: num_u128(r.get(3)).ok()?,
            })
        }))
    }

    /// `fl_create`: hold the creation fee and schedule the launch (hidden until published_at).
    pub async fn fl_create(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        fee_zat: u64,
        l: &NewFairLaunch,
    ) -> Result<FairReceipt> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let receipt = self
            .submit_in(&tx, pk, nonce, request_hash, &action("fl_create", fee_zat))
            .await?;
        let aid: &[u8] = &receipt.id;
        if receipt.replayed {
            let launch_id = tx
                .query_opt("SELECT id FROM fl_launches WHERE create_action_id = $1", &[&aid])
                .await?
                .map(|r| id16(r.get(0)));
            return Ok(FairReceipt { receipt, launch_id });
        }
        let (id, pk_s): (&[u8], &[u8]) = (&l.id, pk);
        tx.execute(
            "INSERT INTO fl_launches (id, network, creator_pubkey, create_action_id, venue, meta, window_secs,
                                      published_at, close_at, round, round_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::float8 / 1000), to_timestamp($9::float8 / 1000),
                     $10, to_timestamp($11::float8 / 1000))",
            &[
                &id,
                &l.network,
                &pk_s,
                &aid,
                &l.venue,
                &l.meta,
                &(l.window_secs as i32),
                &(to_i64(l.published_at_ms)? as f64),
                &(to_i64(l.close_at_ms)? as f64),
                &to_i64(l.round)?,
                &(to_i64(l.round_time_ms)? as f64),
            ],
        )
        .await?;
        tx.commit().await?;
        Ok(FairReceipt {
            receipt,
            launch_id: Some(l.id),
        })
    }

    /// A launch of this network created but not yet published (`fl_create` waits for the next
    /// Delayed epoch boundary) and still open. Only the creator knows its random id.
    pub async fn fl_is_scheduled(&self, network: &str, id: &[u8; 16]) -> Result<bool> {
        let id_s: &[u8] = id;
        let c = self.pool.get().await?;
        Ok(c.query_opt(
            "SELECT 1 FROM fl_launches
             WHERE id = $1 AND network = $2 AND published_at > clock_timestamp() AND status = 'open'",
            &[&id_s, &network],
        )
        .await?
        .is_some())
    }

    /// Published launch of this network that a key may bid on; `None` = unknown/unpublished.
    pub async fn fl_bid_target(&self, network: &str, id: &[u8; 16], pk: &[u8; 32]) -> Result<Option<BidTarget>> {
        let (id_s, pk_s): (&[u8], &[u8]) = (id, pk);
        let c = self.pool.get().await?;
        let r = c
            .query_opt(
                "SELECT round, creator_pubkey = $3 FROM fl_launches
                 WHERE id = $1 AND network = $2 AND published_at <= clock_timestamp()",
                &[&id_s, &network, &pk_s],
            )
            .await?;
        Ok(r.map(|r| BidTarget {
            round: to_u64(r.get(0)),
            is_creator: r.get::<_, Option<bool>>(1).unwrap_or(false),
        }))
    }

    /// `fl_bid`: hold `hold_zat` and store the sealed ciphertext (checked by the API: quicknet,
    /// `round`). One sealed bid per (key, launch).
    #[allow(clippy::too_many_arguments)]
    pub async fn fl_bid(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        network: &str,
        launch_id: &[u8; 16],
        hold_zat: u64,
        ciphertext: &str,
        round: u64,
    ) -> Result<ActionReceipt> {
        let (pk_s, id_s, nonce_s): (&[u8], &[u8], &[u8]) = (pk, launch_id, nonce);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        if is_replay(&tx, pk_s, nonce_s).await? {
            return self
                .submit_in(&tx, pk, nonce, request_hash, &action("fl_bid", hold_zat))
                .await;
        }
        let Some(l) = tx
            .query_opt(
                "SELECT status, close_at > clock_timestamp(), round,
                        (SELECT count(*) FROM fl_bids b WHERE b.launch_id = fl_launches.id AND b.status = 'sealed')
                 FROM fl_launches
                 WHERE id = $1 AND network = $2 AND published_at <= clock_timestamp() FOR UPDATE",
                &[&id_s, &network],
            )
            .await?
        else {
            return Err(LedgerError::NotFound);
        };
        if l.get::<_, String>(0) != "open" || !l.get::<_, bool>(1) {
            return Err(LedgerError::LaunchClosed);
        }
        if to_u64(l.get(2)) != round {
            return Err(LedgerError::Range);
        }
        if l.get::<_, i64>(3) >= MAX_BIDS {
            return Err(LedgerError::LaunchFull);
        }
        let sealed = tx
            .query_opt(
                "SELECT 1 FROM fl_bids WHERE launch_id = $1 AND anon_pubkey = $2 AND status = 'sealed'",
                &[&id_s, &pk_s],
            )
            .await?
            .is_some();
        if sealed {
            return Err(LedgerError::AlreadyBid);
        }
        // The hold is the tier itself (amount, so minActionZat applies).
        let a = NewAction {
            amount_zat: hold_zat,
            ..action("fl_bid", 0)
        };
        let receipt = self.submit_in(&tx, pk, nonce, request_hash, &a).await?;
        if receipt.replayed {
            return Ok(receipt);
        }
        let aid: &[u8] = &receipt.id;
        match tx
            .execute(
                "INSERT INTO fl_bids (launch_id, anon_pubkey, action_id, hold_zat, ciphertext)
                 VALUES ($1, $2, $3, $4, $5)",
                &[&id_s, &pk_s, &aid, &to_i64(hold_zat)?, &ciphertext],
            )
            .await
        {
            Ok(_) => {}
            Err(e) if is_unique_violation(&e) => return Err(LedgerError::AlreadyBid),
            Err(e) => return Err(e.into()),
        }
        tx.commit().await?;
        Ok(receipt)
    }

    /// `fl_cancel`: withdraw the key's sealed bid before `closeAt` (hold released, ciphertext erased).
    pub async fn fl_cancel(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        network: &str,
        launch_id: &[u8; 16],
    ) -> Result<ActionReceipt> {
        let (pk_s, id_s, nonce_s): (&[u8], &[u8], &[u8]) = (pk, launch_id, nonce);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        if is_replay(&tx, pk_s, nonce_s).await? {
            return self
                .submit_in(&tx, pk, nonce, request_hash, &action("fl_cancel", 0))
                .await;
        }
        let Some(l) = tx
            .query_opt(
                "SELECT status, close_at > clock_timestamp() FROM fl_launches WHERE id = $1 AND network = $2 FOR SHARE",
                &[&id_s, &network],
            )
            .await?
        else {
            return Err(LedgerError::NotFound);
        };
        let Some(b) = tx
            .query_opt(
                "SELECT id, action_id, hold_zat FROM fl_bids
                 WHERE launch_id = $1 AND anon_pubkey = $2 AND status = 'sealed' FOR UPDATE",
                &[&id_s, &pk_s],
            )
            .await?
        else {
            return Err(LedgerError::NotFound);
        };
        if l.get::<_, String>(0) != "open" || !l.get::<_, bool>(1) {
            return Err(LedgerError::LaunchClosed);
        }
        let mut receipt = self
            .submit_in(&tx, pk, nonce, request_hash, &action("fl_cancel", 0))
            .await?;
        if receipt.replayed {
            return Ok(receipt);
        }
        let (bid_id, aid, hold): (i64, Option<Vec<u8>>, i64) = (b.get(0), b.get(1), b.get(2));
        if let Some(aid) = aid {
            release_action(&tx, &aid, "cancelled").await?;
        }
        tx.execute(
            "UPDATE fl_bids SET status = 'cancelled', ciphertext = NULL, released_zat = $2 WHERE id = $1",
            &[&bid_id, &hold],
        )
        .await?;
        let rid: &[u8] = &receipt.id;
        tx.execute(
            "UPDATE actions SET status = 'executed', updated_at = now() WHERE id = $1",
            &[&rid],
        )
        .await?;
        tx.commit().await?;
        receipt.status = "executed".into();
        Ok(receipt)
    }

    /// `fl_cancel_launch`: the creator cancels before `closeAt`; everything is released.
    pub async fn fl_cancel_launch(
        &self,
        pk: &[u8; 32],
        nonce: &[u8; 16],
        request_hash: &[u8; 32],
        network: &str,
        launch_id: &[u8; 16],
    ) -> Result<ActionReceipt> {
        let (pk_s, id_s, nonce_s): (&[u8], &[u8], &[u8]) = (pk, launch_id, nonce);
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        if is_replay(&tx, pk_s, nonce_s).await? {
            return self
                .submit_in(&tx, pk, nonce, request_hash, &action("fl_cancel_launch", 0))
                .await;
        }
        // Not the creator → 404, like an unknown launch (do not reveal who created it).
        let Some(l) = tx
            .query_opt(
                "SELECT status, close_at > clock_timestamp() FROM fl_launches
                 WHERE id = $1 AND network = $2 AND creator_pubkey = $3 FOR UPDATE",
                &[&id_s, &network, &pk_s],
            )
            .await?
        else {
            return Err(LedgerError::NotFound);
        };
        if l.get::<_, String>(0) != "open" || !l.get::<_, bool>(1) {
            return Err(LedgerError::LaunchClosed);
        }
        let mut receipt = self
            .submit_in(&tx, pk, nonce, request_hash, &action("fl_cancel_launch", 0))
            .await?;
        if receipt.replayed {
            return Ok(receipt);
        }
        finish_unsuccessful(&tx, id_s, "cancelled", None, "cancelled").await?;
        let rid: &[u8] = &receipt.id;
        tx.execute(
            "UPDATE actions SET status = 'executed', updated_at = now() WHERE id = $1",
            &[&rid],
        )
        .await?;
        tx.commit().await?;
        receipt.status = "executed".into();
        Ok(receipt)
    }

    /// Published launches of a network (newest first), or one launch by id.
    pub async fn fl_public(
        &self,
        network: &str,
        id: Option<&[u8; 16]>,
        status: Option<&str>,
        limit: i64,
    ) -> Result<Vec<LaunchRow>> {
        let id_s: Option<&[u8]> = id.map(|i| &i[..]);
        let c = self.pool.get().await?;
        let rows = c
            .query(
                &format!(
                    "SELECT id, venue, meta->>'name', meta->>'symbol', status, {}, {}, round, {},
                            beacon_sig, commitment_root, attestation, result, failure
                     FROM fl_launches
                     WHERE network = $1 AND published_at <= clock_timestamp()
                       AND ($2::bytea IS NULL OR id = $2) AND ($3::text IS NULL OR status = $3)
                     ORDER BY published_at DESC, id LIMIT $4",
                    ms("published_at"),
                    ms("close_at"),
                    ms("round_time")
                ),
                &[&network, &id_s, &status, &limit],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let status: String = r.get(4);
                LaunchRow {
                    id: id16(r.get(0)),
                    venue: r.get(1),
                    name: r.get::<_, Option<String>>(2).unwrap_or_default(),
                    symbol: r.get::<_, Option<String>>(3).unwrap_or_default(),
                    published_at_ms: to_u64(r.get(5)),
                    close_at_ms: to_u64(r.get(6)),
                    round: to_u64(r.get(7)),
                    round_time_ms: to_u64(r.get(8)),
                    // The verified signature is public only once the job exists.
                    beacon_sig: if matches!(status.as_str(), "executing" | "launched" | "failed") {
                        r.get(9)
                    } else {
                        None
                    },
                    root: r.get(10),
                    attestation: r.get(11),
                    result: r.get(12),
                    failure: r.get(13),
                    status,
                }
            })
            .collect())
    }

    /// Owner's last 20 bids (`Portfolio.fairBids`).
    pub async fn fl_owner_bids(&self, network: &str, pk: &[u8; 32]) -> Result<Vec<OwnerBid>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT b.launch_id, b.hold_zat, b.status, b.amount_zat, b.tokens, b.charge_zat, b.released_zat,
                        b.leaf, b.proof
                 FROM fl_bids b JOIN fl_launches l ON l.id = b.launch_id
                 WHERE b.anon_pubkey = $1 AND l.network = $2 ORDER BY b.id DESC LIMIT 20",
                &[&pk_s, &network],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let status: String = r.get(2);
                let opt = |i: usize| r.get::<_, Option<i64>>(i).map(to_u64);
                let tokens = r.get::<_, Option<Num>>(4).map(Num::u128_or_zero);
                OwnerBid {
                    launch_id: id16(r.get(0)),
                    hold_zat: to_u64(r.get(1)),
                    amount_zat: if matches!(status.as_str(), "revealed" | "settled" | "released") {
                        opt(3)
                    } else {
                        None
                    },
                    tokens,
                    charge_zat: opt(5),
                    released_zat: opt(6),
                    leaf: r.get(7),
                    proof: r.get(8),
                    status,
                }
            })
            .collect())
    }

    /// Launches created by this key (`Portfolio.fairLaunches`), last 20.
    pub async fn fl_owner_launches(&self, network: &str, pk: &[u8; 32]) -> Result<Vec<OwnerLaunch>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let rows = c
            .query(
                &format!(
                    "SELECT id, CASE WHEN published_at > clock_timestamp() AND status = 'open' THEN 'scheduled'
                                ELSE status END, {}, {}
                     FROM fl_launches WHERE creator_pubkey = $1 AND network = $2
                     ORDER BY published_at DESC LIMIT 20",
                    ms("published_at"),
                    ms("close_at")
                ),
                &[&pk_s, &network],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| OwnerLaunch {
                launch_id: id16(r.get(0)),
                status: r.get(1),
                published_at_ms: to_u64(r.get(2)),
                close_at_ms: to_u64(r.get(3)),
            })
            .collect())
    }

    /// Close every open launch past `close_at`: commitment root over the sealed bids, proofs,
    /// `attest` job (SPL Memo with the root hex). Returns how many were closed.
    pub async fn fl_close_due(&self, network: &str) -> Result<usize> {
        let mut n = 0;
        loop {
            let mut c = self.pool.get().await?;
            let tx = c.transaction().await?;
            let Some(l) = tx
                .query_opt(
                    "SELECT id FROM fl_launches
                     WHERE network = $1 AND status = 'open' AND close_at <= clock_timestamp()
                     ORDER BY close_at LIMIT 1 FOR UPDATE SKIP LOCKED",
                    &[&network],
                )
                .await?
            else {
                return Ok(n);
            };
            let id: Vec<u8> = l.get(0);
            let bids = tx
                .query(
                    "SELECT id, ciphertext FROM fl_bids WHERE launch_id = $1 AND status = 'sealed' FOR UPDATE",
                    &[&id],
                )
                .await?;
            let leaves: Vec<merkle::Hash> = bids
                .iter()
                .map(|b| merkle::leaf(b.get::<_, Option<&str>>(1).unwrap_or("")))
                .collect();
            let (root, proofs) = merkle::build(&leaves);
            for ((b, leaf), proof) in bids.iter().zip(&leaves).zip(&proofs) {
                let proof: Value = proof.iter().map(hex::encode).collect::<Vec<_>>().into();
                tx.execute(
                    "UPDATE fl_bids SET leaf = $2, proof = $3 WHERE id = $1",
                    &[&b.get::<_, i64>(0), &&leaf[..], &proof],
                )
                .await?;
            }
            // Neutral memo until the deadline: only the root hex, no prefix.
            let job: i64 = tx
                .query_one(
                    "INSERT INTO relayer_jobs (op, meta, network, exec_mode, not_before)
                     VALUES ('attest', $1, $2, 'now', now()) RETURNING id",
                    &[&json!({ "memo": hex::encode(root), "purpose": "fair" }), &network],
                )
                .await?
                .get(0);
            tx.execute(
                "UPDATE fl_launches SET status = 'closed', commitment_root = $2, attest_job_id = $3 WHERE id = $1",
                &[&id, &&root[..], &job],
            )
            .await?;
            tx.commit().await?;
            n += 1;
        }
    }

    /// Launches whose round time has come (status `closed` → `revealing`) and whose retry time
    /// is due.
    pub async fn fl_reveal_due(&self, network: &str) -> Result<Vec<RevealTask>> {
        let c = self.pool.get().await?;
        c.execute(
            "UPDATE fl_launches SET status = 'revealing'
             WHERE network = $1 AND status = 'closed' AND round_time <= clock_timestamp()",
            &[&network],
        )
        .await?;
        let rows = c
            .query(
                &format!(
                    "SELECT id, round, {} FROM fl_launches
                     WHERE network = $1 AND status = 'revealing'
                       AND (next_try_at IS NULL OR next_try_at <= clock_timestamp())
                     ORDER BY round_time LIMIT 16",
                    ms("round_time")
                ),
                &[&network],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| RevealTask {
                id: id16(r.get(0)),
                round: to_u64(r.get(1)),
                round_time_ms: to_u64(r.get(2)),
            })
            .collect())
    }

    /// Postpone the next reveal attempt.
    pub async fn fl_retry_later(&self, id: &[u8; 16], secs: f64) -> Result<()> {
        let id_s: &[u8] = id;
        let c = self.pool.get().await?;
        c.execute(
            "UPDATE fl_launches SET next_try_at = clock_timestamp() + make_interval(secs => $2)
             WHERE id = $1 AND status = 'revealing'",
            &[&id_s, &secs.max(0.0)],
        )
        .await?;
        Ok(())
    }

    /// Fail a launch that is still before execution (drand / rate unavailable): all released.
    pub async fn fl_fail(&self, id: &[u8; 16], failure: &str) -> Result<bool> {
        let id_s: &[u8] = id;
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let ok = tx
            .query_opt(
                "SELECT 1 FROM fl_launches WHERE id = $1 AND status IN ('closed', 'revealing') FOR UPDATE",
                &[&id_s],
            )
            .await?
            .is_some();
        if ok {
            finish_unsuccessful(&tx, id_s, "failed", Some(failure), "released").await?;
        }
        tx.commit().await?;
        Ok(ok)
    }

    /// Sealed bids of a launch in `revealing` (read only; review F6: decryption happens outside
    /// any transaction, in a blocking thread).
    pub async fn fl_reveal_inputs(&self, id: &[u8; 16]) -> Result<Option<RevealInputs>> {
        let id_s: &[u8] = id;
        let c = self.pool.get().await?;
        let Some(l) = c
            .query_opt(
                "SELECT round, creator_pubkey FROM fl_launches WHERE id = $1 AND status = 'revealing'",
                &[&id_s],
            )
            .await?
        else {
            return Ok(None);
        };
        let bids = c
            .query(
                "SELECT id, anon_pubkey, hold_zat, ciphertext, leaf FROM fl_bids
                 WHERE launch_id = $1 AND status = 'sealed' ORDER BY id",
                &[&id_s],
            )
            .await?
            .into_iter()
            .map(|b| SealedBid {
                id: b.get(0),
                anon_pubkey: b.get::<_, Vec<u8>>(1).try_into().unwrap_or([0; 32]),
                hold_zat: to_u64(b.get(2)),
                ciphertext: b.get(3),
                leaf: b.get(4),
            })
            .collect();
        Ok(Some(RevealInputs {
            launch_id: *id,
            round: to_u64(l.get(0)),
            chain: self.policy.chain.to_bytes(),
            min_action_zat: self.policy.min_action_zat,
            creator: l.get::<_, Option<Vec<u8>>>(1).and_then(|v| v.try_into().ok()),
            bids,
        }))
    }

    /// Reveal with judged bids (from [`judge_bids`] with a VERIFIED beacon): one transaction
    /// that re-checks the launch and the bid set, releases invalid bids, allocates and queues one
    /// `fair_create` job. A commitment mismatch (review F13) fails the launch without using
    /// any decryption.
    pub async fn fl_reveal(&self, j: &Judged, beacon: &VerifiedBeacon, p: &RevealParams) -> Result<RevealOutcome> {
        let id_s: &[u8] = &j.launch_id;
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let Some(l) = tx
            .query_opt(
                "SELECT round, network, venue, meta FROM fl_launches WHERE id = $1 AND status = 'revealing' FOR UPDATE",
                &[&id_s],
            )
            .await?
        else {
            return Ok(RevealOutcome::Skipped);
        };
        if to_u64(l.get(0)) != beacon.round() {
            return Err(LedgerError::Range);
        }
        let (network, venue, meta): (String, String, Value) = (l.get(1), l.get(2), l.get(3));
        let sig: &[u8] = beacon.signature();
        let mut sealed: Vec<i64> = tx
            .query(
                "SELECT id FROM fl_bids WHERE launch_id = $1 AND status = 'sealed' FOR UPDATE",
                &[&id_s],
            )
            .await?
            .into_iter()
            .map(|r| r.get(0))
            .collect();
        sealed.sort_unstable();
        let mut judged_ids: Vec<i64> = j.decisions.iter().map(|d| d.bid_id).collect();
        judged_ids.sort_unstable();
        if sealed != judged_ids {
            // The set changed between the read and now (cannot happen after close): retry.
            return Ok(RevealOutcome::Skipped);
        }
        if j.mismatch {
            tx.execute("UPDATE fl_launches SET beacon_sig = $2 WHERE id = $1", &[&id_s, &sig])
                .await?;
            finish_unsuccessful(&tx, id_s, "failed", Some("internal"), "released").await?;
            tx.commit().await?;
            return Ok(RevealOutcome::Mismatch);
        }
        // Invalid bids: released at once.
        let mut invalid = 0usize;
        for d in j.decisions.iter().filter(|d| d.amount.is_none()) {
            invalid += 1;
            let r = tx
                .query_one("SELECT action_id, hold_zat FROM fl_bids WHERE id = $1", &[&d.bid_id])
                .await?;
            let (aid, hold): (Option<Vec<u8>>, i64) = (r.get(0), r.get(1));
            if let Some(aid) = aid {
                release_action(&tx, &aid, "invalid").await?;
            }
            tx.execute(
                "UPDATE fl_bids SET status = 'invalid', ciphertext = NULL, released_zat = $2 WHERE id = $1",
                &[&d.bid_id, &hold],
            )
            .await?;
        }
        let valid: Vec<&Decision> = j.decisions.iter().filter(|d| d.amount.is_some()).collect();
        let vb: Vec<alloc::ValidBid> = valid
            .iter()
            .map(|d| alloc::ValidBid {
                amount_zat: d.amount.unwrap_or(0),
                is_creator: d.is_creator,
            })
            .collect();
        let plan = alloc::plan(&vb, p.rate, p.max_total_lamports, p.creator_max_lamports);
        let lamports_in = alloc::fuzz_lamports(plan.total, p.shave);
        // Batch update of the revealed bids (review F6).
        let ids: Vec<i64> = valid.iter().map(|d| d.bid_id).collect();
        let amounts: Vec<i64> = valid
            .iter()
            .map(|d| to_i64(d.amount.unwrap_or(0)))
            .collect::<Result<_>>()?;
        let es: Vec<String> = plan.effective.iter().map(u128::to_string).collect();
        tx.execute(
            "UPDATE fl_bids b SET status = 'revealed', amount_zat = u.amount, e_lamports = u.e::numeric,
                    ciphertext = NULL
             FROM unnest($1::bigint[], $2::bigint[], $3::text[]) AS u(id, amount, e) WHERE b.id = u.id",
            &[&ids, &amounts, &es],
        )
        .await?;
        if valid.is_empty() || lamports_in < alloc::LAMPORTS_STEP {
            tx.execute("UPDATE fl_launches SET beacon_sig = $2 WHERE id = $1", &[&id_s, &sig])
                .await?;
            finish_unsuccessful(&tx, id_s, "failed", Some("no_bids"), "released").await?;
            tx.commit().await?;
            return Ok(RevealOutcome::NoBids { invalid });
        }
        // min_out: fresh-curve output of the buy net of a fee bound, minus slippage. The mint
        // is created by this very tx, so only a venue config change can trip it.
        let net = alloc::mul_div(lamports_in, 10_000 - p.fee_bound_bps.min(9_999) as u128, 10_000).unwrap_or(0);
        let quote = alloc::curve_tokens_out(p.curve.virtual_sol, p.curve.virtual_tokens, net);
        let min_out =
            crate::actions::quantize_min_out((quote as u128) * (10_000 - p.slippage_bps.min(10_000) as u128) / 10_000);
        let mint_secret: &[u8] = &p.mint_secret;
        let job: i64 = tx
            .query_one(
                "INSERT INTO relayer_jobs (op, venue, lamports_in, min_out, meta, network, exec_mode, not_before,
                                           mint_secret)
                 VALUES ('fair_create', $1, $2, $3, $4, $5, 'now', now(), $6) RETURNING id",
                &[
                    &venue,
                    &Num::from_u128(lamports_in)?,
                    &Num::from_u128(min_out)?,
                    &meta,
                    &network,
                    &mint_secret,
                ],
            )
            .await?
            .get(0);
        tx.execute(
            "UPDATE fl_launches SET status = 'executing', beacon_sig = $2, rate_lamports_per_zec = $3,
                    total_e = $4, lamports_in = $5, oversubscribed = $6, valid_bids = $7, job_id = $8,
                    next_try_at = NULL
             WHERE id = $1",
            &[
                &id_s,
                &sig,
                &to_i64(p.rate)?,
                &Num::from_u128(plan.total)?,
                &Num::from_u128(lamports_in)?,
                &plan.oversubscribed,
                &(valid.len() as i32),
                &job,
            ],
        )
        .await?;
        // Nothing of the bid set survives in clear: erase every ciphertext of the launch.
        tx.execute(
            "UPDATE fl_bids SET ciphertext = NULL WHERE launch_id = $1 AND ciphertext IS NOT NULL",
            &[&id_s],
        )
        .await?;
        tx.commit().await?;
        Ok(RevealOutcome::Executing {
            valid: valid.len(),
            invalid,
            lamports_in,
        })
    }

    /// Settle final `consolidate` jobs (fair-launch v2): confirmed → settled; failed → settled
    /// and re-queued after 10 min, at most [`CONSOLIDATE_MAX_TRIES`] tries in total. Returns
    /// (settled, given up) — a non-zero second value needs the operator (tokens stay on the
    /// leg vault; the position is still covered in Verify, only D4 is violated).
    pub async fn settle_consolidations(&self) -> Result<(usize, usize)> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let rows = tx
            .query(
                "SELECT id, status, network, mint, dest, meta FROM relayer_jobs
                 WHERE op = 'consolidate' AND status IN ('confirmed', 'failed') AND settled_at IS NULL
                 ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED",
                &[],
            )
            .await?;
        let (mut settled, mut gave_up) = (0, 0);
        let mut ids = Vec::new();
        for r in &rows {
            ids.push(r.get::<_, i64>(0));
            settled += 1;
            if r.get::<_, String>(1) == "failed" {
                let meta: Option<Value> = r.get(5);
                let from = meta.as_ref().and_then(|m| m.get("from")).and_then(Value::as_str);
                let tries = meta
                    .as_ref()
                    .and_then(|m| m.get("try"))
                    .and_then(Value::as_u64)
                    .unwrap_or(1);
                let (network, mint, dest): (String, Option<String>, Option<String>) = (r.get(2), r.get(3), r.get(4));
                match (from, mint, dest) {
                    (Some(from), Some(mint), Some(dest)) if tries < CONSOLIDATE_MAX_TRIES => {
                        insert_consolidate(&tx, &network, &mint, from, &dest, tries + 1, 600.0).await?;
                    }
                    _ => gave_up += 1,
                }
            }
        }
        if !ids.is_empty() {
            mark_settled(&tx, &ids).await?;
        }
        tx.commit().await?;
        Ok((settled, gave_up))
    }

    /// Settle final `fair_create` and `attest` jobs. Returns how many launches changed.
    pub async fn fl_settle_ready(&self) -> Result<usize> {
        let mut n = 0;
        // Attestations (independent of the launch outcome); shared with Verify.
        n += self.settle_attestations().await?;
        loop {
            let mut c = self.pool.get().await?;
            let tx = c.transaction().await?;
            let Some(r) = tx
                .query_opt(
                    "SELECT l.id, l.creator_pubkey, l.create_action_id, l.rate_lamports_per_zec, l.total_e,
                            l.oversubscribed, l.valid_bids,
                            j.id, j.status, j.out_mint, j.out_token_amount, j.out_lamports, j.signature, j.error_code,
                            j.venue, j.out_creator_fee, j.vault, j.bundle_legs, j.network
                     FROM fl_launches l JOIN relayer_jobs j ON j.id = l.job_id
                     WHERE l.status = 'executing' AND j.status IN ('confirmed', 'failed') AND j.settled_at IS NULL
                     LIMIT 1 FOR UPDATE OF l SKIP LOCKED",
                    &[],
                )
                .await?
            else {
                return Ok(n);
            };
            let lid: Vec<u8> = r.get(0);
            let jid: i64 = r.get(7);
            let ok = r.get::<_, String>(8) == "confirmed";
            if !ok {
                let failure = match r.get::<_, Option<String>>(13).as_deref() {
                    Some("venue_unavailable") => "venue_unavailable",
                    _ => "tx_failed",
                };
                finish_unsuccessful(&tx, &lid, "failed", Some(failure), "released").await?;
            } else {
                self.fl_settle_confirmed(&tx, &r).await?;
                // v2 (RELAYER v7): tokens bought by the other bundle legs move to vault A.
                let mint: Option<String> = r.get(9);
                let vault_a: Option<String> = r.get(16);
                let network: String = r.get(18);
                if let (Some(mint), Some(a)) = (mint, vault_a) {
                    for from in leg_vaults(r.get::<_, Option<Value>>(17).as_ref(), &a) {
                        insert_consolidate(&tx, &network, &mint, &from, &a, 1, 0.0).await?;
                    }
                }
            }
            tx.execute(
                "UPDATE relayer_jobs SET mint_secret = NULL, bundle_legs = NULL WHERE id = $1",
                &[&jid],
            )
            .await?;
            mark_settled(&tx, &[jid]).await?;
            tx.commit().await?;
            n += 1;
        }
    }

    async fn fl_settle_confirmed<C: GenericClient>(&self, tx: &C, r: &tokio_postgres::Row) -> Result<()> {
        let lid: Vec<u8> = r.get(0);
        let creator: Option<Vec<u8>> = r.get(1);
        let create_aid: Option<Vec<u8>> = r.get(2);
        let rate = to_u64(r.get::<_, Option<i64>>(3).unwrap_or(0));
        let total_e = num_u128(r.get(4))?;
        let oversubscribed = r.get::<_, Option<bool>>(5).unwrap_or(false);
        let valid_bids = r.get::<_, Option<i32>>(6).unwrap_or(0);
        let mint: String = r.get::<_, Option<String>>(9).unwrap_or_default();
        let t = num_u128(r.get(10))?;
        let s = num_u128(r.get(11))?;
        let sig: Option<String> = r.get(12);
        let decimals: i16 = tx
            .query_opt("SELECT decimals FROM tokens WHERE mint = $1", &[&mint])
            .await?
            .map_or(6, |r| r.get(0));
        let executed_at = minute_now_ms();
        let bids = tx
            .query(
                "SELECT id, anon_pubkey, action_id, amount_zat, e_lamports FROM fl_bids
                 WHERE launch_id = $1 AND status = 'revealed' FOR UPDATE",
                &[&lid],
            )
            .await?;
        let mut creator_tokens: i128 = 0;
        for b in &bids {
            let (bid_id, pk, aid): (i64, Vec<u8>, Option<Vec<u8>>) = (b.get(0), b.get(1), b.get(2));
            let amount = to_u64(b.get::<_, Option<i64>>(3).unwrap_or(0));
            let e = num_u128(b.get(4))?;
            let sh = alloc::share(e, total_e, t, s, rate, amount);
            let tokens = i128::try_from(sh.tokens).map_err(|_| LedgerError::Range)?;
            let charge = to_i64(sh.charge_zat)?;
            if let Some(aid) = &aid {
                if tokens > 0 {
                    credit_tokens(tx, &pk, &mint, tokens, aid).await?;
                }
                let fill = json!({
                    "tokenAmount": sh.tokens.to_string(),
                    "solAmount": sh.spent_lamports.to_string(),
                    "zecSpent": sh.charge_zat.to_string(),
                    "mint": mint,
                    "executedAt": executed_at,
                });
                settle_action(tx, aid, charge, fill).await?;
            } else if tokens > 0 {
                // Action row already gone (should not happen within 48 h): still credit.
                tx.execute(
                    "INSERT INTO token_balances (anon_pubkey, mint, available) VALUES ($1, $2, $3)
                     ON CONFLICT (anon_pubkey, mint) DO UPDATE
                       SET available = token_balances.available + EXCLUDED.available, updated_at = now()",
                    &[&pk, &mint, &Num(tokens)],
                )
                .await?;
            }
            let hold: i64 = tx
                .query_one("SELECT hold_zat FROM fl_bids WHERE id = $1", &[&bid_id])
                .await?
                .get(0);
            tx.execute(
                "UPDATE fl_bids SET status = 'settled', tokens = $2, charge_zat = $3, released_zat = $4 WHERE id = $1",
                &[&bid_id, &Num(tokens), &charge, &(hold - charge)],
            )
            .await?;
            if creator.as_deref() == Some(pk.as_slice()) {
                creator_tokens += tokens;
            }
        }
        // Creator rights: cap for later buys, lock on the creator's own allocation only.
        if let Some(cpk) = &creator {
            let (locked, lock_secs) = if self.rules.lock_secs > 0 && creator_tokens > 0 {
                (creator_tokens, self.rules.lock_secs as f64)
            } else {
                (0, 0.0)
            };
            // v0.9: the creator fee of the launch tx (all participants' money) is the pool's.
            let launch_fee = crate::creator_fees::launch_creator_fee(
                &self.rules,
                r.get::<_, Option<&str>>(14),
                i128::try_from(s).map_err(|_| LedgerError::Range)?,
                r.get::<_, Option<Num>>(15).map(|n| n.0),
            );
            tx.execute(
                "INSERT INTO creator_tokens (mint, anon_pubkey, locked_amount, locked_until,
                                             launch_fee_lamports, launch_fee_left)
                 VALUES ($1, $2, $3::numeric, CASE WHEN $3::numeric > 0
                     THEN date_trunc('hour', now() + make_interval(secs => $4::float8)) + interval '1 hour' END,
                     $5::numeric, $5::numeric)
                 ON CONFLICT (mint) DO NOTHING",
                &[&mint, cpk, &Num(locked), &lock_secs, &Num(launch_fee)],
            )
            .await?;
        }
        if let Some(aid) = &create_aid {
            let fee: i64 = tx
                .query_opt("SELECT hold_zat FROM actions WHERE id = $1", &[aid])
                .await?
                .map_or(0, |r| r.get(0));
            settle_action(
                tx,
                aid,
                fee,
                json!({ "mint": mint, "tokenAmount": "0", "zecSpent": fee.to_string(), "executedAt": executed_at }),
            )
            .await?;
        }
        let result = json!({
            "mint": mint,
            "solanaTx": sig,
            "totalLamports": s.to_string(),
            "tokenAmount": t.to_string(),
            "decimals": decimals,
            "priceSol": price_sol(s, t, decimals.max(0) as u32),
            "bids": valid_bids,
            "oversubscribed": oversubscribed,
        });
        tx.execute(
            "UPDATE fl_launches SET status = 'launched', result = $2, finished_at = date_trunc('hour', now()),
                    meta = meta - 'image'
             WHERE id = $1",
            &[&lid, &result],
        )
        .await?;
        Ok(())
    }

    /// D1 for fair launches: 48 h after a launch is final its bids are deleted and the creator
    /// link erased; cancelled bids are deleted 48 h after their (hour-coarse) creation.
    pub async fn fl_janitor(&self) -> Result<u64> {
        let c = self.pool.get().await?;
        let a = c
            .execute(
                "DELETE FROM fl_bids b USING fl_launches l
                 WHERE b.launch_id = l.id AND l.finished_at < now() - interval '48 hours'",
                &[],
            )
            .await?;
        let b = c
            .execute(
                "DELETE FROM fl_bids WHERE status = 'cancelled' AND created_at < now() - interval '48 hours'",
                &[],
            )
            .await?;
        let d = c
            .execute(
                "UPDATE fl_launches SET creator_pubkey = NULL, create_action_id = NULL
                 WHERE finished_at < now() - interval '48 hours' AND creator_pubkey IS NOT NULL",
                &[],
            )
            .await?;
        // F9: closed fl_* (and order_*) action rows go entirely after 48 h, so "this key took part
        // in a fair launch / placed an order on day D" does not stay forever. Replay protection
        // does not rely on these rows after 48 h: a signed request is only accepted within
        // |now − ts| ≤ 60 s (api_auth), and identical requests within that window are served by
        // the still-present row (or serialized by the (pk, nonce) advisory lock).
        let old = "SELECT id FROM actions WHERE (kind LIKE 'fl\\_%' OR kind LIKE 'order\\_%')
                     AND status <> 'queued' AND updated_at < now() - interval '48 hours'";
        c.execute(&format!("DELETE FROM ledger_ops WHERE action_id IN ({old})"), &[])
            .await?;
        c.execute(&format!("DELETE FROM token_ops WHERE action_id IN ({old})"), &[])
            .await?;
        let e = c
            .execute(&format!("DELETE FROM actions WHERE id IN ({old})"), &[])
            .await?;
        // F10: a final fair_create keeps no mint secret (settle erases it; this covers leftovers).
        let f = c
            .execute(
                "UPDATE relayer_jobs SET mint_secret = NULL
                 WHERE op = 'fair_create' AND mint_secret IS NOT NULL AND status IN ('confirmed', 'failed')
                   AND updated_at < now() - interval '2 hours'",
                &[],
            )
            .await?;
        Ok(a + b + d + e + f)
    }

    /// Mint of a fair launch (for the `fair_launch_sealed_bids` safety rule).
    pub async fn fl_is_fair_mint(&self, mint: &str) -> Result<bool> {
        let c = self.pool.get().await?;
        Ok(c.query_opt(
            "SELECT 1 FROM fl_launches WHERE status = 'launched' AND result->>'mint' = $1",
            &[&mint],
        )
        .await?
        .is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leg_vaults_skip_vault_a_and_duplicates() {
        let legs =
            json!([{"sig": "1", "vault": "B"}, {"sig": "2", "vault": "A"}, {"sig": "3", "vault": "B"}, {"sig": "4"}]);
        assert_eq!(leg_vaults(Some(&legs), "A"), vec!["B".to_string()]);
        assert!(leg_vaults(None, "A").is_empty());
        assert!(leg_vaults(Some(&json!({"vault": "B"})), "A").is_empty());
    }

    #[test]
    fn price_formatting() {
        // 1 SOL for 1e6 whole tokens (6 decimals) = 1e-6 SOL per token.
        assert_eq!(price_sol(1_000_000_000, 1_000_000_000_000, 6), "0.000001");
        assert_eq!(price_sol(3_000_000_000, 1_000_000, 6), "3");
        assert_eq!(price_sol(1, 3, 0), "0.000000000333333333");
        assert_eq!(price_sol(5, 0, 6), "0");
    }
}

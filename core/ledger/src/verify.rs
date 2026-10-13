//! Verify (API.md v0.7, spec docs/analysis/verify.md): daily snapshot of liabilities as
//! Merkle-sum trees, vault balances written by the relayer, operator signature and Solana
//! anchor via an `attest` job, owner proofs, 48 h retention of paths and key bindings.
//!
//! State machine of a snapshot (driven by the API every second):
//! `freezing` (relayer claims nothing; wait until no Solana job is in flight and every final
//! job is settled, ≤ quiesce_secs; ZEC payouts in flight do NOT block, E8) → `collecting`
//! (`min_slot` recorded, E2; relayer writes `verify_vaults` + slot at finalized ≥ min_slot;
//! the scanner samples the ZEC reserve after the freeze started, E7/E8) → `built` (one
//! REPEATABLE READ transaction: trees, digest, attest job; freeze lifted). Any timeout or a
//! build error → `skipped` (freeze lifted; the scheduler retries; E14).
//!
//! Review-day8 (API v0.10): mint granule 1 base unit (E1); no SOL tree — a creator's claimable
//! lamports are part of their ZEC leaf at the buy rate, rounded up (E5/E6); only withdrawal gas
//! is committed SOL (E9); the operator signature is published as soon as the relayer signed,
//! the anchor follows (E10).
//!
//! Privacy: nothing here logs. Leaves carry snapshotId + fresh blinds; balances are split
//! into 2–4 random pieces and shuffled among dummies; trees padded to ≥ 1024 leaves.

use deadpool_postgres::GenericClient;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Value, json};
use tokio_postgres::IsolationLevel;
use unzeen_protocol::verify::{self as pv, Node, SnapshotHeader};

use crate::{Ledger, LedgerError, Result, to_i64, to_u64};

/// Max assets in one proof response (ZEC + 11 random).
pub const MAX_PROOF_ASSETS: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VerifyTiming {
    /// Freeze length (relayer claims nothing), seconds. 120.
    pub freeze_secs: f64,
    /// Max wait for in-flight work before skipping, seconds. 90.
    pub quiesce_secs: f64,
}

impl Default for VerifyTiming {
    fn default() -> Self {
        Self {
            freeze_secs: 120.0,
            quiesce_secs: 90.0,
        }
    }
}

/// Rates (lamports per ZEC, after spread) for a snapshot: `sell` values pool SOL as ZEC cover,
/// `buy` converts creators' claimable lamports into ZEC liabilities.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VerifyRates {
    pub sell: Option<u64>,
    pub buy: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Idle,
    Waiting,
    Collecting(i32),
    Built(i32),
    Skipped(i32, &'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotRow {
    pub id: i32,
    pub chain_id: String,
    pub taken_at_ms: u64,
    pub roots_digest: Vec<u8>,
    pub anchor: Option<Value>,
    pub operator: Option<Value>,
    pub leaves: u32,
    pub solana_slot: u64,
    pub zcash_height: u32,
    pub zec_reserve_zat: u64,
    pub committed_lamports: u64,
    pub rate_sell: Option<u64>,
    pub rate_buy: Option<u64>,
    /// v0.13 `quoteAssets` (NULL for snapshots built before 0019).
    pub quote_assets: Option<Value>,
    /// (asset, decimals, granule, root, sum)
    pub trees: Vec<(String, i16, u64, Vec<u8>, String)>,
    /// (address, sig, lamports, tokens)
    pub vaults: Vec<(String, String, u64, Value)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProofPiece {
    pub piece: u8,
    pub leaf_idx: u32,
    pub value: u64,
    pub blind: Vec<u8>,
    pub path: Vec<(Vec<u8>, String)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AssetProof {
    pub asset: String,
    pub decimals: i16,
    pub pieces: Vec<ProofPiece>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OwnerProof {
    pub snapshot_id: i32,
    pub proofs: Vec<AssetProof>,
    pub truncated: bool,
}

fn rand_below(n: u64) -> u64 {
    if n == 0 { 0 } else { rand::random::<u64>() % n }
}

/// Split `rounded` (a multiple of `g`) into `s` pieces, multiples of `g`, summing to it.
pub fn split_pieces(rounded: u64, g: u64, s: usize) -> Vec<u64> {
    let units = rounded / g.max(1);
    let mut cuts: Vec<u64> = (0..s.saturating_sub(1)).map(|_| rand_below(units + 1)).collect();
    cuts.push(0);
    cuts.push(units);
    cuts.sort_unstable();
    cuts.windows(2).map(|w| (w[1] - w[0]) * g.max(1)).collect()
}

fn shuffle<T>(v: &mut [T]) {
    for i in (1..v.len()).rev() {
        let j = rand_below(i as u64 + 1) as usize;
        v.swap(i, j);
    }
}

fn asset_bytes(asset: &str) -> Option<[u8; 32]> {
    if asset == "ZEC" {
        return Some(pv::ZEC_ASSET);
    }
    bs58::decode(asset).into_vec().ok()?.try_into().ok()
}

/// (asset, decimals, granule, [(anon pubkey, value)])
type Liab = (String, i16, u64, Vec<([u8; 32], u64)>);

struct Piece {
    pk: [u8; 32],
    piece: u8,
    value: u64,
}

/// Numeric `pool_meta` value published by the scanner (0 if absent).
async fn meta_u64<C: GenericClient>(c: &C, key: &str) -> Result<u64> {
    Ok(c.query_opt("SELECT value FROM pool_meta WHERE key = $1", &[&key])
        .await?
        .and_then(|r| r.get::<_, String>(0).parse::<u64>().ok())
        .unwrap_or(0))
}

/// No Solana job in flight and every final job settled. ZEC payouts in flight do not block
/// (E8): their amounts are still held (liability) and are added to the reserve at build.
async fn quiescent<C: GenericClient>(c: &C, network: &str) -> Result<bool> {
    Ok(c.query_one(
        "SELECT NOT EXISTS (SELECT 1 FROM relayer_jobs WHERE network = $1 AND op <> 'attest'
                              AND (status IN ('held', 'claimed', 'sent')
                                   OR (status IN ('confirmed', 'failed') AND settled_at IS NULL)))",
        &[&network],
    )
    .await?
    .get(0))
}

/// Σ credited (non-reorged) deposits. The scanner samples it with the reserve; deposits
/// credited after that sample are real notes with ≥ K confirmations and join the reserve.
pub async fn credited_total<C: GenericClient>(c: &C) -> Result<u64> {
    Ok(to_u64(
        c.query_one(
            "SELECT COALESCE(sum(credited_zat), 0)::bigint FROM deposits WHERE status = 'credited' AND NOT reorged",
            &[],
        )
        .await?
        .get(0),
    ))
}

impl Ledger {
    /// Request a snapshot (daily scheduler or the devnet manual command). `None` if one is
    /// already in progress.
    pub async fn verify_request(
        &self,
        network: &str,
        chain_hex: &str,
        kind: &str,
        t: VerifyTiming,
    ) -> Result<Option<i32>> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        tx.execute("SELECT pg_advisory_xact_lock(7566726966790001)", &[])
            .await?;
        let busy = tx
            .query_opt(
                "SELECT 1 FROM verify_snapshots WHERE network = $1 AND status IN ('freezing', 'collecting')",
                &[&network],
            )
            .await?
            .is_some();
        if busy {
            return Ok(None);
        }
        let id: i32 = tx
            .query_one(
                "INSERT INTO verify_snapshots (network, chain_id, kind, freeze_until)
                 VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id",
                &[&network, &chain_hex, &kind, &t.freeze_secs],
            )
            .await?
            .get(0);
        tx.commit().await?;
        Ok(Some(id))
    }

    /// Daily snapshot due: it is past 00:00 UTC today, nothing built today, and the last
    /// attempt today (if skipped) is ≥ 10 min old; at most 12 attempts a day.
    pub async fn verify_daily_due(&self, network: &str) -> Result<bool> {
        let c = self.pool.get().await?;
        Ok(c.query_one(
            "WITH today AS (SELECT * FROM verify_snapshots
                             WHERE network = $1 AND kind = 'daily'
                               AND requested_at >= date_trunc('day', now(), 'UTC'))
             SELECT NOT EXISTS (SELECT 1 FROM today WHERE status <> 'skipped')
                AND (SELECT count(*) FROM today) < 12
                AND COALESCE((SELECT max(requested_at) FROM today) < now() - interval '10 minutes', TRUE)",
            &[&network],
        )
        .await?
        .get(0))
    }

    /// Any snapshot in `freezing`/`collecting`: the scanner sends no new ZEC payouts then.
    pub async fn verify_frozen(&self) -> Result<bool> {
        let c = self.pool.get().await?;
        Ok(c.query_opt(
            "SELECT 1 FROM verify_snapshots WHERE status IN ('freezing', 'collecting') LIMIT 1",
            &[],
        )
        .await?
        .is_some())
    }

    /// Scanner: attested reserve of the pool wallet, sampled at `at_ms` (before its payout step),
    /// with Σ credited deposits at that moment. One transaction (the build reads all four).
    pub async fn set_reserve(&self, zat: u64, height: u32, at_ms: u64) -> Result<()> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let credited = credited_total(&tx).await?;
        for (k, v) in [
            ("reserve_zat", zat.to_string()),
            ("reserve_height", height.to_string()),
            ("reserve_credited_zat", credited.to_string()),
            ("reserve_at", at_ms.to_string()),
        ] {
            tx.execute(
                "INSERT INTO pool_meta (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
                &[&k, &v],
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Advance the snapshot in progress.
    pub async fn verify_step(&self, network: &str, t: VerifyTiming, rates: VerifyRates) -> Result<Step> {
        let row = {
            let c = self.pool.get().await?;
            c.query_opt(
                "SELECT id, status, assets_done_at IS NOT NULL,
                        requested_at < now() - make_interval(secs => $2), freeze_until < now(),
                        (extract(epoch FROM requested_at) * 1000)::bigint
                 FROM verify_snapshots WHERE network = $1 AND status IN ('freezing', 'collecting')
                 ORDER BY id LIMIT 1",
                &[&network, &t.quiesce_secs],
            )
            .await?
        };
        let Some(r) = row else { return Ok(Step::Idle) };
        let (id, status, assets, quiesce_over, freeze_over): (i32, String, bool, bool, bool) =
            (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4));
        let requested_ms = to_u64(r.get(5));
        let c = self.pool.get().await?;
        let skip = |reason: &'static str| async move {
            c.execute(
                "UPDATE verify_snapshots SET status = 'skipped', skip_reason = $2, freeze_until = now()
                 WHERE id = $1 AND status IN ('freezing', 'collecting')",
                &[&id, &reason],
            )
            .await
            .map(|_| Step::Skipped(id, reason))
        };
        if status == "freezing" {
            let cc = self.pool.get().await?;
            if quiescent(&cc, network).await? {
                // E2: the highest slot of a trade the ledger already counted.
                cc.execute(
                    "UPDATE verify_snapshots SET status = 'collecting', taken_at = date_trunc('minute', now()),
                            min_slot = (SELECT max(slot) FROM relayer_jobs
                                        WHERE network = $2 AND op <> 'attest' AND status = 'confirmed'
                                          AND settled_at IS NOT NULL)
                     WHERE id = $1 AND status = 'freezing'",
                    &[&id, &network],
                )
                .await?;
                return Ok(Step::Collecting(id));
            }
            if quiesce_over || freeze_over {
                return Ok(skip("busy").await?);
            }
            return Ok(Step::Waiting);
        }
        // collecting: vault balances written, and a reserve sampled after the freeze started
        // (no payout can be sent after that sample until the freeze is lifted).
        let reserve_at = meta_u64(&self.pool.get().await?, "reserve_at").await?;
        if assets && reserve_at >= requested_ms {
            return Ok(match self.verify_build(id, network, rates).await {
                Ok(Ok(())) => Step::Built(id),
                Ok(Err(reason)) => skip(reason).await?,
                // E14: a build that cannot succeed must not retry forever under the freeze.
                Err(e) => {
                    tracing::warn!(error = e.kind(), "verify build failed");
                    skip("build_error").await?
                }
            });
        }
        if freeze_over {
            return Ok(skip(if assets { "reserve_stale" } else { "assets_timeout" }).await?);
        }
        Ok(Step::Waiting)
    }

    /// Build trees + digest + attest job in one REPEATABLE READ transaction; lift the freeze.
    /// `Ok(Err(reason))`: cannot build now (skip, retried later).
    async fn verify_build(
        &self,
        id: i32,
        network: &str,
        rates: VerifyRates,
    ) -> Result<std::result::Result<(), &'static str>> {
        let mut c = self.pool.get().await?;
        let tx = c
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .start()
            .await?;
        let s = tx
            .query_opt(
                "SELECT chain_id, extract(epoch FROM taken_at)::bigint, solana_slot FROM verify_snapshots
                 WHERE id = $1 AND status = 'collecting' FOR UPDATE",
                &[&id],
            )
            .await?
            .ok_or(LedgerError::NotFound)?;
        let chain_hex: String = s.get(0);
        let chain: [u8; 2] = hex::decode(&chain_hex)
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or(LedgerError::Range)?;
        let taken_at_sec = to_u64(s.get(1));
        let solana_slot = to_u64(s.get::<_, Option<i64>>(2).unwrap_or(0));

        // Liabilities: (asset, decimals, granule) -> [(pk, value)]. ZEC: one value per key =
        // balance + held + creator fees owed (claimable lamports of all its mints, summed per
        // key, at the buy rate, rounded up; v0.14: + zat owed for ZEC-pair fees, 1:1). One entry
        // per key → piece numbers unique (E6).
        let zec_rows = tx
            .query(
                "SELECT anon_pubkey, sum(z)::bigint, sum(l)::bigint FROM (
                     SELECT anon_pubkey, available_zat + held_zat AS z, 0::bigint AS l FROM balances
                     UNION ALL
                     SELECT anon_pubkey, zat, lamports FROM creator_claimable WHERE lamports > 0 OR zat > 0
                 ) x GROUP BY anon_pubkey HAVING sum(z) > 0 OR sum(l) > 0 ORDER BY anon_pubkey",
                &[],
            )
            .await?;
        let mut zec: Vec<([u8; 32], u64)> = Vec::with_capacity(zec_rows.len());
        for r in zec_rows {
            let pk: Vec<u8> = r.get(0);
            let Ok(pk) = pk.try_into() else { continue };
            let (z, l) = (to_u64(r.get(1)), to_u64(r.get(2)));
            let fees = if l == 0 {
                0
            } else {
                match rates.buy.and_then(|rb| pv::claimable_zat(l, rb)) {
                    Some(f) => f,
                    None => return Ok(Err("no_rate")),
                }
            };
            zec.push((pk, z.saturating_add(fees)));
        }
        let mut assets: Vec<Liab> = vec![("ZEC".into(), 8, pv::ZEC_GRANULE, zec)];
        let rows = tx
            .query(
                "SELECT b.mint, COALESCE(t.decimals, it.decimals, 6::smallint), b.anon_pubkey, b.available + b.held
                 FROM token_balances b
                 LEFT JOIN tokens t ON t.mint = b.mint LEFT JOIN intel_tokens it ON it.mint = b.mint
                 WHERE b.available + b.held > 0 ORDER BY b.mint",
                &[],
            )
            .await?;
        for r in rows {
            let mint: String = r.get(0);
            if asset_bytes(&mint).is_none() {
                continue;
            }
            let dec: i16 = r.get(1);
            let pk: Vec<u8> = r.get(2);
            let Ok(pk) = pk.try_into() else { continue };
            if assets.last().is_none_or(|a| a.0 != mint) {
                assets.push((mint, dec, pv::MINT_GRANULE, vec![]));
            }
            assets.last_mut().expect("pushed").3.push((pk, to_u64(r.get(3))));
        }

        // Pieces (rounded up, split 2..4), common tree size.
        let mut pieces: Vec<Vec<Piece>> = Vec::with_capacity(assets.len());
        for (_, _, g, owners) in &assets {
            let mut ps = Vec::new();
            for (pk, v) in owners {
                let rounded = pv::round_up(*v, *g);
                let s = 2 + rand_below(3) as usize;
                for (i, value) in split_pieces(rounded, *g, s).into_iter().enumerate() {
                    ps.push(Piece {
                        pk: *pk,
                        piece: i as u8,
                        value,
                    });
                }
            }
            pieces.push(ps);
        }
        let n = pv::tree_size(pieces.iter().map(Vec::len).max().unwrap_or(0));

        // Reserve (attested by the scanner, K confirmations like crediting, E7) + deposits
        // credited after its sample (≥ K confirmations, in the wallet) + ZEC payouts in flight
        // (still held as liabilities, already gone from the wallet, E8). Floored to 0.01 ZEC.
        let sampled = meta_u64(&tx, "reserve_zat").await?;
        let sampled_credited = meta_u64(&tx, "reserve_credited_zat").await?;
        let credited_now = credited_total(&tx).await?;
        let inflight: i64 = tx
            .query_one(
                "SELECT COALESCE(sum(amount_zat), 0)::bigint FROM zec_payouts WHERE status = 'sent'",
                &[],
            )
            .await?
            .get(0);
        let zec_reserve = pv::reserve_floor(
            sampled
                .saturating_add(credited_now.saturating_sub(sampled_credited))
                .saturating_add(to_u64(inflight)),
        );
        let zcash_height = meta_u64(&tx, "reserve_height").await?.min(u32::MAX as u64) as u32;
        // E9: SOL of queued buys/creates stays an asset (its ZEC hold is the liability); only
        // the gas of queued withdrawals leaves the pool on top of liabilities.
        let committed: i64 = tx
            .query_one(
                "SELECT COALESCE(sum(COALESCE(gas_lamports, 0)), 0)::bigint
                 FROM relayer_jobs WHERE network = $1 AND op = 'transfer' AND status IN ('queued', 'claimed', 'sent')",
                &[&network],
            )
            .await?
            .get(0);

        let mut roots: Vec<([u8; 32], Node)> = Vec::new();
        for ((asset, dec, g, _), ps) in assets.iter().zip(pieces) {
            let ab = asset_bytes(asset).expect("checked");
            // Slots: real pieces + dummies, shuffled.
            let mut slots: Vec<Option<Piece>> = ps.into_iter().map(Some).collect();
            slots.resize_with(n, || None);
            shuffle(&mut slots);
            let mut leaves = Vec::with_capacity(n);
            let (mut lpk, mut lpiece, mut lidx, mut lval, mut lblind) = (vec![], vec![], vec![], vec![], vec![]);
            for (i, slot) in slots.iter().enumerate() {
                let blind: [u8; 32] = rand::random();
                match slot {
                    Some(p) => {
                        let h = pv::leaf_hash(chain, id as u32, &ab, &p.pk, p.piece, p.value, &blind);
                        leaves.push(Node {
                            hash: h,
                            sum: p.value as u128,
                        });
                        lpk.push(p.pk.to_vec());
                        lpiece.push(i16::from(p.piece));
                        lidx.push(i as i32);
                        lval.push(to_i64(p.value)?);
                        lblind.push(blind.to_vec());
                    }
                    None => {
                        let pk: [u8; 32] = rand::random();
                        let h = pv::leaf_hash(chain, id as u32, &ab, &pk, 0, 0, &blind);
                        leaves.push(Node { hash: h, sum: 0 });
                    }
                }
            }
            let levels = pv::build(leaves);
            let root = levels.last().expect("root")[0];
            let (mut nl, mut ni, mut nh, mut ns) = (vec![], vec![], vec![], vec![]);
            for (l, lvl) in levels.iter().enumerate() {
                for (i, nd) in lvl.iter().enumerate() {
                    nl.push(l as i16);
                    ni.push(i as i32);
                    nh.push(nd.hash.to_vec());
                    ns.push(nd.sum.to_string());
                }
            }
            tx.execute(
                "INSERT INTO verify_nodes (snapshot_id, asset, level, idx, hash, sum)
                 SELECT $1, $2, * FROM unnest($3::smallint[], $4::int[], $5::bytea[], $6::text[])",
                &[&id, asset, &nl, &ni, &nh, &ns],
            )
            .await?;
            tx.execute(
                "INSERT INTO verify_leaves (snapshot_id, asset, anon_pubkey, piece, leaf_idx, value, blind)
                 SELECT $1, $2, * FROM unnest($3::bytea[], $4::smallint[], $5::int[], $6::bigint[], $7::bytea[])",
                &[&id, asset, &lpk, &lpiece, &lidx, &lval, &lblind],
            )
            .await?;
            tx.execute(
                "INSERT INTO verify_trees (snapshot_id, asset, decimals, granule, root, sum)
                 VALUES ($1, $2, $3, $4, $5, $6)",
                &[
                    &id,
                    asset,
                    dec,
                    &to_i64(*g)?,
                    &root.hash.to_vec(),
                    &root.sum.to_string(),
                ],
            )
            .await?;
            roots.push((ab, root));
        }
        let header = SnapshotHeader {
            chain,
            snapshot_id: id as u32,
            taken_at_sec,
            leaves: n as u32,
            solana_slot,
            zcash_height,
            zec_reserve_zat: zec_reserve,
        };
        let digest = pv::roots_digest(&header, &roots);
        // Anchor + operator signature: the attestation key (relayer), memo = hex digest only.
        let job: i64 = tx
            .query_one(
                "INSERT INTO relayer_jobs (op, meta, network, exec_mode, not_before)
                 VALUES ('attest', $1, $2, 'delayed', now()) RETURNING id",
                &[&json!({ "memo": hex::encode(digest), "purpose": "verify" }), &network],
            )
            .await?
            .get(0);
        let rate = rates.sell.map(to_i64).transpose()?;
        let rate_buy = rates.buy.map(to_i64).transpose()?;
        tx.execute(
            "UPDATE verify_snapshots SET status = 'built', freeze_until = now(), zcash_height = $2,
                    zec_reserve_zat = $3, leaves = $4, roots_digest = $5, committed_lamports = $6,
                    rate_lamports_per_zec_sell = $7, attest_job_id = $8, rate_lamports_per_zec_buy = $9,
                    -- v0.13: quote assets of the pool, frozen with the snapshot. Only ZEC SPL counts
                    -- toward ZEC (1:1, bridged); per-vault balances below dust_below are ignored.
                    quote_assets = (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                        'mint', q.mint, 'quote', q.quote, 'decimals', q.decimals,
                                        'bridged', q.bridged, 'counted', q.quote = 'ZEC',
                                        'dustBelow', (CASE WHEN q.quote = 'ZEC' THEN 100000 ELSE 10000 END)::text)
                                        ORDER BY q.mint), '[]'::jsonb)
                                    FROM pool_quotes q
                                    WHERE q.network = (SELECT network FROM verify_snapshots WHERE id = $1))
             WHERE id = $1",
            &[
                &id,
                &(zcash_height as i32),
                &to_i64(zec_reserve)?,
                &(n as i32),
                &digest.to_vec(),
                &committed,
                &rate,
                &job,
                &rate_buy,
            ],
        )
        .await?;
        tx.commit().await?;
        Ok(Ok(()))
    }

    /// E10: publish the operator signature as soon as the relayer signed the digest (it
    /// writes `out_sig` + the signer in `vault` when it claims the attest job), without waiting
    /// for the memo tx. Checked (strict ed25519) against the snapshot's own digest.
    pub async fn publish_operator_sigs(&self) -> Result<usize> {
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT s.id, j.vault, j.out_sig, encode(s.roots_digest, 'hex')
                 FROM verify_snapshots s JOIN relayer_jobs j
                   ON j.op = 'attest' AND j.meta->>'purpose' = 'verify'
                  AND j.meta->>'memo' = encode(s.roots_digest, 'hex')
                 WHERE s.status = 'built' AND s.operator IS NULL AND j.out_sig IS NOT NULL AND j.vault IS NOT NULL",
                &[],
            )
            .await?;
        let mut n = 0;
        for r in rows {
            let (id, pk, sig, memo): (i32, String, String, String) = (r.get(0), r.get(1), r.get(2), r.get(3));
            if !detached_ok(&pk, &sig, &memo) {
                continue;
            }
            n += c
                .execute(
                    "UPDATE verify_snapshots SET operator = $2 WHERE id = $1 AND operator IS NULL",
                    &[&id, &json!({ "pubkey": pk, "sig": sig })],
                )
                .await? as usize;
        }
        Ok(n)
    }

    /// Settle final `attest` jobs (fair-launch roots and Verify roots): anchor facts, and the
    /// operator signature after checking it against the digest.
    pub async fn settle_attestations(&self) -> Result<usize> {
        let mut n = 0;
        loop {
            let mut c = self.pool.get().await?;
            let tx = c.transaction().await?;
            let Some(r) = tx
                .query_opt(
                    "SELECT id, status, signature, slot, vault, out_memo, out_sig, meta->>'memo', out_block_time FROM relayer_jobs
                     WHERE op = 'attest' AND status IN ('confirmed', 'failed') AND settled_at IS NULL
                     LIMIT 1 FOR UPDATE SKIP LOCKED",
                    &[],
                )
                .await?
            else {
                return Ok(n);
            };
            let jid: i64 = r.get(0);
            if r.get::<_, String>(1) == "confirmed" {
                let sig: Option<String> = r.get(2);
                let slot: Option<i64> = r.get(3);
                let signer: Option<String> = r.get(4);
                let memo: Option<String> = r.get(7);
                let matches = memo.is_some() && r.get::<_, Option<String>>(5) == memo;
                let block_time: Option<i64> = r.get(8);
                // F2: anchored before the drand round? (+2 s margin on blockTime precision)
                tx.execute(
                    "UPDATE fl_launches SET attestation = $2::jsonb || jsonb_build_object('beforeRound',
                            $3::bigint IS NOT NULL AND $3::bigint * 1000 + 2000 < extract(epoch FROM round_time) * 1000)
                     WHERE attest_job_id = $1",
                    &[
                        &jid,
                        &json!({ "solanaTx": sig, "slot": slot, "signer": signer, "matches": matches,
                                 "blockTime": block_time }),
                        &block_time,
                    ],
                )
                .await?;
                let op_sig: Option<String> = r.get(6);
                let operator = match (&signer, &op_sig, &memo) {
                    (Some(pk), Some(s), Some(m)) if detached_ok(pk, s, m) => Some(json!({ "pubkey": pk, "sig": s })),
                    _ => None,
                };
                tx.execute(
                    "UPDATE verify_snapshots SET anchor = $2, operator = COALESCE(operator, $3)
                     WHERE attest_job_id = $1",
                    &[
                        &jid,
                        &json!({ "solanaTx": sig, "slot": slot, "matches": matches, "blockTime": block_time }),
                        &operator,
                    ],
                )
                .await?;
            }
            crate::actions::mark_settled(&tx, &[jid]).await?;
            tx.commit().await?;
            n += 1;
        }
    }

    /// Re-queue the anchor of built snapshots whose `attest` job failed (no SOL on the key,
    /// RPC down …): at most every `every_secs`, at most `max_attempts` jobs per snapshot.
    pub async fn verify_reanchor(&self, network: &str, every_secs: f64, max_attempts: i32) -> Result<u64> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let rows = tx
            .query(
                "SELECT s.id, s.roots_digest FROM verify_snapshots s JOIN relayer_jobs j ON j.id = s.attest_job_id
                 WHERE s.network = $1 AND s.status = 'built' AND j.settled_at IS NOT NULL
                   AND ((s.anchor IS NULL AND j.status = 'failed')
                        OR (j.status = 'confirmed' AND (s.anchor->>'matches')::boolean IS FALSE))
                   AND s.anchor_attempts < $2 AND (s.anchor_retry_at IS NULL OR s.anchor_retry_at <= now())
                 FOR UPDATE OF s SKIP LOCKED",
                &[&network, &max_attempts],
            )
            .await?;
        let mut n = 0;
        for r in rows {
            let (id, digest): (i32, Option<Vec<u8>>) = (r.get(0), r.get(1));
            let Some(digest) = digest else { continue };
            let job: i64 = tx
                .query_one(
                    "INSERT INTO relayer_jobs (op, meta, network, exec_mode, not_before)
                     VALUES ('attest', $1, $2, 'delayed', now()) RETURNING id",
                    &[&json!({ "memo": hex::encode(digest), "purpose": "verify" }), &network],
                )
                .await?
                .get(0);
            tx.execute(
                "UPDATE verify_snapshots SET attest_job_id = $2, anchor_attempts = anchor_attempts + 1,
                        anchor_retry_at = now() + make_interval(secs => $3)
                 WHERE id = $1",
                &[&id, &job, &every_secs],
            )
            .await?;
            n += 1;
        }
        tx.commit().await?;
        Ok(n)
    }

    /// Built snapshots, newest first (`before` = id bound).
    pub async fn verify_list(
        &self,
        network: &str,
        before: Option<i32>,
        limit: i64,
    ) -> Result<Vec<(i32, u64, Vec<u8>, Option<Value>)>> {
        let c = self.pool.get().await?;
        let rows = c
            .query(
                "SELECT id, (extract(epoch FROM taken_at) * 1000)::bigint, roots_digest, anchor FROM verify_snapshots
                 WHERE network = $1 AND status = 'built' AND ($2::int IS NULL OR id < $2)
                 ORDER BY id DESC LIMIT $3",
                &[&network, &before, &limit],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get(0), to_u64(r.get(1)), r.get(2), r.get(3)))
            .collect())
    }

    /// One built snapshot (latest when `id` is None).
    pub async fn verify_snapshot(&self, network: &str, id: Option<i32>) -> Result<Option<SnapshotRow>> {
        let c = self.pool.get().await?;
        let Some(r) = c
            .query_opt(
                "SELECT id, chain_id, (extract(epoch FROM taken_at) * 1000)::bigint, roots_digest, anchor, operator,
                        leaves, solana_slot, zcash_height, zec_reserve_zat, committed_lamports,
                        rate_lamports_per_zec_sell, rate_lamports_per_zec_buy, quote_assets
                 FROM verify_snapshots WHERE network = $1 AND status = 'built' AND ($2::int IS NULL OR id = $2)
                 ORDER BY id DESC LIMIT 1",
                &[&network, &id],
            )
            .await?
        else {
            return Ok(None);
        };
        let sid: i32 = r.get(0);
        let trees = c
            .query(
                "SELECT asset, decimals, granule, root, sum FROM verify_trees WHERE snapshot_id = $1 ORDER BY asset",
                &[&sid],
            )
            .await?
            .into_iter()
            .map(|t| (t.get(0), t.get(1), to_u64(t.get(2)), t.get(3), t.get(4)))
            .collect();
        let vaults = c
            .query(
                "SELECT address, sig, lamports, tokens FROM verify_vaults WHERE snapshot_id = $1 ORDER BY address",
                &[&sid],
            )
            .await?
            .into_iter()
            .map(|v| (v.get(0), v.get(1), to_u64(v.get(2)), v.get(3)))
            .collect();
        Ok(Some(SnapshotRow {
            id: sid,
            chain_id: r.get(1),
            taken_at_ms: to_u64(r.get(2)),
            roots_digest: r.get(3),
            anchor: r.get(4),
            operator: r.get(5),
            leaves: r.get::<_, i32>(6) as u32,
            solana_slot: to_u64(r.get::<_, Option<i64>>(7).unwrap_or(0)),
            zcash_height: r.get::<_, Option<i32>>(8).unwrap_or(0) as u32,
            zec_reserve_zat: to_u64(r.get::<_, Option<i64>>(9).unwrap_or(0)),
            committed_lamports: to_u64(r.get::<_, Option<i64>>(10).unwrap_or(0)),
            rate_sell: r.get::<_, Option<i64>>(11).map(to_u64),
            rate_buy: r.get::<_, Option<i64>>(12).map(to_u64),
            quote_assets: r.get(13),
            trees,
            vaults,
        }))
    }

    /// Owner proof for the latest or previous built snapshot; `None` otherwise or once the
    /// paths are purged (48 h).
    pub async fn verify_proof(
        &self,
        network: &str,
        pk: &[u8; 32],
        snapshot: Option<i32>,
    ) -> Result<Option<OwnerProof>> {
        let pk_s: &[u8] = pk;
        let c = self.pool.get().await?;
        let recent: Vec<i32> = c
            .query(
                "SELECT id FROM verify_snapshots WHERE network = $1 AND status = 'built' ORDER BY id DESC LIMIT 2",
                &[&network],
            )
            .await?
            .into_iter()
            .map(|r| r.get(0))
            .collect();
        let Some(sid) = (match snapshot {
            None => recent.first().copied(),
            Some(s) => recent.contains(&s).then_some(s),
        }) else {
            return Ok(None);
        };
        let has_nodes = c
            .query_opt("SELECT 1 FROM verify_nodes WHERE snapshot_id = $1 LIMIT 1", &[&sid])
            .await?
            .is_some();
        if !has_nodes {
            return Ok(None);
        }
        let rows = c
            .query(
                "SELECT l.asset, t.decimals, l.piece, l.leaf_idx, l.value, l.blind
                 FROM verify_leaves l JOIN verify_trees t ON t.snapshot_id = l.snapshot_id AND t.asset = l.asset
                 WHERE l.snapshot_id = $1 AND l.anon_pubkey = $2 ORDER BY l.asset, l.piece",
                &[&sid, &pk_s],
            )
            .await?;
        let mut proofs: Vec<AssetProof> = Vec::new();
        for r in rows {
            let asset: String = r.get(0);
            if proofs.last().is_none_or(|p| p.asset != asset) {
                proofs.push(AssetProof {
                    asset: asset.clone(),
                    decimals: r.get(1),
                    pieces: vec![],
                });
            }
            proofs.last_mut().expect("pushed").pieces.push(ProofPiece {
                piece: r.get::<_, i16>(2) as u8,
                leaf_idx: r.get::<_, i32>(3) as u32,
                value: to_u64(r.get(4)),
                blind: r.get(5),
                path: vec![],
            });
        }
        let truncated = proofs.len() > MAX_PROOF_ASSETS;
        if truncated {
            let zec = proofs.iter().position(|p| p.asset == "ZEC");
            let mut keep: Vec<AssetProof> = Vec::new();
            if let Some(z) = zec {
                keep.push(proofs.remove(z));
            }
            shuffle(&mut proofs);
            proofs.truncate(MAX_PROOF_ASSETS - keep.len());
            keep.append(&mut proofs);
            proofs = keep;
        }
        let levels: i32 = c
            .query_one(
                "SELECT max(level)::int FROM verify_nodes WHERE snapshot_id = $1 AND asset = 'ZEC'",
                &[&sid],
            )
            .await?
            .get::<_, Option<i32>>(0)
            .unwrap_or(0);
        for ap in &mut proofs {
            for p in &mut ap.pieces {
                let (lv, ix): (Vec<i16>, Vec<i32>) =
                    (0..levels).map(|l| (l as i16, ((p.leaf_idx >> l) ^ 1) as i32)).unzip();
                let mut nodes = c
                    .query(
                        "SELECT n.level, n.hash, n.sum FROM verify_nodes n
                         JOIN unnest($3::smallint[], $4::int[]) AS q(level, idx) ON q.level = n.level AND q.idx = n.idx
                         WHERE n.snapshot_id = $1 AND n.asset = $2 ORDER BY n.level",
                        &[&sid, &ap.asset, &lv, &ix],
                    )
                    .await?;
                nodes.sort_by_key(|n| n.get::<_, i16>(0));
                p.path = nodes.into_iter().map(|n| (n.get(1), n.get(2))).collect();
            }
        }
        Ok(Some(OwnerProof {
            snapshot_id: sid,
            proofs,
            truncated,
        }))
    }

    /// Verify retention: paths and key bindings live 48 h after the snapshot.
    pub async fn verify_janitor(&self) -> Result<u64> {
        let c = self.pool.get().await?;
        let a = c
            .execute(
                "DELETE FROM verify_leaves l USING verify_snapshots s
                 WHERE l.snapshot_id = s.id AND s.taken_at < now() - interval '48 hours'",
                &[],
            )
            .await?;
        let b = c
            .execute(
                "DELETE FROM verify_nodes n USING verify_snapshots s
                 WHERE n.snapshot_id = s.id AND s.taken_at < now() - interval '48 hours'",
                &[],
            )
            .await?;
        Ok(a + b)
    }
}

/// ed25519 check of the operator signature (base58) over the hex digest bytes.
fn detached_ok(pubkey_b58: &str, sig_b58: &str, memo_hex: &str) -> bool {
    let Some(pk) = bs58::decode(pubkey_b58)
        .into_vec()
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .and_then(|b| VerifyingKey::from_bytes(&b).ok())
    else {
        return false;
    };
    let Some(sig) = bs58::decode(sig_b58)
        .into_vec()
        .ok()
        .and_then(|v| <[u8; 64]>::try_from(v).ok())
        .map(|b| Signature::from_bytes(&b))
    else {
        return false;
    };
    let Ok(msg) = hex::decode(memo_hex) else { return false };
    pk.verify_strict(&msg, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_is_exact_and_granular() {
        for _ in 0..500 {
            let g = 100_000;
            let v = pv::round_up(rand_below(10_000_000_000), g);
            let s = 2 + rand_below(3) as usize;
            let p = split_pieces(v, g, s);
            assert_eq!(p.len(), s);
            assert_eq!(p.iter().sum::<u64>(), v);
            assert!(p.iter().all(|x| x % g == 0));
        }
        assert_eq!(split_pieces(0, 100, 3), vec![0, 0, 0]);
    }

    #[test]
    fn operator_signature_check() {
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(&[9; 32]);
        let digest = [7u8; 32];
        let pk = bs58::encode(sk.verifying_key().to_bytes()).into_string();
        let sig = bs58::encode(sk.sign(&digest).to_bytes()).into_string();
        assert!(detached_ok(&pk, &sig, &hex::encode(digest)));
        assert!(!detached_ok(&pk, &sig, &hex::encode([8u8; 32])));
        assert!(!detached_ok("x", &sig, &hex::encode(digest)));
    }
}

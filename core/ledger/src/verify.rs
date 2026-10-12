//! Verify (API.md v0.7, spec docs/analysis/verify.md): daily snapshot of liabilities as
//! Merkle-sum trees, vault balances written by the relayer, operator signature and Solana
//! anchor via an `attest` job, owner proofs, 48 h retention of paths and key bindings.
//!
//! State machine of a snapshot (driven by the API every second):
//! `freezing` (relayer claims nothing; wait until no job/payout is in flight and every final
//! job is settled, ≤ quiesce_secs) → `collecting` (relayer writes `verify_vaults` + slot) →
//! `built` (one REPEATABLE READ transaction: trees, digest, attest job; freeze lifted).
//! Any timeout → `skipped` (freeze lifted; the scheduler retries).
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

async fn quiescent<C: GenericClient>(c: &C, network: &str) -> Result<bool> {
    Ok(c.query_one(
        "SELECT NOT EXISTS (SELECT 1 FROM relayer_jobs WHERE network = $1 AND op <> 'attest'
                              AND (status IN ('claimed', 'sent')
                                   OR (status IN ('confirmed', 'failed') AND settled_at IS NULL)))
            AND NOT EXISTS (SELECT 1 FROM zec_payouts WHERE status = 'sent')",
        &[&network],
    )
    .await?
    .get(0))
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

    /// Advance the snapshot in progress. `rate_sell` = lamports per ZEC (sell side) now.
    pub async fn verify_step(&self, network: &str, t: VerifyTiming, rate_sell: Option<u64>) -> Result<Step> {
        let row = {
            let c = self.pool.get().await?;
            c.query_opt(
                "SELECT id, status, assets_done_at IS NOT NULL,
                        requested_at < now() - make_interval(secs => $2), freeze_until < now()
                 FROM verify_snapshots WHERE network = $1 AND status IN ('freezing', 'collecting')
                 ORDER BY id LIMIT 1",
                &[&network, &t.quiesce_secs],
            )
            .await?
        };
        let Some(r) = row else { return Ok(Step::Idle) };
        let (id, status, assets, quiesce_over, freeze_over): (i32, String, bool, bool, bool) =
            (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4));
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
                cc.execute(
                    "UPDATE verify_snapshots SET status = 'collecting', taken_at = date_trunc('minute', now())
                     WHERE id = $1 AND status = 'freezing'",
                    &[&id],
                )
                .await?;
                return Ok(Step::Collecting(id));
            }
            if quiesce_over || freeze_over {
                return Ok(skip("busy").await?);
            }
            return Ok(Step::Waiting);
        }
        // collecting
        if assets {
            self.verify_build(id, network, rate_sell).await?;
            return Ok(Step::Built(id));
        }
        if freeze_over {
            return Ok(skip("assets_timeout").await?);
        }
        Ok(Step::Waiting)
    }

    /// Build trees + digest + attest job in one REPEATABLE READ transaction; lift the freeze.
    async fn verify_build(&self, id: i32, network: &str, rate_sell: Option<u64>) -> Result<()> {
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

        // Liabilities: (asset, decimals, granule) -> [(pk, value)]
        let mut assets: Vec<Liab> = vec![("ZEC".into(), 8, pv::ZEC_GRANULE, vec![])];
        for r in tx
            .query(
                "SELECT anon_pubkey, available_zat + held_zat FROM balances WHERE available_zat + held_zat > 0",
                &[],
            )
            .await?
        {
            let pk: Vec<u8> = r.get(0);
            if let Ok(pk) = pk.try_into() {
                assets[0].3.push((pk, to_u64(r.get(1))));
            }
        }
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
                let g = 10u64.checked_pow(dec.clamp(0, 18) as u32).unwrap_or(1);
                assets.push((mint, dec, g, vec![]));
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

        let zec_reserve = pv::reserve_floor(meta_u64(&tx, "reserve_zat").await?);
        let zcash_height = meta_u64(&tx, "reserve_height").await?.min(u32::MAX as u64) as u32;
        let committed: i64 = tx
            .query_one(
                "SELECT COALESCE(sum(CASE WHEN op IN ('buy', 'create', 'fair_create') THEN COALESCE(lamports_in, 0)
                                          WHEN op = 'transfer' THEN COALESCE(gas_lamports, 0) ELSE 0 END), 0)::bigint
                 FROM relayer_jobs WHERE network = $1 AND status IN ('queued', 'claimed', 'sent')",
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
                &[&json!({ "memo": hex::encode(digest) }), &network],
            )
            .await?
            .get(0);
        let rate = rate_sell.map(to_i64).transpose()?;
        tx.execute(
            "UPDATE verify_snapshots SET status = 'built', freeze_until = now(), zcash_height = $2,
                    zec_reserve_zat = $3, leaves = $4, roots_digest = $5, committed_lamports = $6,
                    rate_lamports_per_zec_sell = $7, attest_job_id = $8
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
            ],
        )
        .await?;
        tx.commit().await?;
        Ok(())
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
                    "SELECT id, status, signature, slot, vault, out_memo, out_sig, meta->>'memo' FROM relayer_jobs
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
                tx.execute(
                    "UPDATE fl_launches SET attestation = $2 WHERE attest_job_id = $1",
                    &[
                        &jid,
                        &json!({ "solanaTx": sig, "slot": slot, "signer": signer, "matches": matches }),
                    ],
                )
                .await?;
                let op_sig: Option<String> = r.get(6);
                let operator = match (&signer, &op_sig, &memo) {
                    (Some(pk), Some(s), Some(m)) if detached_ok(pk, s, m) => Some(json!({ "pubkey": pk, "sig": s })),
                    _ => None,
                };
                tx.execute(
                    "UPDATE verify_snapshots SET anchor = $2, operator = $3 WHERE attest_job_id = $1",
                    &[
                        &jid,
                        &json!({ "solanaTx": sig, "slot": slot, "matches": matches }),
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
                        rate_lamports_per_zec_sell
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

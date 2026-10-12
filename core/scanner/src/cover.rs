//! H1 (review-day2): cover traffic for full-transaction fetches.
//!
//! Compact blocks carry only 52 bytes of each Orchard/Ironwood ciphertext, so memos need
//! the full tx (`GetTransaction`). Fetching only our own txids tells the lightwalletd
//! operator exactly which txs are Unzeen deposits (and, with a wallet that broadcast through
//! the same server, links the sender's IP to a deposit).
//!
//! Instead, for every scanned block we fetch **every** tx that has Orchard or Ironwood
//! actions, in a random order, rate-limited. Our own txs are kept and trial-decrypted by the
//! wallet; all other txs are dropped in memory: never parsed, written to disk or logged.
//! The operator sees "the pool downloads all shielded txs", like any full-memo client.
//!
//! Rate limiting (zec.rocks is a shared public server): a global pacer (`UNZEEN_COVER_RPS`
//! requests/s), at most `UNZEEN_COVER_CONCURRENCY` requests in flight, and exponential
//! backoff with jitter on `ResourceExhausted` / `Unavailable` / timeouts.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use futures_util::{StreamExt, stream};
use rand::seq::SliceRandom;
use tokio::sync::Mutex;
use tonic::{Code, transport::Channel};
use zcash_client_backend::proto::{
    compact_formats::CompactBlock,
    service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
};
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::BlockHeight;

type Client = CompactTxStreamerClient<Channel>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CoverCfg {
    /// Requests in flight at once.
    pub concurrency: usize,
    /// Global request rate (requests per second).
    pub rps: f64,
    /// Retries per tx on transient errors before giving up on it.
    pub max_retries: u32,
}

impl Default for CoverCfg {
    fn default() -> Self {
        Self {
            concurrency: 4,
            rps: 20.0,
            max_retries: 6,
        }
    }
}

impl CoverCfg {
    /// `UNZEEN_COVER_CONCURRENCY` (4), `UNZEEN_COVER_RPS` (20), `UNZEEN_COVER_RETRIES` (6).
    pub fn from_env() -> anyhow::Result<Self> {
        let d = Self::default();
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let concurrency = match get("UNZEEN_COVER_CONCURRENCY") {
            Some(v) => v.parse().context("UNZEEN_COVER_CONCURRENCY must be an integer")?,
            None => d.concurrency,
        };
        let rps = match get("UNZEEN_COVER_RPS") {
            Some(v) => v.parse().context("UNZEEN_COVER_RPS must be a number")?,
            None => d.rps,
        };
        let max_retries = match get("UNZEEN_COVER_RETRIES") {
            Some(v) => v.parse().context("UNZEEN_COVER_RETRIES must be an integer")?,
            None => d.max_retries,
        };
        Ok(Self {
            concurrency: usize::max(1, usize::min(concurrency, 32)),
            rps: f64::clamp(rps, 0.5, 500.0),
            max_retries,
        })
    }
}

/// Counters for one cover fetch (no txids, no per-tx data).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CoverStats {
    /// Shielded (Orchard/Ironwood) txs in the blocks = requests issued.
    pub candidates: usize,
    pub fetched: usize,
    /// Of `fetched`, kept for the wallet.
    pub kept: usize,
    /// Gave up after retries (or server says not found).
    pub failed: usize,
    pub retries: usize,
    /// Payload bytes of all fetched txs.
    pub bytes: u64,
    pub ms: u64,
}

impl CoverStats {
    pub fn add(&mut self, o: &CoverStats) {
        self.candidates += o.candidates;
        self.fetched += o.fetched;
        self.kept += o.kept;
        self.failed += o.failed;
        self.retries += o.retries;
        self.bytes += o.bytes;
        self.ms += o.ms;
    }
}

/// A full tx we asked to keep: raw bytes + mined height reported by the server.
pub struct Kept {
    pub raw: Vec<u8>,
    pub height: Option<BlockHeight>,
}

/// Txids of all txs with Orchard or Ironwood actions in `blocks`.
pub fn shielded_txids(blocks: &[CompactBlock]) -> Vec<TxId> {
    blocks
        .iter()
        .flat_map(|b| b.vtx.iter())
        .filter(|t| !t.actions.is_empty() || !t.ironwood_actions.is_empty())
        .filter_map(|t| <[u8; 32]>::try_from(t.txid.as_slice()).ok())
        .map(TxId::from_bytes)
        .collect()
}

/// Global pacer: hands out send slots spaced `1/rps` apart.
struct Pacer {
    next: Mutex<Instant>,
    gap: Duration,
}

impl Pacer {
    fn new(rps: f64) -> Self {
        Self {
            next: Mutex::new(Instant::now()),
            gap: Duration::from_secs_f64(1.0 / rps),
        }
    }

    async fn wait(&self) {
        let slot = {
            let mut n = self.next.lock().await;
            let now = Instant::now();
            let slot = if *n > now { *n } else { now };
            *n = slot + self.gap;
            slot
        };
        tokio::time::sleep_until(slot.into()).await;
    }

    /// Push every future slot back (server asked us to slow down).
    async fn penalize(&self, d: Duration) {
        let mut n = self.next.lock().await;
        let at = Instant::now() + d;
        if *n < at {
            *n = at;
        }
    }
}

fn transient(c: Code) -> bool {
    matches!(
        c,
        Code::ResourceExhausted
            | Code::Unavailable
            | Code::DeadlineExceeded
            | Code::Aborted
            | Code::Unknown
            | Code::Internal
    )
}

fn jitter_ms(max: u64) -> u64 {
    rand::random::<u64>() % max.max(1)
}

enum One {
    Got { raw: Vec<u8>, height: u64, retries: usize },
    Failed { retries: usize },
}

async fn fetch_one(mut client: Client, pacer: Arc<Pacer>, txid: TxId, max_retries: u32) -> One {
    let mut retries = 0usize;
    loop {
        pacer.wait().await;
        let req = service::TxFilter {
            hash: txid.as_ref().to_vec(),
            ..Default::default()
        };
        match client.get_transaction(req).await {
            Ok(r) => {
                let r = r.into_inner();
                return One::Got {
                    raw: r.data,
                    height: r.height,
                    retries,
                };
            }
            Err(s) if s.code() == Code::NotFound => return One::Failed { retries },
            Err(s) if transient(s.code()) && (retries as u32) < max_retries => {
                // 0.5 s, 1 s, 2 s, ... capped at 30 s, plus jitter; slow everyone down on 429-like.
                let base = 500u64.saturating_mul(1 << retries.min(6)).min(30_000);
                let wait = Duration::from_millis(base + jitter_ms(base / 2 + 1));
                if s.code() == Code::ResourceExhausted {
                    pacer.penalize(wait).await;
                }
                tokio::time::sleep(wait).await;
                retries += 1;
            }
            Err(_) => return One::Failed { retries },
        }
    }
}

/// Fetch every tx of `txids` (shuffled), keep only those in `keep`. Others are dropped as
/// soon as their bytes are counted. Order of requests is random; results are unordered.
pub async fn fetch_all(
    client: &Client,
    cfg: &CoverCfg,
    mut txids: Vec<TxId>,
    keep: &HashSet<TxId>,
) -> (Vec<Kept>, CoverStats) {
    let started = Instant::now();
    // Dedup (a txid can only appear once per chain, but requests may be merged by callers).
    let mut seen = HashSet::new();
    txids.retain(|t| seen.insert(*t));
    txids.shuffle(&mut rand::rng());
    let mut st = CoverStats {
        candidates: txids.len(),
        ..Default::default()
    };
    let pacer = Arc::new(Pacer::new(cfg.rps));
    let mut kept = Vec::new();
    let mut results = stream::iter(txids.into_iter().map(|txid| {
        let (c, p) = (client.clone(), pacer.clone());
        async move { (txid, fetch_one(c, p, txid, cfg.max_retries).await) }
    }))
    .buffer_unordered(cfg.concurrency);
    while let Some((txid, r)) = results.next().await {
        match r {
            One::Got { raw, height, retries } => {
                st.fetched += 1;
                st.retries += retries;
                st.bytes += raw.len() as u64;
                if keep.contains(&txid) {
                    st.kept += 1;
                    let height =
                        (height > 0 && height <= u64::from(u32::MAX)).then(|| BlockHeight::from_u32(height as u32));
                    kept.push(Kept { raw, height });
                }
                // else: `raw` dropped here, never parsed or stored.
            }
            One::Failed { retries } => {
                st.failed += 1;
                st.retries += retries;
            }
        }
    }
    st.ms = started.elapsed().as_millis() as u64;
    (kept, st)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::proto::compact_formats::{CompactOrchardAction, CompactTx};

    fn tx(id: u8, orchard: usize, ironwood: usize) -> CompactTx {
        CompactTx {
            txid: vec![id; 32],
            actions: vec![CompactOrchardAction::default(); orchard],
            ironwood_actions: vec![CompactOrchardAction::default(); ironwood],
            ..Default::default()
        }
    }

    #[test]
    fn picks_only_orchard_family_txs() {
        let blocks = vec![
            CompactBlock {
                height: 1,
                vtx: vec![tx(1, 0, 0), tx(2, 2, 0), tx(3, 0, 1)],
                ..Default::default()
            },
            CompactBlock {
                height: 2,
                vtx: vec![tx(4, 1, 1), tx(5, 0, 0)],
                ..Default::default()
            },
        ];
        let ids: Vec<u8> = shielded_txids(&blocks).iter().map(|t| t.as_ref()[0]).collect();
        assert_eq!(ids, vec![2, 3, 4]);
    }

    #[test]
    fn malformed_txid_is_skipped() {
        let mut bad = tx(9, 1, 0);
        bad.txid = vec![9; 31];
        let blocks = vec![CompactBlock {
            vtx: vec![bad, tx(7, 1, 0)],
            ..Default::default()
        }];
        assert_eq!(shielded_txids(&blocks).len(), 1);
    }

    #[test]
    fn cfg_is_clamped() {
        // SAFETY: test-only env mutation; this test is the only reader of these keys.
        unsafe {
            std::env::set_var("UNZEEN_COVER_CONCURRENCY", "1000");
            std::env::set_var("UNZEEN_COVER_RPS", "0");
        }
        let c = CoverCfg::from_env().unwrap();
        assert_eq!(c.concurrency, 32);
        assert_eq!(c.rps, 0.5);
        unsafe {
            std::env::remove_var("UNZEEN_COVER_CONCURRENCY");
            std::env::remove_var("UNZEEN_COVER_RPS");
        }
    }

    #[tokio::test]
    async fn pacer_spaces_requests() {
        let p = Pacer::new(100.0); // 10 ms apart
        let t = Instant::now();
        for _ in 0..6 {
            p.wait().await;
        }
        assert!(t.elapsed() >= Duration::from_millis(45), "{:?}", t.elapsed());
    }
}

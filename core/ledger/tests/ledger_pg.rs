//! Ledger integration tests against a real Postgres.
//!
//! Uses `DATABASE_URL` (or the repo-root `.env`). Each test runs in a fresh schema that is
//! dropped afterwards. Without a database the tests print "skip" and pass, so `cargo test`
//! stays green on machines without Docker; CI must set DATABASE_URL and REQUIRE_PG=1
//! (then a missing database is a failure, not a skip).

use std::sync::Arc;

use serde_json::json;
use tokio_postgres::NoTls;
use unzeen_ledger::{
    JobOp, Ledger, LedgerError, MemoInput, NewAction, NewJob, NoteObs, NoteRefKey, Observed, PgConfig, Policy, RateUsed,
};
use unzeen_protocol::{
    ChainId, SigningKey, SolanaCluster, ZcashNet,
    memo::{Op, Target, Unz1Body, Venue},
};

const CHAIN: ChainId = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
const POLICY: Policy = Policy {
    chain: CHAIN,
    confirmations: 3,
    min_deposit_zat: 100_000,
    min_action_zat: 50_000,
};
const T0: u64 = 1_800_000_000;

struct TestDb {
    ledger: Ledger,
    admin: tokio_postgres::Client,
    schema: String,
}

impl TestDb {
    async fn drop_schema(self) {
        let _ = self
            .admin
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await;
    }
}

async fn setup() -> Option<TestDb> {
    let _ = dotenvy::from_path(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env"));
    let required = std::env::var("REQUIRE_PG").as_deref() == Ok("1");
    let Ok(url) = std::env::var("DATABASE_URL") else {
        assert!(!required, "REQUIRE_PG=1 but DATABASE_URL is not set");
        eprintln!("skip: DATABASE_URL not set");
        return None;
    };
    let (admin, conn) = match tokio_postgres::connect(&url, NoTls).await {
        Ok(x) => x,
        Err(e) => {
            assert!(!required, "REQUIRE_PG=1 but cannot connect: {e}");
            eprintln!("skip: cannot connect to DATABASE_URL: {e}");
            return None;
        }
    };
    tokio::spawn(conn);
    let schema = format!("t_{}", hex::encode(rand::random::<[u8; 6]>()));
    admin.batch_execute(&format!("CREATE SCHEMA {schema}")).await.unwrap();
    let mut cfg: PgConfig = url.parse().unwrap();
    cfg.options(format!("-c search_path={schema}"));
    let ledger = Ledger::connect_with(cfg, POLICY).await.unwrap();
    Some(TestDb { ledger, admin, schema })
}

fn user(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

fn pk(n: u8) -> [u8; 32] {
    user(n).verifying_key().to_bytes()
}

fn deposit_memo(n: u8, expiry: u32, target: Target) -> String {
    Unz1Body {
        op: Op::Deposit,
        venue: Venue::None,
        mint: [0; 32],
        min_out: 0,
        anon_pubkey: [0; 32],
        nonce: 1,
        expiry,
        target,
    }
    .sign(&user(n), CHAIN)
    .encode()
}

fn note(i: u32, amount: u64, h: Option<u32>, tip: u32, memo: MemoInput) -> NoteObs {
    let key = NoteRefKey::new([42; 32]);
    NoteObs {
        note_ref: key.note_ref(&[7; 32], 4, i),
        amount_zat: amount,
        mined_height: h,
        tip,
        block_time: Some(T0),
        memo,
    }
}

#[tokio::test]
async fn deposit_lifecycle_is_idempotent() {
    let Some(db) = setup().await else { return };
    let l = &db.ledger;
    let memo = MemoInput::Text(deposit_memo(1, T0 as u32 + 3600, Target::None));

    assert_eq!(
        l.observe_note(&note(0, 1_000_000, None, 100, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::Unchanged
    );
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(100), 100, MemoInput::NotFetched), T0)
            .await
            .unwrap(),
        Observed::Seen
    );
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(100), 102, MemoInput::NotFetched), T0)
            .await
            .unwrap(),
        Observed::Confirmed
    );
    assert_eq!(l.balance(&pk(1)).await.unwrap(), None);
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(100), 102, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::Credited
    );
    for tip in [102, 103, 200] {
        assert_eq!(
            l.observe_note(&note(0, 1_000_000, Some(100), tip, memo.clone()), T0)
                .await
                .unwrap(),
            Observed::Unchanged
        );
    }
    let b = l.balance(&pk(1)).await.unwrap().unwrap();
    assert_eq!((b.available_zat, b.held_zat, b.frozen), (1_000_000, 0, false));

    // Same memo paid again (new note): credited again.
    assert_eq!(
        l.observe_note(&note(1, 500_000, Some(150), 160, memo), T0)
            .await
            .unwrap(),
        Observed::Credited
    );
    assert_eq!(l.balance(&pk(1)).await.unwrap().unwrap().available_zat, 1_500_000);
    db.drop_schema().await;
}

#[tokio::test]
async fn bad_expired_dust() {
    let Some(db) = setup().await else { return };
    let l = &db.ledger;
    // Bad signature: memo signed for mainnet.
    let wrong_chain = Unz1Body {
        op: Op::Deposit,
        venue: Venue::None,
        mint: [0; 32],
        min_out: 0,
        anon_pubkey: [0; 32],
        nonce: 1,
        expiry: T0 as u32 + 60,
        target: Target::None,
    }
    .sign(&user(2), ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta))
    .encode();
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(1), 10, MemoInput::Text(wrong_chain)), T0)
            .await
            .unwrap(),
        Observed::Frozen
    );
    assert_eq!(
        l.observe_note(&note(1, 1_000_000, Some(1), 10, MemoInput::Text("hi".into())), T0)
            .await
            .unwrap(),
        Observed::Frozen
    );
    assert_eq!(l.balance(&pk(2)).await.unwrap(), None);

    let expired = deposit_memo(3, T0 as u32 - 1, Target::Shielded([9; 43]));
    assert_eq!(
        l.observe_note(&note(2, 1_000_000, Some(1), 10, MemoInput::Text(expired)), T0)
            .await
            .unwrap(),
        Observed::Credited
    );
    // Refunds are not used in memo v1: an expired deposit is credited even with a target.
    assert_eq!(l.balance(&pk(3)).await.unwrap().unwrap().available_zat, 1_000_000);

    let ok = deposit_memo(4, T0 as u32 + 60, Target::None);
    assert_eq!(
        l.observe_note(&note(3, 99_999, Some(1), 10, MemoInput::Text(ok)), T0)
            .await
            .unwrap(),
        Observed::Dust
    );
    assert_eq!(l.balance(&pk(4)).await.unwrap(), None);

    let stats = l.deposit_stats().await.unwrap();
    assert!(stats.contains(&("frozen".into(), 2)) && stats.contains(&("dust".into(), 1)));
    db.drop_schema().await;
}

#[tokio::test]
async fn reorg_after_credit_freezes_balance() {
    let Some(db) = setup().await else { return };
    let l = &db.ledger;
    let memo = MemoInput::Text(deposit_memo(5, T0 as u32 + 60, Target::None));
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(10), 20, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::Credited
    );
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, None, 20, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::ReorgAlert
    );
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, None, 21, memo), T0).await.unwrap(),
        Observed::Unchanged
    );
    let b = l.balance(&pk(5)).await.unwrap().unwrap();
    assert!(b.frozen);
    assert_eq!(b.available_zat, 1_000_000, "never debited silently");
    let r = l.submit_action(&pk(5), &[1; 16], &[0; 32], "buy", 100_000).await;
    assert!(matches!(r, Err(LedgerError::Frozen)), "{r:?}");
    db.drop_schema().await;
}

#[tokio::test]
async fn holds_are_atomic_and_idempotent() {
    let Some(db) = setup().await else { return };
    let l = Arc::new(db.ledger.clone());
    let memo = MemoInput::Text(deposit_memo(6, T0 as u32 + 60, Target::None));
    l.observe_note(&note(0, 1_000_000, Some(1), 10, memo), T0)
        .await
        .unwrap();
    let me = pk(6);

    // Below minimum / insufficient: nonce not consumed.
    assert!(matches!(
        l.submit_action(&me, &[1; 16], &[1; 32], "buy", 10).await,
        Err(LedgerError::BelowMinimum)
    ));
    assert!(matches!(
        l.submit_action(&me, &[1; 16], &[1; 32], "buy", 2_000_000).await,
        Err(LedgerError::InsufficientBalance)
    ));

    // Retry of the same signed request returns the original receipt, no double hold.
    let a = l.submit_action(&me, &[1; 16], &[1; 32], "buy", 300_000).await.unwrap();
    let a2 = l.submit_action(&me, &[1; 16], &[1; 32], "buy", 300_000).await.unwrap();
    assert!(!a.replayed && a2.replayed && a.id == a2.id);
    assert!(matches!(
        l.submit_action(&me, &[1; 16], &[2; 32], "buy", 300_000).await,
        Err(LedgerError::Replay)
    ));
    let b = l.balance(&me).await.unwrap().unwrap();
    assert_eq!((b.available_zat, b.held_zat), (700_000, 300_000));

    // 10 concurrent holds of 300k against 700k available: exactly 2 succeed.
    let mut tasks = Vec::new();
    for i in 0..10u8 {
        let l = l.clone();
        tasks.push(tokio::spawn(async move {
            l.submit_action(&me, &[100 + i; 16], &[i; 32], "buy", 300_000).await
        }));
    }
    let mut ok = Vec::new();
    for t in tasks {
        if let Ok(r) = t.await.unwrap() {
            ok.push(r.id);
        }
    }
    assert_eq!(ok.len(), 2);
    let b = l.balance(&me).await.unwrap().unwrap();
    assert_eq!((b.available_zat, b.held_zat), (100_000, 900_000));

    // settle spends, fail releases; double close is NotFound.
    l.settle_action(&a.id).await.unwrap();
    l.fail_action(&ok[0], "venue_unavailable").await.unwrap();
    assert!(matches!(l.fail_action(&ok[0], "x").await, Err(LedgerError::NotFound)));
    let b = l.balance(&me).await.unwrap().unwrap();
    assert_eq!((b.available_zat, b.held_zat), (400_000, 300_000));

    // Journal sums equal the balance.
    let row = db
        .admin
        .query_one(
            &format!(
                "SELECT sum(delta_available)::bigint, sum(delta_held)::bigint FROM {}.ledger_ops WHERE anon_pubkey = $1",
                db.schema
            ),
            &[&&me[..]],
        )
        .await
        .unwrap();
    assert_eq!((row.get::<_, i64>(0), row.get::<_, i64>(1)), (400_000, 300_000));
    db.drop_schema().await;
}

#[tokio::test]
async fn api_nonces_single_use() {
    let Some(db) = setup().await else { return };
    let l = &db.ledger;
    assert!(l.use_api_nonce(&pk(7), &[3; 16], 1_000).await.unwrap());
    assert!(!l.use_api_nonce(&pk(7), &[3; 16], 1_000).await.unwrap());
    assert!(l.use_api_nonce(&pk(8), &[3; 16], 1_000).await.unwrap());
    // ts far in the past -> already expired -> purged.
    assert_eq!(l.purge_api_nonces().await.unwrap(), 2);
    db.drop_schema().await;
}

impl TestDb {
    /// Run SQL in the test schema (plays the relayer).
    async fn sql(&self, q: &str) -> u64 {
        self.admin
            .execute(&format!("SET search_path = {}", self.schema), &[])
            .await
            .unwrap();
        self.admin.execute(q, &[]).await.unwrap()
    }

    async fn scalar_i64(&self, q: &str) -> i64 {
        self.admin
            .execute(&format!("SET search_path = {}", self.schema), &[])
            .await
            .unwrap();
        self.admin.query_one(q, &[]).await.unwrap().get(0)
    }
}

async fn fund(l: &Ledger, n: u8, i: u32, amount: u64) {
    let memo = MemoInput::Text(deposit_memo(n, T0 as u32 + 3600, Target::None));
    assert_eq!(
        l.observe_note(&note(i, amount, Some(1), 10, memo), T0).await.unwrap(),
        Observed::Credited
    );
}

const RATE: u64 = 10_000_000_000; // 10 SOL per ZEC

fn action(kind: &str, amount: u64, fee: u64, token: Option<(&str, u64)>, jobs: Vec<NewJob>) -> NewAction {
    NewAction {
        kind: kind.into(),
        amount_zat: amount,
        fee_zat: fee,
        token_hold: token.map(|(m, n)| (m.to_string(), n)),
        rate: Some(RateUsed {
            lamports_per_zec: RATE,
            source: "fixed".into(),
            ts_ms: T0 * 1000,
        }),
        network: "devnet".into(),
        jobs,
        payout: None,
    }
}

fn buy_job(mint: &str, lamports: u64) -> NewJob {
    NewJob {
        venue: Some("pumpfun".into()),
        mint: Some(mint.into()),
        lamports_in: Some(lamports),
        min_out: Some(1),
        ..NewJob::new(JobOp::Buy, 0.0)
    }
}

#[tokio::test]
async fn reorg_freeze_clears_when_remined() {
    let Some(db) = setup().await else { return };
    let l = &db.ledger;
    let memo = MemoInput::Text(deposit_memo(9, T0 as u32 + 60, Target::None));
    l.observe_note(&note(0, 1_000_000, Some(10), 20, memo.clone()), T0)
        .await
        .unwrap();
    // Interrupted pass: the note looks un-mined -> freeze.
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, None, 20, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::ReorgAlert
    );
    assert!(l.balance(&pk(9)).await.unwrap().unwrap().frozen);
    // Mined again but < K confirmations: still frozen.
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(21), 22, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::Unchanged
    );
    assert!(l.balance(&pk(9)).await.unwrap().unwrap().frozen);
    // >= K confirmations: flag cleared, balance unfrozen, amount intact, idempotent.
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(21), 23, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::ReorgCleared
    );
    assert_eq!(
        l.observe_note(&note(0, 1_000_000, Some(21), 24, memo.clone()), T0)
            .await
            .unwrap(),
        Observed::Unchanged
    );
    let b = l.balance(&pk(9)).await.unwrap().unwrap();
    assert_eq!((b.available_zat, b.frozen), (1_000_000, false));

    // Two reorged deposits: one re-mined is not enough to unfreeze.
    l.observe_note(&note(1, 500_000, Some(30), 40, memo.clone()), T0)
        .await
        .unwrap();
    l.observe_note(&note(0, 1_000_000, None, 40, memo.clone()), T0)
        .await
        .unwrap();
    l.observe_note(&note(1, 500_000, None, 40, memo.clone()), T0)
        .await
        .unwrap();
    l.observe_note(&note(0, 1_000_000, Some(41), 45, memo.clone()), T0)
        .await
        .unwrap();
    assert!(l.balance(&pk(9)).await.unwrap().unwrap().frozen);
    l.observe_note(&note(1, 500_000, Some(41), 45, memo), T0).await.unwrap();
    assert!(!l.balance(&pk(9)).await.unwrap().unwrap().frozen);
    db.drop_schema().await;
}

#[tokio::test]
async fn frozen_blocks_token_only_actions() {
    let Some(db) = setup().await else { return };
    let l = &db.ledger;
    fund(l, 10, 0, 1_000_000).await;
    db.sql(&format!(
        "INSERT INTO token_balances (anon_pubkey, mint, available) VALUES ('\\x{}', 'M1', 500)",
        hex::encode(pk(10))
    ))
    .await;
    db.sql("UPDATE balances SET frozen = TRUE").await;
    let sell = action("sell", 0, 0, Some(("M1", 100)), vec![]);
    assert!(matches!(
        l.submit(&pk(10), &[1; 16], &[1; 32], &sell).await,
        Err(LedgerError::Frozen)
    ));
    db.sql("UPDATE balances SET frozen = FALSE").await;
    // More tokens than held -> insufficient, nothing reserved.
    let too_much = action("sell", 0, 0, Some(("M1", 501)), vec![]);
    assert!(matches!(
        l.submit(&pk(10), &[2; 16], &[2; 32], &too_much).await,
        Err(LedgerError::InsufficientBalance)
    ));
    assert_eq!(db.scalar_i64("SELECT held FROM token_balances").await, 0);
    db.drop_schema().await;
}

#[tokio::test]
async fn buy_sell_withdraw_settlement() {
    let Some(db) = setup().await else { return };
    let l = &db.ledger;
    let me = pk(11);
    fund(l, 11, 0, 1_000_000).await;

    // BUY 0.005 ZEC -> 50_000_000 lamports; relayer spends 40M (20% back) and gets 7000 tokens.
    let buy = action("buy", 500_000, 0, None, vec![buy_job("MINT", 50_000_000)]);
    let r = l.submit(&me, &[1; 16], &[1; 32], &buy).await.unwrap();
    assert_eq!(r.rate.as_ref().unwrap().lamports_per_zec, RATE);
    assert_eq!(
        db.scalar_i64("SELECT count(*) FROM relayer_jobs WHERE status = 'queued' AND network = 'devnet'")
            .await,
        1
    );
    // Not settled while in flight.
    db.sql("UPDATE relayer_jobs SET status = 'sent', signature = 'SIG1'")
        .await;
    assert_eq!(l.settle_ready(10).await.unwrap(), 0);
    db.sql("UPDATE relayer_jobs SET status = 'confirmed', out_token_amount = 7000, out_lamports = 40000000")
        .await;
    assert_eq!(l.settle_ready(10).await.unwrap(), 1);
    assert_eq!(l.settle_ready(10).await.unwrap(), 0, "idempotent");
    let b = l.balance(&me).await.unwrap().unwrap();
    assert_eq!((b.available_zat, b.held_zat), (600_000, 0));
    let v = l.action_view(&me, &r.id).await.unwrap().unwrap();
    assert_eq!(v.status, "executed");
    assert_eq!(v.solana_tx.as_deref(), Some("SIG1"));
    assert_eq!(v.fill.as_ref().unwrap()["zecSpent"], json!("400000"));
    assert_eq!(
        l.action_view(&pk(99), &r.id).await.unwrap(),
        None,
        "other keys see nothing"
    );
    let h = l.token_holdings(&me).await.unwrap();
    assert_eq!((h[0].mint.as_str(), h[0].available, h[0].held), ("MINT", 7000, 0));

    // SELL 5000 tokens: relayer sells 4000 for 0.02 SOL -> 200_000 zat, 1000 tokens back.
    let sell = action(
        "sell",
        0,
        0,
        Some(("MINT", 5000)),
        vec![NewJob {
            venue: Some("pumpfun".into()),
            mint: Some("MINT".into()),
            token_amount: Some(5000),
            min_out: Some(0),
            ..NewJob::new(JobOp::Sell, 0.0)
        }],
    );
    let s = l.submit(&me, &[2; 16], &[2; 32], &sell).await.unwrap();
    assert_eq!(l.token_holdings(&me).await.unwrap()[0].held, 5000);
    db.sql(
        "UPDATE relayer_jobs SET status = 'confirmed', signature = 'SIG2', out_token_amount = 4000,
                out_lamports = 20000000 WHERE op = 'sell'",
    )
    .await;
    assert_eq!(l.settle_ready(10).await.unwrap(), 1);
    assert_eq!(l.balance(&me).await.unwrap().unwrap().available_zat, 800_000);
    let h = &l.token_holdings(&me).await.unwrap()[0];
    assert_eq!((h.available, h.held), (3000, 0));
    assert_eq!(l.action_view(&me, &s.id).await.unwrap().unwrap().status, "executed");

    // WITHDRAW_TOKEN in 2 parts with a fee: one part fails -> its tokens come back, fee spent.
    let part = |n: u64| NewJob {
        mint: Some("MINT".into()),
        token_amount: Some(n),
        dest: Some("DEST".into()),
        gas_lamports: Some(1_000_000),
        ..NewJob::new(JobOp::Transfer, 0.0)
    };
    let w = action(
        "withdraw_token",
        0,
        30_000,
        Some(("MINT", 3000)),
        vec![part(1000), part(2000)],
    );
    let wr = l.submit(&me, &[3; 16], &[3; 32], &w).await.unwrap();
    db.sql("UPDATE relayer_jobs SET status = 'confirmed', signature = 'SIG3' WHERE op = 'transfer' AND part = 0")
        .await;
    assert_eq!(l.settle_ready(10).await.unwrap(), 0, "waits for all parts");
    db.sql(
        "UPDATE relayer_jobs SET status = 'failed', error_code = 'pool_liquidity' WHERE op = 'transfer' AND part = 1",
    )
    .await;
    assert_eq!(l.settle_ready(10).await.unwrap(), 1);
    let h = &l.token_holdings(&me).await.unwrap()[0];
    assert_eq!((h.available, h.held), (2000, 0));
    let b = l.balance(&me).await.unwrap().unwrap();
    assert_eq!((b.available_zat, b.held_zat), (770_000, 0));
    assert_eq!(l.action_view(&me, &wr.id).await.unwrap().unwrap().status, "executed");

    // BUY that fails: full release, error code exposed to the owner.
    let f = l
        .submit(
            &me,
            &[4; 16],
            &[4; 32],
            &action("buy", 200_000, 0, None, vec![buy_job("M2", 1)]),
        )
        .await
        .unwrap();
    db.sql("UPDATE relayer_jobs SET status = 'failed', error_code = 'slippage' WHERE mint = 'M2'")
        .await;
    l.settle_ready(10).await.unwrap();
    let v = l.action_view(&me, &f.id).await.unwrap().unwrap();
    assert_eq!((v.status.as_str(), v.error.as_deref()), ("failed", Some("slippage")));
    assert_eq!(l.balance(&me).await.unwrap().unwrap().available_zat, 770_000);

    // Journals add up.
    let row = db
        .admin
        .query_one(
            &format!(
                "SELECT sum(delta_available)::bigint, sum(delta_held)::bigint FROM {}.ledger_ops WHERE anon_pubkey = $1",
                db.schema
            ),
            &[&&me[..]],
        )
        .await
        .unwrap();
    assert_eq!((row.get::<_, i64>(0), row.get::<_, i64>(1)), (770_000, 0));
    assert_eq!(
        db.scalar_i64("SELECT sum(delta_available)::bigint FROM token_ops")
            .await,
        2000
    );

    // N5: no exact times / heights next to the anon key.
    assert_eq!(
        db.scalar_i64(
            "SELECT count(*) FROM deposits WHERE anon_pubkey IS NOT NULL
               AND (mined_height IS NOT NULL OR created_at <> date_trunc('day', created_at, 'UTC'))"
        )
        .await,
        0
    );
    assert_eq!(
        db.scalar_i64("SELECT count(*) FROM ledger_ops WHERE created_at <> date_trunc('day', created_at, 'UTC')")
            .await,
        0
    );

    // M9 detach after 24 h.
    db.sql("UPDATE relayer_jobs SET settled_at = now() - interval '25 hours'")
        .await;
    assert_eq!(l.detach_old_jobs().await.unwrap(), 5);
    assert_eq!(l.action_view(&me, &r.id).await.unwrap().unwrap().solana_tx, None);
    db.drop_schema().await;
}

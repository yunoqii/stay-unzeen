//! Ledger integration tests against a real Postgres.
//!
//! Uses `DATABASE_URL` (or the repo-root `.env`). Each test runs in a fresh schema that is
//! dropped afterwards. Without a database the tests print "skip" and pass, so `cargo test`
//! stays green on machines without Docker; CI must set DATABASE_URL.

use std::sync::Arc;

use tokio_postgres::NoTls;
use unzeen_ledger::{Ledger, LedgerError, MemoInput, NoteObs, NoteRefKey, Observed, PgConfig, Policy};
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
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("skip: DATABASE_URL not set");
        return None;
    };
    let (admin, conn) = match tokio_postgres::connect(&url, NoTls).await {
        Ok(x) => x,
        Err(e) => {
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
        Observed::RefundPending
    );
    assert_eq!(l.balance(&pk(3)).await.unwrap(), None);

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

//! API integration tests: real HTTP server + real Postgres (fresh schema per test).
//!
//! Uses DATABASE_URL (or the repo-root `.env`). Without a database the tests print "skip"
//! and pass; with REQUIRE_PG=1 a missing database is a failure.

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use unzeen_api::{
    AppState,
    config::{Config, ExecConfig, FairConfig, Fees, IntelConfig, LaunchConfig, Limits, RateConfig},
    rate::now_ms,
    router,
};
use unzeen_ledger::{
    Ledger, MemoInput, NoteObs, NoteRefKey, PgConfig, Policy,
    tokio_postgres::{self, NoTls},
};
use unzeen_protocol::{
    ChainId, SigningKey, SolanaCluster, ZcashNet, api_auth,
    memo::{Op, Target, Unz1Body, Venue},
};
use zcash_address::unified::{self, Encoding};

const CHAIN: ChainId = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
const MAINNET: ChainId = ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta);
const MINT: &str = "So11111111111111111111111111111111111111112";
const MINT2: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/// 10 SOL per ZEC.
const RATE: u64 = 10_000_000_000;

struct Env {
    base: String,
    http: reqwest::Client,
    ledger: Ledger,
    admin: tokio_postgres::Client,
    schema: String,
    state: AppState,
}

fn config(url: &str) -> Config {
    Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        database_url: url.into(),
        network: "test",
        cluster: "devnet",
        policy: Policy {
            chain: CHAIN,
            confirmations: 3,
            min_deposit_zat: 100_000,
            min_action_zat: 100_000,
            credit_jitter: 0,
        },
        pool_address: None,
        media_dir: std::env::temp_dir().join("unzeen-media-test"),
        rate: RateConfig {
            fixed_lamports_per_zec: Some(RATE),
            oneclick_url: "http://127.0.0.1:9".into(),
            oneclick_jwt: None,
            cache_secs: 45,
            max_stale_secs: 300,
            spread_bps: 0,
        },
        exec: ExecConfig {
            epoch_min_secs: 30.0,
            epoch_max_secs: 60.0,
            max_epoch_min_secs: 300.0,
            max_epoch_max_secs: 900.0,
            withdraw_token_delay_min_secs: 30.0,
            withdraw_token_delay_max_secs: 300.0,
            zec_payout_delay_min_secs: 60.0,
            zec_payout_delay_max_secs: 600.0,
        },
        create_enabled: true,
        fees: Fees {
            now_fee_zat: 500,
            create_fee_zat: 100_000,
            withdraw_zec_fee_zat: 15_000,
            withdraw_token_gas_lamports: 2_000_000,
            withdraw_token_cost_lamports: 2_100_000,
        },
        venues: vec!["pumpfun".into()],
        actions_enabled: true,
        limits: Limits {
            ip_per_sec: 1000.0,
            ip_burst: 1000.0,
            key_per_min: 6000.0,
            key_burst: 1000.0,
            max_ws: 10,
        },
        cors_origins: vec![],
        launch: LaunchConfig {
            lock_secs: 86_400,
            cap_bps: 500,
            total_supply: 1_000_000_000_000_000,
            virtual_sol_lamports: 30_000_000_000,
            virtual_token_reserves: 1_073_000_000_000_000,
            curve_from_env: false,
            launch_fee_bps_pumpfun: 30,
            launch_fee_bps_dbc: 40,
        },
        intel: IntelConfig {
            full_trades: false,
            queue_max: 256,
            whale_lamports: 1_000_000_000,
        },
        fair: FairConfig {
            enabled: false,
            windows_secs: vec![120, 300],
            hold_tiers_zat: unzeen_api::config::default_hold_tiers(false),
            max_total_bps: 2_500,
            min_bids_for_count: 5,
            drand_urls: vec!["http://127.0.0.1:9".into()],
            fee_bound_bps: 300,
            slippage_bps: 50,
            drand_give_up_secs: 3_600,
            rate_give_up_secs: 600,
        },
        verify: unzeen_api::config::VerifyConfig {
            daily: false,
            timing: unzeen_ledger::verify::VerifyTiming::default(),
            proof_bucket: 65_536,
        },
        stats: unzeen_api::config::StatsConfig {
            daily: false,
            params: unzeen_ledger::stats::StatsParams::default(),
        },
    }
}

async fn setup_with(tweak: impl FnOnce(&mut Config)) -> Option<Env> {
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
            eprintln!("skip: cannot connect: {e}");
            return None;
        }
    };
    tokio::spawn(conn);
    let schema = format!("t_{}", hex::encode(rand::random::<[u8; 6]>()));
    admin.batch_execute(&format!("CREATE SCHEMA {schema}")).await.unwrap();
    admin
        .batch_execute(&format!("SET search_path = {schema}"))
        .await
        .unwrap();
    let mut pg: PgConfig = url.parse().unwrap();
    pg.options(format!("-c search_path={schema}"));
    let mut cfg = config(&url);
    tweak(&mut cfg);
    let ledger = Ledger::connect_with(pg, cfg.policy).await.unwrap();
    let st = AppState::new(cfg, ledger.clone());
    unzeen_api::spawn_background(&st);
    let state = st.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router(st).into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    Some(Env {
        base: format!("http://{addr}"),
        http: reqwest::Client::new(),
        ledger,
        admin,
        schema,
        state,
    })
}

async fn setup() -> Option<Env> {
    setup_with(|_| {}).await
}

fn user(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

struct Resp {
    status: StatusCode,
    headers: reqwest::header::HeaderMap,
    body: Value,
    raw_len: usize,
}

impl Env {
    async fn drop_schema(self) {
        let _ = self
            .admin
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await;
    }

    async fn sql(&self, q: &str) {
        self.admin.batch_execute(q).await.unwrap();
    }

    async fn one_i64(&self, q: &str) -> i64 {
        self.admin.query_one(q, &[]).await.unwrap().get(0)
    }

    async fn raw(&self, method: &str, path: &str, body: &str, headers: Option<&api_auth::SignedHeaders>) -> Resp {
        let mut rb = self
            .http
            .request(method.parse().unwrap(), format!("{}{}", self.base, path))
            .body(body.to_string());
        if let Some(h) = headers {
            rb = rb
                .header(api_auth::H_PUBKEY, &h.pubkey)
                .header(api_auth::H_NONCE, &h.nonce)
                .header(api_auth::H_TS, &h.ts)
                .header(api_auth::H_SIG, &h.sig);
        }
        let r = rb.send().await.unwrap();
        let status = r.status();
        let headers = r.headers().clone();
        let text = r.text().await.unwrap();
        let raw_len = text.len();
        let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Resp {
            status,
            headers,
            body,
            raw_len,
        }
    }

    fn sign(&self, sk: &SigningKey, method: &str, path: &str, body: &str) -> api_auth::SignedHeaders {
        api_auth::sign_request(CHAIN, sk, method, path, body.as_bytes(), rand::random(), now_ms())
    }

    async fn signed(&self, sk: &SigningKey, method: &str, path: &str, body: &str) -> Resp {
        let h = self.sign(sk, method, path, body);
        self.raw(method, path, body, Some(&h)).await
    }

    async fn get(&self, path: &str) -> Resp {
        self.raw("GET", path, "", None).await
    }

    /// Credit a deposit to `user(n)` as the scanner would.
    async fn fund(&self, n: u8, i: u32, amount: u64) {
        let memo = Unz1Body {
            op: Op::Deposit,
            venue: Venue::None,
            mint: [0; 32],
            min_out: 0,
            anon_pubkey: [0; 32],
            nonce: 1,
            expiry: (now_ms() / 1000) as u32 + 3600,
            target: Target::None,
        }
        .sign(&user(n), CHAIN)
        .encode();
        let obs = NoteObs {
            note_ref: NoteRefKey::new([1; 32]).note_ref(&[n; 32], 4, i),
            amount_zat: amount,
            mined_height: Some(1),
            tip: 10,
            block_time: Some(now_ms() / 1000),
            memo: MemoInput::Text(memo),
            public_source: false,
        };
        self.ledger.observe_note(&obs, now_ms() / 1000).await.unwrap();
    }
}

fn code(r: &Resp) -> &str {
    r.body["error"]["code"].as_str().unwrap_or("")
}

fn buy_body(zec_in: u64) -> String {
    json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":zec_in.to_string(),"minOut":"1","exec":"delayed"})
        .to_string()
}

#[tokio::test]
async fn pool_info() {
    let Some(e) = setup().await else { return };
    let r = e.get("/api/pool").await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{:?}", r.body);
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let r = e.get("/api/pool").await;
    assert_eq!(r.status, StatusCode::OK);
    let mut b = r.body.clone();
    let rate = b
        .as_object_mut()
        .unwrap()
        .remove("rate")
        .expect("fixed devnet rate is public");
    assert_eq!(rate["lamportsPerZec"], RATE.to_string());
    assert_eq!(rate["source"], "fixed");
    assert_eq!(rate["lamportsPerZecBuy"], rate["lamportsPerZec"], "spread 0 in tests");
    assert_eq!(
        b,
        json!({"address":"utest1example","network":"test","chainId":"0202",
               "minDepositZat":"100000","minActionZat":"100000","confirmations":3,
               "createEnabled":true,
               "orders": unzeen_api::orders::pool_block(),
               "features":{"fullTrades":false},
               "launchRules":{"lockSecs":86400,"capBps":500,"maxInitialBuyLamports":"1466000000",
                              "maxInitialBuyLamportsByVenue":{"pumpfun":"1466000000"}},
               "fees":{"createFeeZat":"100000","withdrawZecFeeZat":"15000",
                       "withdrawTokenGasLamports":"2000000","withdrawTokenCostLamports":"2100000",
                       "nowFeeZat":"500"}})
    );
    assert!(r.headers.get("set-cookie").is_none());
    // A pool published for another network is never served.
    e.ledger.set_pool_meta("network", "main").await.unwrap();
    assert_eq!(e.get("/api/pool").await.status, StatusCode::INTERNAL_SERVER_ERROR);
    e.drop_schema().await;
}

#[tokio::test]
async fn portfolio_auth_and_replay() {
    let Some(e) = setup().await else { return };
    let me = user(1);

    let r = e.get("/api/portfolio").await;
    assert_eq!((r.status, code(&r)), (StatusCode::UNAUTHORIZED, "unauthorized"));

    // Fresh key: zeros, no-store.
    let r = e.signed(&me, "GET", "/api/portfolio", "").await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["zecBalance"], "0");
    assert_eq!(r.headers["cache-control"], "no-store");

    e.fund(1, 0, 1_000_000).await;
    let h = e.sign(&me, "GET", "/api/portfolio", "");
    let r = e.raw("GET", "/api/portfolio", "", Some(&h)).await;
    assert_eq!(r.body["zecBalance"], "1000000");
    assert_eq!(r.body["frozen"], false);
    let dep = &r.body["deposits"][0];
    assert_eq!(dep["amountZat"], "1000000");
    assert_eq!(dep["status"], "credited");
    assert_eq!(dep["id"].as_str().unwrap().len(), 32);
    assert_eq!(dep["ts"].as_u64().unwrap() % 86_400_000, 0, "day-rounded");

    // Same nonce again -> replay.
    let r = e.raw("GET", "/api/portfolio", "", Some(&h)).await;
    assert_eq!((r.status, code(&r)), (StatusCode::CONFLICT, "replay"));

    // Signed for mainnet -> rejected on the testnet API.
    let hm = api_auth::sign_request(MAINNET, &me, "GET", "/api/portfolio", b"", rand::random(), now_ms());
    assert_eq!(
        e.raw("GET", "/api/portfolio", "", Some(&hm)).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Stale timestamp.
    let hs = api_auth::sign_request(
        CHAIN,
        &me,
        "GET",
        "/api/portfolio",
        b"",
        rand::random(),
        now_ms() - 61_000,
    );
    assert_eq!(
        e.raw("GET", "/api/portfolio", "", Some(&hs)).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Path signed differently from the request-target (query appended) -> 401.
    let h2 = e.sign(&me, "GET", "/api/portfolio", "");
    assert_eq!(
        e.raw("GET", "/api/portfolio?x=1", "", Some(&h2)).await.status,
        StatusCode::UNAUTHORIZED
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn buy_flow_hold_retry_settle() {
    let Some(e) = setup().await else { return };
    let me = user(2);
    e.fund(2, 0, 1_000_000).await;

    // Below minimum / insufficient / not enabled venue / bad body.
    let r = e.signed(&me, "POST", "/api/actions", &buy_body(50_000)).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::UNPROCESSABLE_ENTITY, "below_minimum")
    );
    let r = e.signed(&me, "POST", "/api/actions", &buy_body(2_000_000)).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::UNPROCESSABLE_ENTITY, "insufficient_balance")
    );
    let mbody = json!({"op":"buy","venue":"meteora-dbc","mint":MINT,"zecIn":"200000","minOut":"1","exec":"delayed"})
        .to_string();
    let r = e.signed(&me, "POST", "/api/actions", &mbody).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::SERVICE_UNAVAILABLE, "venue_unavailable")
    );
    for bad in [
        "not json",
        r#"{"op":"buy","venue":"pumpfun","mint":"x","zecIn":"200000","minOut":"1","exec":"delayed"}"#,
        r#"{"op":"buy","venue":"pumpfun","mint":"So11111111111111111111111111111111111111112","zecIn":"0200000","minOut":"1","exec":"delayed"}"#,
        r#"{"op":"claim","extra":1}"#,
    ] {
        let r = e.signed(&me, "POST", "/api/actions", bad).await;
        assert_eq!((r.status, code(&r)), (StatusCode::BAD_REQUEST, "bad_request"), "{bad}");
    }

    // Success: hold placed, rate fixed in the response, job queued with jitter.
    let body = buy_body(400_000);
    let h = e.sign(&me, "POST", "/api/actions", &body);
    let r = e.raw("POST", "/api/actions", &body, Some(&h)).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["status"], "queued");
    assert_eq!(r.body["rate"]["lamportsPerZec"], RATE.to_string());
    assert_eq!(r.body["rate"]["source"], "fixed");
    let id = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(id.len(), 32);

    // Retry of the same signed request -> same receipt; same nonce + other body -> replay.
    let r2 = e.raw("POST", "/api/actions", &body, Some(&h)).await;
    assert_eq!(
        (r2.status, r2.body["id"].as_str().unwrap()),
        (StatusCode::OK, id.as_str())
    );
    let other = buy_body(300_000);
    let mut h3 = h.clone();
    // Re-sign the other body with the SAME nonce.
    let nonce: [u8; 16] = hex::decode(&h.nonce).unwrap().try_into().unwrap();
    let hs = api_auth::sign_request(CHAIN, &me, "POST", "/api/actions", other.as_bytes(), nonce, now_ms());
    h3.sig = hs.sig;
    h3.ts = hs.ts;
    let r3 = e.raw("POST", "/api/actions", &other, Some(&h3)).await;
    assert_eq!((r3.status, code(&r3)), (StatusCode::CONFLICT, "replay"));

    // D10: 0.04 SOL shaved 0-1 % and rounded down to 0.001 SOL -> 0.039 SOL (0.040 only if
    // the shave is exactly 0); the user is charged only that (10 SOL/ZEC -> 390_000 zat).
    let lamports = e
        .one_i64(&format!(
            "SELECT lamports_in FROM {}.relayer_jobs WHERE status = 'queued' AND network = 'devnet'",
            e.schema
        ))
        .await;
    assert!(lamports == 39_000_000 || lamports == 40_000_000, "{lamports}");
    let held = lamports / 100;
    let p = e.signed(&me, "GET", "/api/portfolio", "").await;
    assert_eq!(
        (p.body["zecBalance"].as_str(), p.body["zecHeld"].as_str()),
        (
            Some((1_000_000 - held).to_string().as_str()),
            Some(held.to_string().as_str())
        )
    );
    // D2: not_before is an epoch boundary 0..60 s ahead.
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {}.relayer_jobs WHERE not_before > now() AND not_before <= now() + interval '61 seconds'",
            e.schema
        ))
        .await,
        1
    );
    // The relayer's tables carry no anon key.
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema = '{}'
               AND table_name IN ('relayer_jobs', 'trades', 'tokens') AND column_name = 'anon_pubkey'",
            e.schema
        ))
        .await,
        0
    );

    // Status: owner sees it, others get 404, malformed id 404.
    let path = format!("/api/actions/{id}");
    let s = e.signed(&me, "GET", &path, "").await;
    assert_eq!((s.status, s.body["status"].as_str()), (StatusCode::OK, Some("queued")));
    assert_eq!(e.signed(&user(3), "GET", &path, "").await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        e.signed(&me, "GET", "/api/actions/xyz", "").await.status,
        StatusCode::NOT_FOUND
    );

    // Relayer wrote the signature before broadcast -> owner sees "sent".
    e.sql(&format!(
        "UPDATE {}.relayer_jobs SET status = 'sent', signature = 'SIGBUY'",
        e.schema
    ))
    .await;
    let s = e.signed(&me, "GET", &path, "").await;
    assert_eq!(s.body["status"], "sent");

    // Relayer confirms; the background settler closes the hold.
    e.sql(&format!(
        "UPDATE {}.relayer_jobs SET status = 'confirmed', signature = 'SIGBUY', out_token_amount = 123456,
                out_lamports = lamports_in",
        e.schema
    ))
    .await;
    let mut done = Value::Null;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let s = e.signed(&me, "GET", &path, "").await;
        if s.body["status"] == "executed" {
            done = s.body;
            break;
        }
    }
    assert_eq!(done["solanaTx"], "SIGBUY", "{done:?}");
    assert_eq!(done["fill"]["tokenAmount"], "123456");
    let p = e.signed(&me, "GET", "/api/portfolio", "").await;
    assert_eq!(p.body["zecHeld"], "0");
    assert_eq!(
        p.body["holdings"][0],
        json!({"mint": MINT, "amount": "123456", "held": "0"})
    );

    // Sell more than held -> insufficient; graduated token -> 409.
    let sell = |amt: &str| {
        json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":amt,"minZecOut":"100000","exec":"delayed"})
            .to_string()
    };
    let r = e.signed(&me, "POST", "/api/actions", &sell("999999")).await;
    assert_eq!(code(&r), "insufficient_balance");
    e.sql(&format!(
        "INSERT INTO {}.tokens (mint, venue, symbol, name, decimals, status) VALUES ('{MINT}', 'pumpfun', 'X', 'X', 6, 'graduated')",
        e.schema
    ))
    .await;
    let r = e.signed(&me, "POST", "/api/actions", &sell("1000")).await;
    assert_eq!((r.status, code(&r)), (StatusCode::CONFLICT, "graduated"));

    // Frozen balance: every action -> 423.
    e.sql(&format!("UPDATE {}.balances SET frozen = TRUE", e.schema)).await;
    let b2 =
        json!({"op":"buy","venue":"pumpfun","mint":MINT2,"zecIn":"100000","minOut":"1","exec":"delayed"}).to_string();
    let r = e.signed(&me, "POST", "/api/actions", &b2).await;
    assert_eq!((r.status, code(&r)), (StatusCode::LOCKED, "balance_frozen"));
    e.drop_schema().await;
}

#[tokio::test]
async fn withdrawals_and_create() {
    let Some(e) = setup().await else { return };
    let me = user(4);
    e.fund(4, 0, 2_000_000).await;

    // withdraw_zec: t-address / mainnet UA rejected, testnet UA with Orchard accepted.
    let ua = |net| {
        unified::Address::try_from_items(
            unified::Revision::R0,
            vec![unified::Uitem::Data(unified::Receiver::Orchard([7; 43]))],
        )
        .unwrap()
        .encode(&net)
    };
    let wz = |to: &str| json!({"op":"withdraw_zec","to":to,"amount":"500000"}).to_string();
    for bad in [
        "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd".to_string(),
        ua(zcash_protocol::consensus::NetworkType::Main),
    ] {
        let r = e.signed(&me, "POST", "/api/actions", &wz(&bad)).await;
        assert_eq!(code(&r), "bad_request", "{bad}");
    }
    let r = e
        .signed(
            &me,
            "POST",
            "/api/actions",
            &wz(&ua(zcash_protocol::consensus::NetworkType::Test)),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(
        e.one_i64(&format!("SELECT held_zat FROM {}.balances", e.schema)).await,
        515_000
    );
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {}.zec_payouts WHERE status = 'queued'",
            e.schema
        ))
        .await,
        1
    );

    // create with an initial buy: fee + buy held, one create job with meta.
    let png = format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0x89, b'P', b'N', b'G'])
    );
    let c = json!({"op":"create","venue":"pumpfun","meta":{"name":"Pepe Unzeen","symbol":"PUNZ","image":png},
                   "initialBuyZec":"200000"})
    .to_string();
    let r = e.signed(&me, "POST", "/api/actions", &c).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let l = e
        .one_i64(&format!(
            "SELECT lamports_in FROM {}.relayer_jobs WHERE op = 'create' AND meta->>'symbol' = 'PUNZ'",
            e.schema
        ))
        .await;
    assert!(l == 19_000_000 || l == 20_000_000, "{l}");
    let bad = json!({"op":"create","venue":"pumpfun","meta":{"name":"x","symbol":"$$$"}}).to_string();
    assert_eq!(code(&e.signed(&me, "POST", "/api/actions", &bad).await), "bad_request");

    // withdraw_token (smart, 2 parts): needs tokens; fee from gas + cost at the rate.
    e.sql(&format!(
        "INSERT INTO {}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{}', '{MINT2}', 1000)",
        e.schema,
        hex::encode(me.verifying_key().to_bytes())
    ))
    .await;
    let dests = [MINT, "11111111111111111111111111111112"];
    let wt = json!({"op":"withdraw_token","mint":MINT2,"amount":"1000","to":dests,"exec":"delayed",
                    "smart":{"parts":2,"maxDelayMin":5}})
    .to_string();
    let r = e.signed(&me, "POST", "/api/actions", &wt).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(
        e.one_i64(&format!(
            "SELECT sum(token_amount)::bigint FROM {}.relayer_jobs WHERE op = 'transfer'
              AND not_before > now() + interval '20 seconds'",
            e.schema
        ))
        .await,
        1000
    );
    // fee = 2 parts * 4.1M lamports at 10 SOL/ZEC = 82_000 zat.
    assert_eq!(
        e.one_i64(&format!(
            "SELECT fee_zat FROM {}.actions WHERE kind = 'withdraw_token'",
            e.schema
        ))
        .await,
        82_000
    );
    let mismatch = json!({"op":"withdraw_token","mint":MINT2,"amount":"10","to":[MINT],"exec":"delayed",
                          "smart":{"parts":2,"maxDelayMin":5}})
    .to_string();
    assert_eq!(
        code(&e.signed(&me, "POST", "/api/actions", &mismatch).await),
        "bad_request"
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn market_endpoints_and_ws() {
    let Some(e) = setup().await else { return };
    assert_eq!(e.get("/api/feed").await.body, json!([]));
    assert_eq!(e.get("/api/tokens").await.body, json!([]));
    // v0.5: an unknown mint is queued for the indexer (202), not 404.
    assert_eq!(e.get(&format!("/api/tokens/{MINT}")).await.status, StatusCode::ACCEPTED);
    assert_eq!(e.get("/api/tokens/notamint").await.status, StatusCode::NOT_FOUND);
    assert_eq!(e.get("/api/nope").await.status, StatusCode::NOT_FOUND);

    e.sql(&format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol)
           VALUES ('{MINT}', 'pumpfun', 'PEPE', 'Pepe', 6, 0.000000028, 28.5);
         INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, ts) VALUES
           ('create', 'pumpfun', '{MINT}', 'PEPE', 0, 0, 6, 'S0', to_timestamp(1800000000)),
           ('buy', 'pumpfun', '{MINT}', 'PEPE', 1000000000, 1000000000, 6, 'S1', to_timestamp(1800000010)),
           ('buy', 'pumpfun', '{MINT}', 'PEPE', 1000000000, 2000000000, 6, 'S2', to_timestamp(1800000020)),
           ('sell', 'pumpfun', '{MINT}', 'PEPE', 1000000000, 500000000, 6, 'S3', to_timestamp(1800000400));",
        s = e.schema
    ))
    .await;

    let t = e.get("/api/tokens").await.body;
    assert_eq!(t[0]["priceSol"], "0.000000028");
    assert_eq!(t[0]["marketCapSol"], "28.5");
    let one = e.get(&format!("/api/tokens/{MINT}")).await.body;
    assert_eq!(one["trades"].as_array().unwrap().len(), 4);
    assert_eq!(one["trades"][0]["solanaTx"], "S3");
    assert_eq!(one["trades"][0]["ts"], 1_800_000_400_000u64);
    let feed = e.get("/api/feed?limit=2").await.body;
    assert_eq!(feed.as_array().unwrap().len(), 2);
    assert_eq!(e.get("/api/feed?limit=500").await.status, StatusCode::BAD_REQUEST);
    let before = one["trades"][1]["id"].as_str().unwrap();
    let page = e
        .get(&format!("/api/tokens/{MINT}/trades?before={before}&limit=10"))
        .await
        .body;
    assert_eq!(page.as_array().unwrap().len(), 2);

    // Candles (5m): bar 1 = two buys at 1 and 2 SOL per 1000 tokens; bar 2 = one sell.
    let c = e
        .get(&format!(
            "/api/tokens/{MINT}/candles?tf=5m&from=1799999000&to=1800001000"
        ))
        .await;
    assert_eq!(c.status, StatusCode::OK, "{:?}", c.body);
    assert_eq!(
        c.body,
        json!([
            {"time":1800000000u64,"open":"0.001","high":"0.002","low":"0.001","close":"0.002","volume":"3000000000"},
            {"time":1800000300u64,"open":"0.0005","high":"0.0005","low":"0.0005","close":"0.0005","volume":"500000000"}
        ])
    );
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}/candles?tf=7m")).await.status,
        StatusCode::BAD_REQUEST
    );

    // WS with mint filter receives new trades of that mint only.
    let ws_url = format!("{}/ws/feed?mint={MINT}", e.base.replace("http", "ws"));
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await; // poller initialised
    e.sql(&format!(
        "INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, ts) VALUES
           ('buy', 'pumpfun', '{MINT2}', 'USDT', 1, 1, 6, 'OTHER', now()),
           ('buy', 'pumpfun', '{MINT}', 'PEPE', 5, 7, 6, 'LIVE', now());",
        s = e.schema
    ))
    .await;
    // Older rows may still arrive first (poller started before they were inserted); the
    // filter must never let another mint through.
    let msg = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                let v = serde_json::from_str::<Value>(&t).unwrap();
                assert_eq!(v["mint"], MINT);
                if v["solanaTx"] == "LIVE" {
                    return v;
                }
            }
        }
    })
    .await
    .expect("ws event");
    assert_eq!(msg["solanaTx"], "LIVE");
    assert_eq!(msg["tokenAmount"], "5");
    e.drop_schema().await;
}

#[tokio::test]
async fn rate_limited_with_retry_after() {
    let Some(e) = setup_with(|c| {
        c.limits.ip_per_sec = 0.5;
        c.limits.ip_burst = 3.0;
    })
    .await
    else {
        return;
    };
    let mut last = None;
    for _ in 0..5 {
        last = Some(e.get("/api/feed").await);
    }
    let r = last.unwrap();
    assert_eq!((r.status, code(&r)), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    assert!(r.headers.get("retry-after").is_some());
    e.drop_schema().await;
}

#[tokio::test]
async fn mainnet_actions_disabled_by_default() {
    let Some(e) = setup_with(|c| c.actions_enabled = false).await else {
        return;
    };
    let r = e.signed(&user(5), "POST", "/api/actions", &buy_body(100_000)).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::SERVICE_UNAVAILABLE, "venue_unavailable")
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn media_by_hash_only() {
    let Some(e) = setup().await else { return };
    let dir = std::env::temp_dir().join("unzeen-media-test");
    std::fs::create_dir_all(&dir).unwrap();
    let name = format!("{}.png", "ab".repeat(20));
    std::fs::write(dir.join(&name), b"\x89PNG").unwrap();
    let r = e.raw("GET", &format!("/media/{name}"), "", None).await;
    assert_eq!(r.status, StatusCode::OK);
    for bad in [
        "/media/",
        "/media/..%2Fx.png",
        "/media/ABAB.png",
        &format!("/media/{}.svg", "ab".repeat(20)),
        &format!("/media/{}.png", "cd".repeat(20)),
    ] {
        assert_eq!(e.raw("GET", bad, "", None).await.status, StatusCode::NOT_FOUND, "{bad}");
    }
    e.drop_schema().await;
}

#[tokio::test]
async fn create_without_executor_is_unavailable() {
    // D6: until a relayer executes `create`, the API refuses it and holds nothing.
    let Some(e) = setup_with(|c| c.create_enabled = false).await else {
        return;
    };
    let me = user(7);
    e.fund(7, 0, 2_000_000).await;
    let c = json!({"op":"create","venue":"pumpfun","meta":{"name":"Nope","symbol":"NOPE"},"initialBuyZec":"200000"})
        .to_string();
    let r = e.signed(&me, "POST", "/api/actions", &c).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::SERVICE_UNAVAILABLE, "venue_unavailable")
    );
    assert_eq!(
        e.one_i64(&format!("SELECT held_zat FROM {}.balances", e.schema)).await,
        0
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn exec_now_runs_at_once_and_charges_the_fee() {
    let Some(e) = setup().await else { return };
    let me = user(8);
    e.fund(8, 0, 2_000_000).await;
    let body = json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":"400000","minOut":"1","exec":"now"}).to_string();
    let r = e.signed(&me, "POST", "/api/actions", &body).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {}.relayer_jobs WHERE exec_mode = 'now' AND not_before <= now()",
            e.schema
        ))
        .await,
        1
    );
    // Flat now fee (500 zat in tests) on top of the buy.
    assert_eq!(
        e.one_i64(&format!("SELECT fee_zat FROM {}.actions", e.schema)).await,
        500
    );
    // Withdrawals refuse `now`; `pad` is accepted and ignored.
    let wz = json!({"op":"withdraw_zec","to":"utest1x","amount":"100000","exec":"now"}).to_string();
    assert_eq!(code(&e.signed(&me, "POST", "/api/actions", &wz).await), "bad_request");
    let padded =
        json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":"400000","minOut":"1","pad":"      "}).to_string();
    let r = e.signed(&me, "POST", "/api/actions", &padded).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.raw_len % 1024, 0, "padded response");
    // Portfolio lists own action statuses, padded to a fixed bucket.
    let p = e.signed(&me, "GET", "/api/portfolio", "").await;
    assert_eq!(p.body["actions"].as_array().unwrap().len(), 2);
    assert_eq!(p.body["actions"][0]["status"], "queued");
    assert_eq!(p.raw_len % 4096, 0);
    // `max`: epoch 5..15 min ahead, mode recorded for the relayer.
    let body = json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":"400000","minOut":"1","exec":"max"}).to_string();
    assert_eq!(
        e.signed(&me, "POST", "/api/actions", &body).await.status,
        StatusCode::OK
    );
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {}.relayer_jobs WHERE exec_mode = 'max'
               AND not_before > now() AND not_before <= now() + interval '901 seconds'",
            e.schema
        ))
        .await,
        1
    );
    e.drop_schema().await;
}

// ------------------------------------------------------------------ v0.5: token intel

const MINT3: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/// Indexer snapshot as docs/INTEL.md describes it.
fn snapshot() -> Value {
    json!({
        "program": "token-2022",
        "authorities": {"mintRevoked": true, "freezeRevoked": true, "metadataImmutable": true, "riskyExtensions": []},
        "holders": {"top10Pct": "21.5", "devPct": "4.2", "unzeenPoolPct": "1.1"},
        "dev": {"address": MINT3, "launchesSeen": 2, "rugsSeen": 1, "since": 1_760_000_000_000u64},
        "market": {"venue": "pumpfun", "status": "curve", "curveProgressPct": "12.5"},
        "socials": {"twitter": "https://x.com/pepe"},
        "image": "https://api.example/media/0123456789abcdef0123456789abcdef01234567.png"
    })
}

impl Env {
    async fn put_snapshot(&self, mint: &str, data: &Value) {
        self.admin
            .execute(
                &format!(
                    "INSERT INTO {}.token_safety (mint, as_of, data)
                     VALUES ($1, date_trunc('minute', now()), $2)",
                    self.schema
                ),
                &[&mint, data],
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn token_safety_pending_and_snapshots() {
    let Some(e) = setup().await else { return };
    let s = &e.schema;

    // Malformed mint -> 400 (safety), 404 (token, as before).
    assert_eq!(code(&e.get("/api/tokens/not-a-mint/safety").await), "bad_request");

    // Cold mint: 202 pending for everyone, queued once, no indexer schedule yet -> 60 s.
    for _ in 0..2 {
        let r = e.get(&format!("/api/tokens/{MINT2}/safety")).await;
        assert_eq!(r.status, StatusCode::ACCEPTED);
        assert_eq!(r.body, json!({"status": "pending", "retryAfterMs": 60_000}));
        assert_eq!(r.headers["cache-control"], "public, max-age=60");
        assert!(r.headers.get("set-cookie").is_none());
    }
    assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.intel_requests")).await, 1);
    // GET /api/tokens/:mint of a cold mint: also 202 + queue; never listed in /api/tokens.
    let r = e.get(&format!("/api/tokens/{MINT3}")).await;
    assert_eq!(r.status, StatusCode::ACCEPTED);
    assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.intel_requests")).await, 2);
    // The queue time is minute-rounded.
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.intel_requests WHERE queued_at <> date_trunc('minute', queued_at)"
        ))
        .await,
        0
    );

    // Indexer publishes its schedule: retryAfterMs follows it (+10 s margin).
    e.sql(&format!(
        "INSERT INTO {s}.intel_meta (key, value) VALUES ('next_tick_at', '{}')",
        now_ms() + 20_000
    ))
    .await;
    let r = e.get(&format!("/api/tokens/{MINT2}/safety")).await;
    let ms = r.body["retryAfterMs"].as_i64().unwrap();
    assert!((25_000..=30_000).contains(&ms), "{ms}");

    // Tick: the indexer writes the snapshot + token card and drains the request.
    e.put_snapshot(MINT2, &snapshot()).await;
    e.sql(&format!(
        "INSERT INTO {s}.intel_tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, created_at, as_of)
         VALUES ('{MINT2}', 'pumpfun', 'FOO', 'Foo', 6, 0.0000001, 100, now(), date_trunc('minute', now()));
         INSERT INTO {s}.intel_warm (mint, expires_at) VALUES ('{MINT2}', now() + interval '7 days');
         DELETE FROM {s}.intel_requests WHERE mint = '{MINT2}';"
    ))
    .await;
    let r = e.get(&format!("/api/tokens/{MINT2}/safety")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.headers["cache-control"], "public, max-age=60");
    let b = &r.body;
    assert_eq!(b["mint"], MINT2);
    assert_eq!(b["asOf"].as_i64().unwrap() % 60_000, 0);
    assert_eq!(b["holders"]["devPct"], "4.2");
    assert_eq!(b["dev"]["launchesSeen"], 2);
    assert!(b.get("unzeen").is_none());
    // Token card from the snapshot; trades/candles empty; still not in the public list.
    let t = e.get(&format!("/api/tokens/{MINT2}")).await;
    assert_eq!(t.status, StatusCode::OK);
    assert_eq!(
        (t.body["symbol"].as_str(), &t.body["trades"]),
        (Some("FOO"), &json!([]))
    );
    assert_eq!(e.get("/api/tokens").await.body, json!([]));
    assert_eq!(e.get(&format!("/api/tokens/{MINT2}/candles")).await.body, json!([]));
    assert_eq!(e.get(&format!("/api/tokens/{MINT2}/trades")).await.body, json!([]));

    // The indexer found no such mint -> 404 on both.
    e.sql(&format!(
        "INSERT INTO {s}.token_safety (mint, as_of, missing) VALUES ('{MINT3}', date_trunc('minute', now()), TRUE)"
    ))
    .await;
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT3}/safety")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT3}")).await.status,
        StatusCode::NOT_FOUND
    );

    // T1: an Unzeen launch never shows the creator's share or history.
    e.sql(&format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals) VALUES ('{MINT}', 'pumpfun', 'UNZ', 'Unz', 6);
         INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, ts)
         VALUES ('create', 'pumpfun', '{MINT}', 'UNZ', 0, 0, 6, 'SIGC', now()),
                ('buy', 'pumpfun', '{MINT}', 'UNZ', 1000, 2000000000, 6, 'SIGC', now()),
                ('buy', 'pumpfun', '{MINT}', 'UNZ', 10, 1000000, 6, 'SIGB', now());"
    ))
    .await;
    // Pool token without a snapshot yet: 202, but nothing is queued (it is pinned instead).
    let before = e.one_i64(&format!("SELECT count(*) FROM {s}.intel_requests")).await;
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}/safety")).await.status,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        e.one_i64(&format!("SELECT count(*) FROM {s}.intel_requests")).await,
        before
    );
    e.put_snapshot(MINT, &snapshot()).await;
    let b = e.get(&format!("/api/tokens/{MINT}/safety")).await.body;
    assert!(b.get("dev").is_none(), "{b}");
    assert_eq!(b["holders"]["devPct"], Value::Null);
    assert_eq!(b["holders"]["unzeenPoolPct"], "1.1");
    assert_eq!(
        b["unzeen"],
        json!({"launch": true, "rules": ["creator_initial_buy_locked_24h", "initial_buy_cap_5pct", "authorities_revoked"]})
    );

    // Trade filters without the full feed.
    let r = e.get(&format!("/api/tokens/{MINT}/trades?filter=whales")).await;
    assert_eq!((r.status, code(&r)), (StatusCode::BAD_REQUEST, "feature_disabled"));
    assert_eq!(
        code(&e.get(&format!("/api/tokens/{MINT}/trades?filter=dev")).await),
        "feature_disabled"
    );
    assert_eq!(
        code(&e.get(&format!("/api/tokens/{MINT}/trades?filter=nope")).await),
        "bad_request"
    );
    let all = e.get(&format!("/api/tokens/{MINT}/trades?filter=all")).await;
    assert_eq!(all.headers["cache-control"], "public, max-age=60");
    let all = all.body;
    assert_eq!(all.as_array().unwrap().len(), 3);
    assert!(all.as_array().unwrap().iter().all(|t| t["trader"] == "unzeen"));
    assert_eq!(all[0]["tags"], json!([]));
    assert_eq!(all[1]["tags"], json!(["whale"]));
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}/trades?filter=unzeen")).await.body,
        all
    );
    let page = e
        .get(&format!(
            "/api/tokens/{MINT}/trades?filter=all&limit=1&before={}",
            all[0]["id"].as_str().unwrap()
        ))
        .await
        .body;
    assert_eq!(page, json!([all[1]]));
    // No filter: plain FeedEvent[].
    let plain = e.get(&format!("/api/tokens/{MINT}/trades")).await.body;
    assert!(plain[0].get("trader").is_none());

    // Warm-set sync: pool tokens pinned (hot after a trade), expired searched mints dropped
    // with their snapshots; a searched mint never enters `tokens`.
    e.sql(&format!(
        "INSERT INTO {s}.intel_warm (mint, expires_at) VALUES ('{MINT3}', now() - interval '1 minute')
         ON CONFLICT (mint) DO UPDATE SET expires_at = EXCLUDED.expires_at;
         UPDATE {s}.token_safety SET as_of = date_trunc('minute', now() - interval '2 hours') WHERE mint = '{MINT3}';"
    ))
    .await;
    unzeen_api::intel::warm_sync(&e.state).await.unwrap();
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.intel_warm WHERE mint = '{MINT}' AND pinned AND hot"
        ))
        .await,
        1
    );
    assert_eq!(
        e.one_i64(&format!("SELECT count(*) FROM {s}.intel_warm WHERE mint = '{MINT3}'"))
            .await,
        0
    );
    assert_eq!(
        e.one_i64(&format!("SELECT count(*) FROM {s}.token_safety WHERE mint = '{MINT3}'"))
            .await,
        0
    );
    assert_eq!(
        e.one_i64(&format!("SELECT count(*) FROM {s}.token_safety WHERE mint = '{MINT2}'"))
            .await,
        1
    );
    assert_eq!(
        e.one_i64(&format!("SELECT count(*) FROM {s}.tokens WHERE mint <> '{MINT}'"))
            .await,
        0
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn creator_rules_lock_and_cap() {
    let Some(e) = setup().await else { return };
    let s = &e.schema;
    let me = user(6);
    e.fund(6, 0, 100_000_000).await;

    // Initial buy above the cap (2 SOL > 1.466 SOL at 10 SOL/ZEC) -> 422, nothing held.
    let create = |zec: &str| {
        json!({"op":"create","venue":"pumpfun","meta":{"name":"Rules","symbol":"RULE"},"initialBuyZec":zec}).to_string()
    };
    let r = e.signed(&me, "POST", "/api/actions", &create("20000000")).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::UNPROCESSABLE_ENTITY, "creator_cap"),
        "{:?}",
        r.body
    );
    assert_eq!(e.one_i64(&format!("SELECT held_zat FROM {s}.balances")).await, 0);

    // 1 SOL initial buy: accepted; the relayer creates MINT and buys 34e12 base units.
    let r = e.signed(&me, "POST", "/api/actions", &create("10000000")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGCREATE', out_mint = '{MINT}',
                out_token_amount = 34000000000000, out_lamports = lamports_in WHERE op = 'create'"
    ))
    .await;
    let path = format!("/api/actions/{id}");
    let mut done = Value::Null;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let st = e.signed(&me, "GET", &path, "").await;
        if st.body["status"] == "executed" {
            done = st.body;
            break;
        }
    }
    // executedAt: top level, minute-rounded, not inside fill.
    let at = done["executedAt"]
        .as_u64()
        .unwrap_or_else(|| panic!("executedAt: {done:?}"));
    assert_eq!(at % 60_000, 0);
    assert!(at <= now_ms() && now_ms() - at < 120_000);
    assert!(done["fill"].get("executedAt").is_none());
    assert_eq!(done["fill"]["mint"], MINT);
    // Lock: the initial-buy amount until >= 24 h from now, rounded up to the hour.
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.creator_tokens WHERE mint = '{MINT}' AND locked_amount = 34000000000000
               AND locked_until >= now() + interval '24 hours' AND locked_until <= now() + interval '25 hours'
               AND locked_until = date_trunc('hour', locked_until)"
        ))
        .await,
        1
    );

    // Locked: selling or withdrawing any of the initial buy -> 423.
    let sell =
        |amt: &str| json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":amt,"minZecOut":"100000"}).to_string();
    for body in [
        sell("34000000000000"),
        sell("1"),
        json!({"op":"withdraw_token","mint":MINT,"amount":"5","to":MINT2}).to_string(),
    ] {
        let r = e.signed(&me, "POST", "/api/actions", &body).await;
        assert_eq!((r.status, code(&r)), (StatusCode::LOCKED, "creator_locked"), "{body}");
    }
    // More than the balance at all -> still insufficient_balance.
    let r = e.signed(&me, "POST", "/api/actions", &sell("99000000000000")).await;
    assert_eq!(code(&r), "insufficient_balance");
    // Tokens bought later are free to sell.
    e.sql(&format!(
        "UPDATE {s}.token_balances SET available = available + 1000000000 WHERE mint = '{MINT}'"
    ))
    .await;
    let r = e.signed(&me, "POST", "/api/actions", &sell("1000000000")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);

    // Cap: position 34e12 (+1e9 held). A 0.5 SOL buy may reach ~17.6e12 -> over 50e12.
    let buy = |zec: &str| json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":zec,"minOut":"1"}).to_string();
    let r = e.signed(&me, "POST", "/api/actions", &buy("5000000")).await;
    assert_eq!((r.status, code(&r)), (StatusCode::UNPROCESSABLE_ENTITY, "creator_cap"));
    // 0.1 SOL fits; its estimate counts while queued, so another 0.4 SOL does not.
    let r = e.signed(&me, "POST", "/api/actions", &buy("1000000")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let r = e.signed(&me, "POST", "/api/actions", &buy("4000000")).await;
    assert_eq!(code(&r), "creator_cap");
    // Other keys are not creators: no cap for them.
    e.fund(7, 0, 100_000_000).await;
    let r = e.signed(&user(7), "POST", "/api/actions", &buy("20000000")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(
        e.one_i64(&format!("SELECT count(*) FROM {s}.actions WHERE gain_mint IS NOT NULL"))
            .await,
        1,
        "only the creator's buy keeps an estimate"
    );

    // Lock over: the janitor clears it, selling works.
    e.sql(&format!(
        "UPDATE {s}.creator_tokens SET locked_until = now() - interval '1 second'"
    ))
    .await;
    assert_eq!(e.state.ledger.janitor().await.unwrap().unlocked, 1);
    let r = e.signed(&me, "POST", "/api/actions", &sell("1000")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    e.drop_schema().await;
}

// ================================================================== fair launch (API v0.6)

mod fair {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::{Router, extract::Path, http::StatusCode as S, routing::get};
    use unzeen_fair::{alloc, bid::BidPlaintext, drand, merkle};

    use super::*;

    const SIG_1000: &str =
        "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";
    const SIG_1001: &str =
        "b33bf3667cbd5a82de3a24b4e0e9fe5513cc1a0e840368c6e31f5fcfa79bea03f73896b25883abf2853d10337fb8fa41";
    /// devnet pump.fun Global: 1 SOL virtual, 1.073e15 virtual tokens, 7.931e14 real, 1e15 supply.
    const VS: u64 = 1_000_000_000;
    const VT: u64 = 1_073_000_000_000_000;
    const SUPPLY: u64 = 1_000_000_000_000_000;

    /// Mock drand relay: serves the REAL quicknet signatures of rounds 1000/1001 from the
    /// fixture; while `forged` is set it answers round 1000 with the signature of round 1001.
    /// Any other round: 425 Too Early.
    async fn mock_drand(forged: Arc<AtomicBool>) -> String {
        let app = Router::new().route(
            "/{hash}/public/{round}",
            get(move |Path((hash, round)): Path<(String, u64)>| {
                let forged = forged.clone();
                async move {
                    if hash != drand::QUICKNET_CHAIN_HASH_HEX {
                        return (S::NOT_FOUND, String::new());
                    }
                    let sig = match round {
                        1000 if forged.load(Ordering::SeqCst) => SIG_1001,
                        1000 => SIG_1000,
                        1001 => SIG_1001,
                        _ => return (S::from_u16(425).unwrap(), String::new()),
                    };
                    (
                        S::OK,
                        json!({"round": round, "randomness": "00", "signature": sig}).to_string(),
                    )
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    async fn fair_env(drand_url: String) -> Option<Env> {
        let e = setup_with(move |c| {
            c.fair.enabled = true;
            c.fair.windows_secs = vec![120, 300];
            c.fair.drand_urls = vec![drand_url];
            // Round 1000 is in 2023: never give up in tests.
            c.fair.drand_give_up_secs = 1_000_000_000;
            c.fair.rate_give_up_secs = 1_000_000_000;
        })
        .await?;
        e.sql(&format!(
            "INSERT INTO {s}.launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves,
                                             real_token_reserves, token_total_supply)
             VALUES ('devnet', 'pumpfun', {VS}, {VT}, 793100000000000, {SUPPLY});
             ALTER TABLE {s}.fl_launches DROP CONSTRAINT fl_launches_check;",
            s = e.schema
        ))
        .await;
        Some(e)
    }

    fn create_body() -> String {
        json!({"op":"fl_create","venue":"pumpfun","meta":{"name":"Fair One","symbol":"FAIR"},"windowSecs":120})
            .to_string()
    }

    impl Env {
        /// Create a launch as user(n) and make it open now with reveal round 1000.
        async fn open_launch(&self, n: u8) -> String {
            let r = self.signed(&user(n), "POST", "/api/actions", &create_body()).await;
            assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
            assert_eq!(r.body["status"], "queued");
            let id = r.body["launchId"].as_str().unwrap().to_string();
            // Not published before the epoch boundary.
            assert_eq!(
                self.get(&format!("/api/launches/{id}")).await.status,
                StatusCode::NOT_FOUND
            );
            self.sql(&format!(
                "UPDATE {s}.fl_launches SET published_at = now() - interval '1 second',
                        close_at = now() + interval '1 hour', round = 1000,
                        round_time = to_timestamp({t}) WHERE id = '\\x{id}'",
                s = self.schema,
                t = drand::QUICKNET_GENESIS + 999 * 3
            ))
            .await;
            id
        }

        async fn close(&self, id: &str) {
            self.sql(&format!(
                "UPDATE {}.fl_launches SET close_at = now() - interval '1 millisecond' WHERE id = '\\x{id}'",
                self.schema
            ))
            .await;
        }

        async fn bid(&self, n: u8, id: &str, hold: u64, ct: &str) -> Resp {
            let body = json!({"op":"fl_bid","launchId":id,"holdZat":hold.to_string(),"ciphertext":ct}).to_string();
            self.signed(&user(n), "POST", "/api/actions", &body).await
        }

        async fn wait_status(&self, id: &str, want: &str) -> Value {
            for _ in 0..150 {
                let r = self.get(&format!("/api/launches/{id}")).await;
                if r.body["status"] == want {
                    return r.body;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!(
                "launch never reached {want}: {:?}",
                self.get(&format!("/api/launches/{id}")).await.body
            );
        }

        pub(super) async fn avail(&self, n: u8) -> (i64, i64) {
            let pk = user(n).verifying_key().to_bytes();
            let r = self
                .admin
                .query_one(
                    &format!(
                        "SELECT available_zat, held_zat FROM {}.balances WHERE anon_pubkey = $1",
                        self.schema
                    ),
                    &[&&pk[..]],
                )
                .await
                .unwrap();
            (r.get(0), r.get(1))
        }
    }

    fn sealed(n: u8, id: &str, amount: u64) -> String {
        let p = BidPlaintext {
            chain: CHAIN.to_bytes(),
            launch_id: hex::decode(id).unwrap().try_into().unwrap(),
            anon_pubkey: user(n).verifying_key().to_bytes(),
            amount_zat: amount,
        };
        drand::encrypt(1000, &p.encode())
    }

    #[tokio::test]
    async fn fair_launch_full_cycle() {
        let forged = Arc::new(AtomicBool::new(true));
        let url = mock_drand(forged.clone()).await;
        let Some(e) = fair_env(url).await else { return };
        let s = e.schema.clone();
        for n in 1..=6 {
            e.fund(n, 0, 100_000_000).await;
        }

        // PoolInfo: flag on, caps from the network curve (devnet: ~0.304 SOL total, ~0.048 SOL creator).
        e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
        let pool = e.get("/api/pool").await.body;
        assert_eq!(pool["features"]["fairLaunch"], true);
        let max_total = alloc::curve_max_lamports(VS, VT, SUPPLY / 4);
        let creator_max = alloc::curve_max_lamports(VS, VT, SUPPLY / 20);
        assert_eq!(pool["fairLaunch"]["maxTotalLamports"], max_total.to_string());
        assert_eq!(pool["fairLaunch"]["creatorMaxLamports"], creator_max.to_string());
        assert_eq!(pool["launchRules"]["maxInitialBuyLamports"], creator_max.to_string());
        assert_eq!(pool["fairLaunch"]["drand"]["chainHash"], drand::QUICKNET_CHAIN_HASH_HEX);
        assert_eq!(pool["fairLaunch"]["holdTiersZat"][0], "100000");

        let id = e.open_launch(1).await;
        assert_eq!(e.avail(1).await, (100_000_000 - 100_000, 100_000), "create fee held");
        let l = e.get(&format!("/api/launches/{id}")).await;
        assert_eq!(l.status, StatusCode::OK);
        assert_eq!(l.headers["cache-control"], "public, max-age=5");
        assert_eq!(l.body["status"], "open");
        assert_eq!(l.body["drand"]["round"], 1000);
        assert!(l.body.get("commitment").is_none() && l.body.get("result").is_none());
        assert!(
            l.body["rules"]
                .as_array()
                .unwrap()
                .contains(&json!("fair_launch_sealed_bids"))
        );

        // Submission checks.
        let ct2 = sealed(2, &id, 1_000_000);
        assert_eq!(code(&e.bid(2, &id, 1_234, &ct2).await), "bad_request", "tier");
        assert_eq!(code(&e.bid(2, &id, 1_000_000, "hello").await), "bad_ciphertext");
        let other_round = drand::encrypt(1001, &[0; 64]);
        assert_eq!(code(&e.bid(2, &id, 1_000_000, &other_round).await), "bad_ciphertext");
        let unknown = "00".repeat(16);
        assert_eq!(e.bid(2, &unknown, 1_000_000, &ct2).await.status, StatusCode::NOT_FOUND);
        // Creator: tier above the 5 % cap (~0.0048 ZEC at 10 SOL/ZEC → tier 0.005) → 422.
        let ct1 = sealed(1, &id, 500_000);
        assert_eq!(code(&e.bid(1, &id, 1_000_000, &ct1).await), "creator_cap");

        // Bids: creator (trimmed at reveal), two valid, a copied ciphertext, an over-hold amount.
        let ct3 = sealed(3, &id, 2_000_000);
        let ct5 = sealed(5, &id, 600_000);
        for (n, hold, ct) in [
            (1, 500_000, &ct1),
            (2, 1_000_000, &ct2),
            (3, 2_500_000, &ct3),
            (4, 1_000_000, &ct2),
            (5, 500_000, &ct5),
        ] {
            let r = e.bid(n, &id, hold, ct).await;
            assert_eq!(r.status, StatusCode::OK, "user {n}: {:?}", r.body);
            assert_eq!(r.body["status"], "queued");
        }
        assert_eq!(e.avail(3).await, (100_000_000 - 2_500_000, 2_500_000), "hold = tier");
        // One sealed bid per key; cancel releases; idempotent retry of the same request.
        let ct6 = sealed(6, &id, 300_000);
        assert_eq!(e.bid(6, &id, 500_000, &ct6).await.status, StatusCode::OK);
        assert_eq!(code(&e.bid(6, &id, 500_000, &ct6).await), "already_bid");
        let cancel = json!({"op":"fl_cancel","launchId":id}).to_string();
        let h = e.sign(&user(6), "POST", "/api/actions", &cancel);
        let r = e.raw("POST", "/api/actions", &cancel, Some(&h)).await;
        assert_eq!(r.body["status"], "executed", "{:?}", r.body);
        let again = e.raw("POST", "/api/actions", &cancel, Some(&h)).await;
        assert_eq!(again.body["id"], r.body["id"]);
        assert_eq!(e.avail(6).await, (100_000_000, 0));
        assert_eq!(
            code(&e.signed(&user(6), "POST", "/api/actions", &cancel).await),
            "not_found"
        );

        // Owner view before close: sealed, no amount, no proof; no fl_* in actions.
        let pf = e.signed(&user(2), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf["fairBids"][0]["status"], "sealed");
        assert!(pf["fairBids"][0].get("amountZat").is_none() && pf["fairBids"][0].get("proof").is_none());
        assert_eq!(pf["actions"].as_array().unwrap().len(), 0);
        let pf1 = e.signed(&user(1), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf1["fairLaunches"][0]["launchId"], id);
        assert_eq!(pf1["fairLaunches"][0]["status"], "open");
        // Nobody sees a count before the round.
        let list = e.get("/api/launches?status=open").await.body;
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert!(!list.to_string().contains("\"bids\"") && list[0].get("result").is_none());
        assert_eq!(e.get("/api/launches?status=nope").await.status, StatusCode::BAD_REQUEST);

        // Close → root + attest job; reveal round in the past → revealing with a FORGED beacon.
        e.close(&id).await;
        assert_eq!(code(&e.bid(6, &id, 500_000, &ct6).await), "launch_closed");
        let l = e.wait_status(&id, "revealing").await;
        let root = l["commitment"]["root"].as_str().unwrap().to_string();
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'attest' AND exec_mode = 'now'
                   AND action_id IS NULL AND meta->>'memo' = '{root}'"
            ))
            .await,
            1
        );
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // Forged beacon: NO bid judged, nothing decrypted, no job.
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.fl_bids WHERE status <> 'sealed' AND status <> 'cancelled'"
            ))
            .await,
            0
        );
        assert_eq!(e.wait_status(&id, "revealing").await["status"], "revealing");
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'fair_create'"
            ))
            .await,
            0
        );

        // Proofs are available from close on and verify against the root.
        let pf = e.signed(&user(2), "GET", "/api/portfolio", "").await.body;
        let proof = &pf["fairBids"][0]["proof"];
        let leaf: [u8; 32] = hex::decode(proof["leaf"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(leaf, merkle::leaf(&ct2));
        let path: Vec<[u8; 32]> = proof["path"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| hex::decode(h.as_str().unwrap()).unwrap().try_into().unwrap())
            .collect();
        assert_eq!(path.len(), 10, "fixed depth 10 whatever the bid count (F7)");
        let root_b: [u8; 32] = hex::decode(&root).unwrap().try_into().unwrap();
        assert!(merkle::verify(&leaf, &path, &root_b));

        // Real beacon → reveal → executing.
        forged.store(false, Ordering::SeqCst);
        e.sql(&format!("UPDATE {s}.fl_launches SET next_try_at = NULL")).await;
        let l = e.wait_status(&id, "executing").await;
        assert_eq!(l["drand"]["signature"], SIG_1000);
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.fl_bids WHERE ciphertext IS NOT NULL"
            ))
            .await,
            0
        );
        assert_eq!(
            e.avail(4).await,
            (100_000_000, 0),
            "copied ciphertext → invalid, released"
        );
        assert_eq!(e.avail(5).await, (100_000_000, 0), "amount > hold → invalid, released");
        let pf4 = e.signed(&user(4), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf4["fairBids"][0]["status"], "invalid");
        assert!(pf4["fairBids"][0].get("amountZat").is_none());

        // The job: one fair_create, D10-rounded, within the cap, fixed mint keypair, no action link.
        let job = e
            .admin
            .query_one(
                &format!(
                    "SELECT lamports_in, min_out, mint_secret, exec_mode, action_id IS NULL, venue, meta->>'symbol'
                     FROM {s}.relayer_jobs WHERE op = 'fair_create'"
                ),
                &[],
            )
            .await
            .unwrap();
        let lamports_in = job.get::<_, i64>(0) as u64;
        let secret: Vec<u8> = job.get(2);
        assert_eq!(lamports_in % alloc::LAMPORTS_STEP, 0);
        assert!(lamports_in <= max_total);
        assert_eq!(secret.len(), 64);
        assert_eq!(
            (job.get::<_, String>(3), job.get::<_, bool>(4)),
            ("now".to_string(), true)
        );
        assert_eq!(
            (job.get::<_, String>(5), job.get::<_, String>(6)),
            ("pumpfun".into(), "FAIR".into())
        );
        let sk = SigningKey::from_bytes(&secret[..32].try_into().unwrap());
        assert_eq!(sk.verifying_key().to_bytes()[..], secret[32..]);
        let mint = unzeen_protocol::pubkey_to_b58(&secret[32..].try_into().unwrap());

        // Expected allocation (test re-derives it from the public formulas).
        let bids = [
            alloc::ValidBid {
                amount_zat: 500_000,
                is_creator: true,
            },
            alloc::ValidBid {
                amount_zat: 1_000_000,
                is_creator: false,
            },
            alloc::ValidBid {
                amount_zat: 2_000_000,
                is_creator: false,
            },
        ];
        let plan = alloc::plan(&bids, RATE, max_total, creator_max);
        assert!(plan.oversubscribed);
        assert_eq!(plan.effective[0], creator_max * max_total / (creator_max + 300_000_000));
        assert!(lamports_in <= plan.total && plan.total - lamports_in <= plan.total / 100 + alloc::LAMPORTS_STEP);

        // Relayer: both jobs confirmed.
        let spent = lamports_in - 1_000;
        let t = alloc::curve_tokens_out(VS, VT, spent) * 99 / 100;
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGFAIR', out_mint = '{mint}',
                    out_token_amount = {t}, out_lamports = {spent} WHERE op = 'fair_create';
             UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGATTEST', slot = 77,
                    vault = 'AttestKey111', out_memo = '{root}', out_block_time = 1692806300
              WHERE op = 'attest' AND meta->>'purpose' = 'fair';"
        ))
        .await;
        let l = e.wait_status(&id, "launched").await;
        assert_eq!(l["result"]["mint"], mint);
        assert_eq!(l["result"]["solanaTx"], "SIGFAIR");
        assert_eq!(l["result"]["bids"], "<5");
        assert_eq!(l["result"]["oversubscribed"], true);
        assert_eq!(l["result"]["tokenAmount"], t.to_string());
        assert_eq!(l["result"]["totalLamports"], spent.to_string());
        assert_eq!(l["commitment"]["attestation"]["solanaTx"], "SIGATTEST");
        assert_eq!(l["commitment"]["attestation"]["slot"], 77);
        assert_eq!(l["commitment"]["attestation"]["matches"], true);
        // F2: block time 1692806300 s vs t(1000) = 1692806364 s → anchored before the round.
        assert_eq!(l["commitment"]["attestation"]["blockTime"], 1_692_806_300);
        assert_eq!(l["commitment"]["attestation"]["beforeRound"], true);

        let mut tok_sum = 0u64;
        for (i, (n, amount)) in [(1u8, 500_000u64), (2, 1_000_000), (3, 2_000_000)]
            .into_iter()
            .enumerate()
        {
            let e_i = e
                .one_i64(&format!(
                    "SELECT e_lamports FROM {s}.fl_bids WHERE anon_pubkey = '\\x{}'",
                    hex::encode(user(n).verifying_key().to_bytes())
                ))
                .await as u64;
            let e_total: u64 = e
                .one_i64(&format!("SELECT total_e FROM {s}.fl_launches WHERE id = '\\x{id}'"))
                .await as u64;
            assert_eq!(e_i, plan.effective[i], "user {n}");
            assert_eq!(e_total, plan.total);
            let sh = alloc::share(e_i, plan.total, t, spent, RATE, amount);
            let toks = e
                .one_i64(&format!(
                    "SELECT available FROM {s}.token_balances WHERE mint = '{mint}' AND anon_pubkey = '\\x{}'",
                    hex::encode(user(n).verifying_key().to_bytes())
                ))
                .await as u64;
            assert_eq!(toks, sh.tokens, "user {n} tokens");
            assert!(sh.charge_zat <= amount);
            let fee = if n == 1 { 100_000 } else { 0 };
            assert_eq!(
                e.avail(n).await,
                (100_000_000 - fee - sh.charge_zat as i64, 0),
                "user {n} zec"
            );
            tok_sum += toks;
            if n == 1 {
                // Creator: within 5 % of the supply, locked 24 h.
                assert!(toks <= SUPPLY / 20, "{toks}");
                assert_eq!(
                    e.one_i64(&format!(
                        "SELECT count(*) FROM {s}.creator_tokens WHERE mint = '{mint}' AND locked_amount = {toks}
                           AND locked_until >= now() + interval '24 hours'"
                    ))
                    .await,
                    1
                );
            }
        }
        assert!(tok_sum <= t, "Σ t_i ≤ T");
        // v0.9: the creator fee of the launch tx (all participants' buys) is the pool's:
        // upper bound ceil(spent × 30 bps) without the relayer's exact figure.
        let launch_fee = (spent as i64 * 30 + 9_999) / 10_000;
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.creator_tokens WHERE mint = '{mint}'
                   AND launch_fee_lamports = {launch_fee} AND launch_fee_left = {launch_fee}"
            ))
            .await,
            1
        );
        // Owner view after settle; secret erased; launch visible as launched in the list.
        let pf = e.signed(&user(2), "GET", "/api/portfolio", "").await.body;
        let b = &pf["fairBids"][0];
        assert_eq!(b["status"], "settled");
        assert_eq!(b["amountZat"], "1000000");
        assert!(b["tokenAmount"].as_str().is_some() && b["chargedZat"].as_str().is_some());
        assert_eq!(pf["holdings"][0]["mint"], mint);
        assert_eq!(pf["actions"].as_array().unwrap().len(), 0);
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE mint_secret IS NOT NULL"
            ))
            .await,
            0
        );
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE settled_at IS NULL"
            ))
            .await,
            0
        );
        // Creator lock applies to the fair allocation.
        let sell = json!({"op":"sell","venue":"pumpfun","mint":mint,"amount":"1","minZecOut":"100000"}).to_string();
        assert_eq!(
            code(&e.signed(&user(1), "POST", "/api/actions", &sell).await),
            "creator_locked"
        );
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn fair_launch_hidden_when_disabled() {
        let Some(e) = setup().await else { return };
        e.fund(1, 0, 100_000_000).await;
        assert_eq!(e.get("/api/launches").await.status, StatusCode::NOT_FOUND);
        assert_eq!(
            e.get(&format!("/api/launches/{}", "00".repeat(16))).await.status,
            StatusCode::NOT_FOUND
        );
        // F1: no route at all — every method / malformed query / bad encoding = unknown path.
        let nope = e.raw("GET", "/api/nope", "", None).await;
        for (m, path) in [
            ("GET", "/api/launches"),
            ("POST", "/api/launches"),
            ("DELETE", "/api/launches/00"),
            ("GET", "/api/launches?status=a&status=b"),
            ("GET", "/api/launches/%FF"),
            ("PUT", "/api/launches/0000"),
        ] {
            let r = e.raw(m, path, "", None).await;
            assert_eq!((r.status, &r.body), (nope.status, &nope.body), "{m} {path}");
            assert!(r.headers.get("allow").is_none(), "{m} {path}: no Allow header");
        }
        let unknown = e.signed(&user(1), "POST", "/api/actions", r#"{"op":"nope"}"#).await;
        let fl = e.signed(&user(1), "POST", "/api/actions", &create_body()).await;
        assert_eq!(fl.status, StatusCode::BAD_REQUEST);
        assert_eq!(fl.body, unknown.body, "indistinguishable from an unknown op");
        e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
        let r = e.get("/api/pool").await;
        assert_eq!(r.status, StatusCode::OK);
        let raw = r.body.to_string();
        assert!(
            !raw.to_ascii_lowercase().contains("fair"),
            "PoolInfo mentions fair: {raw}"
        );
        let pf = e.signed(&user(1), "GET", "/api/portfolio", "").await.body;
        assert!(pf.get("fairBids").is_none() && pf.get("fairLaunches").is_none());
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn fair_launch_cancel_and_failures() {
        let forged = Arc::new(AtomicBool::new(false));
        let url = mock_drand(forged).await;
        let Some(e) = fair_env(url).await else { return };
        let s = e.schema.clone();
        for n in 1..=3 {
            e.fund(n, 0, 100_000_000).await;
        }
        // drand: future round → 425 → TooEarly; known round → verified beacon.
        assert!(matches!(
            e.state.drand.fetch(99_999_999_999).await,
            unzeen_api::fair::Fetch::TooEarly
        ));
        assert!(matches!(
            e.state.drand.fetch(1000).await,
            unzeen_api::fair::Fetch::Beacon(_)
        ));

        // Creator cancels: only the creator (others get 404), everything released.
        let a = e.open_launch(1).await;
        let ct2 = sealed(2, &a, 1_000_000);
        assert_eq!(e.bid(2, &a, 1_000_000, &ct2).await.status, StatusCode::OK);
        let cl = json!({"op":"fl_cancel_launch","launchId":a}).to_string();
        assert_eq!(
            e.signed(&user(2), "POST", "/api/actions", &cl).await.status,
            StatusCode::NOT_FOUND
        );
        let r = e.signed(&user(1), "POST", "/api/actions", &cl).await;
        assert_eq!(r.body["status"], "executed", "{:?}", r.body);
        assert_eq!(e.avail(1).await, (100_000_000, 0));
        assert_eq!(e.avail(2).await, (100_000_000, 0));
        assert_eq!(e.wait_status(&a, "cancelled").await["status"], "cancelled");
        assert_eq!(
            code(&e.bid(3, &a, 1_000_000, &sealed(3, &a, 1_000_000)).await),
            "launch_closed"
        );

        // No bids at all → failed (no_bids), fee returned.
        let b = e.open_launch(1).await;
        e.close(&b).await;
        let l = e.wait_status(&b, "failed").await;
        assert_eq!(l["failure"], "no_bids");
        assert!(l["commitment"]["root"].as_str().is_some());
        assert_eq!(e.avail(1).await, (100_000_000, 0));

        // F15: two identical fl_bid requests in flight → the same receipt, one bid.
        let d = e.open_launch(1).await;
        let body =
            json!({"op":"fl_bid","launchId":d,"holdZat":"1000000","ciphertext":sealed(2, &d, 1_000_000)}).to_string();
        let h = e.sign(&user(2), "POST", "/api/actions", &body);
        let (r1, r2) = tokio::join!(
            e.raw("POST", "/api/actions", &body, Some(&h)),
            e.raw("POST", "/api/actions", &body, Some(&h))
        );
        assert_eq!(
            (r1.status, r2.status),
            (StatusCode::OK, StatusCode::OK),
            "{:?} {:?}",
            r1.body,
            r2.body
        );
        assert_eq!(r1.body["id"], r2.body["id"]);
        assert_eq!(e.avail(2).await, (99_000_000, 1_000_000), "held once");
        // F6: bid cap per launch (1024 sealed) → launch_full.
        e.sql(&format!(
            "INSERT INTO {s}.fl_bids (launch_id, anon_pubkey, hold_zat, ciphertext)
             SELECT '\\x{d}', decode(lpad(to_hex(g), 64, '0'), 'hex'), 100000, 'x' FROM generate_series(1, 1023) g"
        ))
        .await;
        assert_eq!(
            code(&e.bid(3, &d, 1_000_000, &sealed(3, &d, 1_000_000)).await),
            "launch_full"
        );
        e.sql(&format!("DELETE FROM {s}.fl_bids WHERE ciphertext = 'x'")).await;
        // F13: the bid set no longer matches the committed root → failed (internal), released.
        e.sql(&format!(
            "UPDATE {s}.fl_launches SET round_time = now() + interval '1 hour' WHERE id = '\\x{d}'"
        ))
        .await;
        e.close(&d).await;
        e.wait_status(&d, "closed").await;
        e.sql(&format!(
            "UPDATE {s}.fl_bids SET ciphertext = ciphertext || ' ' WHERE launch_id = '\\x{d}' AND status = 'sealed';
             UPDATE {s}.fl_launches SET round_time = to_timestamp({}) WHERE id = '\\x{d}';",
            drand::QUICKNET_GENESIS + 999 * 3
        ))
        .await;
        let l = e.wait_status(&d, "failed").await;
        assert_eq!(l["failure"], "internal");
        assert_eq!(e.avail(2).await, (100_000_000, 0));
        assert_eq!(e.avail(1).await, (100_000_000, 0));

        // Relayer failure → failed (tx_failed), every hold released.
        let c = e.open_launch(1).await;
        assert_eq!(
            e.bid(3, &c, 1_000_000, &sealed(3, &c, 900_000)).await.status,
            StatusCode::OK
        );
        e.close(&c).await;
        e.wait_status(&c, "executing").await;
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'failed', error_code = 'slippage' WHERE op = 'fair_create'"
        ))
        .await;
        let l = e.wait_status(&c, "failed").await;
        assert_eq!(l["failure"], "tx_failed");
        assert_eq!(e.avail(3).await, (100_000_000, 0));
        assert_eq!(e.avail(1).await, (100_000_000, 0));
        let pf = e.signed(&user(3), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf["fairBids"][0]["status"], "released");
        assert_eq!(pf["fairBids"][0]["releasedZat"], "1000000");
        // F9: 48 h later the fl_* action rows (and launches' bids) are gone entirely.
        e.sql(&format!(
            "UPDATE {s}.actions SET updated_at = now() - interval '3 days' WHERE kind LIKE 'fl\\_%' AND status <> 'queued';
             UPDATE {s}.fl_launches SET finished_at = now() - interval '3 days' WHERE finished_at IS NOT NULL;"
        ))
        .await;
        assert!(e.ledger.fl_janitor().await.unwrap() > 0);
        assert_eq!(
            e.one_i64(&format!("SELECT count(*) FROM {s}.actions WHERE kind LIKE 'fl\\_%'"))
                .await,
            0
        );
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.fl_bids")).await, 0);
        e.drop_schema().await;
    }
}

#[tokio::test]
async fn creator_cap_per_venue_meteora_dbc() {
    let Some(e) = setup_with(|c| c.venues = vec!["pumpfun".into(), "meteora-dbc".into()]).await else {
        return;
    };
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let pool = e.get("/api/pool").await.body;
    let rules = &pool["launchRules"];
    assert_eq!(rules["maxInitialBuyLamports"], "1466000000");
    assert_eq!(rules["maxInitialBuyLamportsByVenue"]["pumpfun"], "1466000000");
    // 1% DBC fee instead of ~1.25%: 1.466 SOL × 5/5.013, rounded down to 0.001 SOL.
    assert_eq!(rules["maxInitialBuyLamportsByVenue"]["meteora-dbc"], "1462000000");
    // 1.465 SOL initial buy: fine on pump.fun, over the cap on meteora-dbc.
    e.fund(8, 0, 100_000_000).await;
    let create = |venue: &str| {
        json!({"op":"create","venue":venue,"meta":{"name":"Cap","symbol":"CAP"},"initialBuyZec":"14650000"}).to_string()
    };
    let r = e.signed(&user(8), "POST", "/api/actions", &create("meteora-dbc")).await;
    assert_eq!(code(&r), "creator_cap", "{:?}", r.body);
    let r = e.signed(&user(8), "POST", "/api/actions", &create("pumpfun")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    e.drop_schema().await;
}

// ================================================================== Verify (API v0.7)

mod verify_pl {
    use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey};
    use unzeen_ledger::verify::VerifyTiming;
    use unzeen_protocol::verify::{self as pv, Node, SnapshotHeader};

    use super::*;

    const T: VerifyTiming = VerifyTiming {
        freeze_secs: 4.0,
        quiesce_secs: 2.0,
    };

    async fn wait_status(e: &Env, id: i32, want: &str) {
        for _ in 0..100 {
            let st: String = e
                .admin
                .query_one(
                    &format!("SELECT status FROM {}.verify_snapshots WHERE id = $1", e.schema),
                    &[&id],
                )
                .await
                .unwrap()
                .get(0);
            if st == want {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("snapshot {id} never reached {want}");
    }

    fn b58_32(s: &str) -> [u8; 32] {
        bs58::decode(s).into_vec().unwrap().try_into().unwrap()
    }

    #[tokio::test]
    async fn verify_snapshot_proofs_and_retention() {
        let Some(e) = setup_with(|c| c.verify.timing = T).await else {
            return;
        };
        let s = e.schema.clone();
        e.fund(1, 0, 123_456_789).await;
        e.fund(2, 0, 50_000_000).await;
        let pk1 = user(1).verifying_key().to_bytes();
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals) VALUES ('{MINT}', 'pumpfun', 'T', 'T', 6);
             INSERT INTO {s}.token_balances (anon_pubkey, mint, available, held)
               VALUES ('\\x{}', '{MINT}', 2500000, 1);
             INSERT INTO {s}.pool_meta (key, value) VALUES ('reserve_zat', '123456789'), ('reserve_height', '3000000');
             -- v0.10 (E5/E6): creator fees of user 2 on two mints → one ZEC value for the key.
             INSERT INTO {s}.creator_claimable (anon_pubkey, mint, lamports)
               VALUES ('\\x{pk2}', '{MINT}', 30000000), ('\\x{pk2}', '{MINT2}', 20000000);
             -- E9: only withdrawal gas is committed SOL.
             INSERT INTO {s}.relayer_jobs (op, mint, token_amount, dest, gas_lamports, network, status)
               VALUES ('transfer', '{MINT}', 1, '{MINT2}', 2000000, 'devnet', 'queued');",
            hex::encode(pk1),
            pk2 = hex::encode(user(2).verifying_key().to_bytes())
        ))
        .await;
        // E8: a ZEC payout in flight (0.01 ZEC) does not block the snapshot.
        let ua = unified::Address::try_from_items(
            unified::Revision::R0,
            vec![unified::Uitem::Data(unified::Receiver::Orchard([7; 43]))],
        )
        .unwrap()
        .encode(&zcash_protocol::consensus::NetworkType::Test);
        let r = e
            .signed(
                &user(1),
                "POST",
                "/api/actions",
                &json!({"op":"withdraw_zec","to":ua,"amount":"1000000"}).to_string(),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        e.sql(&format!(
            "UPDATE {s}.zec_payouts SET status = 'sent', txid = '\\x{}'",
            "ab".repeat(32)
        ))
        .await;
        assert_eq!(e.get("/api/verify").await.status, StatusCode::NOT_FOUND);

        // A job in flight: the freeze cannot complete → skipped (busy), freeze lifted.
        e.sql(&format!(
            "INSERT INTO {s}.relayer_jobs (op, venue, mint, lamports_in, min_out, network, status)
             VALUES ('buy', 'pumpfun', '{MINT}', 5000000, 1, 'devnet', 'claimed')"
        ))
        .await;
        let id0 = e
            .ledger
            .verify_request("devnet", "0202", "manual", T)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            e.ledger.verify_request("devnet", "0202", "manual", T).await.unwrap(),
            None,
            "one at a time"
        );
        wait_status(&e, id0, "skipped").await;
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.verify_snapshots WHERE freeze_until > now()"
            ))
            .await,
            0
        );
        // The queued buy waits; an earlier trade is confirmed and counted at slot 555 (E2).
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'queued' WHERE op = 'buy';
             INSERT INTO {s}.relayer_jobs (op, venue, mint, lamports_in, min_out, network, status, signature, slot,
                                           settled_at)
             VALUES ('buy', 'pumpfun', '{MINT}', 1000000, 1, 'devnet', 'confirmed', 'SIGOLD', 555, now());"
        ))
        .await;

        // Quiet pool: freezing → collecting; the relayer writes signed vault balances.
        let id = e
            .ledger
            .verify_request("devnet", "0202", "manual", T)
            .await
            .unwrap()
            .unwrap();
        wait_status(&e, id, "collecting").await;
        let vault = SigningKey::from_bytes(&[5; 32]);
        let vaddr = bs58::encode(vault.verifying_key().to_bytes()).into_string();
        let vsig = bs58::encode(
            vault
                .sign(pv::vault_message("0202", id as u32, &vaddr).as_bytes())
                .to_bytes(),
        )
        .into_string();
        e.sql(&format!(
            "INSERT INTO {s}.verify_vaults (snapshot_id, address, lamports, tokens, sig)
             VALUES ({id}, '{vaddr}', 2000000000, '[{{\"mint\":\"{MINT}\",\"amount\":\"9000000\"}}]', '{vsig}');
             UPDATE {s}.verify_snapshots SET solana_slot = 777, assets_done_at = now() WHERE id = {id};"
        ))
        .await;
        // Assets are in, but the reserve was sampled before the freeze: wait for a new sample.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.verify_snapshots WHERE id = {id} AND status = 'collecting'"
            ))
            .await,
            1
        );
        // The scanner samples the reserve after the freeze started (E7/E8).
        e.ledger.set_reserve(123_456_789, 3_000_000, now_ms()).await.unwrap();
        // A deposit credited after the sample is in the wallet with ≥ K confirmations: it joins
        // the reserve (and the liabilities).
        e.fund(3, 0, 2_000_000).await;
        wait_status(&e, id, "built").await;

        let snap = e.get("/api/verify").await;
        assert_eq!(snap.status, StatusCode::OK);
        assert_eq!(snap.headers["cache-control"], "public, max-age=300");
        let v = snap.body;
        assert_eq!((v["id"].as_i64(), v["leaves"].as_u64()), (Some(id as i64), Some(1024)));
        // 1.23456789 sampled + 0.02 credited later + 0.01 in flight = 1.26456789 → 1.26.
        assert_eq!(v["zecReserve"]["amountZat"], "126000000", "floored to 0.01 ZEC");
        assert_eq!(v["zecReserve"]["attested"], true);
        assert_eq!(
            v["committedLamports"], "2000000",
            "E9: only withdrawal gas, not the queued buy"
        );
        assert_eq!(v["rateLamportsPerZecBuy"], RATE.to_string());
        assert_eq!(
            e.one_i64(&format!("SELECT min_slot FROM {s}.verify_snapshots WHERE id = {id}"))
                .await,
            555,
            "E2: highest slot of a counted trade"
        );
        assert!(
            v.get("operator").is_none() && v.get("anchor").is_none(),
            "not anchored yet"
        );
        // Liabilities: rounded up to the granule, never below the real balance.
        let trees = v["trees"].as_array().unwrap();
        let zec = trees.iter().find(|t| t["asset"] == "ZEC").unwrap();
        let zsum: u64 = zec["sum"].as_str().unwrap().parse().unwrap();
        // + 0.05 SOL creator fees of user 2 at 10 SOL/ZEC = 0.005 ZEC; + user 3's 0.02 ZEC.
        let real = 123_456_789 + 50_000_000 + 500_000 + 2_000_000;
        assert!(
            zsum >= real && zsum < real + 3 * 100_000 && zsum.is_multiple_of(100_000),
            "{zsum}"
        );
        assert!(trees.iter().all(|t| t["asset"] != "SOL"), "E5: no SOL tree");
        let mt = trees.iter().find(|t| t["asset"] == MINT).unwrap();
        assert_eq!(mt["sum"], "2500001", "E1: exact, granule 1 base unit");
        assert_eq!(mt["granule"], "1");
        // The vault signature checks with its own address.
        let vv = &v["vaults"][0];
        let vk = VerifyingKey::from_bytes(&b58_32(vv["address"].as_str().unwrap())).unwrap();
        let sig = Signature::from_bytes(
            &bs58::decode(vv["sig"].as_str().unwrap())
                .into_vec()
                .unwrap()
                .try_into()
                .unwrap(),
        );
        assert!(
            vk.verify(pv::vault_message("0202", id as u32, &vaddr).as_bytes(), &sig)
                .is_ok()
        );
        // rootsDigest is reproducible from public fields.
        let roots: Vec<([u8; 32], Node)> = trees
            .iter()
            .map(|t| {
                let a = if t["asset"] == "ZEC" {
                    pv::ZEC_ASSET
                } else {
                    b58_32(t["asset"].as_str().unwrap())
                };
                let root = Node {
                    hash: hex::decode(t["root"].as_str().unwrap()).unwrap().try_into().unwrap(),
                    sum: t["sum"].as_str().unwrap().parse().unwrap(),
                };
                (a, root)
            })
            .collect();
        let header = SnapshotHeader {
            chain: [2, 2],
            snapshot_id: id as u32,
            taken_at_sec: v["takenAt"].as_u64().unwrap() / 1000,
            leaves: 1024,
            solana_slot: 777,
            zcash_height: 3_000_000,
            zec_reserve_zat: 126_000_000,
        };
        let digest = pv::roots_digest(&header, &roots);
        assert_eq!(v["rootsDigest"], hex::encode(digest));

        // Anchor: attest job with ONLY the digest hex; relayer confirms with an operator sig.
        let memo: String = e
            .admin
            .query_one(
                &format!(
                    "SELECT meta->>'memo' FROM {s}.relayer_jobs WHERE op = 'attest' AND meta->>'purpose' = 'verify'"
                ),
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(memo, hex::encode(digest));
        // The first attest fails (no SOL on the key): it is re-queued with the same memo.
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'attest' AND meta->>'purpose' = 'verify'"
            ))
            .await,
            1
        );
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'failed', error_code = 'pool_liquidity' WHERE op = 'attest'"
        ))
        .await;
        for _ in 0..50 {
            if e.one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'attest'"))
                .await
                == 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'attest' AND status = 'queued' AND meta->>'memo' = '{memo}'"
            ))
            .await,
            1,
            "re-anchored"
        );
        assert_eq!(
            e.one_i64(&format!(
                "SELECT anchor_attempts::bigint FROM {s}.verify_snapshots WHERE id = {id}"
            ))
            .await,
            2
        );
        let op = SigningKey::from_bytes(&[9; 32]);
        let opk = bs58::encode(op.verifying_key().to_bytes()).into_string();
        let osig = bs58::encode(op.sign(&digest).to_bytes()).into_string();
        // E10: a wrong signature is never published; the relayer's signature at claim time is
        // published at once, before the memo tx lands.
        let bad = bs58::encode(op.sign(b"other").to_bytes()).into_string();
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'claimed', vault = '{opk}', out_sig = '{bad}'
              WHERE op = 'attest' AND status = 'queued'"
        ))
        .await;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(e.get("/api/verify").await.body.get("operator").is_none());
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET out_sig = '{osig}' WHERE op = 'attest' AND status = 'claimed'"
        ))
        .await;
        let mut v = Value::Null;
        for _ in 0..50 {
            v = e.get("/api/verify").await.body;
            if v.get("operator").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(v["operator"]["pubkey"], opk);
        assert!(v.get("anchor").is_none(), "signed, anchor pending");
        // The memo tx lands: the anchor follows, with blockTime.
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGV', slot = 901,
                    out_memo = '{memo}', out_block_time = 1792000000 WHERE op = 'attest' AND status = 'claimed'"
        ))
        .await;
        for _ in 0..50 {
            v = e.get("/api/verify").await.body;
            if v.get("anchor").is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(v["operator"]["pubkey"], opk);
        assert_eq!(v["anchor"]["solanaTx"], "SIGV");
        assert_eq!(v["anchor"]["matches"], true);
        assert_eq!(v["anchor"]["blockTime"], 1_792_000_000);
        let hist = e.get("/api/verify/snapshots").await.body;
        assert_eq!(hist.as_array().unwrap().len(), 1, "skipped snapshots are not published");
        assert_eq!(e.get(&format!("/api/verify/{id}")).await.status, StatusCode::OK);
        assert_eq!(e.get(&format!("/api/verify/{id0}")).await.status, StatusCode::NOT_FOUND);

        // Owner proof: pieces sum to the committed value, paths reach the published roots.
        let r = e.signed(&user(1), "GET", "/api/verify/proof", "").await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        assert_eq!(r.raw_len, 65_536, "constant 64 KiB bucket");
        assert_eq!(r.headers["cache-control"], "no-store");
        let p = &r.body;
        assert_eq!(p["snapshotId"], id);
        assert_eq!(p["truncated"], false);
        let mut seen = 0;
        for ap in p["proofs"].as_array().unwrap() {
            let tree = trees.iter().find(|t| t["asset"] == ap["asset"]).unwrap();
            let a = if ap["asset"] == "ZEC" {
                pv::ZEC_ASSET
            } else {
                b58_32(ap["asset"].as_str().unwrap())
            };
            let pieces = ap["pieces"].as_array().unwrap();
            assert!((2..=4).contains(&pieces.len()));
            let mut total = 0u64;
            for pc in pieces {
                let value: u64 = pc["value"].as_str().unwrap().parse().unwrap();
                total += value;
                let blind: [u8; 32] = hex::decode(pc["blind"].as_str().unwrap()).unwrap().try_into().unwrap();
                let leaf = Node {
                    hash: pv::leaf_hash(
                        [2, 2],
                        id as u32,
                        &a,
                        &pk1,
                        pc["piece"].as_u64().unwrap() as u8,
                        value,
                        &blind,
                    ),
                    sum: value as u128,
                };
                let path: Vec<Node> = pc["path"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| Node {
                        hash: hex::decode(n["hash"].as_str().unwrap()).unwrap().try_into().unwrap(),
                        sum: n["sum"].as_str().unwrap().parse().unwrap(),
                    })
                    .collect();
                assert_eq!(path.len(), 10);
                let root = pv::root_from_path(&leaf, pc["leafIndex"].as_u64().unwrap() as usize, &path);
                assert_eq!(hex::encode(root.hash), tree["root"].as_str().unwrap());
            }
            if ap["asset"] == "ZEC" {
                assert_eq!(total, 123_500_000, "rounded up to 0.001 ZEC");
            } else {
                assert_eq!(total, 2_500_001);
            }
            seen += 1;
        }
        assert_eq!(seen, 2);
        // Creator with fees on two mints: ONE ZEC value (0.5 ZEC + 0.05 SOL at 10 SOL/ZEC), piece
        // numbers unique within the key (E5/E6), no SOL proof.
        let p2 = e.signed(&user(2), "GET", "/api/verify/proof", "").await.body;
        let ap = p2["proofs"].as_array().unwrap();
        assert_eq!(ap.len(), 1, "{p2:?}");
        assert_eq!(ap[0]["asset"], "ZEC");
        let pcs = ap[0]["pieces"].as_array().unwrap();
        let total: u64 = pcs
            .iter()
            .map(|p| p["value"].as_str().unwrap().parse::<u64>().unwrap())
            .sum();
        assert_eq!(total, 50_500_000);
        let mut nums: Vec<u64> = pcs.iter().map(|p| p["piece"].as_u64().unwrap()).collect();
        nums.sort_unstable();
        nums.dedup();
        assert_eq!(nums.len(), pcs.len(), "piece numbers unique per key");
        // A key with nothing: empty proofs, same padding bucket.
        let r9 = e.signed(&user(9), "GET", "/api/verify/proof", "").await;
        assert_eq!(r9.body["proofs"].as_array().unwrap().len(), 0);
        assert_eq!(r9.raw_len, r.raw_len, "size does not tell what a key holds");
        assert_eq!(
            e.signed(&user(1), "GET", "/api/verify/proof?snapshot=999", "")
                .await
                .status,
            StatusCode::NOT_FOUND
        );

        // 48 h later: paths and bindings are gone, the public snapshot stays.
        e.sql(&format!(
            "UPDATE {s}.verify_snapshots SET taken_at = taken_at - interval '49 hours'"
        ))
        .await;
        assert!(e.ledger.verify_janitor().await.unwrap() > 0);
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.verify_leaves")).await, 0);
        assert_eq!(
            e.signed(&user(1), "GET", "/api/verify/proof", "").await.status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(e.get("/api/verify").await.status, StatusCode::OK);
        e.drop_schema().await;
    }
}

#[tokio::test]
async fn creator_fee_sweeps_credit_and_claim() {
    let Some(e) = setup().await else { return };
    let s = e.schema.clone();
    let pk = user(4).verifying_key().to_bytes();
    e.sql(&format!(
        "INSERT INTO {s}.creator_tokens (mint, anon_pubkey) VALUES ('{MINT}', '\\x{pk}');
         INSERT INTO {s}.creator_fee_sweeps (network, venue, kind, mint, authority, signature, last_valid_block_height,
                                             status, lamports, slot)
         VALUES ('devnet', 'pumpfun', 'creator', '{MINT}', 'A', 'S1', 1, 'confirmed', 30000000, 5),
                ('devnet', 'pumpfun', 'creator', '{MINT}', 'A', 'S2', 1, 'confirmed', 20000000, 6),
                ('devnet', 'pumpfun', 'creator', '{MINT}', 'A', 'S3', 1, 'sent', NULL, NULL),
                ('devnet', 'meteora-dbc', 'partner', '{MINT}', 'P', 'S4', 1, 'confirmed', 7000000, 7),
                ('devnet', 'pumpfun', 'creator', '{MINT2}', 'A', 'S5', 1, 'confirmed', 9000000, 8);",
        pk = hex::encode(pk)
    ))
    .await;
    // Nothing yet → claim refused, nothing changes.
    let claim = json!({"op":"claim"}).to_string();
    assert_eq!(
        code(&e.signed(&user(4), "POST", "/api/actions", &claim).await),
        "below_minimum"
    );
    let r = e.ledger.credit_fee_sweeps("devnet").await.unwrap();
    assert_eq!(
        (r.credited, r.pool_revenue),
        (2, 1),
        "MINT2 has no Unzeen creator → pool"
    );
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.creator_fee_sweeps WHERE credited_at IS NOT NULL
               AND credited_at = date_trunc('hour', credited_at)"
        ))
        .await,
        3,
        "partner untouched, credited_at hour-coarse"
    );
    assert_eq!(
        e.ledger.credit_fee_sweeps("devnet").await.unwrap().credited,
        0,
        "idempotent"
    );
    let pf = e.signed(&user(4), "GET", "/api/portfolio", "").await.body;
    assert_eq!(pf["claimable"], json!([{"mint": MINT, "solAmount": "50000000"}]));
    // claim: 0.05 SOL at 10 SOL/ZEC (spread 0) = 0.005 ZEC.
    let r = e.signed(&user(4), "POST", "/api/actions", &claim).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["status"], "executed");
    let pf = e.signed(&user(4), "GET", "/api/portfolio", "").await.body;
    assert_eq!(pf["zecBalance"], "500000");
    assert_eq!(pf["claimable"], json!([]));
    assert_eq!(pf["actions"][0]["kind"], "claim");
    assert_eq!(pf["actions"][0]["fill"]["zecCredited"], "500000");
    assert_eq!(
        code(&e.signed(&user(4), "POST", "/api/actions", &claim).await),
        "below_minimum"
    );
    e.drop_schema().await;
}

// ================================================================== orders (API v0.8)

mod orders_v08 {
    use unzeen_ledger::actions::quantize_min_out;
    use unzeen_ledger::orders::{buy_min_out, parse_e18, sell_min_out};

    use super::*;

    impl Env {
        /// The indexer's price pass (INTEL.md v2) for MINT. `tick_at` = now + n ms (fresh, E16).
        async fn tick(&self, n: i64, price: &str, status: &str) {
            let n = now_ms() as i64 + n;
            self.sql(&format!(
                "INSERT INTO {s}.intel_prices (mint, price_sol, status, tick_at) VALUES ('{MINT}', {price}, '{status}', {n})
                 ON CONFLICT (mint) DO UPDATE SET prev_price_sol = intel_prices.price_sol,
                   prev_tick_at = intel_prices.tick_at, price_sol = EXCLUDED.price_sol, status = EXCLUDED.status,
                   tick_at = EXCLUDED.tick_at WHERE intel_prices.tick_at < EXCLUDED.tick_at",
                s = self.schema
            ))
            .await;
        }

        async fn order(&self, n: u8, id: &str) -> Value {
            for _ in 0..3 {
                let pf = self.signed(&user(n), "GET", "/api/portfolio", "").await.body;
                if let Some(o) = pf["orders"].as_array().unwrap().iter().find(|o| o["id"] == id) {
                    return o.clone();
                }
            }
            Value::Null
        }

        async fn wait_order(&self, n: u8, id: &str, f: impl Fn(&Value) -> bool) -> Value {
            for _ in 0..60 {
                let o = self.order(n, id).await;
                if f(&o) {
                    return o;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("order {id} condition not reached: {:?}", self.order(n, id).await);
        }
    }

    fn create(kind: &str, amount: u64, trigger: &str) -> Value {
        json!({"op":"order_create","venue":"pumpfun","mint":MINT,"kind":kind,"triggerPriceSol":trigger,
               "amount":amount.to_string()})
    }

    #[tokio::test]
    async fn orders_trigger_cancel_expire_retention() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.fund(1, 0, 100_000_000).await;
        e.fund(2, 0, 10_000_000).await;
        let pk2 = hex::encode(user(2).verifying_key().to_bytes());
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals) VALUES ('{MINT}', 'pumpfun', 'T', 'T', 6);
             INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk2}', '{MINT}', 1000000000000);"
        ))
        .await;
        e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
        let pool = e.get("/api/pool").await.body;
        assert_eq!(pool["orders"]["maxOpenPerKey"], 10);
        assert_eq!(pool["orders"]["defaultSlippageBps"]["stop_loss"], 1500);

        // Validation.
        let post = |n: u8, v: Value| {
            let body = v.to_string();
            let e = &e;
            async move { e.signed(&user(n), "POST", "/api/actions", &body).await }
        };
        let mut bad = create("limit_buy", 10_000_000, "0.000001");
        bad["mint"] = json!(MINT2);
        assert_eq!(code(&post(1, bad).await), "order_unsupported_mint");
        let mut bad = create("limit_buy", 10_000_000, "0.000001");
        bad["exec"] = json!("now");
        assert_eq!(code(&post(1, bad).await), "bad_request");
        let mut bad = create("limit_buy", 10_000_000, "0.000001");
        bad["ttlSecs"] = json!(60);
        assert_eq!(code(&post(1, bad).await), "bad_request");
        assert_eq!(
            code(&post(1, create("limit_buy", 10_000_000, "0")).await),
            "bad_request"
        );
        assert_eq!(
            code(&post(2, create("limit_sell", 1_000, "0.000001")).await),
            "below_minimum"
        );

        // limit_buy: 0.1 ZEC when the price drops to 1e-6 SOL.
        e.tick(1, "0.000002", "curve").await;
        let r = post(1, create("limit_buy", 10_000_000, "0.000001")).await;
        assert_eq!(
            (r.status, r.body["status"].as_str()),
            (StatusCode::OK, Some("open")),
            "{:?}",
            r.body
        );
        let buy_id = r.body["id"].as_str().unwrap().to_string();
        assert_eq!(e.avail(1).await, (90_000_000, 10_000_000));
        let o = e.order(1, &buy_id).await;
        assert_eq!(
            (o["status"].as_str(), o["triggerPriceSol"].as_str()),
            (Some("open"), Some("0.000001"))
        );
        assert_eq!(o["expiresAt"].as_u64().unwrap() % 3_600_000, 0);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(e.order(1, &buy_id).await["status"], "open", "price above the trigger");
        e.tick(2, "0.0000009", "curve").await;
        let o = e.wait_order(1, &buy_id, |o| o["status"] == "triggered").await;
        let aid = o["actionId"].as_str().unwrap().to_string();
        let job = e
            .admin
            .query_one(
                &format!(
                    "SELECT j.op, j.lamports_in, j.min_out, j.exec_mode, j.not_before > now(), a.hold_zat
                     FROM {s}.relayer_jobs j JOIN {s}.actions a ON a.id = j.action_id WHERE a.id = '\\x{aid}'"
                ),
                &[],
            )
            .await
            .unwrap();
        let lamports = job.get::<_, i64>(1) as u64;
        assert_eq!(job.get::<_, String>(0), "buy");
        assert!((990_000_000..=1_000_000_000).contains(&lamports) && lamports.is_multiple_of(1_000_000));
        // E4: min_out from the tick price (0.9e-6), not the trigger, quantized to 3 digits.
        assert_eq!(
            job.get::<_, i64>(2) as u64,
            quantize_min_out(buy_min_out(lamports, parse_e18("0.0000009").unwrap(), 6, 500).unwrap())
        );
        assert_eq!(
            (job.get::<_, String>(3), job.get::<_, bool>(4)),
            ("delayed".into(), true),
            "next epoch"
        );
        let held = job.get::<_, i64>(5);
        assert_eq!(
            e.avail(1).await,
            (100_000_000 - held, held),
            "hold moved, D10 remainder released"
        );
        // The trade is an ordinary buy in actions; settle → order filled.
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGO', out_token_amount = 1000,
                    out_lamports = lamports_in WHERE action_id = '\\x{aid}'"
        ))
        .await;
        e.wait_order(1, &buy_id, |o| o["status"] == "filled").await;
        let pf = e.signed(&user(1), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf["actions"].as_array().unwrap().len(), 1);
        assert_eq!(pf["actions"][0]["kind"], "buy");

        // stop_loss: two consecutive ticks at or below the trigger.
        let r = post(2, create("stop_loss", 500_000_000_000, "0.000001")).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        let sl = r.body["id"].as_str().unwrap().to_string();
        // E16: tick 2 is older than the order and is never evaluated for it.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(e.order(2, &sl).await.get("armed").is_none(), "old tick ignored");
        e.tick(3, "0.0000009", "curve").await; // first tick after the order, below: arms
        e.wait_order(2, &sl, |o| o["armed"] == true).await;
        e.tick(4, "0.0000011", "curve").await; // recovered: disarmed
        e.wait_order(2, &sl, |o| o.get("armed").is_none()).await;
        e.tick(5, "0.000001", "curve").await; // armed again
        e.wait_order(2, &sl, |o| o["armed"] == true).await;
        assert_eq!(e.order(2, &sl).await["status"], "open");
        e.tick(6, "0.00000095", "curve").await; // second consecutive tick → sell
        let o = e.wait_order(2, &sl, |o| o["status"] == "triggered").await;
        let said = o["actionId"].as_str().unwrap();
        let min_out = e
            .one_i64(&format!(
                "SELECT min_out FROM {s}.relayer_jobs WHERE action_id = '\\x{said}' AND op = 'sell'
                   AND token_amount = 500000000000"
            ))
            .await as u64;
        assert_eq!(
            min_out,
            quantize_min_out(sell_min_out(500_000_000_000, parse_e18("0.00000095").unwrap(), 6, 1_500).unwrap()),
            "tick price, not the trigger"
        );
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.actions WHERE id = '\\x{said}' AND request_hash = '\\x{}'",
                "00".repeat(32)
            ))
            .await,
            0,
            "E20: random request hash"
        );

        // Cancel: only from open; tokens come back.
        let r = post(2, create("limit_sell", 100_000_000_000, "0.01")).await;
        let ls = r.body["id"].as_str().unwrap().to_string();
        assert_eq!(
            e.one_i64(&format!(
                "SELECT held FROM {s}.token_balances WHERE anon_pubkey = '\\x{pk2}'"
            ))
            .await,
            600_000_000_000
        );
        let cancel = json!({"op":"order_cancel","orderId":ls});
        let r = post(2, cancel.clone()).await;
        assert_eq!(r.body["status"], "cancelled", "{:?}", r.body);
        assert_eq!(code(&post(2, cancel).await), "order_not_open");
        assert_eq!(
            code(&post(2, json!({"op":"order_cancel","orderId":sl})).await),
            "order_not_open"
        );
        assert_eq!(
            post(1, json!({"op":"order_cancel","orderId":ls})).await.status,
            StatusCode::NOT_FOUND,
            "someone else's order"
        );
        assert_eq!(
            e.one_i64(&format!(
                "SELECT held FROM {s}.token_balances WHERE anon_pubkey = '\\x{pk2}'"
            ))
            .await,
            500_000_000_000
        );

        // Limits: 4 open per key and mint.
        let mut ids = vec![];
        for _ in 0..4 {
            let r = post(1, create("limit_buy", 1_000_000, "0.0000001")).await;
            assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
            ids.push(r.body["id"].as_str().unwrap().to_string());
        }
        assert_eq!(
            code(&post(1, create("limit_buy", 1_000_000, "0.0000001")).await),
            "order_limit"
        );
        // Expiry releases the hold.
        e.sql(&format!(
            "UPDATE {s}.orders SET expires_at = date_trunc('hour', now()) WHERE id = '\\x{}'",
            ids[0]
        ))
        .await;
        e.wait_order(1, &ids[0], |o| o["status"] == "expired").await;
        // Graduated: the rest fail, holds released.
        e.tick(7, "0.000003", "graduated").await;
        for id in &ids[1..] {
            let o = e.wait_order(1, id, |o| o["status"] == "failed").await;
            assert_eq!(o["error"], "graduated");
        }
        assert_eq!(
            e.avail(1).await,
            (100_000_000 - held, 0),
            "only the filled buy is spent"
        );

        // D1: closed + 24 h → gone from the portfolio (scrubbed); + 48 h → deleted.
        e.sql(&format!(
            "UPDATE {s}.orders SET closed_at = now() - interval '25 hours' WHERE status <> 'triggered'"
        ))
        .await;
        let (scrubbed, _) = e.ledger.orders_janitor().await.unwrap();
        assert!(scrubbed >= 6);
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.orders WHERE closed_at IS NOT NULL AND mint IS NOT NULL"
            ))
            .await,
            0
        );
        let pf = e.signed(&user(1), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf["orders"].as_array().unwrap().len(), 0);
        e.sql(&format!(
            "UPDATE {s}.orders SET closed_at = now() - interval '49 hours' WHERE closed_at IS NOT NULL"
        ))
        .await;
        let (_, deleted) = e.ledger.orders_janitor().await.unwrap();
        assert!(deleted >= 6);
        e.drop_schema().await;
    }
}

// ================================================================== API v0.9: launch fee, cabinet, stats

/// Wait until the action `id` of `user(n)` is executed (settler runs every second).
async fn wait_executed(e: &Env, n: u8, id: &str) -> Value {
    let path = format!("/api/actions/{id}");
    for _ in 0..60 {
        let st = e.signed(&user(n), "GET", &path, "").await;
        if st.body["status"] == "executed" {
            return st.body;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("action {id} not executed");
}

#[tokio::test]
async fn launch_fee_to_pool_and_creator_cabinet() {
    let Some(e) = setup().await else { return };
    let s = e.schema.clone();
    let me = 8u8;
    e.fund(me, 0, 100_000_000).await;

    // Empty cabinet: same padded size as any other answer, nothing about anyone.
    let empty = e.signed(&user(me), "GET", "/api/creator", "").await;
    assert_eq!(empty.status, StatusCode::OK, "{:?}", empty.body);
    assert_eq!(empty.body["tokens"], json!([]));
    assert_eq!(empty.raw_len % 4096, 0);
    assert_eq!(empty.headers["cache-control"], "no-store");
    // Unsigned → 401.
    assert_eq!(e.get("/api/creator").await.status, StatusCode::UNAUTHORIZED);

    // create with a ~1 SOL initial buy; the relayer reports no exact creator fee.
    let body = json!({"op":"create","venue":"pumpfun","meta":{"name":"Fee","symbol":"FEE"},"initialBuyZec":"10000000"})
        .to_string();
    let r = e.signed(&user(me), "POST", "/api/actions", &body).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    let paid = e
        .one_i64(&format!("SELECT lamports_in FROM {s}.relayer_jobs WHERE op = 'create'"))
        .await;
    e.sql(&format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, created_at)
           VALUES ('{MINT}', 'pumpfun', 'FEE', 'Fee', 6, now() - interval '1 hour');
         INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, ts)
           VALUES ('create', 'pumpfun', '{MINT}', 'FEE', 0, 0, 6, 'SIGCREATE', now()),
                  ('buy', 'pumpfun', '{MINT}', 'FEE', 34000000000000, {paid}, 6, 'SIGCREATE', now()),
                  ('sell', 'pumpfun', '{MINT}', 'FEE', 1000, 500000000, 6, 'SIGX', now());
         UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGCREATE', out_mint = '{MINT}',
                out_token_amount = 34000000000000, out_lamports = lamports_in WHERE op = 'create'"
    ))
    .await;
    wait_executed(&e, me, &id).await;
    // Upper bound: ceil(paid × 30 bps), all of it still to withhold.
    let fee = (paid * 30 + 9_999) / 10_000;
    assert!(fee > 0);
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.creator_tokens WHERE mint = '{MINT}'
               AND launch_fee_lamports = {fee} AND launch_fee_left = {fee}"
        ))
        .await,
        1
    );

    // First sweep smaller than the launch fee: all pool. Second: the rest of the fee to the
    // pool, the remainder to the creator.
    e.sql(&format!(
        "INSERT INTO {s}.creator_fee_sweeps (network, venue, kind, mint, authority, signature,
                                             last_valid_block_height, status, lamports, slot)
         VALUES ('devnet', 'pumpfun', 'creator', '{MINT}', 'A', 'W1', 1, 'confirmed', {a}, 5);",
        a = fee - 1_000
    ))
    .await;
    let rep = e.ledger.credit_fee_sweeps("devnet").await.unwrap();
    assert_eq!(
        (rep.credited, rep.pool_revenue, rep.withheld_lamports),
        (0, 1, (fee - 1_000) as u64)
    );
    e.sql(&format!(
        "INSERT INTO {s}.creator_fee_sweeps (network, venue, kind, mint, authority, signature,
                                             last_valid_block_height, status, lamports, slot)
         VALUES ('devnet', 'pumpfun', 'creator', '{MINT}', 'A', 'W2', 1, 'confirmed', 20000000, 6);"
    ))
    .await;
    let rep = e.ledger.credit_fee_sweeps("devnet").await.unwrap();
    assert_eq!((rep.credited, rep.pool_revenue, rep.withheld_lamports), (1, 0, 1_000));
    assert_eq!(
        e.one_i64(&format!(
            "SELECT sum(pool_lamports)::bigint FROM {s}.creator_fee_sweeps WHERE mint = '{MINT}'"
        ))
        .await,
        fee
    );
    assert_eq!(
        e.one_i64(&format!("SELECT launch_fee_left FROM {s}.creator_tokens"))
            .await,
        0
    );
    let pf = e.signed(&user(me), "GET", "/api/portfolio", "").await.body;
    assert_eq!(pf["claimable"], json!([{"mint": MINT, "solAmount": "19999000"}]));

    // Cabinet: own token only, owner-only figures, padded.
    let cab = e.signed(&user(me), "GET", "/api/creator", "").await;
    assert_eq!(cab.status, StatusCode::OK);
    assert_eq!(cab.raw_len % 4096, 0);
    assert_eq!(cab.raw_len, empty.raw_len, "one token fits the same bucket");
    let t = &cab.body["tokens"][0];
    assert_eq!(cab.body["tokens"].as_array().unwrap().len(), 1);
    assert_eq!(
        (t["mint"].as_str(), t["symbol"].as_str(), t["status"].as_str()),
        (Some(MINT), Some("FEE"), Some("curve"))
    );
    assert_eq!(
        t["fees"],
        json!({"claimableLamports": "19999000", "claimedLamports": "0"})
    );
    assert_eq!(t["volumeLamports"], (paid + 500_000_000).to_string());
    assert_eq!(t["trades"], 2);
    assert_eq!(t["holders"], Value::Null, "no indexer snapshot yet");
    assert_eq!(t["lock"]["lockedAmount"], "34000000000000");
    assert!(t["lock"]["until"].as_i64().unwrap() > now_ms() as i64 + 23 * 3_600_000);
    assert_eq!(
        t["cap"],
        json!({"capBps": 500, "capTokens": "50000000000000", "positionTokens": "34000000000000"})
    );
    // Indexer snapshot with a holder count (INTEL: holders.count) and curve progress.
    e.sql(&format!(
        "INSERT INTO {s}.token_safety (mint, as_of, data) VALUES ('{MINT}', date_trunc('minute', now()),
           '{{\"market\": {{\"venue\": \"pumpfun\", \"status\": \"curve\", \"curveProgressPct\": \"3.2\"}},
              \"holders\": {{\"top10Pct\": \"50\", \"devPct\": null, \"unzeenPoolPct\": \"40\", \"count\": 17}}}}')"
    ))
    .await;
    let t = e.signed(&user(me), "GET", "/api/creator", "").await.body["tokens"][0].clone();
    assert_eq!(
        (t["holders"].clone(), t["curveProgressPct"].clone()),
        (json!(17), json!("3.2"))
    );
    assert!(t["holdersAsOf"].as_i64().unwrap() % 60_000 == 0);

    // Another key sees nothing of it (T1).
    e.fund(9, 0, 1_000_000).await;
    let other = e.signed(&user(9), "GET", "/api/creator", "").await;
    assert_eq!(other.body["tokens"], json!([]));
    assert_eq!(other.raw_len, empty.raw_len);
    // Public token endpoints carry no creator numbers.
    let pubtok = e.get(&format!("/api/tokens/{MINT}")).await.body.to_string();
    for k in ["claim", "launch_fee", "fees", "positionTokens", "lockedAmount"] {
        assert!(!pubtok.contains(k), "{k} in public token: {pubtok}");
    }

    // claim → claimed moves, claimable 0.
    let r = e
        .signed(&user(me), "POST", "/api/actions", &json!({"op":"claim"}).to_string())
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let t = e.signed(&user(me), "GET", "/api/creator", "").await.body["tokens"][0].clone();
    assert_eq!(
        t["fees"],
        json!({"claimableLamports": "0", "claimedLamports": "19999000"})
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn launch_fee_exact_from_relayer() {
    let Some(e) = setup().await else { return };
    let s = e.schema.clone();
    e.fund(10, 0, 100_000_000).await;
    let body = json!({"op":"create","venue":"pumpfun","meta":{"name":"Ex","symbol":"EX"},"initialBuyZec":"10000000"})
        .to_string();
    let r = e.signed(&user(10), "POST", "/api/actions", &body).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    // The relayer reports the exact creator fee of the launch buy (TradeEvent.creatorFee).
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGEX', out_mint = '{MINT2}',
                out_token_amount = 1000, out_lamports = lamports_in, out_creator_fee = 123456 WHERE op = 'create'"
    ))
    .await;
    wait_executed(&e, 10, &id).await;
    assert_eq!(
        e.one_i64(&format!(
            "SELECT launch_fee_left FROM {s}.creator_tokens WHERE mint = '{MINT2}'"
        ))
        .await,
        123_456
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn stats_daily_snapshot_k_anonymity() {
    let Some(e) = setup().await else { return };
    let s = e.schema.clone();
    // No snapshot yet → 404 (never a live aggregate).
    let r = e.get("/api/stats").await;
    assert_eq!((r.status, code(&r)), (StatusCode::NOT_FOUND, "not_found"));

    // Before the cut-off (yesterday): 6 pumpfun trades on MINT (1.23456789 SOL), 2 DBC trades,
    // 1 launch. Today: trades that must not count yet.
    let mut q = format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol)
           VALUES ('{MINT}', 'pumpfun', 'AAA', 'A', 6, 0.000000028, 28), ('{MINT2}', 'meteora-dbc', 'BBB', 'B', 6, 0, 0);
         INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, ts) VALUES
           ('create', 'pumpfun', '{MINT}', 'AAA', 0, 0, 6, 'C1', now() - interval '1 day'),"
    );
    for i in 0..6 {
        let sol = if i == 0 { 234_567_890 } else { 200_000_000 };
        q += &format!("('buy', 'pumpfun', '{MINT}', 'AAA', 1, {sol}, 6, 'P{i}', now() - interval '1 day'),");
    }
    q += &format!(
        "('buy', 'meteora-dbc', '{MINT2}', 'BBB', 1, 900000000, 6, 'D1', now() - interval '1 day'),
         ('sell', 'meteora-dbc', '{MINT2}', 'BBB', 1, 900000000, 6, 'D2', now() - interval '1 day'),
         ('buy', 'pumpfun', '{MINT}', 'AAA', 1, 5000000000, 6, 'T1', date_trunc('day', now(), 'UTC') + interval '1 second');"
    );
    e.sql(&q).await;
    // 4 credited deposits before the cut-off (7.5 ZEC).
    for i in 0..4 {
        e.fund(20 + i as u8, i, 187_500_000).await;
    }
    e.sql(&format!(
        "UPDATE {s}.deposits SET created_at = created_at - interval '1 day' WHERE status = 'credited'"
    ))
    .await;

    let p = e.state.cfg.stats.params;
    e.ledger.stats_snapshot("devnet", &p).await.unwrap();
    let r = e.get("/api/stats").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers["cache-control"], "public, max-age=3600");
    let v = r.body;
    let midnight = (now_ms() / 86_400_000 * 86_400_000) as i64;
    assert_eq!(v["asOf"], midnight);
    assert_eq!(v["trades"], 8, "today's trade is after the cut-off");
    assert_eq!(v["volumeSol"], "3", "3.034567890 SOL rounded down to 0.1");
    assert_eq!(v["launches"], "<5");
    assert_eq!(v["zecShielded"], "<5", "fewer than 5 deposits");
    assert_eq!(
        v["byVenue"],
        json!({
            "pumpfun": {"volumeSol": "1.2", "trades": 6, "launches": "<5"},
            "meteora-dbc": {"volumeSol": "<5", "trades": "<5", "launches": "<5"},
            "jupiter": {"volumeSol": "<5", "trades": "<5", "launches": "<5"},
        })
    );
    let top = v["topTokens"].as_array().unwrap();
    assert_eq!(top.len(), 1, "MINT2 has < 5 trades: {top:?}");
    assert_eq!(
        (
            top[0]["mint"].as_str(),
            top[0]["volumeSol"].as_str(),
            top[0]["trades"].as_u64()
        ),
        (Some(MINT), Some("1.2"), Some(6))
    );
    assert_eq!(top[0]["priceSol"], "0.000000028");
    // No creator numbers anywhere in the public stats (T1).
    let txt = v.to_string();
    assert!(!txt.contains("claim") && !txt.contains("creator"), "{txt}");

    // A 5th deposit (before the cut-off): the shielded total is published, rounded to 1 ZEC.
    e.fund(30, 9, 100_000_000).await;
    e.sql(&format!(
        "UPDATE {s}.deposits SET created_at = created_at - interval '1 day' WHERE created_at >= date_trunc('day', now(), 'UTC')"
    ))
    .await;
    e.ledger.stats_snapshot("devnet", &p).await.unwrap();
    assert_eq!(
        e.get("/api/stats").await.body["zecShielded"],
        "8",
        "8.5 ZEC rounded down"
    );
    // Previous day published 8 ZEC at 5 deposits: 4 more deposits do not move it.
    e.sql(&format!(
        "UPDATE {s}.stats_snapshots SET day = day - 1;
         UPDATE {s}.deposits SET credited_zat = credited_zat * 3"
    ))
    .await;
    for i in 0..4 {
        e.fund(40 + i as u8, 10 + i, 100_000_000).await;
    }
    e.sql(&format!(
        "UPDATE {s}.deposits SET created_at = created_at - interval '1 day' WHERE created_at >= date_trunc('day', now(), 'UTC')"
    ))
    .await;
    e.ledger.stats_snapshot("devnet", &p).await.unwrap();
    assert_eq!(e.get("/api/stats").await.body["zecShielded"], "8");
    assert!(!e.ledger.stats_due("devnet").await.unwrap());
    e.drop_schema().await;
}

#[tokio::test]
async fn jupiter_devnet_and_explicit_min_out() {
    let Some(e) = setup_with(|c| c.venues = vec!["pumpfun".into(), "jupiter".into()]).await else {
        return;
    };
    let s = e.schema.clone();
    e.fund(11, 0, 100_000_000).await;
    // Jupiter on devnet: refused before any hold.
    let r = e
        .signed(
            &user(11),
            "POST",
            "/api/actions",
            &json!({"op":"buy","venue":"jupiter","mint":MINT2,"zecIn":"1000000","minOut":"5"}).to_string(),
        )
        .await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::SERVICE_UNAVAILABLE, "venue_unavailable")
    );
    assert_eq!(e.one_i64(&format!("SELECT held_zat FROM {s}.balances")).await, 0);
    // A mint with no pool price: minOut / minZecOut must be explicit (non-zero).
    let buy0 = json!({"op":"buy","venue":"pumpfun","mint":MINT2,"zecIn":"1000000","minOut":"0"}).to_string();
    assert_eq!(
        code(&e.signed(&user(11), "POST", "/api/actions", &buy0).await),
        "bad_request"
    );
    let buy = json!({"op":"buy","venue":"pumpfun","mint":MINT2,"zecIn":"1000000","minOut":"123456"}).to_string();
    let r = e.signed(&user(11), "POST", "/api/actions", &buy).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    // E4: the user's minOut is scaled by D10 and quantized to 3 significant digits.
    let m = e
        .one_i64(&format!("SELECT min_out FROM {s}.relayer_jobs WHERE op = 'buy'"))
        .await;
    assert!(m <= 123_456 && m % 1_000 == 0 && m >= 121_000, "{m}");
    e.sql(&format!(
        "INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{}', '{MINT2}', 1000)",
        hex::encode(user(11).verifying_key().to_bytes())
    ))
    .await;
    let sell0 = json!({"op":"sell","venue":"pumpfun","mint":MINT2,"amount":"1000","minZecOut":"0"}).to_string();
    assert_eq!(
        code(&e.signed(&user(11), "POST", "/api/actions", &sell0).await),
        "bad_request"
    );
    e.drop_schema().await;
}

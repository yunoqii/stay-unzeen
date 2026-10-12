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
    config::{Config, ExecConfig, Fees, Limits, RateConfig},
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
        },
        pool_address: None,
        rate: RateConfig {
            fixed_lamports_per_zec: Some(RATE),
            oneclick_url: "http://127.0.0.1:9".into(),
            oneclick_jwt: None,
            cache_secs: 45,
            max_stale_secs: 300,
            spread_bps: 0,
        },
        exec: ExecConfig {
            jitter_min_secs: 3.0,
            jitter_max_secs: 20.0,
            withdraw_token_delay_min_secs: 30.0,
            withdraw_token_delay_max_secs: 300.0,
            zec_payout_delay_min_secs: 60.0,
            zec_payout_delay_max_secs: 600.0,
        },
        fees: Fees {
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
        let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Resp { status, headers, body }
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
        };
        self.ledger.observe_note(&obs, now_ms() / 1000).await.unwrap();
    }
}

fn code(r: &Resp) -> &str {
    r.body["error"]["code"].as_str().unwrap_or("")
}

fn buy_body(zec_in: u64) -> String {
    json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":zec_in.to_string(),"minOut":"1"}).to_string()
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
    assert_eq!(
        r.body,
        json!({"address":"utest1example","network":"test","chainId":"0202",
               "minDepositZat":"100000","minActionZat":"100000","confirmations":3})
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
    let mbody = json!({"op":"buy","venue":"meteora-dbc","mint":MINT,"zecIn":"200000","minOut":"1"}).to_string();
    let r = e.signed(&me, "POST", "/api/actions", &mbody).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::SERVICE_UNAVAILABLE, "venue_unavailable")
    );
    for bad in [
        "not json",
        r#"{"op":"buy","venue":"pumpfun","mint":"x","zecIn":"200000","minOut":"1"}"#,
        r#"{"op":"buy","venue":"pumpfun","mint":"So11111111111111111111111111111111111111112","zecIn":"0200000","minOut":"1"}"#,
        r#"{"op":"claim"}"#,
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

    let p = e.signed(&me, "GET", "/api/portfolio", "").await;
    assert_eq!(
        (p.body["zecBalance"].as_str(), p.body["zecHeld"].as_str()),
        (Some("600000"), Some("400000"))
    );
    assert_eq!(
        e.one_i64(&format!(
            "SELECT lamports_in FROM {}.relayer_jobs WHERE status = 'queued'
              AND not_before >= now() + interval '2 seconds' AND network = 'devnet'",
            e.schema
        ))
        .await,
        40_000_000
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

    // Relayer confirms; the background settler closes the hold.
    e.sql(&format!(
        "UPDATE {}.relayer_jobs SET status = 'confirmed', signature = 'SIGBUY', out_token_amount = 123456,
                out_lamports = 40000000",
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
    let sell =
        |amt: &str| json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":amt,"minZecOut":"100000"}).to_string();
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
    let b2 = json!({"op":"buy","venue":"pumpfun","mint":MINT2,"zecIn":"100000","minOut":"1"}).to_string();
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
    assert_eq!(
        e.one_i64(&format!(
            "SELECT lamports_in FROM {}.relayer_jobs WHERE op = 'create' AND meta->>'symbol' = 'PUNZ'",
            e.schema
        ))
        .await,
        20_000_000
    );
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
    let wt = json!({"op":"withdraw_token","mint":MINT2,"amount":"1000","to":dests,
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
    let mismatch = json!({"op":"withdraw_token","mint":MINT2,"amount":"10","to":[MINT],
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
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}")).await.status,
        StatusCode::NOT_FOUND
    );
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

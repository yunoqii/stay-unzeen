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
    actions::quantize_min_out,
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
            hood: false,
            price_max_age_secs: 300,
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
            trade_fee_bps_pumpfun: 125,
            min_claim_zat: 100_000,
        },
        intel: IntelConfig {
            full_trades: false,
            queue_max: 256,
            whale_lamports: 1_000_000_000,
            discovery: false,
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
        chat: unzeen_api::config::ChatConfig {
            enabled: false,
            noop: false,
            min_account_zat: 100_000,
            key: None,
        },
        scenarios: unzeen_api::config::ScenariosConfig {
            enabled: true,
            key: Some(unzeen_api::config::ChatKey([5; 32])),
        },
        quotes: unzeen_api::config::QuotesConfig {
            list: unzeen_api::config::known_quotes(false),
            zec_spread_bps: 30,
            zec_virtual_units: 271_890_000,
        },
        // v0.28 timers (Pulse, progress sampling, quote rounds) off: tests drive the steps, so
        // no test depends on their timing and parallel tests do not load the database with them.
        comfort: unzeen_api::config::ComfortConfig {
            timers: false,
            ..Default::default()
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
        gi(&self.admin.query_one(q, &[]).await.unwrap(), 0)
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
        api_auth::sign_request(
            self.state.cfg.policy.chain,
            sk,
            method,
            path,
            body.as_bytes(),
            rand::random(),
            now_ms(),
        )
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
        .sign(&user(n), self.state.cfg.policy.chain)
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
    // v0.19: scenarios on in tests (only the S3 blocks are advertised).
    let scn = b.as_object_mut().unwrap().remove("scenarios").expect("scenarios block");
    assert_eq!(scn["maxSteps"], 12);
    assert_eq!(scn["ttlSecs"]["maxNoWithdraw"], 604_800);
    assert!(scn["blocks"].as_array().unwrap().iter().any(|x| x == "buy"));
    assert_eq!(b["features"]["scenarios"], true);
    b["features"].as_object_mut().unwrap().remove("scenarios");
    assert_eq!(
        b,
        json!({"address":"utest1example","network":"test","chainId":"0202",
               // v0.18: the chain of this origin.
               "chain":{"id":"solana","network":"devnet","mainnet":false,"native":{"symbol":"SOL","decimals":9}},
               "minDepositZat":"100000","minActionZat":"100000","minClaimZat":"100000","confirmations":3,
               "createEnabled":true,
               "orders": unzeen_api::orders::pool_block(),
               "features":{"fullTrades":false,"pulse":true},
               // v0.16: enabled venues with what the pool can do there.
               "venues":[{"venue":"pumpfun","trade":true,"create":true,"quotes":["SOL","USDC"],
                          "atomicFirstBuy":true,"creatorFees":true,"mainnetOnly":false}],
               "launchRules":{"lockSecs":86400,"capBps":500,"maxInitialBuyLamports":"1466000000",
                              "maxInitialBuyLamportsByVenue":{"pumpfun":"1466000000"},
                              "maxInitialBuyZecUnitsByVenue":{},
                              // v0.24: initialBuyZec range at the buy rate (10 SOL/ZEC, spread 0):
                              // one 0.001 SOL step .. last amount below 1.467 SOL.
                              "minInitialBuyZat":"10000",
                              "maxInitialBuyZatByVenue":{"pumpfun":"14669999"}},
               "fees":{"createFeeZat":"100000","withdrawZecFeeZat":"15000",
                       "withdrawTokenGasLamports":"2000000","withdrawTokenCostLamports":"2100000",
                       "nowFeeZat":"500"},
               // v0.13: devnet default UNZEEN_QUOTES = USDC (pump.fun devnet mint).
               "quotes":[{"quote":"USDC","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                          "decimals":6,"bridged":false,"venues":["pumpfun"]}]})
    );
    assert!(r.headers.get("set-cookie").is_none());
    // A pool published for another network is never served.
    e.ledger.set_pool_meta("network", "main").await.unwrap();
    assert_eq!(e.get("/api/pool").await.status, StatusCode::INTERNAL_SERVER_ERROR);
    e.drop_schema().await;
}

/// API v0.21: one fixed 16 KiB portfolio, never compressed or transformed, holdings paged.
#[tokio::test]
async fn portfolio_fixed_size_uncompressed_and_paged() {
    let Some(e) = setup().await else { return };
    let me = user(1);
    let pk = hex::encode(me.verifying_key().to_bytes());
    // 45 holdings → pages of 20, 20, 5.
    for i in 0..45u32 {
        e.sql(&format!(
            "INSERT INTO {}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', 'Mint{i:040}', 1000)",
            e.schema
        ))
        .await;
    }
    let get = |path: &'static str| {
        let h = e.sign(&me, "GET", path, "");
        e.http
            .get(format!("{}{}", e.base, path))
            .header(api_auth::H_PUBKEY, &h.pubkey)
            .header(api_auth::H_NONCE, &h.nonce)
            .header(api_auth::H_TS, &h.ts)
            .header(api_auth::H_SIG, &h.sig)
            .header("accept-encoding", "gzip, deflate, br, zstd")
            .send()
    };
    let mut seen = Vec::new();
    for (path, n, more) in [
        ("/api/portfolio", 20, 25),
        ("/api/portfolio?holdingsPage=1", 20, 5),
        ("/api/portfolio?holdingsPage=2", 5, 0),
        ("/api/portfolio?holdingsPage=3", 0, 0),
    ] {
        let r = get(path).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK, "{path}");
        assert!(
            r.headers().get("content-encoding").is_none(),
            "padded answers are never compressed"
        );
        assert_eq!(r.headers()["cache-control"], "no-store, no-transform");
        let bytes = r.bytes().await.unwrap();
        assert_eq!(bytes.len(), unzeen_api::PORTFOLIO_BYTES, "{path}: fixed size");
        assert_eq!(unzeen_api::PORTFOLIO_BYTES, 16_384);
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        let h = v["holdings"].as_array().unwrap();
        assert_eq!(h.len(), n, "{path}");
        assert_eq!(v["more"]["holdings"], more, "{path}");
        seen.extend(h.iter().map(|x| x["mint"].as_str().unwrap().to_string()));
    }
    seen.dedup();
    assert_eq!(seen.len(), 45, "pages cover every holding once");
    // Other query parameters are refused (the signature covers them).
    let h = e.sign(&me, "GET", "/api/portfolio?x=1", "");
    assert_eq!(
        code(&e.raw("GET", "/api/portfolio?x=1", "", Some(&h)).await),
        "bad_request"
    );
    // Other padded answers carry the same headers.
    let r = e.signed(&me, "GET", "/api/creator", "").await;
    assert_eq!(r.headers["cache-control"], "no-store, no-transform", "{:?}", r.body);
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
    assert_eq!(r.headers["cache-control"], "no-store, no-transform");

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

    // 0031: tx landed, result not parsed → `needs_review`: not final, no refund, hold kept,
    // the owner still sees `sent` (pending).
    let held0 = e.signed(&me, "GET", "/api/portfolio", "").await.body["zecHeld"].clone();
    e.sql(&format!("UPDATE {}.relayer_jobs SET status = 'needs_review'", e.schema))
        .await;
    assert_eq!(e.ledger.settle_ready(50).await.unwrap(), 0);
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let s = e.signed(&me, "GET", &path, "").await;
    assert_eq!(s.body["status"], "sent", "{:?}", s.body);
    let p = e.signed(&me, "GET", "/api/portfolio", "").await.body;
    assert_eq!(p["zecHeld"], held0);
    assert_ne!(p["zecHeld"], "0");
    assert_eq!(e.ledger.needs_review_count().await.unwrap(), 1);

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
        e.one_i64(&format!(
            "SELECT token_hold FROM {}.actions WHERE kind = 'withdraw_token'",
            e.schema
        ))
        .await,
        "the parts are the whole hold"
    );
    // A1: never the exact amount: shaved 0.5–2 %, each part at 3 significant digits, the rest
    // stays available.
    let parts: Vec<i64> = e
        .admin
        .query(
            &format!(
                "SELECT token_amount FROM {}.relayer_jobs WHERE op = 'transfer'",
                e.schema
            ),
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| gi(r, 0))
        .collect();
    let total: i64 = parts.iter().sum();
    assert!((970..1000).contains(&total), "{parts:?}");
    assert!(parts.iter().all(|p| quantize_min_out(*p as u128) as i64 == *p));
    assert_eq!(
        e.one_i64(&format!(
            "SELECT available FROM {}.token_balances WHERE mint = '{MINT2}'",
            e.schema
        ))
        .await,
        1000 - total
    );
    // v0.17: the owner sees the parts (sizes, start times, state).
    let wid = r.body["id"].as_str().unwrap().to_string();
    let st = e.signed(&me, "GET", &format!("/api/actions/{wid}"), "").await.body;
    let ps = st["parts"].as_array().unwrap();
    assert_eq!(ps.len(), 2);
    assert_eq!(
        ps.iter()
            .map(|p| p["amount"].as_str().unwrap().parse::<i64>().unwrap())
            .sum::<i64>(),
        total
    );
    assert!(
        ps.iter()
            .all(|p| p["status"] == "queued" && p["notBefore"].as_u64().unwrap() > now_ms())
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
    // v0.12 list fields (public: the pool's own feed + the indexer snapshot).
    assert_eq!(t[0]["unzeenLaunch"], true);
    assert_eq!(t[0]["volume24hSol"], "3.5");
    assert_eq!(t[0]["unzeenTrades24h"], 3);
    assert!(t[0].get("curveProgressPct").is_none(), "no indexer snapshot yet");
    e.sql(&format!(
        "INSERT INTO {s}.token_safety (mint, as_of, data)
           VALUES ('{MINT}', date_trunc('minute', now()), '{{\"market\": {{\"curveProgressPct\": \"41.2\"}}}}')",
        s = e.schema
    ))
    .await;
    assert_eq!(e.get("/api/tokens").await.body[0]["curveProgressPct"], "41.2");
    // Discovery flag off: like an unknown path; no features.discovery.
    assert_eq!(
        e.get("/api/tokens?source=discovery").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(e.get("/api/tokens?source=x").await.status, StatusCode::BAD_REQUEST);
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

    // 24.10: a discovery candidate's card takes the discovery pass's price / cap / venue / status
    // (graduated: the AMM pool), and its chart comes from the price samples + market_trades.
    e.sql(&format!(
        "UPDATE {s}.intel_tokens SET venue = 'jupiter', status = 'graduated', price_sol = 0, market_cap_sol = 0 WHERE mint = '{MINT2}';
         INSERT INTO {s}.intel_discovery (network, mint, venue, created_at, name, symbol, status, price_sol, market_cap_sol, progress_pct, as_of)
         VALUES ('devnet', '{MINT2}', 'meteora-dbc', to_timestamp(1800000000), 'Foo', 'FOO', 'graduated', 0.0000005, 500, NULL, to_timestamp(1800000060));
         INSERT INTO {s}.price_samples (mint, tick_at, price_sol) VALUES
           ('{MINT2}', 1800000060000, 0.0000004), ('{MINT2}', 1800000120000, 0.0000006);
         INSERT INTO {s}.market_trades (mint, kind, venue, symbol, trader, unzeen, tags, token_amount, sol_amount, decimals, signature, ix, slot, ts)
         VALUES ('{MINT2}', 'buy', 'meteora-dbc', 'FOO', 'Trader1', FALSE, '{{}}', 1000000, 500, 6, 'SIGMT', 0, 1, to_timestamp(1800000130));"
    ))
    .await;
    let t = e.get(&format!("/api/tokens/{MINT2}")).await;
    assert_eq!(
        (&t.body["venue"], &t.body["status"], &t.body["priceSol"], &t.body["marketCapSol"], &t.body["createdAt"], &t.body["priceTs"]),
        (&json!("meteora-dbc"), &json!("graduated"), &json!("0.0000005"), &json!("500"), &json!(1_800_000_000_000i64), &json!(1_800_000_060_000i64)),
        "{:?}",
        t.body
    );
    let c = e
        .get(&format!("/api/tokens/{MINT2}/candles?tf=1m&from=1800000000&to=1800000240"))
        .await;
    assert_eq!(
        c.body,
        json!([
            {"time": 1800000060, "open": "0.0000004", "high": "0.0000004", "low": "0.0000004", "close": "0.0000004", "volume": "0"},
            // open = the previous bar's close (bars connect), low widened to it
            {"time": 1800000120, "open": "0.0000004", "high": "0.0000006", "low": "0.0000004", "close": "0.0000005", "volume": "500"}
        ])
    );

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
    const VS: u128 = 1_000_000_000;
    const VT: u128 = 1_073_000_000_000_000;
    const SUPPLY: u128 = 1_000_000_000_000_000;

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
            // v0.25: before the epoch boundary the id holder sees `scheduled` and nothing else;
            // the public list does not have it.
            let r = self.get(&format!("/api/launches/{id}")).await;
            assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
            assert_eq!(r.body, json!({ "id": id, "status": "scheduled" }));
            assert_eq!(r.headers["cache-control"], "no-store");
            let list = self.get("/api/launches").await.body;
            assert!(!list.to_string().contains(&id), "scheduled launch listed: {list}");
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
        let lamports_in = gi(&job, 0) as u128;
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

        // Relayer: both jobs confirmed. Fair-launch v2 (RELAYER v7): a Jito bundle of 3 legs,
        // signature/vault of leg 0, sums over the legs, PARTIAL fill (S < lamports_in, T below
        // min_out) is accepted and shared pro rata; the unspent part of every hold is released.
        let spent = lamports_in * 8 / 10;
        let t = alloc::curve_tokens_out(VS, VT, spent) * 99 / 100;
        assert!(t < gi(&job, 1) as u128, "below min_out");
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGFAIR', out_mint = '{mint}',
                    out_token_amount = {t}, out_lamports = {spent}, vault = 'VaultA',
                    bundle_legs = '[{{\"sig\":\"L1\",\"vault\":\"VaultB\"}},{{\"sig\":\"L2\",\"vault\":\"VaultC\"}}]'
              WHERE op = 'fair_create';
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

        let mut tok_sum = 0u128;
        for (i, (n, amount)) in [(1u8, 500_000u64), (2, 1_000_000), (3, 2_000_000)]
            .into_iter()
            .enumerate()
        {
            let e_i = e
                .one_i64(&format!(
                    "SELECT e_lamports FROM {s}.fl_bids WHERE anon_pubkey = '\\x{}'",
                    hex::encode(user(n).verifying_key().to_bytes())
                ))
                .await as u128;
            let e_total: u128 = e
                .one_i64(&format!("SELECT total_e FROM {s}.fl_launches WHERE id = '\\x{id}'"))
                .await as u128;
            assert_eq!(e_i, plan.effective[i], "user {n}");
            assert_eq!(e_total, plan.total);
            let sh = alloc::share(e_i, plan.total, t, spent, RATE, amount);
            let toks = e
                .one_i64(&format!(
                    "SELECT available FROM {s}.token_balances WHERE mint = '{mint}' AND anon_pubkey = '\\x{}'",
                    hex::encode(user(n).verifying_key().to_bytes())
                ))
                .await as u128;
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
                "SELECT count(*) FROM {s}.relayer_jobs WHERE settled_at IS NULL AND op <> 'consolidate'"
            ))
            .await,
            0
        );
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE bundle_legs IS NOT NULL"
            ))
            .await,
            0,
            "bundle_legs erased at settle"
        );
        // Consolidation: one internal job per other leg vault → vault A, no action link.
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'consolidate' AND mint = '{mint}' AND dest = 'VaultA'
                   AND meta->>'from' IN ('VaultB', 'VaultC') AND action_id IS NULL AND status = 'queued'
                   AND exec_mode = 'delayed'"
            ))
            .await,
            2
        );
        // A failed consolidation is settled and re-queued (try 2); confirmed ones are settled (an
        // empty leg vault: confirmed with 0 and no tx/signature, allowed for consolidate by 0018).
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'failed', error_code = 'internal'
              WHERE op = 'consolidate' AND meta->>'from' = 'VaultB';
             UPDATE {s}.relayer_jobs SET status = 'confirmed', out_token_amount = 0
              WHERE op = 'consolidate' AND meta->>'from' = 'VaultC';"
        ))
        .await;
        let mut requeued = 0;
        for _ in 0..50 {
            requeued = e
                .one_i64(&format!(
                    "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'consolidate' AND status = 'queued'
                       AND meta->>'from' = 'VaultB' AND (meta->>'try')::int = 2"
                ))
                .await;
            if requeued == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(requeued, 1);
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'consolidate' AND settled_at IS NOT NULL"
            ))
            .await,
            2
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
        // v0.17: digest v2 also covers quoteAssets (absent = empty list).
        assert_eq!(v["digestVersion"], 2);
        let quotes: Vec<pv::QuoteAssetFact> = v["quoteAssets"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|q| pv::QuoteAssetFact {
                mint: b58_32(q["mint"].as_str().unwrap()),
                decimals: q["decimals"].as_u64().unwrap() as u8,
                bridged: q["bridged"].as_bool().unwrap(),
                counted: q["counted"].as_bool().unwrap(),
                dust_below: q["dustBelow"].as_str().unwrap().parse().unwrap(),
            })
            .collect();
        let digest = pv::roots_digest_v2(&header, &roots, &quotes);
        assert_eq!(v["rootsDigest"], hex::encode(digest));
        assert_ne!(
            hex::encode(pv::roots_digest(&header, &roots)),
            hex::encode(digest),
            "v1 and v2 never coincide"
        );

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
        assert_eq!(r.headers["cache-control"], "no-store, no-transform");
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
    assert_eq!(
        pf["claimable"],
        json!([{"mint": MINT, "solAmount": "50000000", "zecAmount": "0"}])
    );
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

/// v0.14: quote-token creator fees. ZEC SPL → zat 1:1 (after the launch fee in zat); USDC →
/// the sweeper's pool-A lamports, waiting while they are missing; claim pays both.
#[tokio::test]
async fn quote_creator_fees_zec_and_usdc() {
    let Some(e) = setup().await else { return };
    let s = e.schema.clone();
    let pk = hex::encode(user(4).verifying_key().to_bytes());
    let usdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    e.sql(&format!(
        "INSERT INTO {s}.creator_tokens (mint, anon_pubkey, launch_fee_zat, launch_fee_zat_left,
                                         launch_fee_lamports, launch_fee_left)
           VALUES ('{MINT}', '\\x{pk}', 100000, 100000, 0, 0),
                  ('{MINT2}', '\\x{pk}', 0, 0, 1000000, 1000000);
         INSERT INTO {s}.creator_fee_sweeps (network, venue, kind, mint, authority, signature, last_valid_block_height,
                                             status, lamports, slot, quote_mint, quote_amount)
         VALUES ('devnet', 'pumpfun', 'creator', '{MINT}', 'A', 'Z1', 1, 'confirmed', 0, 5, '{ZEC_SPL}', 300000),
                ('devnet', 'pumpfun', 'creator', '{MINT2}', 'A', 'U1', 1, 'confirmed', 0, 6, '{usdc}', 5000000),
                ('devnet', 'pumpfun', 'creator', '{MINT2}', 'A', 'U2', 1, 'confirmed', 4000000, 7, '{usdc}', 2000000);"
    ))
    .await;
    let r = e.ledger.credit_fee_sweeps("devnet").await.unwrap();
    assert_eq!((r.credited, r.withheld_lamports), (2, 1_000_000));
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.creator_fee_sweeps WHERE credited_at IS NULL AND signature = 'U1'"
        ))
        .await,
        1,
        "USDC sweep without its pool-A lamports waits"
    );
    let pf = e.signed(&user(4), "GET", "/api/portfolio", "").await.body;
    let mut cl = pf["claimable"].as_array().unwrap().clone();
    cl.sort_by_key(|v| v["mint"].as_str().unwrap().to_string());
    let mut want = vec![
        json!({"mint": MINT, "solAmount": "0", "zecAmount": "200000"}),
        json!({"mint": MINT2, "solAmount": "3000000", "zecAmount": "0"}),
    ];
    want.sort_by_key(|v| v["mint"].as_str().unwrap().to_string());
    assert_eq!(cl, want);
    // claim: 0.003 SOL at 10 SOL/ZEC = 30 000 zat + 200 000 zat owed 1:1.
    let r = e
        .signed(&user(4), "POST", "/api/actions", &json!({"op":"claim"}).to_string())
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let pf = e.signed(&user(4), "GET", "/api/portfolio", "").await.body;
    assert_eq!(pf["zecBalance"], "230000");
    assert_eq!(pf["claimable"], json!([]));
    assert_eq!(
        e.one_i64(&format!(
            "SELECT claimed_zat FROM {s}.creator_claimable WHERE mint = '{MINT}'"
        ))
        .await,
        200_000
    );
    // The sweeper fills the equivalent later → credited then.
    e.sql(&format!(
        "UPDATE {s}.creator_fee_sweeps SET lamports = 10000000 WHERE signature = 'U1'"
    ))
    .await;
    assert_eq!(e.ledger.credit_fee_sweeps("devnet").await.unwrap().credited, 1);
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

    /// B2 (devnet run 15.10): with the venue's `launch_curves` row, a fired sell order's min_out
    /// comes from the curve at the tick price (impact of this size included) minus slippage;
    /// a take_profit of a big position no longer fails `slippage` on a thin curve.
    #[tokio::test]
    async fn order_min_out_includes_curve_impact() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.fund(3, 0, 10_000_000).await;
        let pk = hex::encode(user(3).verifying_key().to_bytes());
        let curve = unzeen_ledger::curve::CurveParams {
            virtual_sol: 300_000_000,
            virtual_tokens: 1_073_000_000_000_000,
            fee_bps: 125,
            ..Default::default()
        };
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals) VALUES ('{MINT}', 'pumpfun', 'T', 'T', 6);
             INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', '{MINT}', 200000000000000);
             INSERT INTO {s}.launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves,
                                            real_token_reserves, token_total_supply)
             VALUES ('devnet', 'pumpfun', 300000000, 1073000000000000, 793100000000000, 1000000000000000);"
        ))
        .await;
        // 200M tokens, take profit at/below 1e-9 SOL (spot value 0.2 SOL; the curve pays ~25 % less).
        e.tick(1, "0.0000000009", "curve").await;
        let body = create("take_profit", 200_000_000_000_000, "0.000000001").to_string();
        let r = e.signed(&user(3), "POST", "/api/actions", &body).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        let id = r.body["id"].as_str().unwrap().to_string();
        e.tick(2, "0.0000000011", "curve").await;
        e.wait_order(3, &id, |o| o["status"] == "triggered").await;
        let m = e
            .one_i64(&format!("SELECT min_out FROM {s}.relayer_jobs WHERE op = 'sell'"))
            .await as u128;
        // The sold amount may be shaved (A5/A6); the floor follows the amount actually sold.
        let amt = e
            .one_i64(&format!(
                "SELECT token_amount::bigint FROM {s}.relayer_jobs WHERE op = 'sell'"
            ))
            .await as u128;
        let p = parse_e18("0.0000000011").unwrap();
        let spot = sell_min_out(amt, p, 6, 500).unwrap();
        let want = quantize_min_out(curve.sell_out(p, 6, amt).unwrap() * 9_500 / 10_000);
        assert_eq!(m, want);
        assert!(m * 10 < spot * 9, "curve floor {m} well below the spot floor {spot}");
        e.drop_schema().await;
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
        let lamports = gi(&job, 1) as u64;
        assert_eq!(job.get::<_, String>(0), "buy");
        assert!((990_000_000..=1_000_000_000).contains(&lamports) && lamports.is_multiple_of(1_000_000));
        // E4: min_out from the tick price (0.9e-6), not the trigger, quantized to 3 digits.
        assert_eq!(
            gi(&job, 2) as u128,
            quantize_min_out(buy_min_out(lamports as u128, parse_e18("0.0000009").unwrap(), 6, 500).unwrap())
        );
        assert_eq!(
            (job.get::<_, String>(3), job.get::<_, bool>(4)),
            ("delayed".into(), true),
            "next epoch"
        );
        let held = gi(&job, 5);
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
            .await as u128;
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

    // ============================================================== v0.15: bracket + re-arm

    fn bracket(amount: u64, tp: &str, sl: &str) -> Value {
        json!({"op":"order_create","venue":"pumpfun","mint":MINT,"kind":"bracket","tpPriceSol":tp,"slPriceSol":sl,
               "amount":amount.to_string()})
    }

    impl Env {
        /// (available, held) token base units of `user(n)` for MINT.
        async fn tokens(&self, n: u8) -> (i64, i64) {
            let pk = hex::encode(user(n).verifying_key().to_bytes());
            let r = self
                .admin
                .query_one(
                    &format!(
                        "SELECT available, held FROM {}.token_balances WHERE anon_pubkey = '\\x{pk}' AND mint = '{MINT}'",
                        self.schema
                    ),
                    &[],
                )
                .await
                .unwrap();
            (gi(&r, 0), gi(&r, 1))
        }

        async fn sells_of(&self, n: u8) -> i64 {
            let pk = hex::encode(user(n).verifying_key().to_bytes());
            self.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs j JOIN {s}.actions a ON a.id = j.action_id
                 WHERE a.anon_pubkey = '\\x{pk}' AND a.kind = 'sell' AND j.op = 'sell'",
                s = self.schema
            ))
            .await
        }

        async fn orders_env(&self, users: &[u8]) {
            let s = &self.schema;
            self.sql(&format!(
                "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals) VALUES ('{MINT}', 'pumpfun', 'T', 'T', 6)
                 ON CONFLICT DO NOTHING"
            ))
            .await;
            for n in users {
                let pk = hex::encode(user(*n).verifying_key().to_bytes());
                self.sql(&format!(
                    "INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', '{MINT}', 1000000000000)"
                ))
                .await;
            }
            self.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
        }

        /// Close the relayer job of `aid` as the relayer would.
        async fn fail_job(&self, aid: &str, code: &str) {
            self.sql(&format!(
                "UPDATE {}.relayer_jobs SET status = 'failed', error_code = '{code}', error_message = 'x'
                 WHERE action_id = '\\x{aid}'",
                self.schema
            ))
            .await;
        }
    }

    fn eval_params() -> unzeen_ledger::orders::EvalParams {
        let r = unzeen_ledger::RateUsed {
            lamports_per_zec: RATE,
            source: "fixed".into(),
            ts_ms: now_ms(),
        };
        unzeen_ledger::orders::EvalParams {
            rate_buy: Some(r.clone()),
            rate_sell: Some(r),
            delay_delayed: 30.0,
            delay_max: 300.0,
            trade_fee_bps_pumpfun: 125,
        }
    }

    #[tokio::test]
    async fn bracket_oco_one_hold_and_tick_race() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.orders_env(&[3, 4]).await;
        let post = |n: u8, v: Value| {
            let body = v.to_string();
            let e = &e;
            async move { e.signed(&user(n), "POST", "/api/actions", &body).await }
        };
        let pool = e.get("/api/pool").await.body;
        assert!(pool["orders"]["kinds"].as_array().unwrap().contains(&json!("bracket")));
        assert_eq!(pool["orders"]["defaultSlippageBps"]["bracket"], 500);
        assert_eq!(pool["orders"]["maxRearms"], 3);

        // Validation.
        let mut bad = bracket(500_000_000_000, "0.000002", "0.0000008");
        bad["triggerPriceSol"] = json!("0.000002");
        assert_eq!(
            code(&post(3, bad).await),
            "bad_request",
            "bracket has no triggerPriceSol"
        );
        let mut bad = bracket(500_000_000_000, "0.000002", "0.0000008");
        bad.as_object_mut().unwrap().remove("slPriceSol");
        assert_eq!(code(&post(3, bad).await), "bad_request", "both legs required");
        assert_eq!(
            code(&post(3, bracket(500_000_000_000, "0.000001", "0.000001")).await),
            "bad_request",
            "sl < tp"
        );
        let mut bad = create("stop_loss", 500_000_000_000, "0.000001");
        bad["slPriceSol"] = json!("0.0000008");
        assert_eq!(code(&post(3, bad).await), "bad_request", "legs only for bracket");
        let mut bad = bracket(500_000_000_000, "0.000002", "0.0000008");
        bad["slSlippageBps"] = json!(10);
        assert_eq!(code(&post(3, bad).await), "bad_request");
        // below_minimum is judged at the SL price: 1000 tokens × 1e-9 → nothing.
        assert_eq!(
            code(&post(3, bracket(100_000_000, "1", "0.000000001")).await),
            "below_minimum"
        );

        // A: TP 2e-6 / SL 0.8e-6; B: TP 1e-5 / SL 0.8e-6. One hold each.
        e.tick(1, "0.000001", "curve").await;
        let r = post(3, bracket(500_000_000_000, "0.000002", "0.0000008")).await;
        assert_eq!(
            (r.status, r.body["status"].as_str()),
            (StatusCode::OK, Some("open")),
            "{:?}",
            r.body
        );
        let a = r.body["id"].as_str().unwrap().to_string();
        let mut b = bracket(500_000_000_000, "0.00001", "0.0000008");
        b["rearm"] = json!(true);
        let r = post(3, b).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        let b = r.body["id"].as_str().unwrap().to_string();
        assert_eq!(e.tokens(3).await, (0, 1_000_000_000_000), "one hold per bracket");
        let o = e.order(3, &a).await;
        assert_eq!(o["kind"], "bracket");
        assert_eq!(o["triggerPriceSol"], "0.000002");
        assert_eq!(o["slPriceSol"], "0.0000008");
        assert_eq!(
            (o["slippageBps"].as_i64(), o["slSlippageBps"].as_i64()),
            (Some(500), Some(1500))
        );
        assert_eq!(o["rearms"], 0);
        assert!(o.get("leg").is_none() && o.get("rearm").is_none());
        assert_eq!(e.order(3, &b).await["rearm"], true);

        // SL leg arms on both…
        e.tick(2, "0.0000007", "curve").await;
        e.wait_order(3, &a, |o| o["armed"] == true).await;
        e.wait_order(3, &b, |o| o["armed"] == true).await;
        // …then the price jumps over A's TP: A fires on TP, B is disarmed.
        e.tick(3, "0.0000021", "curve").await;
        let o = e.wait_order(3, &a, |o| o["status"] == "triggered").await;
        assert_eq!(o["leg"], "tp");
        let aid = o["actionId"].as_str().unwrap().to_string();
        e.wait_order(3, &b, |o| o.get("armed").is_none()).await;
        assert_eq!(e.order(3, &b).await["status"], "open");
        let job = e
            .admin
            .query_one(
                &format!("SELECT token_amount, min_out FROM {s}.relayer_jobs WHERE action_id = '\\x{aid}'"),
                &[],
            )
            .await
            .unwrap();
        assert_eq!(goi(&job, 0), Some(500_000_000_000));
        assert_eq!(
            gi(&job, 1) as u128,
            quantize_min_out(sell_min_out(500_000_000_000, parse_e18("0.0000021").unwrap(), 6, 500).unwrap()),
            "TP leg: tick price, TP slippage"
        );
        // Two ticks below SL: only B sells (SL leg, its own slippage); A stays as it was.
        e.tick(4, "0.00000075", "curve").await;
        e.wait_order(3, &b, |o| o["armed"] == true).await;
        e.tick(5, "0.00000075", "curve").await;
        let o = e.wait_order(3, &b, |o| o["status"] == "triggered").await;
        assert_eq!(o["leg"], "sl");
        let bid = o["actionId"].as_str().unwrap().to_string();
        assert_eq!(
            e.one_i64(&format!(
                "SELECT min_out FROM {s}.relayer_jobs WHERE action_id = '\\x{bid}'"
            ))
            .await as u128,
            quantize_min_out(sell_min_out(500_000_000_000, parse_e18("0.00000075").unwrap(), 6, 1_500).unwrap()),
            "SL leg: tick price, SL slippage"
        );
        assert_eq!(e.order(3, &a).await["actionId"].as_str(), Some(aid.as_str()));
        assert_eq!(e.sells_of(3).await, 2, "one trade per bracket");
        assert_eq!(e.tokens(3).await, (0, 1_000_000_000_000), "holds moved to the trades");
        // Cancel after a leg fired: not open.
        assert_eq!(
            code(&post(3, json!({"op":"order_cancel","orderId":a})).await),
            "order_not_open"
        );
        // B re-arms on slippage as a whole bracket (both legs back).
        e.fail_job(&bid, "slippage").await;
        let o = e.wait_order(3, &b, |o| o["status"] == "open").await;
        assert_eq!(
            (o["rearms"].as_i64(), o.get("leg"), o.get("actionId")),
            (Some(1), None, None)
        );
        assert_eq!(e.tokens(3).await, (0, 1_000_000_000_000), "hold kept on the order");
        // Cancel releases the bracket's single hold.
        let r = post(3, json!({"op":"order_cancel","orderId":b})).await;
        assert_eq!(r.body["status"], "cancelled", "{:?}", r.body);
        assert_eq!(e.tokens(3).await, (500_000_000_000, 500_000_000_000));

        // Race: SL armed, then two ticks (SL confirm, then TP) land while several evaluators
        // run at once. Exactly one leg fires, one trade, the hold moves once.
        let r = post(4, bracket(400_000_000_000, "0.000002", "0.0000008")).await;
        let c = r.body["id"].as_str().unwrap().to_string();
        e.tick(6, "0.0000007", "curve").await;
        e.wait_order(4, &c, |o| o["armed"] == true).await;
        let pass = || async {
            for _ in 0..5 {
                e.ledger.orders_tick("devnet", &eval_params()).await.unwrap();
            }
        };
        let ticks = async {
            e.tick(7, "0.0000007", "curve").await;
            e.tick(8, "0.0000025", "curve").await;
        };
        tokio::join!(pass(), pass(), pass(), pass(), ticks);
        let o = e.wait_order(4, &c, |o| o["status"] == "triggered").await;
        assert!(matches!(o["leg"].as_str(), Some("tp" | "sl")), "{o:?}");
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(e.sells_of(4).await, 1, "OCO: one trade");
        assert_eq!(e.tokens(4).await, (600_000_000_000, 400_000_000_000));
        assert_eq!(e.order(4, &c).await["status"], "triggered");

        // D1 retention scrubs the bracket legs too.
        e.sql(&format!(
            "UPDATE {s}.orders SET closed_at = now() - interval '25 hours', status = 'cancelled' WHERE kind = 'bracket'"
        ))
        .await;
        e.ledger.orders_janitor().await.unwrap();
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.orders WHERE sl_price_sol IS NOT NULL OR leg IS NOT NULL OR mint IS NOT NULL"
            ))
            .await,
            0
        );
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn rearm_after_slippage() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.orders_env(&[5]).await;
        e.fund(6, 0, 100_000_000).await;
        let post = |n: u8, v: Value| {
            let body = v.to_string();
            let e = &e;
            async move { e.signed(&user(n), "POST", "/api/actions", &body).await }
        };
        let with_rearm = |mut v: Value| {
            v["rearm"] = json!(true);
            v
        };
        e.tick(1, "0.000001", "curve").await;

        // limit_sell + rearm: on-chain slippage → open again, same hold; then filled.
        let r = post(5, with_rearm(create("limit_sell", 500_000_000_000, "0.000001"))).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        let ls = r.body["id"].as_str().unwrap().to_string();
        e.tick(2, "0.0000011", "curve").await;
        let o = e.wait_order(5, &ls, |o| o["status"] == "triggered").await;
        let aid1 = o["actionId"].as_str().unwrap().to_string();
        e.fail_job(&aid1, "slippage").await;
        e.ledger.settle_ready(50).await.unwrap(); // DEBUGTMP
        let o = e.wait_order(5, &ls, |o| o["status"] == "open").await;
        assert_eq!((o["rearms"].as_i64(), o.get("actionId")), (Some(1), None));
        assert_eq!(
            e.tokens(5).await,
            (500_000_000_000, 500_000_000_000),
            "hold stays on the order"
        );
        let pf = e.signed(&user(5), "GET", "/api/portfolio", "").await.body;
        let failed = pf["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == aid1.as_str())
            .cloned();
        assert_eq!(
            failed.unwrap()["status"],
            "failed",
            "the attempt is an ordinary failed sell"
        );
        // Next tick: fires again (a new trade), then settles.
        e.tick(3, "0.0000012", "curve").await;
        let o = e.wait_order(5, &ls, |o| o["status"] == "triggered").await;
        let aid2 = o["actionId"].as_str().unwrap().to_string();
        assert_ne!(aid1, aid2);
        // A5: the re-armed sell is a NEW amount (shaved 0.5–2 %, 3 significant digits), the
        // rest of the hold is back on the balance.
        let t2 = e
            .one_i64(&format!(
                "SELECT token_amount FROM {s}.relayer_jobs WHERE action_id = '\\x{aid2}'"
            ))
            .await;
        assert!((490_000_000_000..500_000_000_000).contains(&t2), "{t2}");
        assert_eq!(quantize_min_out(t2 as u128) as i64, t2);
        assert_eq!(e.order(5, &ls).await["amount"], t2.to_string());
        assert_eq!(e.tokens(5).await, (1_000_000_000_000 - t2, t2));
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGR', out_token_amount = token_amount,
                    out_lamports = 500000000 WHERE action_id = '\\x{aid2}'"
        ))
        .await;
        let o = e.wait_order(5, &ls, |o| o["status"] == "filled").await;
        assert_eq!(o["rearms"], 1);
        let base = 1_000_000_000_000 - t2;
        assert_eq!(e.tokens(5).await, (base, 0));

        // Re-arms exhausted → failed (slippage), hold released.
        let r = post(5, with_rearm(create("limit_sell", 100_000_000_000, "0.000001"))).await;
        let ex = r.body["id"].as_str().unwrap().to_string();
        e.sql(&format!("UPDATE {s}.orders SET rearms = 3 WHERE id = '\\x{ex}'"))
            .await;
        // Another error than slippage never re-arms.
        let r = post(5, with_rearm(create("limit_sell", 100_000_000_000, "0.000001"))).await;
        let pl = r.body["id"].as_str().unwrap().to_string();
        e.tick(4, "0.0000013", "curve").await;
        let a_ex = e.wait_order(5, &ex, |o| o["status"] == "triggered").await["actionId"]
            .as_str()
            .unwrap()
            .to_string();
        let a_pl = e.wait_order(5, &pl, |o| o["status"] == "triggered").await["actionId"]
            .as_str()
            .unwrap()
            .to_string();
        e.fail_job(&a_ex, "slippage").await;
        e.fail_job(&a_pl, "pool_liquidity").await;
        assert_eq!(
            e.wait_order(5, &ex, |o| o["status"] == "failed").await["error"],
            "slippage"
        );
        assert_eq!(
            e.wait_order(5, &pl, |o| o["status"] == "failed").await["error"],
            "pool_liquidity"
        );
        assert_eq!(e.tokens(5).await, (base, 0));

        // stop_loss + rearm: the server guard (tick gapped below trigger × (1 − 15 %)) re-arms
        // instead of failing; without rearm the same gap fails.
        let r = post(5, with_rearm(create("stop_loss", 100_000_000_000, "0.000001"))).await;
        let sl = r.body["id"].as_str().unwrap().to_string();
        let r = post(5, create("stop_loss", 100_000_000_000, "0.000001")).await;
        let sl0 = r.body["id"].as_str().unwrap().to_string();
        e.tick(5, "0.0000005", "curve").await;
        e.wait_order(5, &sl, |o| o["armed"] == true).await;
        e.tick(6, "0.0000005", "curve").await;
        let o = e.wait_order(5, &sl, |o| o["rearms"] == 1).await;
        assert_eq!((o["status"].as_str(), o.get("armed")), (Some("open"), None));
        assert_eq!(
            e.wait_order(5, &sl0, |o| o["status"] == "failed").await["error"],
            "slippage"
        );
        assert_eq!(e.tokens(5).await, (base - 100_000_000_000, 100_000_000_000));

        // limit_buy + rearm: amount becomes the actual hold (D10 remainder already back);
        // the balance never changes on re-arm; cancel returns everything.
        let r = post(6, with_rearm(create("limit_buy", 10_000_000, "0.000001"))).await;
        let lb = r.body["id"].as_str().unwrap().to_string();
        e.tick(7, "0.0000009", "curve").await;
        let o = e.wait_order(6, &lb, |o| o["status"] == "triggered").await;
        let ab = o["actionId"].as_str().unwrap().to_string();
        let (avail, held) = e.avail(6).await;
        assert_eq!(avail + held, 100_000_000);
        e.fail_job(&ab, "slippage").await;
        let o = e.wait_order(6, &lb, |o| o["status"] == "open").await;
        assert_eq!(o["amount"].as_str().unwrap().parse::<i64>().unwrap(), held);
        assert_eq!(e.avail(6).await, (avail, held), "re-arm moves no money");
        let r = post(6, json!({"op":"order_cancel","orderId":lb})).await;
        assert_eq!(r.body["status"], "cancelled", "{:?}", r.body);
        assert_eq!(e.avail(6).await, (100_000_000, 0));
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
    assert_eq!(empty.headers["cache-control"], "no-store, no-transform");
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
        (0, 1, (fee - 1_000) as u128)
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
    assert_eq!(
        pf["claimable"],
        json!([{"mint": MINT, "solAmount": "19999000", "zecAmount": "0"}])
    );

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
        json!({"claimableLamports": "19999000", "claimedLamports": "0", "claimableZat": "0", "claimedZat": "0"})
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
        json!({"claimableLamports": "0", "claimedLamports": "19999000", "claimableZat": "0", "claimedZat": "0"})
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

#[tokio::test]
async fn discovery_list_behind_flag() {
    let Some(e) = setup_with(|c| c.intel.discovery = true).await else {
        return;
    };
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    assert_eq!(e.get("/api/pool").await.body["features"]["discovery"], true);
    assert_eq!(e.get("/api/tokens?source=discovery").await.body, json!([]));
    e.sql(&format!(
        "INSERT INTO {s}.intel_discovery (network, mint, venue, created_at, name, symbol, status, price_sol,
                                          market_cap_sol, progress_pct, as_of, pool, config) VALUES
           ('devnet', '{MINT}', 'pumpfun', to_timestamp(1800000000), 'Fresh', 'FRSH', 'curve', 0.00000003, 30,
            12.50, to_timestamp(1800000060), 'PoolSecretish', 'Cfg'),
           ('mainnet-beta', 'Other1111111111111111111111111111111111111', 'pumpfun', to_timestamp(1800000000),
            NULL, NULL, 'curve', 0, 0, NULL, to_timestamp(1800000060), NULL, NULL)",
        s = e.schema
    ))
    .await;
    let r = e.get("/api/tokens?source=discovery").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers["cache-control"], "public, max-age=60");
    let d = r.body.as_array().unwrap();
    assert_eq!(d.len(), 1, "only this network");
    assert_eq!(d[0]["symbol"], "FRSH");
    assert_eq!(d[0]["curveProgressPct"], "12.5");
    assert_eq!(d[0]["asOf"], 1_800_000_060_000u64);
    assert_eq!(d[0]["unzeenLaunch"], false);
    assert_eq!(d[0]["decimals"], 6);
    assert!(d[0].get("pool").is_none() && d[0].get("config").is_none());
    // Discovery never leaks into the pool list.
    assert_eq!(e.get("/api/tokens").await.body, json!([]));
    e.drop_schema().await;
}

/// A chat_* / noop body padded to exactly 1024 bytes (`pad` last), like web/lib/pad.ts.
fn chat_body(v: Value) -> String {
    let head = v.to_string();
    let base = format!("{},\"pad\":\"\"}}", &head[..head.len() - 1]);
    format!(
        "{},\"pad\":\"{}\"}}",
        &head[..head.len() - 1],
        " ".repeat(1024 - base.len())
    )
}

#[tokio::test]
async fn chat_flow() {
    let Some(e) = setup_with(|c| {
        c.chat.enabled = true;
        c.chat.noop = true;
        c.chat.key = Some(unzeen_api::config::ChatKey([0x42; 32]));
        c.chat.min_account_zat = 100_000;
    })
    .await
    else {
        return;
    };
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let s = e.schema.clone();
    let pool = e.get("/api/pool").await.body;
    assert_eq!(pool["features"]["chat"], true);
    assert_eq!(pool["features"]["noop"], true);
    assert_eq!(pool["chat"]["bodyBytes"], 1024);
    assert_eq!(pool["chat"]["minAccountZat"], "100000");
    e.sql(&format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol)
           VALUES ('{MINT}', 'pumpfun', 'PEPE', 'Pepe', 6, 0.000000028, 28.5);"
    ))
    .await;
    let post =
        |text: &str, badge: bool| chat_body(json!({"op":"chat","mint":MINT,"text":text,"showCreatorBadge":badge}));
    let act = |sk: &SigningKey, b: String| {
        let sk = sk.clone();
        let e = &e;
        async move { e.signed(&sk, "POST", "/api/actions", &b).await }
    };

    // Not eligible (no balance): 403 without amounts, padded like a success.
    let r = act(&user(1), post("gm", false)).await;
    assert_eq!((r.status, code(&r)), (StatusCode::FORBIDDEN, "chat_not_eligible"));
    assert_eq!(r.raw_len, 1024);
    e.fund(1, 0, 1_000_000).await;
    e.fund(2, 1, 1_000_000).await;
    e.fund(3, 2, 1_000_000).await;
    e.fund(4, 3, 1_000_000).await;
    // Wrong size, bad text, unknown mint.
    let r = act(&user(1), json!({"op":"chat","mint":MINT,"text":"gm"}).to_string()).await;
    assert_eq!((r.status, code(&r)), (StatusCode::BAD_REQUEST, "bad_request"));
    let r = act(&user(1), post(" gm", false)).await;
    assert_eq!(code(&r), "chat_text_invalid");
    assert_eq!(r.body["error"]["details"], "edge_space");
    let other = MINT2;
    let r = act(&user(1), chat_body(json!({"op":"chat","mint":other,"text":"gm"}))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // Badge without creator rights.
    let r = act(&user(1), post("gm", true)).await;
    assert_eq!(code(&r), "not_creator");

    // Post; same nonce + body → same answer; nick = HMAC vector formula.
    let body = post("gm frens", false);
    let h = e.sign(&user(1), "POST", "/api/actions", &body);
    let r1 = e.raw("POST", "/api/actions", &body, Some(&h)).await;
    assert_eq!(r1.status, StatusCode::OK, "{:?}", r1.body);
    assert_eq!(r1.raw_len, 1024);
    let r2 = e.raw("POST", "/api/actions", &body, Some(&h)).await;
    assert_eq!(
        (r1.body["id"].clone(), r1.body["nick"].clone()),
        (r2.body["id"].clone(), r2.body["nick"].clone())
    );
    let mint_b: [u8; 32] = bs58::decode(MINT).into_vec().unwrap().try_into().unwrap();
    let nick1 = unzeen_protocol::chat::nick(&[0x42; 32], CHAIN, &mint_b, &user(1).verifying_key().to_bytes(), false);
    assert_eq!(r1.body["nick"], nick1);
    let id1 = r1.body["id"].as_str().unwrap().to_string();
    // Rate limit: 10 s between ops of one key.
    let r = act(&user(1), post("again", false)).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    // Nothing in actions / Portfolio; no key in chat tables.
    assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.actions")).await, 0);
    let pf = e.signed(&user(1), "GET", "/api/portfolio", "").await.body;
    assert_eq!(pf["actions"].as_array().unwrap().len(), 0);

    // Not visible before the boundary; visible after.
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}/chat")).await.body["messages"],
        json!([])
    );
    e.ledger.chat_publish().await.unwrap();
    let page = e.get(&format!("/api/tokens/{MINT}/chat")).await;
    assert_eq!(page.headers["cache-control"], "public, max-age=5, no-transform");
    assert_eq!(page.raw_len % 4096, 0);
    let m = &page.body["messages"][0];
    assert_eq!(
        (m["id"].as_str().unwrap(), m["text"].as_str().unwrap()),
        (id1.as_str(), "gm frens")
    );
    assert_eq!(m["isCreator"], false);
    let cur = page.body["cursor"].as_str().unwrap().to_string();

    // Creator of the mint: badge = separate nick; hide user 2's message (text stays, flag set).
    e.sql(&format!(
        "INSERT INTO {s}.creator_tokens (mint, anon_pubkey) VALUES ('{MINT}', '\\x{}')",
        hex::encode(user(3).verifying_key().to_bytes())
    ))
    .await;
    let rc = act(&user(3), post("dev here", true)).await;
    assert_eq!(rc.status, StatusCode::OK);
    assert_ne!(
        rc.body["nick"],
        unzeen_protocol::chat::nick(&[0x42; 32], CHAIN, &mint_b, &user(3).verifying_key().to_bytes(), false)
    );
    let r2m = act(&user(2), post("fud", false)).await;
    let id2 = r2m.body["id"].as_str().unwrap().to_string();
    e.ledger.chat_publish().await.unwrap();
    // Hide: only the creator; others → 403.
    let r = act(&user(4), chat_body(json!({"op":"chat_hide","id":id2}))).await;
    assert_eq!(code(&r), "not_creator");
    // user 3 posted < 10 s ago: the creator hides after the per-key interval.
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    let r = act(&user(3), chat_body(json!({"op":"chat_hide","id":id2}))).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    e.ledger.chat_publish().await.unwrap();
    let after = e.get(&format!("/api/tokens/{MINT}/chat?after={cur}")).await.body;
    let hidden = after["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id2.as_str())
        .unwrap()
        .clone();
    assert_eq!(
        (hidden["hiddenByCreator"].clone(), hidden["text"].clone()),
        (json!(true), json!("fud"))
    );
    assert_eq!(
        after["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["id"] == id2.as_str())
            .count(),
        1
    );

    // Delete: not the author → 404; author → tombstone, text gone.
    let r = act(&user(4), chat_body(json!({"op":"chat_delete","id":id1}))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    let r = act(&user(1), chat_body(json!({"op":"chat_delete","id":id1}))).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let cur2 = e.get(&format!("/api/tokens/{MINT}/chat")).await.body["cursor"]
        .as_str()
        .unwrap()
        .to_string();
    e.ledger.chat_publish().await.unwrap();
    let after = e.get(&format!("/api/tokens/{MINT}/chat?after={cur2}")).await.body;
    assert_eq!(after["removed"], json!([{"id": id1, "reason": "deleted"}]));
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.chat_messages WHERE text IS NOT NULL AND status = 'removed'"
        ))
        .await,
        0
    );

    // Reports: own report = no effect; 3 distinct reporters → removed (reports).
    let rr = |sk: SigningKey| act(&sk, chat_body(json!({"op":"chat_report","id":id2,"reason":"spam"})));
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    assert_eq!(rr(user(2)).await.status, StatusCode::OK); // own
    assert_eq!(rr(user(1)).await.status, StatusCode::OK);
    assert_eq!(rr(user(4)).await.status, StatusCode::OK);
    e.ledger.chat_publish().await.unwrap();
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.chat_messages WHERE status = 'removed' AND removed_reason = 'reports'"
        ))
        .await,
        0,
        "2 reporters < 3"
    );
    assert_eq!(rr(user(3)).await.status, StatusCode::OK);
    e.ledger.chat_publish().await.unwrap();
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.chat_messages WHERE removed_reason = 'reports'"
        ))
        .await,
        1
    );

    // Mute (operator) → 403 chat_muted.
    e.ledger.chat_mute(MINT, &nick1, 1.0).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    assert_eq!(code(&act(&user(1), post("hi", false)).await), "chat_muted");

    // noop: 1024 in, 1024 out, nothing stored but the nonce.
    let r = act(&user(4), chat_body(json!({"op":"noop"}))).await;
    assert_eq!((r.status, r.raw_len), (StatusCode::OK, 1024));
    assert_eq!(r.body["status"], "queued");
    // Mint not listed → empty page; malformed cursor → 400.
    assert_eq!(e.get(&format!("/api/tokens/{other}/chat")).await.body["cursor"], "0");
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}/chat?after=x")).await.status,
        StatusCode::BAD_REQUEST
    );
    // No anon key anywhere in chat tables (only nicks); api_nonces rows expire.
    let pk1 = hex::encode(user(1).verifying_key().to_bytes());
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.chat_messages WHERE position(decode('{pk1}', 'hex') IN convert_to(coalesce(text,'') || nick, 'UTF8')) > 0"
        ))
        .await,
        0
    );
    e.drop_schema().await;
}

#[tokio::test]
async fn chat_hidden_when_disabled() {
    let Some(e) = setup().await else { return };
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let pool = e.get("/api/pool").await.body;
    assert!(pool["features"].get("chat").is_none() && pool.get("chat").is_none());
    assert!(pool["features"].get("noop").is_none());
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}/chat")).await.status,
        StatusCode::NOT_FOUND
    );
    e.fund(1, 0, 1_000_000).await;
    let r = e
        .signed(
            &user(1),
            "POST",
            "/api/actions",
            &chat_body(json!({"op":"chat","mint":MINT,"text":"gm"})),
        )
        .await;
    assert_eq!((r.status, code(&r)), (StatusCode::BAD_REQUEST, "bad_request"));
    let r = e
        .signed(&user(1), "POST", "/api/actions", &chat_body(json!({"op":"noop"})))
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    e.drop_schema().await;
}

const ZEC_SPL: &str = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

async fn bal(e: &Env, n: u8) -> (i64, i64) {
    let r = e
        .admin
        .query_one(
            &format!(
                "SELECT available_zat, held_zat FROM {}.balances WHERE anon_pubkey = '\\x{}'",
                e.schema,
                hex::encode(user(n).verifying_key().to_bytes())
            ),
            &[],
        )
        .await
        .unwrap();
    (r.get(0), r.get(1))
}

#[tokio::test]
async fn quote_pairs_zec_spl_and_usdc() {
    let Some(e) = setup_with(|c| {
        // Both registries: ZEC SPL (mainnet) is looked up by mint; create on devnet uses USDC.
        c.quotes.list = unzeen_api::config::known_quotes(true)
            .into_iter()
            .chain(unzeen_api::config::known_quotes(false))
            .collect();
        c.chat.noop = true;
    })
    .await
    else {
        return;
    };
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let s = e.schema.clone();
    // PoolInfo.quotes: only enabled venues (pumpfun here).
    let pool = e.get("/api/pool").await.body;
    let quotes = pool["quotes"].as_array().unwrap().clone();
    let zq = quotes.iter().find(|q| q["quote"] == "ZEC").unwrap();
    assert_eq!(
        (
            zq["mint"].as_str().unwrap(),
            zq["bridged"].clone(),
            zq["spreadBps"].clone()
        ),
        (ZEC_SPL, json!(true), json!(30))
    );
    assert_eq!(zq["venues"], json!(["pumpfun"]));
    assert!(
        quotes
            .iter()
            .all(|q| q["venues"].as_array().unwrap().iter().all(|v| v == "pumpfun"))
    );

    e.fund(2, 0, 2_000_000).await;
    e.sql(&format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, quote_mint, price_quote)
           VALUES ('{MINT}', 'pumpfun', 'ZPEPE', 'Z Pepe', 6, 0, 0, '{ZEC_SPL}', 0.00001);
         INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, ts, quote_mint, quote_amount)
           VALUES ('buy', 'pumpfun', '{MINT}', 'ZPEPE', 1000, 0, 6, 'QS0', now() - interval '1 hour', '{ZEC_SPL}', 300000),
                  ('buy', 'pumpfun', '{MINT}', 'ZPEPE', 1000, 0, 6, 'QS1', now(), '{ZEC_SPL}', 300000);"
    ))
    .await;
    // v0.14: the feed poller values fresh ZEC-pair trades at the pool rate (10 SOL/ZEC here):
    // 0.003 ZEC → 0.03 SOL; an hour-old one stays 0; price_sol follows price_quote.
    let mut valued = 0;
    for _ in 0..50 {
        valued = e
            .one_i64(&format!("SELECT sol_amount FROM {s}.trades WHERE signature = 'QS1'"))
            .await;
        if valued > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(valued, 30_000_000);
    assert_eq!(
        e.one_i64(&format!("SELECT sol_amount FROM {s}.trades WHERE signature = 'QS0'"))
            .await,
        0
    );
    assert_eq!(
        e.one_i64(&format!(
            "SELECT (price_sol * 100000000)::bigint FROM {s}.tokens WHERE mint = '{MINT}'"
        ))
        .await,
        10_000,
        "0.00001 ZEC × 10 SOL/ZEC = 0.0001 SOL"
    );
    // Token and feed carry the pair.
    let t = e.get(&format!("/api/tokens/{MINT}")).await.body;
    assert_eq!(
        (t["quote"].clone(), t["quoteMint"].clone(), t["priceQuote"].clone()),
        (json!("ZEC"), json!(ZEC_SPL), json!("0.00001"))
    );
    assert_eq!(t["trades"][0]["quoteAmount"], "300000");
    assert_eq!(t["trades"][0]["quoteMint"], ZEC_SPL);
    let list = e.get("/api/tokens").await.body;
    assert_eq!(list[0]["quote"], "ZEC");

    // Buy in the ZEC SPL pair: 1:1 minus 30 bps, ZEC SPL units in the job, no SOL rate.
    let r = e.signed(&user(2), "POST", "/api/actions", &buy_body(400_000)).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(r.body["rate"]["quote"], "ZEC");
    assert_eq!(r.body["rate"]["quotePerZec"], "99700000");
    assert_eq!(r.body["rate"]["source"], "parity");
    assert!(r.body["rate"].get("lamportsPerZec").is_none());
    let id = r.body["id"].as_str().unwrap().to_string();
    let units = e
        .one_i64(&format!("SELECT lamports_in FROM {s}.relayer_jobs WHERE op = 'buy'"))
        .await;
    assert_eq!(units, 390_000, "398 800 units shaved 0–1 % and floored to 0.0001 ZEC");
    let charged = (390_000u128 * 100_000_000).div_ceil(99_700_000) as i64; // 391 174
    assert_eq!(bal(&e, 2).await, (2_000_000 - charged, charged));
    // Relayer: partial fill 300 000 units for 1000 tokens → pro-rata refund.
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'ZB1', out_token_amount = 1000, out_lamports = NULL,
                out_quote_mint = '{ZEC_SPL}', out_quote_amount = 300000 WHERE op = 'buy'"
    ))
    .await;
    let st = wait_executed(&e, 2, &id).await;
    assert_eq!(
        (st["fill"]["quoteAmount"].clone(), st["fill"]["quoteMint"].clone()),
        (json!("300000"), json!(ZEC_SPL))
    );
    assert!(st["fill"].get("solAmount").is_none());
    let refund = (charged as i128 * 90_000 / 390_000) as i64;
    assert_eq!(bal(&e, 2).await, (2_000_000 - charged + refund, 0));

    // Sell in the ZEC pair: minZecOut → ZEC SPL units at 1 + 30 bps; proceeds credited 1:1 − spread.
    // (600 of the 1000 bought: not a mirror of the buy, so no A6 shave here.)
    let sell = json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":"600","minZecOut":"100000"}).to_string();
    let r = e.signed(&user(2), "POST", "/api/actions", &sell).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let sid = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(
        e.one_i64(&format!("SELECT min_out FROM {s}.relayer_jobs WHERE op = 'sell'"))
            .await,
        100_000, // 100 300 units quantized down to 3 significant digits (E4)
    );
    let before = bal(&e, 2).await.0;
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'ZS1', out_token_amount = 600, out_lamports = NULL,
                out_quote_mint = '{ZEC_SPL}', out_quote_amount = 200600 WHERE op = 'sell'"
    ))
    .await;
    wait_executed(&e, 2, &sid).await;
    assert_eq!(bal(&e, 2).await.0 - before, 200_000);

    // A6: selling the rest (400 = the whole position left, ±1 %) is shaved and rounded; a
    // sell that mirrors nothing stays exact.
    let sell = |a: &str| json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":a,"minZecOut":"100000"}).to_string();
    let r = e.signed(&user(2), "POST", "/api/actions", &sell("400")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let sid2 = r.body["id"].as_str().unwrap().to_string();
    let t = e
        .one_i64(&format!(
            "SELECT token_amount FROM {s}.relayer_jobs WHERE action_id = '\\x{sid2}'"
        ))
        .await;
    assert!((392..400).contains(&t), "{t}");
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'failed', error_code = 'slippage', error_message = 'x'
         WHERE action_id = '\\x{sid2}'"
    ))
    .await;
    let path = format!("/api/actions/{sid2}");
    for _ in 0..60 {
        if e.signed(&user(2), "GET", &path, "").await.body["status"] == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let r = e.signed(&user(2), "POST", "/api/actions", &sell("250")).await;
    let sid3 = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(
        e.one_i64(&format!(
            "SELECT token_amount FROM {s}.relayer_jobs WHERE action_id = '\\x{sid3}'"
        ))
        .await,
        250
    );

    // Orders: SOL pairs only.
    let ord = json!({"op":"order_create","venue":"pumpfun","mint":MINT,"kind":"limit_buy","triggerPriceSol":"0.00000001","amount":"200000"}).to_string();
    assert_eq!(
        code(&e.signed(&user(2), "POST", "/api/actions", &ord).await),
        "order_unsupported_mint"
    );

    // Create in a USDC pair (devnet pump.fun USDC): lamport-booked, meta.quote for the relayer.
    let c = json!({"op":"create","venue":"pumpfun","meta":{"name":"Usd","symbol":"USDX"},"quote":"USDC"}).to_string();
    let r = e.signed(&user(2), "POST", "/api/actions", &c).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'create' AND meta->>'quote' = 'USDC'"
        ))
        .await,
        1
    );
    // ZEC pair on devnet does not exist; unknown quote → 400; platform outside LaunchLab → 400.
    for (body, want) in [
        (
            json!({"op":"create","venue":"pumpfun","meta":{"name":"A","symbol":"A"},"quote":"ZEC"}),
            "bad_request",
        ),
        (
            json!({"op":"create","venue":"pumpfun","meta":{"name":"A","symbol":"A"},"quote":"DOGE"}),
            "bad_request",
        ),
        (
            json!({"op":"create","venue":"pumpfun","meta":{"name":"A","symbol":"A"},"platform":"bonk"}),
            "bad_request",
        ),
    ] {
        assert_eq!(
            code(&e.signed(&user(2), "POST", "/api/actions", &body.to_string()).await),
            want,
            "{body}"
        );
    }

    // Nonce replay both ways: a nonce spent by noop cannot be reused by an action.
    let noop = chat_body(json!({"op":"noop"}));
    let h = e.sign(&user(2), "POST", "/api/actions", &noop);
    assert_eq!(
        e.raw("POST", "/api/actions", &noop, Some(&h)).await.status,
        StatusCode::OK
    );
    let nonce: [u8; 16] = hex::decode(&h.nonce).unwrap().try_into().unwrap();
    let b2 = buy_body(300_000);
    let h2 = api_auth::sign_request(CHAIN, &user(2), "POST", "/api/actions", b2.as_bytes(), nonce, now_ms());
    let r = e.raw("POST", "/api/actions", &b2, Some(&h2)).await;
    assert_eq!((r.status, code(&r)), (StatusCode::CONFLICT, "replay"));
    e.drop_schema().await;
}

// ================================================================== API v0.16: Bags

/// Wait until the action `id` of `user(n)` reaches a final status.
async fn wait_final(e: &Env, n: u8, id: &str) -> Value {
    let path = format!("/api/actions/{id}");
    for _ in 0..60 {
        let st = e.signed(&user(n), "GET", &path, "").await;
        if st.body["status"] == "executed" || st.body["status"] == "failed" {
            return st.body;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("action {id} not final");
}

#[tokio::test]
async fn bags_devnet_unavailable_and_pool_venues() {
    let Some(e) = setup_with(|c| c.venues = vec!["pumpfun".into(), "bags".into(), "jupiter".into()]).await else {
        return;
    };
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let v = e.get("/api/pool").await.body["venues"].clone();
    assert_eq!(
        v,
        json!([
            {"venue":"pumpfun","trade":true,"create":true,"quotes":["SOL","USDC"],"atomicFirstBuy":true,
             "creatorFees":true,"mainnetOnly":false},
            {"venue":"bags","trade":false,"create":false,"quotes":[],"atomicFirstBuy":false,
             "creatorFees":false,"mainnetOnly":true},
            {"venue":"jupiter","trade":false,"create":false,"quotes":[],"atomicFirstBuy":true,
             "creatorFees":false,"mainnetOnly":true}
        ])
    );
    e.fund(9, 0, 100_000_000).await;
    let body = json!({"op":"create","venue":"bags","meta":{"name":"Bag","symbol":"BAG"},"initialBuyZec":"1000000"})
        .to_string();
    let r = e.signed(&user(9), "POST", "/api/actions", &body).await;
    assert_eq!(code(&r), "venue_unavailable", "{:?}", r.body);
    e.drop_schema().await;
}

#[tokio::test]
async fn bags_first_buy_is_a_separate_held_job() {
    let Some(e) = setup_with(|c| {
        c.cluster = "mainnet-beta";
        c.venues = vec!["pumpfun".into(), "bags".into()];
    })
    .await
    else {
        return;
    };
    let s = e.schema.clone();
    let n = 10u8;
    e.fund(n, 0, 100_000_000).await;
    let create = |sym: &str| {
        json!({"op":"create","venue":"bags","meta":{"name":"Bag","symbol":sym},"initialBuyZec":"10000000"}).to_string()
    };
    let job = |sym: &str, part: i16, col: &str| {
        format!(
            "SELECT {col} FROM {s}.relayer_jobs WHERE part = {part} AND action_id =
               (SELECT action_id FROM {s}.relayer_jobs WHERE op = 'create' AND meta->>'symbol' = '{sym}')"
        )
    };
    // Quote pairs: Bags is SOL only.
    let usdc = json!({"op":"create","venue":"bags","meta":{"name":"Bag","symbol":"BAGU"},"quote":"USDC"}).to_string();
    assert_eq!(
        code(&e.signed(&user(n), "POST", "/api/actions", &usdc).await),
        "bad_request"
    );

    // A4: no Bags curve row from the relayer → refused (never a first buy with min_out 0).
    let r = e.signed(&user(n), "POST", "/api/actions", &create("BAG0")).await;
    assert_eq!(code(&r), "venue_unavailable", "{:?}", r.body);
    assert_eq!(e.avail(n).await, (100_000_000, 0));
    e.sql(&format!(
        "INSERT INTO {s}.launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves,
                                         real_token_reserves, token_total_supply)
         VALUES ('mainnet-beta', 'bags', 30000000000, 1073000000000000, 793100000000000, 1000000000000000)"
    ))
    .await;

    // 1) Create + first buy, both confirmed.
    let r = e.signed(&user(n), "POST", "/api/actions", &create("BAGA")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    // The launch vault must also fund the first buy (RELAYER v10 meta.reserve_lamports);
    // min_out bounds the first buy's price (75 % of the curve estimate).
    assert_eq!(
        e.one_i64(&job("BAGA", 0, "(meta->>'reserve_lamports')::bigint")).await,
        e.one_i64(&job("BAGA", 1, "lamports_in")).await
    );
    assert!(e.one_i64(&job("BAGA", 1, "min_out")).await > 0);
    let a = r.body["id"].as_str().unwrap().to_string();
    let (avail0, held0) = e.avail(n).await;
    assert_eq!(avail0 + held0, 100_000_000);
    let lamports = e.one_i64(&job("BAGA", 1, "lamports_in")).await;
    assert!(lamports > 0);
    assert_eq!(
        e.one_i64(&job("BAGA", 0, "lamports_in")).await,
        0,
        "create carries no buy"
    );
    let st = e
        .admin
        .query_one(
            &job("BAGA", 1, "status || '/' || op || '/' || COALESCE(mint, '-')"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(st.get::<_, String>(0), "held/buy/-");
    // Held while the create is queued (the settler runs every second).
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(
        e.admin
            .query_one(&job("BAGA", 1, "status"), &[])
            .await
            .unwrap()
            .get::<_, String>(0),
        "held"
    );
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGBAGC', out_mint = '{MINT}',
                out_token_amount = 0, out_lamports = 0, out_creator_fee = 0
         WHERE op = 'create' AND meta->>'symbol' = 'BAGA'"
    ))
    .await;
    let mut released = String::new();
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        released = e
            .admin
            .query_one(&job("BAGA", 1, "status || '/' || COALESCE(mint, '-')"), &[])
            .await
            .unwrap()
            .get(0);
        if released != "held/-" {
            break;
        }
    }
    assert_eq!(released, format!("queued/{MINT}"), "released onto the new mint");
    let st = e.signed(&user(n), "GET", &format!("/api/actions/{a}"), "").await.body["status"].clone();
    assert!(st == "queued" || st == "sent", "action waits for its first buy: {st}");
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGBAGB', out_token_amount = 5000000,
                out_lamports = lamports_in WHERE op = 'buy' AND mint = '{MINT}'"
    ))
    .await;
    let done = wait_executed(&e, n, &a).await;
    assert_eq!(done["fill"]["mint"], MINT);
    assert_eq!(done["fill"]["tokenAmount"], "5000000");
    let ct = e
        .admin
        .query_one(
            &format!("SELECT locked_amount, launch_fee_lamports FROM {s}.creator_tokens WHERE mint = '{MINT}'"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        (gi(&ct, 0), gi(&ct, 1)),
        (5_000_000, 0),
        "first-buy tokens locked; Bags launch fee is not ours"
    );
    let (avail1, held1) = e.avail(n).await;
    assert_eq!((held1, avail1), (0, avail0 + held0 - held0), "whole hold spent");

    // 2) Create confirmed, first buy fails (a sniper moved the price): create fee spent,
    //    the first buy's ZEC comes back.
    let r = e.signed(&user(n), "POST", "/api/actions", &create("BAGB")).await;
    let b = r.body["id"].as_str().unwrap().to_string();
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SIGBAGC2', out_mint = '{MINT2}',
                out_token_amount = 0, out_lamports = 0, out_creator_fee = 0
         WHERE op = 'create' AND meta->>'symbol' = 'BAGB'"
    ))
    .await;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if e.one_i64(&format!(
            "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'buy' AND mint = '{MINT2}' AND status = 'queued'"
        ))
        .await
            == 1
        {
            break;
        }
    }
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'failed', error_code = 'slippage', error_message = 'x'
         WHERE op = 'buy' AND mint = '{MINT2}'"
    ))
    .await;
    let done = wait_executed(&e, n, &b).await;
    assert_eq!(done["fill"]["mint"], MINT2);
    let fee = 100_000; // createFeeZat in tests
    assert_eq!(e.avail(n).await, (avail1 - fee, 0), "only the create fee is spent");

    // 3) Create fails → the held buy fails with it, everything back.
    let r = e.signed(&user(n), "POST", "/api/actions", &create("BAGC")).await;
    let c = r.body["id"].as_str().unwrap().to_string();
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'failed', error_code = 'venue_unavailable', error_message = 'x'
         WHERE op = 'create' AND meta->>'symbol' = 'BAGC'"
    ))
    .await;
    let done = wait_final(&e, n, &c).await;
    assert_eq!(
        (done["status"].as_str(), done["error"].as_str()),
        (Some("failed"), Some("venue_unavailable")),
        "{done:?}"
    );
    assert_eq!(e.avail(n).await, (avail1 - fee, 0));
    e.drop_schema().await;
}

// ================================================================== API v0.17: full feed, candles in quote

#[tokio::test]
async fn full_feed_filters_and_quote_candles() {
    let Some(e) = setup_with(|c| c.intel.full_trades = true).await else {
        return;
    };
    let s = e.schema.clone();
    let creator = "Dev1111111111111111111111111111111111111111";
    // MINT: a foreign pump.fun token (not an Unzeen launch). MINT2: a devnet USDC pair.
    e.sql(&format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals) VALUES ('{MINT}', 'pumpfun', 'F', 'F', 6);
         INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, quote_mint)
           VALUES ('{MINT2}', 'pumpfun', 'Q', 'Q', 6, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
         INSERT INTO {s}.intel_creates (network, mint, venue, creator, slot, created_at, signature)
           VALUES ('devnet', '{MINT}', 'pumpfun', '{creator}', 1, now() - interval '1 hour', 'SIGC');
         INSERT INTO {s}.market_trades (mint, kind, venue, symbol, trader, unzeen, tags, token_amount, sol_amount,
                                        decimals, signature, ix, slot, ts) VALUES
           ('{MINT}', 'buy', 'pumpfun', 'F', 'Whale111', FALSE, '{{whale}}', 1000000, 5000000000, 6, 'S1', 0, 1, now()),
           ('{MINT}', 'buy', 'pumpfun', 'F', '{creator}', FALSE, '{{}}', 1000, 1000000, 6, 'S2', 0, 1, now()),
           ('{MINT}', 'sell', 'pumpfun', 'F', 'Other111', FALSE, '{{dev}}', 1000, 1000000, 6, 'S3', 0, 1, now()),
           ('{MINT}', 'buy', 'pumpfun', 'F', 'Vault111', TRUE, '{{}}', 1000, 1000000, 6, 'S4', 0, 1, now()),
           ('{MINT}', 'buy', 'pumpfun', 'F', 'Small111', FALSE, '{{}}', 10, 10000, 6, 'S5', 0, 1, now());
         INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts,
                                 quote_mint, quote_amount) VALUES
           ('buy', 'pumpfun', '{MINT2}', 'Q', 2000000, 1000000000, 6, 'Q1', 1, now() - interval '30 seconds',
            '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 150000000),
           ('sell', 'pumpfun', '{MINT2}', 'Q', 1000000, 600000000, 6, 'Q2', 1, now() - interval '20 seconds',
            '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 80000000);"
    ))
    .await;
    let sigs = |v: &Value| -> Vec<String> {
        let mut x: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["solanaTx"].as_str().unwrap().to_string())
            .collect();
        x.sort();
        x
    };
    let w = e.get(&format!("/api/tokens/{MINT}/trades?filter=whales")).await;
    assert_eq!(w.status, StatusCode::OK, "{:?}", w.body);
    assert_eq!(sigs(&w.body), vec!["S1"]);
    assert_eq!(w.body[0]["trader"], "Whale111");
    let d = e.get(&format!("/api/tokens/{MINT}/trades?filter=dev")).await;
    assert_eq!(
        sigs(&d.body),
        vec!["S2", "S3"],
        "tagged + the creator's own trade, never the pool's"
    );
    let s2 = d
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["solanaTx"] == "S2")
        .unwrap();
    assert!(s2["tags"].as_array().unwrap().contains(&json!("dev")));
    let all = e.get(&format!("/api/tokens/{MINT}/trades?filter=all")).await;
    assert_eq!(all.body.as_array().unwrap().len(), 5);
    let u = e.get(&format!("/api/tokens/{MINT}/trades?filter=unzeen")).await;
    assert_eq!(sigs(&u.body), vec!["S4"]);
    assert_eq!(u.body[0]["trader"], "unzeen");

    // Candles: SOL by default, pair units with quote=1.
    let sol = e.get(&format!("/api/tokens/{MINT2}/candles?tf=1h")).await;
    assert_eq!(sol.status, StatusCode::OK, "{:?}", sol.body);
    let bar = &sol.body[sol.body.as_array().unwrap().len() - 1];
    assert_eq!(bar["volume"], "1600000000");
    let q = e.get(&format!("/api/tokens/{MINT2}/candles?tf=1h&quote=1")).await;
    let bar = &q.body[q.body.as_array().unwrap().len() - 1];
    // 150 USDC / 2 tokens = 75; then 80 / 1 = 80.
    assert_eq!((bar["open"].as_str(), bar["close"].as_str()), (Some("75"), Some("80")));
    assert_eq!(bar["volume"], "230000000");
    assert_eq!(
        code(&e.get(&format!("/api/tokens/{MINT2}/candles?quote=x")).await),
        "bad_request"
    );
    // A SOL pair with quote=1: same as SOL.
    assert_eq!(
        e.get(&format!("/api/tokens/{MINT}/candles?tf=1h&quote=1")).await.status,
        StatusCode::OK
    );
    e.drop_schema().await;
}

/// Integer column of either type (BIGINT or NUMERIC(78,0) since migration 0026) as i64.
fn gi(r: &unzeen_ledger::tokio_postgres::Row, i: usize) -> i64 {
    i64::try_from(r.get::<_, unzeen_ledger::Num>(i).0).expect("fits i64 in tests")
}

fn goi(r: &unzeen_ledger::tokio_postgres::Row, i: usize) -> Option<i64> {
    r.get::<_, Option<unzeen_ledger::Num>>(i)
        .map(|n| i64::try_from(n.0).expect("fits i64 in tests"))
}

/// v0.18: display-only rates from the timer cache (503 until the first refresh) and the
/// Robinhood Chain venue refused on a Solana server before any hold.
#[tokio::test]
async fn public_rates_and_hood_venue() {
    let Some(e) = setup().await else { return };
    let r = e.get("/api/rates").await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{:?}", r.body);
    e.state
        .public_rates
        .set(unzeen_api::rates::Snapshot {
            zec_usd: 1218.79,
            sol_usd: 107.79,
            eth_usd: 2506.85,
            ts_ms: 1_791_763_200_000,
        })
        .await;
    let r = e.get("/api/rates").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.body,
        json!({"usd":{"ZEC":"1218.79","SOL":"107.79","ETH":"2506.85"},
               "pairs":{"ZEC/SOL":"11.3071","ZEC/ETH":"0.486184"},
               "approximate":true,"source":"near-1click","ts":1_791_763_200_000u64})
    );
    assert_eq!(r.headers["cache-control"], "public, max-age=60");

    e.fund(1, 0, 5_000_000).await;
    let body = json!({"op":"sell","venue":"pons","mint":MINT,"amount":"1000000000000000000000000000",
                      "minZecOut":"1","exec":"delayed"})
    .to_string();
    let r = e.signed(&user(1), "POST", "/api/actions", &body).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{:?}", r.body);
    assert_eq!(r.body["error"]["code"], "venue_unavailable");
    // A Solana server caps token amounts at u64 (SPL); 1e27 is refused on input.
    let body = json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":"1000000000000000000000000000",
                      "minZecOut":"200000","exec":"delayed"})
    .to_string();
    let r = e.signed(&user(1), "POST", "/api/actions", &body).await;
    assert_eq!(r.body["error"]["code"], "bad_request", "{:?}", r.body);
    // u64::MAX still parses (u128 path) and fails only on the balance.
    let body = json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":u64::MAX.to_string(),
                      "minZecOut":"200000","exec":"delayed"})
    .to_string();
    let r = e.signed(&user(1), "POST", "/api/actions", &body).await;
    assert_eq!(r.body["error"]["code"], "insufficient_balance", "{:?}", r.body);
    e.drop_schema().await;
}

// ================================================================== scenarios (API v0.19, S2/S3)

mod scenarios_v019 {
    use super::*;

    impl Env {
        async fn scenario(&self, n: u8) -> Value {
            let pf = self.signed(&user(n), "GET", "/api/portfolio", "").await;
            assert_eq!(pf.raw_len, unzeen_api::PORTFOLIO_BYTES, "one fixed portfolio size");
            pf.body["scenarios"][0].clone()
        }

        async fn wait_scenario(&self, n: u8, f: impl Fn(&Value) -> bool) -> Value {
            for _ in 0..100 {
                let s = self.scenario(n).await;
                if f(&s) {
                    return s;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("scenario condition not reached: {:?}", self.scenario(n).await);
        }

        async fn wait_jobs(&self, op: &str, n: i64) {
            let s = &self.schema;
            for _ in 0..100 {
                if self
                    .one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs WHERE op = '{op}'"))
                    .await
                    >= n
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let r = self
                .admin
                .query_one(
                    &format!("SELECT status, error, phase, cursor, state::text FROM {s}.scenarios LIMIT 1"),
                    &[],
                )
                .await
                .unwrap();
            panic!(
                "no {op} job: {:?} {:?} {:?} {:?} {:?}",
                r.get::<_, String>(0),
                r.get::<_, Option<String>>(1),
                r.get::<_, String>(2),
                r.get::<_, i16>(3),
                r.get::<_, String>(4)
            );
        }

        async fn token_with_tick(&self) {
            let s = &self.schema;
            let now = now_ms();
            self.sql(&format!(
                "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol)
                 VALUES ('{MINT}', 'pumpfun', 'UNZ', 'Unz', 6, 0.000001, 1000);
                 INSERT INTO {s}.intel_prices (mint, price_sol, status, tick_at) VALUES ('{MINT}', 0.000001, 'curve', {now})"
            ))
            .await;
        }
    }

    fn op(v: Value) -> String {
        v.to_string()
    }

    fn plan_buy_wait_sell() -> Value {
        json!({"v":1,"steps":[
            {"id":0,"block":{"type":"manual_start"}},
            {"id":1,"block":{"type":"buy","venue":"pumpfun","mint":MINT,"zec":{"abs":"10000000"},
                             "guard":{"slippageBps":500},"exec":"now"}},
            {"id":2,"block":{"type":"wait_random","minSecs":3600,"maxSecs":7200}},
            {"id":3,"block":{"type":"sell","venue":"pumpfun","mint":MINT,"amount":{"pct":100,"of":{"step":1}},
                             "guard":{"slippageBps":1500},"exec":"delayed"}},
            {"id":4,"block":{"type":"end"}}]})
    }

    /// API v0.21: before start step 0 is `pending`; once started `manual_start` is `done`; a
    /// cancelled plan reports never-run steps as `skipped`, finished ones keep `done`.
    #[tokio::test]
    async fn step_statuses_after_start_and_cancel() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.fund(7, 0, 50_000_000).await;
        e.token_with_tick().await;
        let r = e
            .signed(
                &user(7),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":plan_buy_wait_sell()})),
            )
            .await;
        let id = r.body["id"].as_str().unwrap().to_string();
        assert_eq!(e.scenario(7).await["steps"][0]["status"], "pending");
        let r = e
            .signed(
                &user(7),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_start","id":id})),
            )
            .await;
        assert_eq!(r.body["status"], "active", "{:?}", r.body);
        e.wait_jobs("buy", 1).await;
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SB', out_token_amount = 90000000000,
                    out_lamports = lamports_in WHERE op = 'buy'"
        ))
        .await;
        let sc = e.wait_scenario(7, |x| x["steps"][2]["status"] == "waiting").await;
        assert_eq!(sc["steps"][0]["status"], "done");
        assert_eq!(sc["steps"][1]["status"], "done");
        let r = e
            .signed(
                &user(7),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_cancel","id":id})),
            )
            .await;
        assert_eq!(r.body["status"], "cancelled", "{:?}", r.body);
        let sc = e.scenario(7).await;
        assert_eq!(sc["status"], "cancelled");
        let st: Vec<&str> = sc["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["status"].as_str().unwrap())
            .collect();
        assert_eq!(st, ["done", "done", "skipped", "skipped", "skipped"]);
        assert!(sc["steps"][2].get("nextAt").is_none());
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn manual_start_buy_wait_sell_done() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.fund(7, 0, 50_000_000).await;
        e.token_with_tick().await;
        let r = e
            .signed(
                &user(7),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":plan_buy_wait_sell()})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        assert_eq!(r.body["status"], "waiting_start");
        let id = r.body["id"].as_str().unwrap().to_string();
        let sc = e.scenario(7).await;
        assert_eq!(
            (sc["id"].as_str(), sc["status"].as_str()),
            (Some(id.as_str()), Some("waiting_start"))
        );
        // The creation receipt is not a trade: not in Portfolio.actions, no hold, no job.
        let pf = e.signed(&user(7), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf["actions"], json!([]));
        assert_eq!(pf["zecHeld"], "0");

        let r = e
            .signed(
                &user(7),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_start","id":id})),
            )
            .await;
        assert_eq!(r.body["status"], "active", "{:?}", r.body);
        assert_eq!(
            e.scenario(7).await["steps"][0]["status"],
            "done",
            "manual_start done once started"
        );
        // Now right after the manual start: an ordinary `now` buy with the hold taken at this step.
        e.wait_jobs("buy", 1).await;
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'buy' AND exec_mode = 'now'"
            ))
            .await,
            1
        );
        let sc = e.wait_scenario(7, |x| x["steps"][1]["status"] == "running").await;
        let buy_action = sc["steps"][1]["actionId"].as_str().unwrap().to_string();
        assert!(sc["steps"][1]["runs"] == 1);
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SB', out_token_amount = 90000000000,
                    out_lamports = lamports_in WHERE op = 'buy'"
        ))
        .await;
        // The executor took the wait (phase `waiting`, timer 1–2 h away).
        for _ in 0..100 {
            if e.one_i64(&format!(
                "SELECT count(*) FROM {s}.scenarios WHERE phase = 'waiting' AND cursor = 2"
            ))
            .await
                == 1
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let sc = e.scenario(7).await;
        assert_eq!(sc["steps"][2]["status"], "waiting");
        let next = sc["steps"][2]["nextAt"].as_i64().unwrap();
        assert!(
            next % 60_000 == 0 && next > now_ms() as i64 + 3_000_000,
            "minute-rounded, ≥ 1 h away"
        );
        let pf = e.signed(&user(7), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf["holdings"][0]["amount"], "90000000000");
        assert!(pf["actions"].as_array().unwrap().iter().any(|a| a["id"] == buy_action));
        // Skip the wait; the sell spends the buy's output (100 %).
        e.sql(&format!("UPDATE {s}.scenarios SET next_at = now()")).await;
        e.wait_jobs("sell", 1).await;
        // A6: 100 % of the buy mirrors it → shaved 0.5–2 % and rounded to 3 significant digits.
        let sold = e
            .one_i64(&format!("SELECT token_amount FROM {s}.relayer_jobs WHERE op = 'sell'"))
            .await;
        assert!((88_200_000_000..90_000_000_000).contains(&sold), "{sold}");
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SS', out_token_amount = token_amount,
                    out_lamports = 50000000 WHERE op = 'sell'"
        ))
        .await;
        let sc = e.wait_scenario(7, |x| x["status"] == "done").await;
        assert_eq!(sc["steps"][3]["status"], "done");
        assert_eq!(sc["steps"][4]["status"], "done");
        // Retention: closed + 24 h → scrubbed (gone from the portfolio), + 48 h → deleted.
        e.sql(&format!(
            "UPDATE {s}.scenarios SET closed_at = now() - interval '25 hours'"
        ))
        .await;
        e.ledger.scenarios_janitor().await.unwrap();
        assert_eq!(e.scenario(7).await, Value::Null);
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.scenario_runs WHERE action_id IS NOT NULL"
            ))
            .await,
            0
        );
        e.sql(&format!(
            "UPDATE {s}.scenarios SET closed_at = now() - interval '49 hours'"
        ))
        .await;
        e.ledger.scenarios_janitor().await.unwrap();
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.scenarios")).await, 0);
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn refused_step_rolls_back_to_savepoint_and_fails_the_plan() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.fund(8, 0, 1_000_000).await;
        e.token_with_tick().await;
        // 0.5 ZEC buy with 0.01 ZEC on the balance → insufficient_balance at the step (hold at step).
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"buy","venue":"pumpfun","mint":MINT,"zec":{"abs":"50000000"},
                             "guard":{"slippageBps":500},"exec":"delayed"}}]});
        let r = e
            .signed(
                &user(8),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":plan})),
            )
            .await;
        assert_eq!(r.body["status"], "active", "{:?}", r.body);
        let sc = e.wait_scenario(8, |x| x["status"] == "failed").await;
        assert_eq!(sc["error"], "insufficient_balance");
        assert_eq!(sc["steps"][0]["error"], "insufficient_balance");
        // The refused action left nothing behind (savepoint): only the creation receipt exists.
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.actions WHERE kind <> 'scenario_create'"
            ))
            .await,
            0
        );
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs")).await, 0);
        let pf = e.signed(&user(8), "GET", "/api/portfolio", "").await.body;
        assert_eq!(
            (pf["zecBalance"].as_str(), pf["zecHeld"].as_str()),
            (Some("1000000"), Some("0"))
        );
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn validation_limits_cancel_and_replay() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.fund(9, 0, 10_000_000).await;
        e.token_with_tick().await;
        // scenario_rule with details {step, code}.
        let bad = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"wait_random","minSecs":60,"maxSecs":120}},
            {"id":1,"block":{"type":"buy","venue":"pumpfun","mint":MINT,"zec":{"abs":"1000000"},
                             "guard":{"slippageBps":500},"exec":"now"}}]});
        let r = e
            .signed(
                &user(9),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":bad})),
            )
            .await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(r.body["error"]["code"], "scenario_rule");
        assert_eq!(r.body["error"]["details"], json!({"code":"now_not_first","step":1}));
        // A block of a disabled feature (chat is off here) answers like an unknown op.
        let later = json!({"v":1,"steps":[{"id":0,"block":{"type":"chat","mint":MINT,"text":"gm"}}]});
        let r = e
            .signed(
                &user(9),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":later})),
            )
            .await;
        assert_eq!(
            (r.status, r.body["error"]["code"].as_str()),
            (StatusCode::BAD_REQUEST, Some("bad_request"))
        );
        assert_eq!(r.body["error"]["details"], json!({"code":"feature_disabled","step":0}));
        // 3 active plans per key, the 4th → scenario_limit.
        let wait = json!({"v":1,"steps":[{"id":0,"block":{"type":"manual_start"}},
                                         {"id":1,"block":{"type":"wait_random","minSecs":60,"maxSecs":120}}]});
        let body = op(json!({"op":"scenario_create","plan":wait}));
        let mut ids = vec![];
        for _ in 0..3 {
            let r = e.signed(&user(9), "POST", "/api/actions", &body).await;
            assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
            ids.push(r.body["id"].as_str().unwrap().to_string());
        }
        let r = e.signed(&user(9), "POST", "/api/actions", &body).await;
        assert_eq!(r.body["error"]["code"], "scenario_limit");
        // Replace = cancel old + create new atomically (still 3 active).
        let r = e
            .signed(
                &user(9),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":wait,"replaces":ids[0]})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.scenarios WHERE status IN ('waiting_start','active')"
            ))
            .await,
            3
        );
        // Cancel one, then stop all; cancelling again → scenario_not_active.
        let r = e
            .signed(
                &user(9),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_cancel","id":ids[1]})),
            )
            .await;
        assert_eq!(r.body["status"], "cancelled", "{:?}", r.body);
        let r = e
            .signed(
                &user(9),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_cancel","all":true})),
            )
            .await;
        assert_eq!(r.body["ids"].as_array().unwrap().len(), 2, "{:?}", r.body);
        let r = e
            .signed(
                &user(9),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_cancel","id":ids[1]})),
            )
            .await;
        assert_eq!(
            (r.status, r.body["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("scenario_not_active"))
        );
        // Another key cannot see or cancel them.
        let r = e
            .signed(
                &user(1),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_cancel","id":ids[2]})),
            )
            .await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn sealed_fields_and_expiry() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        // Sealing is exercised at the ledger level (S6 blocks are not offered yet): a plan with a
        // blob is cancelled → the blob is gone in the same transaction.
        e.fund(10, 0, 10_000_000).await;
        let wait = json!({"v":1,"steps":[{"id":0,"block":{"type":"wait_random","minSecs":60,"maxSecs":120}}]});
        let r = e
            .signed(
                &user(10),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":wait})),
            )
            .await;
        let id = r.body["id"].as_str().unwrap().to_string();
        e.sql(&format!(
            "INSERT INTO {s}.scenario_sealed (scenario_id, step, blob) VALUES ('\\x{id}', 0, '\\x00')"
        ))
        .await;
        // TTL over → expired, sealed blob deleted.
        e.sql(&format!(
            "UPDATE {s}.scenarios SET expires_at = date_trunc('hour', now())"
        ))
        .await;
        let sc = e.wait_scenario(10, |x| x["status"] == "expired").await;
        assert_eq!(sc["id"], id);
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.scenario_sealed")).await, 0);
        e.drop_schema().await;
    }

    async fn wait_sql(e: &Env, q: &str) {
        for _ in 0..100 {
            if e.one_i64(q).await >= 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("condition not reached: {q}");
    }

    /// Wait for `n` jobs of `op`, skipping floors / waits on the way (P2/P9 add random delays).
    async fn wait_jobs_skipping(e: &Env, op: &str, n: i64) {
        let s = &e.schema;
        for _ in 0..100 {
            skip_timers(e).await;
            if e.one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs WHERE op = '{op}'"))
                .await
                >= n
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("no {op} job");
    }

    async fn create_plan(e: &Env, n: u8, plan: Value) -> String {
        let r = e
            .signed(
                &user(n),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_create","plan":plan})),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    /// Skip the current timer of every plan (waits, floors, polls).
    async fn skip_timers(e: &Env) {
        // Floors are measured from the key's real last trade (public `trades.ts`): the fake
        // relayer's confirmed jobs get feed rows dated 3 h back, as if that much time had passed.
        let s = &e.schema;
        e.sql(&format!(
            "INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
             SELECT CASE WHEN op = 'sell' THEN 'sell' ELSE 'buy' END, COALESCE(venue, 'pumpfun'),
                    COALESCE(mint, out_mint, 'M'), 'X', COALESCE(out_token_amount, 0), COALESCE(out_lamports, 0), 6,
                    signature, 1, now() - interval '3 hours'
             FROM {s}.relayer_jobs WHERE status = 'confirmed' AND signature IS NOT NULL AND op IN ('buy', 'sell', 'create')
             ON CONFLICT DO NOTHING;
             UPDATE {s}.trades SET ts = now() - interval '3 hours' WHERE ts > now() - interval '3 hours';
             UPDATE {s}.scenarios SET next_at = now() WHERE next_at IS NOT NULL"
        ))
        .await;
    }

    #[tokio::test]
    async fn s4_deposit_trigger_feeds_a_buy() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.token_with_tick().await;
        e.fund(11, 0, 1_000_000).await;
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"deposit_received","minZat":"20000000"}},
            {"id":1,"block":{"type":"buy","venue":"pumpfun","mint":MINT,"zec":{"pct":50,"of":{"step":0}},
                             "guard":{"limitPrice":"0.00001"},"exec":"delayed"}},
            {"id":2,"block":{"type":"end"}}]});
        create_plan(&e, 11, plan).await;
        // Armed on the deposits total before the new deposit (old balance does not count).
        wait_sql(
            &e,
            &format!("SELECT count(*) FROM {s}.scenarios WHERE state->'sub' ? 'base'"),
        )
        .await;
        e.fund(11, 1, 30_000_000).await;
        skip_timers(&e).await;
        // P3: fired → waiting 10–40 min (phase waiting), nothing traded yet.
        wait_sql(
            &e,
            &format!("SELECT count(*) FROM {s}.scenarios WHERE phase = 'waiting' AND cursor = 0"),
        )
        .await;
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs")).await, 0);
        skip_timers(&e).await;
        e.wait_jobs("buy", 1).await;
        // 50 % of the 0.3 ZEC deposit (the earlier 0.01 ZEC is not the trigger's output).
        let hold = e
            .one_i64(&format!("SELECT hold_zat FROM {s}.actions WHERE kind = 'buy'"))
            .await;
        assert!((14_000_000..=15_000_000).contains(&hold), "{hold}");
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn s4_s5_order_place_cancel_own_result_and_time() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.token_with_tick().await;
        e.fund(12, 0, 10_000_000).await;
        let pk = hex::encode(user(12).verifying_key().to_bytes());
        e.sql(&format!(
            "INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', '{MINT}', 5000000000)"
        ))
        .await;
        let at = (now_ms() / 60_000 + 5) * 60_000;
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"time_at","at":at}},
            {"id":1,"block":{"type":"order_place","order":{"kind":"limit_sell","venue":"pumpfun","mint":MINT,
                             "amount":{"pct":40,"of":"balance"},"triggerPriceSol":"0.001"}}},
            {"id":2,"block":{"type":"order_cancel","ref":{"step":1}}},
            {"id":3,"block":{"type":"own_result","ref":{"step":1},"on":"failed"}},
            {"id":4,"block":{"type":"end"}}]});
        create_plan(&e, 12, plan).await;
        // time_at: waiting until `at` + U(0, 10 min).
        wait_sql(
            &e,
            &format!(
                "SELECT count(*) FROM {s}.scenarios WHERE phase = 'waiting' AND next_at > now() + interval '4 minutes'"
            ),
        )
        .await;
        skip_timers(&e).await;
        let sc = e.wait_scenario(12, |x| x["status"] == "done").await;
        let oid = sc["steps"][1]["orderId"].as_str().unwrap().to_string();
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.orders WHERE id = '\\x{oid}' AND status = 'cancelled'"
            ))
            .await,
            1
        );
        // The order's token hold went back.
        let pf = e.signed(&user(12), "GET", "/api/portfolio", "").await.body;
        assert_eq!(
            (pf["holdings"][0]["amount"].as_str(), pf["holdings"][0]["held"].as_str()),
            (Some("5000000000"), Some("0"))
        );
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn s5_swap_dca_repeat() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.token_with_tick().await;
        let now = now_ms();
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol)
             VALUES ('{MINT2}', 'pumpfun', 'B', 'B', 6, 0.000002, 1000);
             INSERT INTO {s}.intel_prices (mint, price_sol, status, tick_at) VALUES ('{MINT2}', 0.000002, 'curve', {now})"
        ))
        .await;
        e.fund(13, 0, 100_000_000).await;
        let pk = hex::encode(user(13).verifying_key().to_bytes());
        e.sql(&format!(
            "INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', '{MINT}', 90000000000)"
        ))
        .await;
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"swap","from":MINT,"to":MINT2,"amount":{"abs":"90000000000"},
                             "guardSell":{"slippageBps":1500},"guardBuy":{"slippageBps":500},"exec":"delayed"}},
            {"id":1,"block":{"type":"dca","side":"buy","venue":"pumpfun","mint":{"step":0},"total":{"abs":"4000000"},
                             "slices":2,"everySecs":{"min":600,"max":900},"guard":{"slippageBps":500},"exec":"delayed"}},
            {"id":2,"block":{"type":"end"}}]});
        create_plan(&e, 13, plan).await;
        // Swap: sell leg, then a hidden pause, then the buy leg (spending 92–98 % of the proceeds).
        e.wait_jobs("sell", 1).await;
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SW1', out_token_amount = token_amount,
                    out_lamports = 500000000 WHERE op = 'sell'"
        ))
        .await;
        wait_sql(
            &e,
            &format!("SELECT count(*) FROM {s}.scenarios WHERE phase = 'waiting' AND state->'sub'->>'leg' = 'buy'"),
        )
        .await;
        skip_timers(&e).await;
        e.wait_jobs("buy", 1).await;
        let proceeds = e
            .one_i64(&format!("SELECT amount_zat FROM {s}.actions WHERE kind = 'sell'"))
            .await;
        let _ = proceeds;
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'SW2', out_token_amount = 7000000000,
                    out_lamports = lamports_in WHERE op = 'buy'"
        ))
        .await;
        // DCA on the swap's `to` (MINT2): two slices with a wait in between (P9 gap first).
        wait_jobs_skipping(&e, "buy", 2).await;
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'D' || id, out_token_amount = 1000,
                    out_lamports = lamports_in WHERE op = 'buy' AND status = 'queued'"
        ))
        .await;
        wait_jobs_skipping(&e, "buy", 3).await;
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'buy' AND mint = '{MINT2}'"
            ))
            .await,
            3
        );
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'D' || id, out_token_amount = 1000,
                    out_lamports = lamports_in WHERE op = 'buy' AND status = 'queued'"
        ))
        .await;
        let sc = e.wait_scenario(13, |x| x["status"] == "done").await;
        assert_eq!(sc["steps"][1]["runs"], 2, "{sc:?}");
        // Repeat: abs buys twice.
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"buy","venue":"pumpfun","mint":MINT,"zec":{"abs":"2000000"},
                             "guard":{"slippageBps":500},"exec":"delayed"}},
            {"id":1,"block":{"type":"wait_random","minSecs":60,"maxSecs":120}},
            {"id":2,"block":{"type":"repeat","from":0,"times":2}}]});
        create_plan(&e, 13, plan).await;
        for round in 0..2 {
            wait_sql(
                &e,
                &format!(
                    "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'buy' AND mint = '{MINT}' AND status = 'queued'"
                ),
            )
            .await;
            e.sql(&format!(
                "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'R' || id, out_token_amount = 1000,
                        out_lamports = lamports_in WHERE op = 'buy' AND status = 'queued'"
            ))
            .await;
            wait_sql(
                &e,
                &format!("SELECT count(*) FROM {s}.scenarios WHERE status = 'active' AND phase = 'waiting'"),
            )
            .await;
            skip_timers(&e).await;
            let _ = round;
        }
        let sc = e.wait_scenario(13, |x| x["status"] == "done").await;
        assert_eq!(sc["status"], "done");
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'buy' AND mint = '{MINT}'"
            ))
            .await,
            2
        );
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn s6_sealed_withdrawal_claim_and_safety() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.token_with_tick().await;
        e.fund(14, 0, 10_000_000).await;
        let pk = hex::encode(user(14).verifying_key().to_bytes());
        e.sql(&format!(
            "INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', '{MINT}', 5000000000);
             INSERT INTO {s}.creator_tokens (mint, anon_pubkey) VALUES ('{MINT2}', '\\x{pk}');
             INSERT INTO {s}.creator_claimable (anon_pubkey, mint, lamports) VALUES ('\\x{pk}', '{MINT2}', 50000000);
             INSERT INTO {s}.token_safety (mint, as_of, data) VALUES ('{MINT}', date_trunc('minute', now()),
               '{{\"authorities\":{{\"mintRevoked\":true,\"freezeRevoked\":true,\"riskyExtensions\":[]}},\"market\":{{\"status\":\"curve\"}}}}')"
        ))
        .await;
        let dest = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"check_safety","mint":MINT,"require":{"authoritiesRevoked":true,"noRiskyExtensions":true},"onFalse":"stop"}},
            {"id":1,"block":{"type":"claim","mint":MINT2}},
            {"id":2,"block":{"type":"wait_random","minSecs":3600,"maxSecs":7200}},
            {"id":3,"block":{"type":"withdraw_token","mint":MINT,"amount":{"pct":100,"of":"balance"},"to":dest,"exec":"max"}}]});
        create_plan(&e, 14, plan).await;
        // The address is sealed (masked echo), the plain one is nowhere in the plan row.
        let sc = e.scenario(14).await;
        assert!(sc.get("plan").is_none(), "no plan echo in the portfolio");
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.scenarios WHERE plan->'steps'->3->'block'->>'to' = 'sealed'"
            ))
            .await,
            1
        );
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.scenarios WHERE plan::text LIKE '%{dest}%'"
            ))
            .await,
            0
        );
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.scenario_sealed")).await, 1);
        // Safety passes, claim credits 0.05 SOL at 10 SOL/ZEC = 0.005 ZEC, then the wait.
        wait_sql(
            &e,
            &format!("SELECT count(*) FROM {s}.scenarios WHERE phase = 'waiting' AND cursor = 2"),
        )
        .await;
        let pf = e.signed(&user(14), "GET", "/api/portfolio", "").await.body;
        assert_eq!(pf["zecBalance"], "10500000");
        wait_jobs_skipping(&e, "transfer", 1).await;
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'transfer' AND dest = '{dest}'"
            ))
            .await,
            1
        );
        // The sealed address stays until the transfer is confirmed (a retry needs it), then goes.
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.scenario_sealed")).await, 1);
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'T' || id, out_token_amount = token_amount,
                    out_lamports = 0 WHERE op = 'transfer'"
        ))
        .await;
        wait_sql(&e, &format!("SELECT (count(*) = 0)::int FROM {s}.scenario_sealed")).await;
        // A failing safety check stops the plan with `check_failed`.
        e.sql(&format!(
            "UPDATE {s}.token_safety SET data = jsonb_set(data, '{{authorities,mintRevoked}}', 'false')"
        ))
        .await;
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"check_safety","mint":MINT,"require":{"authoritiesRevoked":true},"onFalse":"stop"}},
            {"id":1,"block":{"type":"end"}}]});
        let id2 = create_plan(&e, 14, plan).await;
        wait_sql(
            &e,
            &format!("SELECT count(*) FROM {s}.scenarios WHERE id = '\\x{id2}' AND status = 'failed'"),
        )
        .await;
        let pf = e.signed(&user(14), "GET", "/api/portfolio", "").await.body;
        let sc = pf["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == id2.as_str())
            .unwrap()
            .clone();
        assert_eq!(sc["error"], "check_failed");
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn s7_cancel_while_in_flight_and_flag_off() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.token_with_tick().await;
        e.fund(15, 0, 50_000_000).await;
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"buy","venue":"pumpfun","mint":MINT,"zec":{"abs":"10000000"},
                             "guard":{"slippageBps":500},"exec":"delayed"}},
            {"id":1,"block":{"type":"wait_random","minSecs":60,"maxSecs":120}},
            {"id":2,"block":{"type":"sell_all","venue":"pumpfun","mint":MINT,"guard":{"slippageBps":1500},"exec":"delayed"}}]});
        let id = create_plan(&e, 15, plan).await;
        e.wait_jobs("buy", 1).await;
        // Cancel while the buy is queued: the buy is not recalled (like a fired order), the plan stops.
        let r = e
            .signed(
                &user(15),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_cancel","id":id})),
            )
            .await;
        assert_eq!(r.body["status"], "cancelled", "{:?}", r.body);
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'C1', out_token_amount = 1000,
                    out_lamports = lamports_in WHERE op = 'buy'"
        ))
        .await;
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(
            e.one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'sell'"))
                .await,
            0
        );
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.relayer_jobs WHERE settled_at IS NOT NULL"
            ))
            .await,
            1
        );
        // Executor pass over a closed plan does nothing.
        let rep = unzeen_api::scenarios::exec::pass(&e.state).await;
        assert_eq!((rep.fired, rep.failed), (0, 0));
        e.drop_schema().await;

        // Flag off: ops answer like unknown ops, nothing in PoolInfo / Portfolio.
        let Some(e) = setup_with(|c| c.scenarios = Default::default()).await else {
            return;
        };
        e.ledger.set_pool_meta("network", "test").await.unwrap();
        e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
        let r = e
            .signed(
                &user(1),
                "POST",
                "/api/actions",
                &op(json!({"op":"scenario_cancel","all":true})),
            )
            .await;
        assert_eq!(
            (r.status, r.body["error"]["message"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid action body"))
        );
        let p = e.get("/api/pool").await.body;
        assert!(p.get("scenarios").is_none() && p["features"].get("scenarios").is_none());
        let pf = e.signed(&user(1), "GET", "/api/portfolio", "").await;
        assert!(pf.body.get("scenarios").is_none());
        assert_eq!(pf.raw_len, unzeen_api::PORTFOLIO_BYTES, "same size without the feature");
        e.drop_schema().await;
    }

    /// S7: the executor never talks to the network — no HTTP client, no RPC, no 1Click call
    /// (rates come only from the background cache, prices from the indexer's tables).
    #[test]
    fn executor_makes_no_network_requests() {
        let src = include_str!("../src/scenarios/exec.rs");
        for banned in [
            "reqwest",
            "http::",
            ".refresh(",
            "fetch",
            "tonic",
            "TcpStream",
            "rpc_url",
            "connect(",
        ] {
            assert!(!src.contains(banned), "executor must not use {banned}");
        }
        let ops = include_str!("../src/scenarios/ops.rs");
        assert!(!ops.contains("reqwest") && !ops.contains(".refresh("));
    }

    /// Review-scenarios п. 1/3: floors by TIME from the key's real last trade. A manual buy
    /// outside the plan holds the plan's token withdrawal back; a sell holds a following buy
    /// funded `of: "balance"` (P6) — the step waits, it never fails.
    #[tokio::test]
    async fn s8_floors_by_time_from_real_trades() {
        let Some(e) = setup().await else { return };
        let s = e.schema.clone();
        e.token_with_tick().await;
        e.fund(16, 0, 100_000_000).await;
        let pk = hex::encode(user(16).verifying_key().to_bytes());
        e.sql(&format!(
            "INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', '{MINT}', 5000000000)"
        ))
        .await;
        // A manual buy of MINT, still in flight.
        let r = e.signed(&user(16), "POST", "/api/actions", &buy_body(1_000_000)).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        let dest = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"withdraw_token","mint":MINT,"amount":{"abs":"1000000000"},"to":dest,"exec":"max"}}]});
        create_plan(&e, 16, plan).await;
        wait_sql(
            &e,
            &format!("SELECT count(*) FROM {s}.scenarios WHERE state->'steps'->>'0' = 'waiting'"),
        )
        .await;
        // Confirmed 30 min ago: still < 1 h + U(0, 30 min).
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'MB', out_token_amount = 1000,
                    out_lamports = lamports_in WHERE op = 'buy';
             INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
             VALUES ('buy', 'pumpfun', '{MINT}', 'X', 1000, 1, 6, 'MB', 1, now() - interval '30 minutes');
             UPDATE {s}.scenarios SET next_at = now()"
        ))
        .await;
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(
            e.one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'transfer'"))
                .await,
            0
        );
        assert_eq!(
            e.one_i64(&format!("SELECT count(*) FROM {s}.scenarios WHERE status = 'active'"))
                .await,
            1
        );
        // 3 h later: the withdrawal goes.
        wait_jobs_skipping(&e, "transfer", 1).await;

        // P6 through `of: "balance"`: sell, then a buy of another mint waits U(3, 15) min.
        let plan = json!({"v":1,"steps":[
            {"id":0,"block":{"type":"sell","venue":"pumpfun","mint":MINT,"amount":{"abs":"2000000000"},
                             "guard":{"limitPrice":"0.0001"},"exec":"delayed"}},
            {"id":1,"block":{"type":"buy","venue":"pumpfun","mint":MINT,"zec":{"pct":10,"of":"balance"},
                             "guard":{"limitPrice":"0.00001"},"exec":"delayed"}}]});
        create_plan(&e, 16, plan).await;
        wait_jobs_skipping(&e, "sell", 1).await;
        e.sql(&format!(
            "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = 'S6', out_token_amount = token_amount,
                    out_lamports = 2000000 WHERE op = 'sell';
             INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
             VALUES ('sell', 'pumpfun', '{MINT}', 'X', 1, 1, 6, 'S6', 1, now())"
        ))
        .await;
        wait_sql(
            &e,
            &format!("SELECT count(*) FROM {s}.scenarios WHERE cursor = 1 AND status = 'active'"),
        )
        .await;
        e.sql(&format!(
            "UPDATE {s}.scenarios SET next_at = now() WHERE status = 'active' AND cursor = 1"
        ))
        .await;
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(
            e.one_i64(&format!("SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'buy'"))
                .await,
            1,
            "only the manual buy"
        );
        let p6 = e
            .one_i64(&format!(
                "SELECT (state->'sub'->>'p6')::float8::bigint FROM {s}.scenarios WHERE status = 'active' AND cursor = 1"
            ))
            .await;
        assert!((180..=900).contains(&p6), "{p6}");
        wait_jobs_skipping(&e, "buy", 2).await;
        e.drop_schema().await;
    }
}

// ================================================================== Robinhood Chain instance (API v0.20)

/// A hood-testnet instance end to end with a fake relayer: deposit (memo signed for 0212) →
/// buy on Pons (wei, 18-decimal token amounts beyond u64) → sell → withdraw_token to an EVM
/// address. Solana venues / addresses are refused on this server.
#[tokio::test]
async fn hood_instance_deposit_buy_sell_withdraw() {
    const TOKEN: &str = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const WEI_PER_ZEC: u64 = 485_000_000_000_000_000; // 0.485 ETH / ZEC
    let Some(e) = setup_with(|c| {
        c.policy.chain = ChainId::hood(ZcashNet::Testnet, unzeen_protocol::HoodNet::Testnet);
        c.cluster = "hood-testnet";
        c.venues = vec!["pons".into()];
        c.rate.fixed_lamports_per_zec = Some(WEI_PER_ZEC);
        c.rate.hood = true;
        c.quotes.list = vec![];
        c.fees.withdraw_token_gas_lamports = 50_000_000_000_000;
        c.fees.withdraw_token_cost_lamports = 10_000_000_000_000;
    })
    .await
    else {
        return;
    };
    let s = e.schema.clone();
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let p = e.get("/api/pool").await.body;
    assert_eq!(p["chainId"], "0212");
    assert_eq!(
        p["chain"],
        json!({"id":"hood","network":"hood-testnet","mainnet":false,"native":{"symbol":"ETH","decimals":18},"evmChainId":46630,
               "priceMaxAgeSecs":300})
    );
    assert_eq!(p["venues"][0]["venue"], "pons");
    assert_eq!(p["quotes"], json!([]));

    // Deposit: the memo is signed for chain id 0212.
    e.fund(20, 0, 50_000_000).await;
    let pf = e.signed(&user(20), "GET", "/api/portfolio", "").await.body;
    assert_eq!(pf["zecBalance"], "50000000");

    e.sql(&format!(
        "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol)
         VALUES ('{TOKEN}', 'pons', 'PONS', 'Pons token', 18, 0.0000000001, 100)"
    ))
    .await;
    // Solana venue / mint refused here.
    let bad = json!({"op":"buy","venue":"pumpfun","mint":TOKEN,"zecIn":"1000000","minOut":"1"}).to_string();
    let r = e.signed(&user(20), "POST", "/api/actions", &bad).await;
    assert_eq!(r.body["error"]["code"], "venue_unavailable", "{:?}", r.body);
    let bad = json!({"op":"buy","venue":"pons","mint":MINT,"zecIn":"1000000","minOut":"1"}).to_string();
    let r = e.signed(&user(20), "POST", "/api/actions", &bad).await;
    assert_eq!(r.body["error"]["code"], "bad_request", "{:?}", r.body);

    // review-hood-final п. 7: minOut 0, a stale or zero pool price → refused before any hold.
    let try_buy =
        |min_out: &str| json!({"op":"buy","venue":"pons","mint":TOKEN,"zecIn":"1000000","minOut":min_out}).to_string();
    let r = e.signed(&user(20), "POST", "/api/actions", &try_buy("0")).await;
    assert_eq!(r.body["error"]["code"], "bad_request", "{:?}", r.body);
    let sell0 = json!({"op":"sell","venue":"pons","mint":TOKEN,"amount":"1000","minZecOut":"0"}).to_string();
    let r = e.signed(&user(20), "POST", "/api/actions", &sell0).await;
    assert_eq!(r.body["error"]["code"], "bad_request", "{:?}", r.body);
    e.sql(&format!(
        "UPDATE {s}.tokens SET price_at = now() - interval '6 minutes'"
    ))
    .await;
    let r = e.signed(&user(20), "POST", "/api/actions", &try_buy("1")).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::SERVICE_UNAVAILABLE, "stale_price"),
        "{:?}",
        r.body
    );
    assert_eq!(r.headers["retry-after"], "60");
    // A status-only update does not refresh the price time; rewriting the price does.
    e.sql(&format!("UPDATE {s}.tokens SET status = status, updated_at = now()"))
        .await;
    assert_eq!(
        code(&e.signed(&user(20), "POST", "/api/actions", &try_buy("1")).await),
        "stale_price"
    );
    e.sql(&format!("UPDATE {s}.tokens SET price_sol = 0")).await;
    assert_eq!(
        code(&e.signed(&user(20), "POST", "/api/actions", &try_buy("1")).await),
        "stale_price"
    );
    e.sql(&format!("UPDATE {s}.tokens SET price_sol = 0.0000000001")).await;
    // v0.23: Token.priceTs (10 s granularity) lets the client block before sending.
    let one = e.get(&format!("/api/tokens/{TOKEN}")).await.body;
    let ts = one["priceTs"].as_i64().unwrap();
    assert_eq!(ts % 10_000, 0);
    assert!(ts <= now_ms() as i64 && ts > now_ms() as i64 - 20_000, "{ts}");
    let list = e.get("/api/tokens").await.body;
    assert_eq!(list[0]["priceTs"], ts);
    assert_eq!(
        e.signed(&user(20), "GET", "/api/portfolio", "").await.body["zecHeld"],
        "0",
        "no hold taken"
    );

    // Buy 0.1 ZEC → ≈ 0.0485 ETH in 0.0001 ETH steps; the lowercase mint is stored EIP-55.
    let buy = json!({"op":"buy","venue":"pons","mint":TOKEN.to_lowercase(),"zecIn":"10000000",
                     "minOut":"100000000000000000000000000","exec":"delayed"})
    .to_string();
    let r = e.signed(&user(20), "POST", "/api/actions", &buy).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let job = e
        .admin
        .query_one(
            &format!(
                "SELECT network, venue, mint, lamports_in::text, min_out::text FROM {s}.relayer_jobs WHERE op = 'buy'"
            ),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        (
            job.get::<_, String>(0),
            job.get::<_, String>(1),
            job.get::<_, String>(2)
        ),
        ("hood-testnet".into(), "pons".into(), TOKEN.into())
    );
    let wei: u128 = job.get::<_, String>(3).parse().unwrap();
    assert_eq!(wei % 100_000_000_000_000, 0, "D10 step 0.0001 ETH");
    assert!(
        (48_000_000_000_000_000..=48_500_000_000_000_000).contains(&wei),
        "{wei}"
    );
    let min_out: u128 = job.get::<_, String>(4).parse().unwrap();
    assert!(
        min_out > u64::MAX as u128 && min_out <= 100_000_000_000_000_000_000_000_000,
        "{min_out}"
    );
    // Fake relayer: confirmed with 5e26 + 1 base units (≫ u64), all the wei spent.
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = '0xb1', slot = 7, vault = '0x0000000000000000000000000000000000000001',
                out_mint = mint, out_token_amount = 500000000000000000000000001, out_lamports = lamports_in, network_fee = 20000000000000
          WHERE op = 'buy'"
    ))
    .await;
    let mut held = String::new();
    for _ in 0..50 {
        let pf = e.signed(&user(20), "GET", "/api/portfolio", "").await.body;
        if let Some(h) = pf["holdings"].as_array().and_then(|a| a.first()) {
            held = h["amount"].as_str().unwrap().to_string();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(held, "500000000000000000000000001");

    // Sell 2e26: proceeds in wei → ZEC at the fixed rate.
    let sell = json!({"op":"sell","venue":"pons","mint":TOKEN,"amount":"200000000000000000000000000",
                      "minZecOut":"1000000","exec":"delayed"})
    .to_string();
    let r = e.signed(&user(20), "POST", "/api/actions", &sell).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let min_wei: u128 = e
        .admin
        .query_one(
            &format!("SELECT min_out::text FROM {s}.relayer_jobs WHERE op = 'sell'"),
            &[],
        )
        .await
        .unwrap()
        .get::<_, String>(0)
        .parse()
        .unwrap();
    assert_eq!(min_wei, 4_850_000_000_000_000, "0.01 ZEC at 0.485 ETH/ZEC, ceil");
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = '0xb2', slot = 8,
                out_token_amount = token_amount, out_lamports = 19400000000000000000 WHERE op = 'sell'"
    ))
    .await;
    // 19.4 ETH (> u64::MAX wei) → 40 ZEC credited.
    let mut zec = String::new();
    for _ in 0..50 {
        zec = e.signed(&user(20), "GET", "/api/portfolio", "").await.body["zecBalance"]
            .as_str()
            .unwrap()
            .to_string();
        if zec.parse::<u64>().unwrap() > 4_000_000_000 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(zec.parse::<u64>().unwrap() >= 4_000_000_000, "{zec}");

    // Withdraw 1e26 to a fresh EVM address (lowercase in, EIP-55 out), ETH gas drop in wei.
    let to = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
    let w = json!({"op":"withdraw_token","mint":TOKEN,"amount":"100000000000000000000000000","to":to,"exec":"delayed"})
        .to_string();
    let r = e.signed(&user(20), "POST", "/api/actions", &w).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let t = e
        .admin
        .query_one(
            &format!("SELECT dest, gas_lamports, token_amount::text FROM {s}.relayer_jobs WHERE op = 'transfer'"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(t.get::<_, String>(0), "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
    assert_eq!(t.get::<_, i64>(1), 50_000_000_000_000);
    let part: u128 = t.get::<_, String>(2).parse().unwrap();
    assert!(
        part < 100_000_000_000_000_000_000_000_000 && part > 97_000_000_000_000_000_000_000_000,
        "A1 shave {part}"
    );
    e.sql(&format!(
        "UPDATE {s}.relayer_jobs SET status = 'confirmed', signature = '0xb3', slot = 9, out_token_amount = token_amount,
                out_lamports = 0 WHERE op = 'transfer'"
    ))
    .await;
    for _ in 0..50 {
        let pf = e.signed(&user(20), "GET", "/api/portfolio", "").await.body;
        if pf["holdings"][0]["held"] == "0" {
            let left: u128 = pf["holdings"][0]["amount"].as_str().unwrap().parse().unwrap();
            assert_eq!(
                left,
                500_000_000_000_000_000_000_000_001 - 200_000_000_000_000_000_000_000_000 - part
            );
            e.drop_schema().await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("withdrawal not settled");
}

mod verify_v3 {
    use unzeen_ledger::verify::VerifyTiming;
    use unzeen_protocol::verify::{self as pv, Node, TreeVersion};

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
        let r = e
            .admin
            .query_one(
                &format!(
                    "SELECT status, skip_reason FROM {}.verify_snapshots WHERE id = $1",
                    e.schema
                ),
                &[&id],
            )
            .await
            .unwrap();
        panic!(
            "snapshot {id} never reached {want}: {:?} {:?}",
            r.get::<_, String>(0),
            r.get::<_, Option<String>>(1)
        );
    }

    /// API v0.20: a Robinhood Chain snapshot is digest v3 with u128 leaves (1e27 base units of
    /// an ERC-20) and `0x…` assets; the browser check (leaf v3 → path → root) holds.
    #[tokio::test]
    async fn hood_snapshot_is_v3_with_u128_leaves() {
        const TOKEN: &str = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
        let Some(e) = setup_with(|c| {
            c.policy.chain = ChainId::hood(ZcashNet::Testnet, unzeen_protocol::HoodNet::Testnet);
            c.cluster = "hood-testnet";
            c.venues = vec!["pons".into()];
            c.rate.fixed_lamports_per_zec = Some(485_000_000_000_000_000);
            c.rate.hood = true;
            c.quotes.list = vec![];
            c.verify.timing = T;
        })
        .await
        else {
            return;
        };
        let s = e.schema.clone();
        e.fund(1, 0, 123_456_789).await;
        let pk1 = user(1).verifying_key().to_bytes();
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals) VALUES ('{TOKEN}', 'pons', 'P', 'P', 18);
             INSERT INTO {s}.token_balances (anon_pubkey, mint, available, held)
               VALUES ('\\x{}', '{TOKEN}', 1000000000000000000000000000, 7);
             INSERT INTO {s}.pool_meta (key, value) VALUES ('reserve_zat', '123456789'), ('reserve_height', '3000000');",
            hex::encode(pk1)
        ))
        .await;
        // Solana quote mints registered under the hood network (old instance start): the hood
        // registration empties the list, the snapshot has no quote assets.
        e.sql(&format!(
            "INSERT INTO {s}.pool_quotes (network, mint, quote, decimals, bridged)
             VALUES ('hood-testnet', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'USDC', 6, false),
                    ('devnet', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'USDC', 6, false)
             ON CONFLICT DO NOTHING"
        ))
        .await;
        unzeen_api::register_pool_quotes(&e.ledger, &e.state.cfg).await.unwrap();
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.pool_quotes WHERE network = 'hood-testnet'"
            ))
            .await,
            0
        );
        assert_eq!(e.one_i64(&format!("SELECT count(*) FROM {s}.pool_quotes WHERE network = 'devnet' AND mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'")).await, 1, "other networks untouched");
        let id = e
            .ledger
            .verify_request("hood-testnet", "0212", "manual", T)
            .await
            .unwrap()
            .unwrap();
        wait_status(&e, id, "collecting").await;
        e.sql(&format!(
            "INSERT INTO {s}.verify_vaults (snapshot_id, address, lamports, tokens, sig)
             VALUES ({id}, '0x0000000000000000000000000000000000000001', 30000000000000000000,
                     '[{{\"mint\":\"{TOKEN}\",\"amount\":\"1000000000000000000000000007\"}}]', '0xsig');
             UPDATE {s}.verify_snapshots SET solana_slot = 12345678, assets_done_at = now() WHERE id = {id};"
        ))
        .await;
        e.ledger.set_reserve(123_456_789, 3_000_000, now_ms()).await.unwrap();
        wait_status(&e, id, "built").await;
        let v = e.get("/api/verify").await.body;
        assert_eq!(v["digestVersion"], 3);
        assert_eq!(v["chainId"], "0212");
        assert!(
            v.get("quoteAssets").is_none_or(|q| q == &json!([])),
            "no Solana quote mints on hood: {:?}",
            v["quoteAssets"]
        );
        assert_eq!(v["vaults"][0]["lamports"], "30000000000000000000", "wei beyond u64");
        let tree = v["trees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["asset"] == TOKEN)
            .unwrap()
            .clone();
        assert_eq!(tree["sum"], "1000000000000000000000000007");

        let p = e.signed(&user(1), "GET", "/api/verify/proof", "").await.body;
        let ap = p["proofs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["asset"] == TOKEN)
            .unwrap();
        let asset = unzeen_protocol::evm::asset32(&unzeen_protocol::evm::parse_address(TOKEN).unwrap());
        let mut total = 0u128;
        for pc in ap["pieces"].as_array().unwrap() {
            let value: u128 = pc["value"].as_str().unwrap().parse().unwrap();
            total += value;
            let blind: [u8; 32] = hex::decode(pc["blind"].as_str().unwrap()).unwrap().try_into().unwrap();
            let leaf = Node {
                hash: pv::leaf_hash_v3(
                    [2, 0x12],
                    id as u32,
                    &asset,
                    &pk1,
                    pc["piece"].as_u64().unwrap() as u8,
                    value,
                    &blind,
                ),
                sum: value,
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
            let root = pv::root_from_path_v(
                TreeVersion::V3,
                &leaf,
                pc["leafIndex"].as_u64().unwrap() as usize,
                &path,
            );
            assert_eq!(hex::encode(root.hash), tree["root"].as_str().unwrap());
        }
        assert_eq!(total, 1_000_000_000_000_000_000_000_000_007);
        e.drop_schema().await;
    }
}

/// v0.24 (devnet run 15.10): `PoolInfo.launchRules.minInitialBuyZat ..= maxInitialBuyZatByVenue`
/// is exactly the accepted `initialBuyZec` range, and it is not empty.
#[tokio::test]
async fn initial_buy_range_matches_create() {
    let Some(e) = setup().await else { return };
    let me = user(7);
    e.fund(7, 0, 100_000_000).await;
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let p = e.get("/api/pool").await;
    let rules = &p.body["launchRules"];
    let min: u64 = rules["minInitialBuyZat"].as_str().unwrap().parse().unwrap();
    let max: u64 = rules["maxInitialBuyZatByVenue"]["pumpfun"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        min <= max && min < 100_000,
        "below minActionZat is allowed: {min}..{max}"
    );
    let create = |n: u64, sym: &str| {
        json!({"op":"create","venue":"pumpfun","meta":{"name":"Range","symbol":sym},"initialBuyZec":n.to_string()})
            .to_string()
    };
    let r = e.signed(&me, "POST", "/api/actions", &create(min - 1, "LO")).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::UNPROCESSABLE_ENTITY, "below_minimum"),
        "{:?}",
        r.body
    );
    let r = e.signed(&me, "POST", "/api/actions", &create(max + 1, "HI")).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::UNPROCESSABLE_ENTITY, "creator_cap"),
        "{:?}",
        r.body
    );
    for (n, sym) in [(min, "MIN"), (max, "MAX")] {
        let r = e.signed(&me, "POST", "/api/actions", &create(n, sym)).await;
        assert_eq!(r.status, StatusCode::OK, "{n}: {:?}", r.body);
    }
    // The minimum charges one 0.001 SOL step (+ the create fee), never 0 lamports.
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {}.relayer_jobs WHERE op = 'create' AND lamports_in >= 1000000",
            e.schema
        ))
        .await,
        2
    );
    e.drop_schema().await;
}

/// v0.25 (devnet run 15.10):
/// - buy `minOut = 0` / sell `minZecOut = 0` are refused on Solana too, also for pool tokens;
/// - B1: a buy of exactly `minActionZat` is accepted at a rate where the D10 shave takes the
///   charged amount below it (11.4425 SOL/ZEC);
/// - B2: the sell minimum is checked with the curve's price impact when `launch_curves` has
///   the venue (0.3 SOL devnet curve): a sell worth the minimum at spot but not on the curve
///   is `below_minimum`.
#[tokio::test]
async fn trade_guards_minimum_and_curve_impact() {
    let Some(e) = setup_with(|c| c.rate.fixed_lamports_per_zec = Some(11_442_500_000)).await else {
        return;
    };
    let s = e.schema.clone();
    let me = user(21);
    e.fund(21, 0, 100_000_000).await;
    // Devnet curve: 0.3 SOL / 1.073e15; the token sits on it after +0.627 SOL of buys
    // (S = 0.927 SOL, T = k / S), price = S/T per base unit.
    let (s0, t0) = (300_000_000u128, 1_073_000_000_000_000u128);
    let sol = 927_000_000u128;
    let tok = s0 * t0 / sol;
    let price = format!("{:.18}", sol as f64 * 1e6 / tok as f64 / 1e9);
    e.sql(&format!(
        "INSERT INTO {s}.launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves,
                                        real_token_reserves, token_total_supply)
         VALUES ('devnet', 'pumpfun', {s0}, {t0}, 793100000000000, 1000000000000000);
         INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, status)
         VALUES ('{MINT}', 'pumpfun', 'IMP', 'Impact', 6, {price}, 1, 'curve');
         INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{}', '{MINT}', {tok})",
        hex::encode(me.verifying_key().to_bytes())
    ))
    .await;
    let post = |b: Value| {
        let e = &e;
        let me = &me;
        async move { e.signed(me, "POST", "/api/actions", &b.to_string()).await }
    };
    // 1. Zero guards, before any hold.
    let r = post(json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":"1000000","minOut":"0"})).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::BAD_REQUEST, "bad_request"),
        "{:?}",
        r.body
    );
    let r = post(json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":"1000000000","minZecOut":"0"})).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::BAD_REQUEST, "bad_request"),
        "{:?}",
        r.body
    );
    assert_eq!(e.one_i64(&format!("SELECT held_zat FROM {s}.balances")).await, 0);
    // 2. B1: exactly minActionZat (0.0114425 SOL, shaved to 0.011 SOL = 96 133 zat) is accepted.
    for _ in 0..5 {
        let r = post(json!({"op":"buy","venue":"pumpfun","mint":MINT,"zecIn":"100000","minOut":"1"})).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    }
    assert_eq!(
        e.one_i64(&format!(
            "SELECT count(*) FROM {s}.relayer_jobs WHERE op = 'buy' AND min_out >= 1"
        ))
        .await,
        5
    );
    // 3. B2: with minZecOut = 1 the server's estimate decides the minimum check.
    let spot_per_base = sol as f64 / tok as f64; // lamports per base unit
    let min_l = 100_000u128 * 11_442_500_000 / 100_000_000; // 11 442 500 lamports
    // amount with spot value = 1.05 × min: impact (< 1 %) and the 1.25 % fee leave it above.
    let small = (min_l as f64 * 1.05 / spot_per_base) as u128;
    let r = post(json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":small.to_string(),"minZecOut":"1"})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    // Now the same check where the impact matters: drop the curve to a tiny one so that the
    // same spot value is far below the minimum on the curve.
    e.sql(&format!(
        "UPDATE {s}.launch_curves SET virtual_sol_lamports = 30000, virtual_token_reserves = 1073000000"
    ))
    .await;
    let r = post(json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":small.to_string(),"minZecOut":"1"})).await;
    assert_eq!(
        (r.status, code(&r)),
        (StatusCode::UNPROCESSABLE_ENTITY, "below_minimum"),
        "{:?}",
        r.body
    );
    // Without a curve row: the spot estimate, as before.
    e.sql(&format!("DELETE FROM {s}.launch_curves")).await;
    let r = post(json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":small.to_string(),"minZecOut":"1"})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    e.drop_schema().await;
}

/// v0.26: `PoolInfo.venues[].curve` mirrors the venue's `launch_curves` row and the fee core
/// uses in its curve estimates; venues without a row have no `curve`.
#[tokio::test]
async fn pool_info_venue_curve() {
    let Some(e) = setup().await else { return };
    e.ledger.set_pool_meta("network", "test").await.unwrap();
    e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
    let v = e.get("/api/pool").await.body;
    assert!(v["venues"][0].get("curve").is_none(), "{v}");
    e.sql(&format!(
        "INSERT INTO {}.launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves,
                                       real_token_reserves, token_total_supply)
         VALUES ('devnet', 'pumpfun', 300000000, 1073000000000000, 793100000000000, 1000000000000000)",
        e.schema
    ))
    .await;
    let v = e.get("/api/pool").await.body;
    assert_eq!(v["venues"][0]["venue"], "pumpfun");
    assert_eq!(
        v["venues"][0]["curve"],
        json!({"virtualSol":"300000000","virtualTokens":"1073000000000000","tokenTotalSupply":"1000000000000000",
               "feeBps":125,"feeSource":"config"})
    );
    // v0.27: tiers read from chain by the relayer win over the config; feeBps = fresh-curve tier.
    e.sql(&format!(
        "UPDATE {}.launch_curves SET fee_tiers = '[{{\"marketCapLamports\":\"0\",\"bps\":120}},
                                                 {{\"marketCapLamports\":\"500000000\",\"bps\":100}}]'",
        e.schema
    ))
    .await;
    let v = e.get("/api/pool").await.body;
    assert_eq!(
        v["venues"][0]["curve"]["feeBps"], 120,
        "fresh curve 0.28 SOL < 0.5 SOL tier"
    );
    assert_eq!(v["venues"][0]["curve"]["feeSource"], "chain");
    assert_eq!(
        v["venues"][0]["curve"]["feeTiers"][1],
        json!({"marketCapLamports":"500000000","bps":100})
    );
    e.drop_schema().await;
}

/// API v0.28 "Trading comfort": Pulse (+ WS), progress / ETA / curve state in token data,
/// core estimates from the token's curve state, Jupiter quotes.
mod comfort_v028 {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{Router, extract::Query, routing::get};
    use unzeen_ledger::actions::quantize_min_out;
    use unzeen_ledger::curve::{BuyFee, CurveParams};
    use unzeen_ledger::orders::parse_e18;

    use super::*;

    const P1: &str = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const D_NEW: &str = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const D_HOT: &str = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
    const D_DONE: &str = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
    const D_OLD: &str = "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3";
    const DBC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    fn now() -> i64 {
        now_ms() as i64
    }

    fn ids(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x["mint"].as_str().unwrap().to_string())
            .collect()
    }

    /// Pool token P1 (pump.fun, price tick 72 % with a pace history) + discovery candidates:
    /// D_NEW (fresh, 10 %, safety snapshot with holders), D_HOT (85 %), D_DONE (graduated after
    /// being seen on the curve), D_OLD (8 h old, 5 %: in no column).
    #[tokio::test]
    async fn pulse_columns_eta_graduations_and_ws() {
        let Some(e) = setup_with(|c| c.intel.discovery = true).await else {
            return;
        };
        let s = e.schema.clone();
        let t = now();
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, status, created_at)
             VALUES ('{P1}', 'pumpfun', 'P1', 'Pool one', 6, 0.00000003, 30, 'curve', now() - interval '1 hour');
             INSERT INTO {s}.trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, ts)
             VALUES ('create', 'pumpfun', '{P1}', 'P1', 1, 1, 6, 'CREATE1', now());
             INSERT INTO {s}.intel_prices (mint, price_sol, status, tick_at, progress_pct) VALUES ('{P1}', 0.00000003, 'curve', {t}, 72.00);
             INSERT INTO {s}.curve_progress (mint, tick_at, progress) VALUES ('{P1}', {a}, 60.00), ('{P1}', {b}, 66.00), ('{D_DONE}', {b}, 99.10);
             INSERT INTO {s}.intel_discovery (network, mint, venue, created_at, name, symbol, status, price_sol, market_cap_sol, progress_pct, as_of) VALUES
               ('devnet', '{D_NEW}', 'pumpfun', now() - interval '30 minutes', 'New', 'NEW', 'curve', 0.00000003, 28, 10.00, date_trunc('minute', now())),
               ('devnet', '{D_HOT}', 'raydium-launchlab', now() - interval '10 hours', 'Hot', 'HOT', 'curve', 0.0000002, 200, 85.00, date_trunc('minute', now())),
               ('devnet', '{D_DONE}', 'meteora-dbc', now() - interval '2 hours', 'Done', 'DONE', 'graduated', 0.0000004, 400, NULL, date_trunc('minute', now())),
               ('devnet', '{D_OLD}', 'pumpfun', now() - interval '8 hours', 'Old', 'OLD', 'curve', 0.00000003, 28, 5.00, date_trunc('minute', now()));",
            a = t - 300_000,
            b = t - 150_000
        ))
        .await;
        // The warm set keeps the snapshot (core drops snapshots of unwarmed mints).
        e.sql(&format!(
            "INSERT INTO {s}.intel_warm (mint, expires_at) VALUES ('{D_NEW}', now() + interval '7 days')"
        ))
        .await;
        e.put_snapshot(
            D_NEW,
            &json!({"program":"spl-token","authorities":{"mintRevoked":true,"freezeRevoked":false,"metadataImmutable":null,
                    "riskyExtensions":["transferHook","bogus"]},
                    "holders":{"top10Pct":"31.5","devPct":"2","unzeenPoolPct":"0","count":123},
                    "market":{"venue":"pumpfun","status":"curve","curveProgressPct":"10"},
                    "image":"https://evil.example/x.png"}),
        )
        .await;
        unzeen_api::comfort::sample(&e.state).await.unwrap();
        assert_eq!(
            e.one_i64(&format!(
                "SELECT count(*) FROM {s}.curve_graduations WHERE mint = '{D_DONE}'"
            ))
            .await,
            1,
            "seen on the curve, now graduated"
        );
        let v = unzeen_api::comfort::build_pulse(&e.state).await.unwrap();
        e.state.pulse.put(v.to_string()).await;
        let r = e.get("/api/pulse").await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.headers["cache-control"], "public, max-age=3");
        let p = r.body;
        assert_eq!(p["graduatingPct"], 70);
        assert_eq!(p["etaWindowSecs"], 600);
        assert_eq!(ids(&p["new"]), [D_NEW]);
        assert_eq!(ids(&p["graduating"]), [D_HOT, P1]);
        assert_eq!(ids(&p["graduated"]), [D_DONE]);
        // Pool card: numbers of the pool, progress of the price tick, ETA by pace:
        // 60 → 72 % in 300 s = 2.4 pp/min, 28 pp left → 700 s.
        let c = &p["graduating"][1];
        assert_eq!(c["pool"], true);
        assert_eq!(c["unzeenLaunch"], true);
        assert_eq!(c["curveProgressPct"], "72");
        assert_eq!(c["eta"], json!({"secs": 700, "ratePctPerMin": "2.40", "samples": 3}));
        assert_eq!(c["quote"], "SOL");
        assert_eq!(c["holders"], Value::Null);
        assert!(c.get("safety").is_none());
        // Discovery card with a safety snapshot: flags only, holders count, no foreign image.
        let n = &p["new"][0];
        assert_eq!(n["pool"], false);
        assert_eq!(n["holders"], 123, "{n}");
        assert_eq!(n["safety"]["mintRevoked"], true);
        assert_eq!(n["safety"]["freezeRevoked"], false);
        assert_eq!(n["safety"]["riskyExtensions"], json!(["transferHook"]));
        assert_eq!(n["safety"]["top10Pct"], "31.5");
        assert!(n["safety"].get("devPct").is_none() && n.get("image").is_none());
        assert!(n.get("eta").is_none(), "one tick only");
        let d = &p["graduated"][0];
        assert!(d["graduatedAt"].as_i64().unwrap() % 60_000 == 0);
        assert!(d.get("curveProgressPct").is_none() && d.get("eta").is_none());
        assert_eq!(p["graduating"][0]["venue"], "raydium-launchlab");
        // Same bytes for every client.
        let a = e.raw("GET", "/api/pulse", "", None).await.raw_len;
        let b = e.raw("GET", "/api/pulse", "", None).await.raw_len;
        assert_eq!(a, b);
        // WS: the whole Pulse on connect, then on change.
        let ws_url = format!("{}/ws/pulse", e.base.replace("http", "ws"));
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(first) = first else { panic!("text") };
        assert_eq!(
            serde_json::from_str::<Value>(&first).unwrap()["graduated"],
            p["graduated"]
        );
        e.sql(&format!(
            "UPDATE {s}.intel_discovery SET progress_pct = 90.00 WHERE mint = '{D_NEW}'"
        ))
        .await;
        let v = unzeen_api::comfort::build_pulse(&e.state).await.unwrap();
        e.state.pulse.put(v.to_string()).await;
        let changed = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(Ok(Message::Text(t))) = ws.next().await {
                    let v = serde_json::from_str::<Value>(&t).unwrap();
                    if ids(&v["graduating"]).contains(&D_NEW.to_string()) {
                        return v;
                    }
                }
            }
        })
        .await
        .expect("pulse change over WS");
        assert_eq!(ids(&changed["graduating"])[0], D_NEW);
        // Without discovery: pool tokens only.
        e.drop_schema().await;
    }

    #[tokio::test]
    async fn token_data_carries_progress_eta_and_curve_state() {
        let Some(e) = setup_with(|c| c.venues = vec!["pumpfun".into(), "meteora-dbc".into()]).await else {
            return;
        };
        let s = e.schema.clone();
        let t = now();
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, status) VALUES
               ('{P1}', 'pumpfun', 'P1', 'P1', 6, 0.0000000279, 28, 'curve'),
               ('{DBC}', 'meteora-dbc', 'D', 'D', 6, 0.0000000300, 30, 'curve');
             INSERT INTO {s}.launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves,
                                            real_token_reserves, token_total_supply, fee_tiers)
             VALUES ('devnet', 'pumpfun', 30000000000, 1073000000000000, 793100000000000, 1000000000000000,
                     '[{{\"marketCapLamports\":\"0\",\"bps\":125}},{{\"marketCapLamports\":\"100000000000\",\"bps\":95}}]');
             INSERT INTO {s}.intel_prices (mint, price_sol, status, tick_at, progress_pct, curve) VALUES
               ('{P1}', 0.0000000279, 'curve', {t}, 3.10,
                '{{\"virtualSol\":\"30000000000\",\"virtualTokens\":\"1073000000000000\",\"buyFee\":\"added\",\"buyLimitLamports\":\"85000000000\"}}'),
               ('{DBC}', 0.0000000300, 'curve', {t}, 7.50,
                '{{\"virtualSol\":\"31000000000\",\"virtualTokens\":\"1033000000000000\",\"feeBps\":100,\"buyFee\":\"input\",\"buyLimitLamports\":\"54000000000\",\"sellLimitTokens\":\"40000000000000\"}}');
             INSERT INTO {s}.curve_progress (mint, tick_at, progress) VALUES ('{P1}', {a}, 2.10);",
            a = t - 200_000
        ))
        .await;
        unzeen_api::comfort::sample(&e.state).await.unwrap();
        let v = e.get(&format!("/api/tokens/{P1}")).await.body;
        assert_eq!(v["curveProgressPct"], "3.1");
        // pump: the FeeConfig tier of the curve's market cap (≈ 28 SOL < 100 SOL → 125).
        assert_eq!(
            v["curve"],
            json!({"virtualSol":"30000000000","virtualTokens":"1073000000000000","feeBps":125,"buyFee":"added",
                   "buyLimitLamports":"85000000000","asOf": t})
        );
        // 2.1 → 3.1 % in 200 s: 0.30 pp/min, 96.9 pp left → 19 380 s.
        assert_eq!(v["eta"], json!({"secs": 19_380, "ratePctPerMin": "0.30", "samples": 2}));
        let d = e.get(&format!("/api/tokens/{DBC}")).await.body;
        assert_eq!(d["curve"]["feeBps"], 100);
        assert_eq!(d["curve"]["buyFee"], "input");
        assert_eq!(d["curve"]["sellLimitTokens"], "40000000000000");
        // The list carries the same fields.
        let l = e.get("/api/tokens").await.body;
        let lp = l.as_array().unwrap().iter().find(|x| x["mint"] == P1).unwrap();
        assert_eq!(lp["curve"], v["curve"]);
        assert_eq!(lp["eta"], v["eta"]);
        // A stale tick (> 180 s) gives no curve state; graduated tokens get none of the fields.
        e.sql(&format!(
            "UPDATE {s}.intel_prices SET tick_at = {} WHERE mint = '{DBC}'",
            t - 200_000
        ))
        .await;
        assert!(e.get(&format!("/api/tokens/{DBC}")).await.body.get("curve").is_none());
        e.sql(&format!(
            "UPDATE {s}.tokens SET status = 'graduated' WHERE mint = '{P1}'"
        ))
        .await;
        let g = e.get(&format!("/api/tokens/{P1}")).await.body;
        assert!(g.get("curve").is_none() && g.get("eta").is_none() && g.get("curveProgressPct").is_none());
        e.drop_schema().await;
    }

    /// B2 (pre-submit audit 23.10): trades by others moved the curve, `tokens.price_sol` kept the
    /// pool's last trade. The sampler copies a newer, fresh indexer tick (price, cap scaled).
    #[tokio::test]
    async fn sampler_syncs_pool_price_from_fresh_tick() {
        let Some(e) = setup().await else {
            return;
        };
        let s = e.schema.clone();
        let t = now();
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, status) VALUES
               ('{P1}', 'pumpfun', 'P1', 'P1', 6, 0.00000003, 30, 'curve'),
               ('{DBC}', 'pumpfun', 'D', 'D', 6, 0.00000003, 30, 'curve');
             UPDATE {s}.tokens SET price_at = now() - interval '5 days';
             INSERT INTO {s}.intel_prices (mint, price_sol, status, tick_at) VALUES
               ('{P1}', 0.000000045, 'curve', {t}),
               ('{DBC}', 0.000000045, 'curve', {stale});",
            stale = t - 200_000
        ))
        .await;
        unzeen_api::comfort::sample(&e.state).await.unwrap();
        let v = e.get(&format!("/api/tokens/{P1}")).await.body;
        assert_eq!(v["priceSol"], "0.000000045");
        assert_eq!(v["marketCapSol"], "45");
        let fresh = e
            .one_i64(&format!(
                "SELECT (price_at > now() - interval '1 minute')::int::bigint FROM {s}.tokens WHERE mint = '{P1}'"
            ))
            .await;
        assert_eq!(fresh, 1);
        // A tick older than 180 s is not copied.
        let d = e.get(&format!("/api/tokens/{DBC}")).await.body;
        assert_eq!(d["priceSol"], "0.00000003");
        // The pool's own later trade wins over an older tick.
        e.sql(&format!(
            "UPDATE {s}.tokens SET price_sol = 0.00000005 WHERE mint = '{P1}';
             UPDATE {s}.intel_prices SET price_sol = 0.00000004, tick_at = {old} WHERE mint = '{P1}';",
            old = t - 60_000
        ))
        .await;
        unzeen_api::comfort::sample(&e.state).await.unwrap();
        assert_eq!(e.get(&format!("/api/tokens/{P1}")).await.body["priceSol"], "0.00000005");
        // Different status (graduated by the indexer) or a ZEC pair: untouched.
        e.sql(&format!(
            "UPDATE {s}.intel_prices SET price_sol = 0.00000009, status = 'graduated', tick_at = {n} WHERE mint = '{P1}'",
            n = now() + 1_000
        ))
        .await;
        unzeen_api::comfort::sample(&e.state).await.unwrap();
        assert_eq!(e.get(&format!("/api/tokens/{P1}")).await.body["priceSol"], "0.00000005");
        e.drop_schema().await;
    }

    /// Core's estimates follow the token's curve state: the sell minimum (B2) and a fired
    /// order's min_out, from a thin DBC-like / pump curve the venue's launch row knows nothing of.
    #[tokio::test]
    async fn estimates_use_the_token_curve_state() {
        let Some(e) = setup_with(|c| c.rate.fixed_lamports_per_zec = Some(10_000_000_000)).await else {
            return;
        };
        let s = e.schema.clone();
        let me = user(31);
        e.fund(31, 0, 100_000_000).await;
        let pk = hex::encode(me.verifying_key().to_bytes());
        // Spot 1e-9 SOL per whole token = 1e-6 lamports per base unit.
        let price = "0.000000001";
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, status)
             VALUES ('{MINT}', 'pumpfun', 'T', 'T', 6, {price}, 1, 'curve');
             INSERT INTO {s}.token_balances (anon_pubkey, mint, available) VALUES ('\\x{pk}', '{MINT}', 900000000000000)"
        ))
        .await;
        let post = |b: Value| {
            let e = &e;
            let me = &me;
            async move { e.signed(me, "POST", "/api/actions", &b.to_string()).await }
        };
        // 15e12 base units = 0.015 SOL at spot: above the 0.01 SOL (0.001 ZEC) minimum.
        let amount = "15000000000000";
        let r = post(json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":amount,"minZecOut":"1"})).await;
        assert_eq!(r.status, StatusCode::OK, "spot: {:?}", r.body);
        // A thin curve at the same spot (S = 0.01 SOL): the same sell returns < 0.01 SOL.
        let (cs, ct) = (10_000_000u128, 10_000_000_000_000u128);
        e.sql(&format!(
            "INSERT INTO {s}.intel_prices (mint, price_sol, status, tick_at, progress_pct, curve)
             VALUES ('{MINT}', {price}, 'curve', {t}, 1.00,
                     '{{\"virtualSol\":\"{cs}\",\"virtualTokens\":\"{ct}\",\"feeBps\":100,\"buyFee\":\"input\"}}')",
            t = now()
        ))
        .await;
        let r = post(json!({"op":"sell","venue":"pumpfun","mint":MINT,"amount":amount,"minZecOut":"1"})).await;
        assert_eq!(
            (r.status, code(&r)),
            (StatusCode::UNPROCESSABLE_ENTITY, "below_minimum"),
            "{:?}",
            r.body
        );
        // Order: a take_profit fires on the next tick; min_out = the token curve's output.
        let body = json!({"op":"order_create","venue":"pumpfun","mint":MINT,"kind":"take_profit",
                          "triggerPriceSol":"0.000000001","amount":"200000000000000"})
        .to_string();
        let r = e.signed(&me, "POST", "/api/actions", &body).await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        let big = (100_000_000_000u128, 100_000_000_000_000_000u128); // 100 SOL curve at 1e-6 l/base
        e.sql(&format!(
            "UPDATE {s}.intel_prices SET prev_price_sol = price_sol, prev_tick_at = tick_at, price_sol = 0.0000000011,
               tick_at = {t}, curve = '{{\"virtualSol\":\"{}\",\"virtualTokens\":\"{}\",\"buyFee\":\"added\"}}'",
            big.0,
            big.1,
            t = now() + 5
        ))
        .await;
        let mut m = 0i64;
        for _ in 0..100 {
            m = e.one_i64(&format!("SELECT COALESCE(max(min_out), 0)::bigint FROM {s}.relayer_jobs WHERE op = 'sell' AND token_amount > 100000000000000")).await;
            if m > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(m > 0, "order fired");
        let amt = e
            .one_i64(&format!(
                "SELECT token_amount::bigint FROM {s}.relayer_jobs WHERE op = 'sell' AND token_amount > 100000000000000"
            ))
            .await as u128;
        let p11 = parse_e18("0.0000000011").unwrap();
        // pump curve state without a fee: no launch_curves tiers → the configured 125 bps.
        let curve = CurveParams {
            virtual_sol: big.0,
            virtual_tokens: big.1,
            fee_bps: 125,
            buy_fee: BuyFee::Added,
            buy_limit: None,
        };
        assert_eq!(
            m as u128,
            quantize_min_out(curve.sell_out(p11, 6, amt).unwrap() * 9_500 / 10_000)
        );
        e.drop_schema().await;
    }

    async fn mock_jupiter(hits: Arc<AtomicUsize>) -> String {
        let app = Router::new().route(
            "/quote",
            get(move |Query(q): Query<std::collections::HashMap<String, String>>| {
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let amount: u128 = q["amount"].parse().unwrap();
                    let buy = q["inputMint"] == "So11111111111111111111111111111111111111112";
                    json!({"inputMint": q["inputMint"], "inAmount": q["amount"], "outputMint": q["outputMint"],
                           "outAmount": (if buy { amount * 1000 } else { amount / 1000 }).to_string(),
                           "priceImpactPct": "0.0125", "slippageBps": 50,
                           "routePlan": [{"swapInfo": {"label": "Pump.fun Amm"}}]})
                    .to_string()
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    /// The quote grid is filled by a background round (here driven by the test); user
    /// requests are answered from it only — they never reach Jupiter.
    #[tokio::test]
    async fn quote_from_background_grid_only() {
        let hits = Arc::new(AtomicUsize::new(0));
        let url = mock_jupiter(hits.clone()).await;
        let Some(e) = setup_with(move |c| {
            c.comfort.quote = Some(unzeen_api::config::JupiterQuoteConfig {
                url,
                api_key: None,
                rps: 1.0,
                round_secs: 600,
                max_mints: 40,
            });
        })
        .await
        else {
            return;
        };
        let s = e.schema.clone();
        // Graduated pool token (1e-6 SOL per whole token) and a curve token (not quoted).
        e.sql(&format!(
            "INSERT INTO {s}.tokens (mint, venue, symbol, name, decimals, price_sol, market_cap_sol, status) VALUES
               ('{MINT2}', 'pumpfun', 'G', 'G', 6, 0.000001, 1000, 'graduated'),
               ('{P1}', 'pumpfun', 'C', 'C', 6, 0.000001, 1000, 'curve')"
        ))
        .await;
        e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
        assert_eq!(e.get("/api/pool").await.body["features"]["quote"], true);
        // Before the first round: nothing to answer from, and no upstream call.
        let r = e
            .get(&format!("/api/quote?mint={MINT2}&side=buy&amount=123456789"))
            .await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        let svc = e.state.quotes.clone().unwrap();
        let n = unzeen_api::comfort::quote_round(&e.state, &svc, Duration::ZERO)
            .await
            .unwrap();
        let grid = unzeen_api::comfort::QUOTE_GRID_LAMPORTS.len();
        assert_eq!(n, 2 * grid, "one token × both sides × the grid");
        assert_eq!(hits.load(Ordering::SeqCst), 2 * grid);
        // Between grid points: the chord (mock is linear, so exact): buy 123 456 789 lamports → ×1000.
        let r = e
            .get(&format!("/api/quote?mint={MINT2}&side=buy&amount=123456789"))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
        assert_eq!(r.headers["cache-control"], "public, max-age=10");
        assert_eq!(r.body["inAmount"], "123456789");
        assert_eq!(r.body["outAmount"], "123456789000");
        assert_eq!(r.body["priceImpactPct"], "1.2500");
        assert_eq!(r.body["route"], json!(["Pump.fun Amm"]));
        assert_eq!(r.body["maxAmount"], "25000000000");
        // Sell grid: tokens worth the grid lamports at the public price (0.01 SOL = 1e10 units).
        let r = e
            .get(&format!("/api/quote?mint={MINT2}&side=sell&amount=10000000000"))
            .await;
        assert_eq!(r.body["outAmount"], "10000000", "{:?}", r.body);
        // Below the first point: proportional; above the last: not served.
        let r = e.get(&format!("/api/quote?mint={MINT2}&side=buy&amount=1000")).await;
        assert_eq!(r.body["outAmount"], "1000000");
        let r = e
            .get(&format!("/api/quote?mint={MINT2}&side=buy&amount=25000000001"))
            .await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
        // Not graduated / unknown: not in the grid.
        assert_eq!(
            e.get(&format!("/api/quote?mint={P1}&side=buy&amount=1000"))
                .await
                .status,
            StatusCode::NOT_FOUND
        );
        // No request ever reached Jupiter because of a user.
        assert_eq!(hits.load(Ordering::SeqCst), 2 * grid);
        // Validation.
        for bad in [
            format!("/api/quote?mint={MINT2}&side=hold&amount=1"),
            format!("/api/quote?mint={MINT2}&side=buy&amount=0"),
            format!("/api/quote?mint={MINT2}&side=buy&amount=01"),
            format!("/api/quote?mint={MINT2}&side=buy&amount=1&taker=x"),
            "/api/quote?mint=nope&side=buy&amount=1".to_string(),
        ] {
            assert_eq!(e.get(&bad).await.status, StatusCode::BAD_REQUEST, "{bad}");
        }
        // A token that left the candidate set is dropped on the next round.
        e.sql(&format!("UPDATE {s}.tokens SET price_sol = 0 WHERE mint = '{MINT2}'"))
            .await;
        unzeen_api::comfort::quote_round(&e.state, &svc, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(
            e.get(&format!("/api/quote?mint={MINT2}&side=buy&amount=1000"))
                .await
                .status,
            StatusCode::NOT_FOUND
        );
        e.drop_schema().await;
        // Off (devnet default): the path does not exist, no feature flag.
        let Some(e) = setup().await else { return };
        e.ledger.set_pool_meta("pool_ua", "utest1example").await.unwrap();
        assert!(e.get("/api/pool").await.body["features"].get("quote").is_none());
        assert_eq!(
            e.get(&format!("/api/quote?mint={MINT2}&side=buy&amount=1"))
                .await
                .status,
            StatusCode::NOT_FOUND
        );
        e.drop_schema().await;
    }
}

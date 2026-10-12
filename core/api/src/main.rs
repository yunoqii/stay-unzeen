//! unzeen-api — HTTP/WS API server (docs/API.md).
//!
//!   unzeen-api serve                      run the server (API_BIND, default 127.0.0.1:8080)
//!   unzeen-api stats-snapshot             devnet: build today's public stats snapshot
//!   unzeen-api dev-request --anon-key F   DEV: send a signed request and print the response
//!
//! `.env` is loaded from the current directory or its parents (repo root).

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, anyhow, bail};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;
use unzeen_api::{AppState, config::Config, rate::now_ms, router, spawn_background};
use unzeen_ledger::Ledger;
use unzeen_protocol::{SigningKey, api_auth};

#[derive(Parser)]
#[command(name = "unzeen-api", about = "Unzeen API server")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the API server.
    Serve,
    /// Request a Verify snapshot now (devnet only; mainnet runs daily at 00:00 UTC). The running
    /// API server performs it (freeze, relayer vault snapshot, trees, anchor).
    VerifySnapshot,
    /// Build today's public stats snapshot now (devnet only; mainnet runs daily at 00:00 UTC).
    /// Data cut-off is 00:00 UTC today, so a re-run the same day gives the same numbers.
    StatsSnapshot,
    /// DEV: sign a request with an anon key file (hex secret, from `unzeen-scanner anon-key`)
    /// and print the response. Refused on mainnet unless UNZEEN_DEV_PRINT=1.
    DevRequest {
        #[arg(long)]
        anon_key: PathBuf,
        #[arg(long, default_value = "GET")]
        method: String,
        #[arg(long, default_value = "/api/portfolio")]
        path: String,
        /// Request body (JSON) for POST.
        #[arg(long, default_value = "")]
        body: String,
        /// Server base URL (default: http://API_BIND).
        #[arg(long)]
        base_url: Option<String>,
    },
}

fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_env("API_LOG").unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    let cfg = Config::from_env()?;
    match cli.cmd.unwrap_or(Cmd::Serve) {
        Cmd::Serve => serve(cfg).await,
        Cmd::VerifySnapshot => verify_snapshot(&cfg).await,
        Cmd::StatsSnapshot => stats_snapshot(&cfg).await,
        Cmd::DevRequest {
            anon_key,
            method,
            path,
            body,
            base_url,
        } => dev_request(&cfg, &anon_key, &method, &path, &body, base_url).await,
    }
}

async fn serve(cfg: Config) -> anyhow::Result<()> {
    let ledger = Ledger::connect(&cfg.database_url, cfg.policy)
        .await
        .map_err(|e| anyhow!("connecting to Postgres: {e}"))?;
    if !cfg.actions_enabled {
        tracing::warn!(
            "mainnet-beta: POST /api/actions disabled (set UNZEEN_ALLOW_MAINNET_ACTIONS=1 with lead approval)"
        );
    }
    let bind = cfg.bind;
    tracing::info!(
        network = cfg.network,
        cluster = cfg.cluster,
        chain_id = cfg.policy.chain.to_hex(),
        rate = if cfg.rate.fixed_lamports_per_zec.is_some() { "fixed" } else { "near-1click" },
        epoch_s = format!("{}..{}", cfg.exec.epoch_min_secs, cfg.exec.epoch_max_secs),
        venues = cfg.venues.join(","),
        %bind,
        "unzeen-api starting"
    );
    let st = AppState::new(cfg, ledger);
    spawn_background(&st);
    let app = router(st).into_make_service_with_connect_info::<SocketAddr>();
    let listener = tokio::net::TcpListener::bind(bind).await.context("bind")?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn verify_snapshot(cfg: &Config) -> anyhow::Result<()> {
    if cfg.cluster != "devnet" {
        bail!("manual Verify snapshots are devnet-only (mainnet: daily at 00:00 UTC)");
    }
    let ledger = Ledger::connect(&cfg.database_url, cfg.policy)
        .await
        .map_err(|e| anyhow!("connecting to Postgres: {e}"))?;
    match ledger
        .verify_request(cfg.cluster, &cfg.policy.chain.to_hex(), "manual", cfg.verify.timing)
        .await
        .map_err(|e| anyhow!("{e}"))?
    {
        Some(id) => println!("snapshot #{id} requested; the running API server builds it (watch GET /api/verify)"),
        None => println!("a snapshot is already in progress"),
    }
    Ok(())
}

async fn stats_snapshot(cfg: &Config) -> anyhow::Result<()> {
    if cfg.cluster != "devnet" {
        bail!("manual stats snapshots are devnet-only (mainnet: daily at 00:00 UTC)");
    }
    let ledger = Ledger::connect(&cfg.database_url, cfg.policy)
        .await
        .map_err(|e| anyhow!("connecting to Postgres: {e}"))?;
    let day = ledger
        .stats_snapshot(cfg.cluster, &cfg.stats.params)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    println!("stats snapshot for {day} stored (cut-off 00:00 UTC); GET /api/stats serves it");
    Ok(())
}

async fn dev_request(
    cfg: &Config,
    key: &PathBuf,
    method: &str,
    path: &str,
    body: &str,
    base_url: Option<String>,
) -> anyhow::Result<()> {
    if cfg.network == "main" && std::env::var("UNZEEN_DEV_PRINT").as_deref() != Ok("1") {
        bail!("dev-request prints account data; refused on mainnet (UNZEEN_DEV_PRINT=1 to override)");
    }
    let hexs = std::fs::read_to_string(key).context("reading anon key file")?;
    let sk: [u8; 32] = hex::decode(hexs.trim())
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| anyhow!("anon key file must hold 32 bytes hex"))?;
    let sk = SigningKey::from_bytes(&sk);
    let h = api_auth::sign_request(
        cfg.policy.chain,
        &sk,
        method,
        path,
        body.as_bytes(),
        rand::random(),
        now_ms(),
    );
    let base = base_url.unwrap_or_else(|| format!("http://{}", cfg.bind));
    let m: reqwest::Method = method.to_ascii_uppercase().parse().context("method")?;
    let res = reqwest::Client::new()
        .request(m, format!("{}{}", base.trim_end_matches('/'), path))
        .header(api_auth::H_PUBKEY, &h.pubkey)
        .header(api_auth::H_NONCE, &h.nonce)
        .header(api_auth::H_TS, &h.ts)
        .header(api_auth::H_SIG, &h.sig)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    println!("anon pubkey: {}", h.pubkey);
    println!("HTTP {}", res.status());
    println!("{}", res.text().await?);
    Ok(())
}

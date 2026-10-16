//! unzeen-api — HTTP/WS API server (docs/API.md).
//!
//!   unzeen-api serve                      run the server (API_BIND, default 127.0.0.1:8080)
//!   unzeen-api stats-snapshot             build today's public stats snapshot now
//!                                         (mainnet only with --allow-mainnet)
//!   unzeen-api verify-snapshot            request a Verify snapshot now (mainnet: --allow-mainnet)
//!   unzeen-api review-job [--list | <id> --reparse | --confirm --out-* | --fail] --yes
//!                                         GAP-11: resolve relayer jobs in `needs_review`
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
    /// Request a Verify snapshot now (mainnet runs daily at 00:00 UTC). The running API server
    /// performs it (freeze ≤ 120 s, relayer vault snapshot, trees, anchor).
    VerifySnapshot {
        /// Operator opt-in for mainnet (e.g. for the demo video): trading freezes up to 120 s.
        #[arg(long)]
        allow_mainnet: bool,
    },
    /// Build today's public stats snapshot now (mainnet runs daily at 00:00 UTC).
    /// Default cut-off is 00:00 UTC today (a re-run the same day gives the same numbers).
    StatsSnapshot {
        /// Cut-off at 00:00 UTC tomorrow: today's activity is included (demo).
        #[arg(long)]
        include_today: bool,
        /// Operator opt-in for mainnet.
        #[arg(long)]
        allow_mainnet: bool,
    },
    /// Create K_chat (32 random bytes, hex, 0600) for UNZEEN_CHAT_KEY_FILE. One per network; keep
    /// it outside the database, the repo and backups. Rotating it renames every chat nickname.
    ChatKeygen {
        #[arg(long)]
        out: PathBuf,
    },
    /// Operator chat moderation (API v0.12). Never deanonymizes: acts on message ids and
    /// (nick, mint) pairs only.
    Chat {
        #[command(subcommand)]
        cmd: ChatCmd,
    },
    /// GAP-11 operator: resolve relayer jobs stuck in `needs_review` (tx landed, result not
    /// parsed) without SQL. No id / --list: list them. With an id and no action: show it.
    /// Prefer --reparse (the hood relayer re-reads the receipt from the chain); --confirm
    /// takes the facts from the explorer; --fail only if NO funds moved (core then refunds).
    ReviewJob {
        id: Option<i64>,
        #[arg(long)]
        list: bool,
        /// Hand the job back to the relayer now: it re-parses the landed tx (hood).
        #[arg(long, conflicts_with_all = ["confirm", "fail"])]
        reparse: bool,
        /// Mark confirmed with the explicit out_* below (checked against the job).
        #[arg(long, conflicts_with = "fail")]
        confirm: bool,
        /// Mark failed: the operator checked on the explorer that no funds moved.
        #[arg(long)]
        fail: bool,
        /// error_code for --fail.
        #[arg(long, default_value = "internal")]
        code: String,
        #[arg(long)]
        out_token_amount: Option<String>,
        /// Lamports (Solana) or wei (hood) actually spent / received.
        #[arg(long)]
        out_lamports: Option<String>,
        #[arg(long)]
        out_mint: Option<String>,
        #[arg(long)]
        out_quote_mint: Option<String>,
        #[arg(long)]
        out_quote_amount: Option<String>,
        /// Slot (Solana) or block number (hood) of the tx.
        #[arg(long)]
        slot: Option<i64>,
        /// Required for --confirm / --fail (they move user balances at settlement).
        #[arg(long)]
        yes: bool,
        /// Also print the tx signature/hash (public, but not next to the job id in logs).
        #[arg(long)]
        show_signature: bool,
    },
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

#[derive(Subcommand)]
enum ChatCmd {
    /// Remove one message (`operator`) on the next boundary.
    Hide { id: String },
    /// Mute a nickname in one token chat for N hours (`403 chat_muted`).
    Mute {
        #[arg(long)]
        mint: String,
        #[arg(long)]
        nick: String,
        #[arg(long, default_value_t = 24.0)]
        hours: f64,
    },
    /// Remove every message of a token chat on the next boundary.
    Purge {
        #[arg(long)]
        mint: String,
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
    // Needs no configuration (and must work before UNZEEN_CHAT_KEY_FILE exists).
    if let Some(Cmd::ChatKeygen { out }) = &cli.cmd {
        return chat_keygen(out);
    }
    let cfg = Config::from_env()?;
    match cli.cmd.unwrap_or(Cmd::Serve) {
        Cmd::Serve => serve(cfg).await,
        Cmd::ChatKeygen { out } => chat_keygen(&out),
        Cmd::Chat { cmd } => chat_cmd(&cfg, cmd).await,
        Cmd::VerifySnapshot { allow_mainnet } => verify_snapshot(&cfg, allow_mainnet).await,
        Cmd::StatsSnapshot {
            include_today,
            allow_mainnet,
        } => stats_snapshot(&cfg, include_today, allow_mainnet).await,
        Cmd::ReviewJob {
            id,
            list,
            reparse,
            confirm,
            fail,
            code,
            out_token_amount,
            out_lamports,
            out_mint,
            out_quote_mint,
            out_quote_amount,
            slot,
            yes,
            show_signature,
        } => {
            let out = unzeen_ledger::review::ReviewOut {
                out_token_amount,
                out_lamports,
                out_mint,
                out_quote_mint,
                out_quote_amount,
                slot,
            };
            let action = match (reparse, confirm, fail) {
                (true, _, _) => Some(unzeen_ledger::review::Resolution::Reparse),
                (_, true, _) => Some(unzeen_ledger::review::Resolution::Confirm(out)),
                (_, _, true) => Some(unzeen_ledger::review::Resolution::Fail { code }),
                _ => None,
            };
            review_job(&cfg, if list { None } else { id }, action, yes, show_signature).await
        }
        Cmd::DevRequest {
            anon_key,
            method,
            path,
            body,
            base_url,
        } => dev_request(&cfg, &anon_key, &method, &path, &body, base_url).await,
    }
}

fn print_review(j: &unzeen_ledger::review::ReviewJob, show_signature: bool) {
    println!(
        "#{:<8} {:<11} venue={:<17} network={:<12} lamports_in={} token_amount={} mint={} age={} min sig={}{}",
        j.id,
        j.op,
        j.venue.as_deref().unwrap_or("-"),
        j.network,
        j.lamports_in.as_deref().unwrap_or("-"),
        j.token_amount.as_deref().unwrap_or("-"),
        j.mint.as_deref().unwrap_or("-"),
        j.age_secs / 60,
        match (&j.signature, show_signature) {
            (None, _) => "none",
            (Some(_), false) => "recorded (--show-signature)",
            (Some(s), true) => s.as_str(),
        },
        j.error_message
            .as_deref()
            .map_or(String::new(), |m| format!(" note={m:?}")),
    );
}

async fn review_job(
    cfg: &Config,
    id: Option<i64>,
    action: Option<unzeen_ledger::review::Resolution>,
    yes: bool,
    show_signature: bool,
) -> anyhow::Result<()> {
    use unzeen_ledger::review::{FAIL_CODES, Resolution, check_confirm};
    let ledger = connect_checked(cfg).await?;
    let Some(id) = id else {
        if action.is_some() {
            bail!("--reparse/--confirm/--fail need a job id");
        }
        let jobs = ledger.review_jobs().await?;
        println!("needs_review: {}", jobs.len());
        for j in &jobs {
            print_review(j, show_signature);
        }
        return Ok(());
    };
    let Some((job, status, settled)) = ledger.review_job(id).await? else {
        bail!("no relayer job #{id}");
    };
    print_review(&job, show_signature);
    if status != "needs_review" || settled {
        bail!(
            "job #{id} is {status}{}: only needs_review jobs are resolved here",
            if settled { " (settled)" } else { "" }
        );
    }
    let Some(action) = action else {
        println!("status: needs_review. Next: --reparse (hood) | --confirm --out-... --yes | --fail --yes");
        return Ok(());
    };
    match &action {
        Resolution::Reparse if job.network != "hood" => {
            bail!("--reparse works with the hood relayer only (the Solana relayer never writes needs_review)")
        }
        Resolution::Reparse => {}
        Resolution::Confirm(o) => {
            check_confirm(&job, o).map_err(|e| anyhow!("refused: {e}"))?;
            if !yes {
                bail!("--confirm credits the user at settlement: re-check the tx on the explorer, then add --yes");
            }
        }
        Resolution::Fail { code } => {
            if !FAIL_CODES.contains(&code.as_str()) {
                bail!("--code must be one of {}", FAIL_CODES.join(", "));
            }
            if !yes {
                bail!("--fail REFUNDS the user at settlement: only if the tx moved no funds; add --yes");
            }
        }
    }
    if !ledger.resolve_review(id, &action).await? {
        bail!("job #{id} left needs_review meanwhile (the relayer resolved it?): nothing changed");
    }
    println!(
        "#{id}: {}",
        match action {
            Resolution::Reparse => "handed back to the relayer; it re-reads the tx on its next pass",
            Resolution::Confirm(_) => "confirmed; the core settler closes the action within ~1 s",
            Resolution::Fail { .. } => "failed; the core settler releases the hold within ~1 s",
        }
    );
    Ok(())
}

async fn serve(cfg: Config) -> anyhow::Result<()> {
    // RUNBOOK GAP: one database per network (the ledger is not split by network).
    let ledger = connect_checked(&cfg).await?;
    unzeen_api::register_pool_quotes(&ledger, &cfg)
        .await
        .map_err(|e| anyhow!("pool quotes: {e}"))?;
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

fn chat_keygen(out: &PathBuf) -> anyhow::Result<()> {
    use std::io::Write;
    let k: [u8; 32] = rand::random();
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o
        .open(out)
        .with_context(|| format!("creating {} (must not exist)", out.display()))?;
    writeln!(
        f,
        "# unzeen K_chat (chat nicknames). Keep outside the DB, the repo and backups."
    )?;
    writeln!(f, "{}", hex::encode(k))?;
    println!(
        "K_chat written to {} (0600); set UNZEEN_CHAT_KEY_FILE to this path",
        out.display()
    );
    Ok(())
}

async fn chat_cmd(cfg: &Config, cmd: ChatCmd) -> anyhow::Result<()> {
    let ledger = connect_checked(cfg).await?;
    match cmd {
        ChatCmd::Hide { id } => {
            let id: [u8; 16] = hex::decode(&id)
                .ok()
                .and_then(|v| v.try_into().ok())
                .ok_or_else(|| anyhow!("id: 32 hex"))?;
            if !ledger.chat_operator_remove(&id).await.map_err(|e| anyhow!("{e}"))? {
                bail!("no such message (or already removed)");
            }
            println!("removal queued for the next boundary");
        }
        ChatCmd::Mute { mint, nick, hours } => {
            ledger
                .chat_mute(&mint, &nick, hours)
                .await
                .map_err(|e| anyhow!("{e}"))?;
            println!("muted for {hours} h");
        }
        ChatCmd::Purge { mint } => {
            let n = ledger.chat_purge(&mint).await.map_err(|e| anyhow!("{e}"))?;
            println!("{n} message(s) queued for removal");
        }
    }
    Ok(())
}

/// Ledger of this network; refuses a database bound to another network.
async fn connect_checked(cfg: &Config) -> anyhow::Result<Ledger> {
    let ledger = Ledger::connect(&cfg.database_url, cfg.policy)
        .await
        .map_err(|e| anyhow!("connecting to Postgres: {e}"))?;
    if let Err(msg) = ledger
        .check_pool_network(cfg.network, cfg.cluster)
        .await
        .map_err(|e| anyhow!("{e}"))?
    {
        bail!("refusing to run: {msg}");
    }
    Ok(ledger)
}

/// Manual snapshots on mainnet need the operator's explicit flag.
fn manual_gate(cfg: &Config, allow_mainnet: bool, what: &str) -> anyhow::Result<()> {
    if cfg.cluster != "devnet" {
        if !allow_mainnet {
            bail!(
                "manual {what} on {} needs --allow-mainnet (otherwise daily at 00:00 UTC)",
                cfg.cluster
            );
        }
        tracing::warn!(cluster = cfg.cluster, "manual {what} on mainnet (operator flag)");
    }
    Ok(())
}

async fn verify_snapshot(cfg: &Config, allow_mainnet: bool) -> anyhow::Result<()> {
    manual_gate(cfg, allow_mainnet, "Verify snapshot")?;
    let ledger = connect_checked(cfg).await?;
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

async fn stats_snapshot(cfg: &Config, include_today: bool, allow_mainnet: bool) -> anyhow::Result<()> {
    manual_gate(cfg, allow_mainnet, "stats snapshot")?;
    let ledger = connect_checked(cfg).await?;
    let day = ledger
        .stats_snapshot_with(cfg.cluster, &cfg.stats.params, include_today)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    let cut = if include_today {
        "00:00 UTC tomorrow (today included)"
    } else {
        "00:00 UTC"
    };
    println!("stats snapshot for {day} stored (cut-off {cut}); GET /api/stats serves it");
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

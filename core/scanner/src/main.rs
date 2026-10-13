//! unzeen-scanner — Unzeen pool wallet and deposit scanner.
//!
//! Service:
//!   serve        sync + feed every incoming note into the Postgres ledger (no deposit data
//!                in stdout/logs)
//! Operator:
//!   init, address, send, probe, seed-keygen, seed-encrypt, ledger-stats,
//!   rebalance (quote | check | status | plan | close)
//! Dev only (print deposit data / anon keys; refused on mainnet unless UNZEEN_DEV_PRINT=1):
//!   sync, deposits, inspect-tx, anon-key, memo-deposit, balance
//!
//! Wallet state and keys live in $UNZEEN_HOME/<network>/{data,keys} (default ~/.unzeen),
//! created 0700 with umask 077.

mod blocks;
mod config;
mod cover;
mod deposits;
mod memo;
mod oneclick;
mod payout;
mod rebalance;
mod seed;
mod send;
mod service;
mod sync;
mod wallet;

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow, bail};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;
use unzeen_protocol::{
    SigningKey,
    memo::{Op, Target, Unz1Body, Venue},
    pubkey_from_b58, pubkey_to_b58,
};
use zeroize::Zeroizing;

use crate::{config::Common, deposits::Deposit};

#[derive(Parser)]
#[command(name = "unzeen-scanner", about = "Unzeen pool wallet / deposit scanner")]
struct Cli {
    #[command(flatten)]
    common: Common,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Generate the pool seed (age-encrypted) and wallet; print the Ironwood/Orchard-only UA.
    Init {
        /// Wallet birthday height (default: chain tip - 10).
        #[arg(long, env = "UNZEEN_BIRTHDAY")]
        birthday: Option<u32>,
        /// Also print the UFVK (reveals ALL deposits and memos). Dev only.
        #[arg(long)]
        show_ufvk: bool,
    },
    /// Print the pool's UA (and the UFVK with --show-ufvk, dev only).
    Address {
        #[arg(long)]
        show_ufvk: bool,
    },
    /// Service: sync forever and credit deposits into the Postgres ledger (DATABASE_URL).
    Serve {
        /// Seconds between passes.
        #[arg(long, default_value_t = 20)]
        interval: u64,
        /// Run a single pass and exit.
        #[arg(long)]
        once: bool,
        /// Also execute `withdraw_zec` payouts (needs the seed key; mainnet gated).
        #[arg(long, env = "UNZEEN_PAYOUTS")]
        payouts: bool,
        /// Also run the automatic pool rebalance ZEC -> SOL via 1Click (dry-run unless mainnet
        /// and UNZEEN_ALLOW_MAINNET_REBALANCE=1).
        #[arg(long, env = "UNZEEN_REBALANCE")]
        rebalance: bool,
    },
    /// Operator: ZEC payouts above the mainnet cap (`UNZEEN_MAX_PAYOUT_ZAT`, final audit A2).
    Payout {
        #[command(subcommand)]
        cmd: PayoutCmd,
    },
    /// Operator: read-only `GetLightdInfo` of a lightwalletd (e.g. a candidate for
    /// `LIGHTWALLETD_SEND_URL`).
    LwdInfo {
        #[arg(long)]
        url: String,
    },
    /// Pool rebalance ZEC -> SOL via NEAR Intents 1Click (see docs/RELAYER.md v7).
    Rebalance {
        /// `sol` (ZEC → SOL) | `zec-spl` (ZEC → ZEC SPL stock of ZEC pairs, API v0.13).
        #[arg(long, default_value = "sol")]
        target: String,
        #[command(subcommand)]
        cmd: RebalanceCmd,
    },
    /// DEV: sync and print incoming notes (with memos).
    Sync {
        /// Keep running: re-sync every N seconds.
        #[arg(long)]
        watch: Option<u64>,
        /// Print all known notes, not only those new or changed in this run.
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Send shielded ZEC with an optional text memo (mainnet gated). Run `sync` first.
    Send {
        #[arg(long)]
        to: String,
        /// Amount in zatoshis (max 50_000_000 = 0.5 TAZ on testnet, 5_000_000 = 0.05 ZEC on mainnet).
        #[arg(long)]
        amount_zat: u64,
        /// Text memo (ZIP-302 UTF-8, <= 512 bytes).
        #[arg(long)]
        memo: Option<String>,
    },
    /// DEV: fetch a tx from lightwalletd and decrypt it with the pool keys (prints memos).
    InspectTx { txid: String },
    /// Read-only H1 probe: fetch ALL shielded txs of the last N blocks like the scanner does
    /// and print traffic/time counters (no wallet needed, no txids printed).
    Probe {
        #[arg(long, default_value_t = 20)]
        blocks: u32,
        /// How many of the fetched txs to parse as a consensus check.
        #[arg(long, default_value_t = 5)]
        max_txs: usize,
    },
    /// DEV: list all incoming notes known to the wallet.
    Deposits {
        #[arg(long)]
        json: bool,
    },
    /// Encrypt the legacy plaintext keys/pool.mnemonic with age, then wipe the plaintext.
    SeedEncrypt {
        #[arg(long)]
        keep_plaintext: bool,
    },
    /// Create an age X25519 identity file (0600) for UNZEEN_SEED_KEY_FILE.
    SeedKeygen {
        #[arg(long)]
        out: PathBuf,
    },
    /// DEV: create a random anon (ed25519) secret key file (hex, 0600).
    AnonKey {
        #[arg(long)]
        out: PathBuf,
    },
    /// DEV: build a signed `unz1` deposit memo (what the web client does).
    MemoDeposit {
        /// File from `anon-key`.
        #[arg(long)]
        anon_key: PathBuf,
        /// Expiry, minutes from now.
        #[arg(long, default_value_t = 60)]
        expiry_mins: u64,
        #[arg(long)]
        nonce: Option<u64>,
    },
    /// DEV: sign an API request with an anon key file; prints `-H` arguments for curl.
    SignRequest {
        #[arg(long)]
        anon_key: PathBuf,
        #[arg(long, default_value = "GET")]
        method: String,
        /// Raw request-target, e.g. /api/portfolio
        #[arg(long)]
        path: String,
        #[arg(long, default_value = "")]
        body: String,
    },
    /// DEV: print the ledger balance of an anon pubkey (base58).
    Balance { pubkey: String },
    /// Deposit counts by status (no identifying data).
    LedgerStats,
    /// Pool wallet balance: spendable / pending (K confirmations). Prints no addresses.
    WalletBalance,
}

#[derive(Subcommand)]
enum PayoutCmd {
    /// Queued payouts above the cap waiting for approval: id, amount, age. No recipients.
    ListHeld,
    /// Let one held payout go into the next payout tx.
    Approve { id: i64 },
}

#[derive(Subcommand)]
enum RebalanceCmd {
    /// Dry 1Click quote of the configured lot with mainnet parameters (read-only, no deposit
    /// address is created) + reference price check.
    Quote,
    /// Evaluate the trigger now (SOL inventory, committed SOL, guards). Read-only.
    Check,
    /// Journal of rebalances (no user data exists there).
    Status {
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    /// Operator: plan a rebalance (executed by `serve --rebalance`). `--force` skips the SOL
    /// trigger; the random delay applies unless `--now`.
    Plan {
        #[arg(long)]
        force: bool,
        #[arg(long)]
        now: bool,
    },
    /// Operator: close a rebalance in `attention` (or a `planned` one) as failed | done | refunded.
    Close {
        id: i64,
        #[arg(long)]
        status: String,
    },
}

fn main() -> anyhow::Result<()> {
    // Everything we create (wallet DB, WAL, keys) is owner-only.
    #[cfg(unix)]
    // SAFETY: umask is process-global and we are still single-threaded.
    unsafe {
        libc::umask(0o077);
    }
    let _ = dotenvy::dotenv();
    // Treat empty values from .env (e.g. `LIGHTWALLETD_URL=`) as "not set".
    for key in [
        "UNZEEN_NETWORK",
        "LIGHTWALLETD_URL",
        "LIGHTWALLETD_FALLBACK_URLS",
        "UNZEEN_DATA_DIR",
        "UNZEEN_KEYS_DIR",
        "UNZEEN_BIRTHDAY",
    ] {
        if std::env::var_os(key).is_some_and(|v| v.is_empty()) {
            // SAFETY: no other threads exist yet (the tokio runtime is built below).
            unsafe { std::env::remove_var(key) };
        }
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

/// Dev commands print deposit data; on mainnet require an explicit opt-in.
fn dev_only(c: &Common, what: &str) -> anyhow::Result<()> {
    if c.network == config::NetName::Main && std::env::var("UNZEEN_DEV_PRINT").as_deref() != Ok("1") {
        bail!("`{what}` prints deposit data; refused on mainnet (set UNZEEN_DEV_PRINT=1 to override)");
    }
    Ok(())
}

async fn run() -> anyhow::Result<()> {
    // tonic's TLS needs an explicit rustls crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cli = Cli::parse();
    let mut filter = EnvFilter::try_from_env("RUST_LOG").unwrap_or_else(|_| "info,schemerz=warn".into());
    if matches!(cli.cmd, Cmd::Serve { .. }) {
        // librustzcash logs txids at INFO ("Storing decrypted transaction with id ...").
        // In service mode these crates are capped at WARN whatever RUST_LOG says.
        for d in [
            "zcash_client_backend=warn",
            "zcash_client_sqlite=warn",
            "zcash_primitives=warn",
            "schemerz=warn",
        ] {
            filter = filter.add_directive(d.parse().expect("static directive"));
        }
    }
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();

    let c = &cli.common;
    if c.network == config::NetName::Main {
        tracing::warn!("UNZEEN_NETWORK=main: REAL ZEC. Use only with lead approval and dust amounts.");
    }

    match cli.cmd {
        Cmd::Init { birthday, show_ufvk } => {
            if show_ufvk {
                dev_only(c, "init --show-ufvk")?;
            }
            let out = wallet::init(c, birthday).await?;
            println!("network:   {}", c.network.as_str());
            println!("birthday:  {}", out.birthday);
            println!("seed:      {} (age-encrypted)", c.seed_age_path().display());
            println!("wallet db: {}", c.wallet_db_path().display());
            println!("ua:        {}", out.ua_orchard);
            if show_ufvk {
                println!("ufvk:      {}", out.ufvk);
            }
        }
        Cmd::Address { show_ufvk } => {
            if show_ufvk {
                dev_only(c, "address --show-ufvk")?;
            }
            let out = wallet::show(c)?;
            println!("birthday: {}", out.birthday);
            println!("ua:       {}", out.ua_orchard);
            if show_ufvk {
                println!("ufvk:     {}", out.ufvk);
            }
        }
        Cmd::Serve {
            interval,
            once,
            payouts,
            rebalance,
        } => service::serve(c, interval, once, payouts, rebalance).await?,
        Cmd::Rebalance { cmd, target } => rebalance_cmd(c, cmd, &target).await?,
        Cmd::Payout { cmd } => {
            let url = std::env::var("DATABASE_URL").context("DATABASE_URL")?;
            let ledger = unzeen_ledger::Ledger::connect(&url, service::policy_from_env(c)?).await?;
            let cap = payout::PayoutCfg::from_env()?.max_payout_zat;
            match cmd {
                PayoutCmd::ListHeld => {
                    let held = ledger.held_payouts(cap).await?;
                    println!("cap: {} ZEC; held: {}", deposits::format_zec(cap), held.len());
                    for h in held {
                        println!(
                            "{:>8}  {:>14} ZEC  queued ~{} h",
                            h.id,
                            deposits::format_zec(h.amount_zat),
                            h.queued_secs / 3600
                        );
                    }
                }
                PayoutCmd::Approve { id } => {
                    if ledger.approve_payout(id).await? {
                        println!("payout {id} approved: it goes out with the next payout pass");
                    } else {
                        bail!("no queued payout {id}");
                    }
                }
            }
        }
        Cmd::LwdInfo { url } => {
            let i = c.lightd_info(&url).await?;
            println!(
                "chain: {}\nvendor: {}\nversion: {}\nheight: {}\nconsensus branch: {}\nsapling activation: {}\ntaddr support: {}",
                i.chain_name,
                i.vendor,
                i.version,
                i.block_height,
                i.consensus_branch_id,
                i.sapling_activation_height,
                i.taddr_support
            );
        }
        Cmd::Sync { watch, all, json } => {
            dev_only(c, "sync")?;
            let db_path = c.wallet_db_path();
            let mut db = wallet::open_db(c)?;
            let mut client = None;
            // Printed = (pool, row, memo known, height): a note is printed again when its
            // memo arrives or it is (un)mined, so nothing is lost (the old cursor could skip).
            let mut printed: HashSet<_> = if all {
                HashSet::new()
            } else {
                deposits::list(&db_path)?.iter().map(Deposit::print_key).collect()
            };
            let mut backoff = 5;
            let cover_cfg = cover::CoverCfg::from_env()?;
            loop {
                let res: anyhow::Result<u32> = async {
                    if client.is_none() {
                        client = Some(c.connect().await?);
                    }
                    let rep = sync::sync(c.params(), client.as_mut().expect("set"), &mut db, &cover_cfg).await?;
                    tracing::info!(
                        tip = rep.tip,
                        scanned = rep.scanned_blocks,
                        enhanced = rep.enhanced_txs,
                        "sync complete"
                    );
                    Ok(rep.tip)
                }
                .await;
                match res {
                    Ok(tip) => {
                        backoff = 5;
                        let mut any = false;
                        for d in deposits::list(&db_path)? {
                            if printed.insert(d.print_key()) {
                                print_deposit(&d, json, Some(tip))?;
                                any = true;
                            }
                        }
                        if !any && !json {
                            eprintln!("no new incoming shielded notes (tip {tip})");
                        }
                    }
                    Err(e) if watch.is_some() => {
                        client = None;
                        tracing::warn!(error = %format!("{e:#}"), retry_in_s = backoff, "sync failed");
                        tokio::time::sleep(Duration::from_secs(backoff)).await;
                        backoff = (backoff * 2).min(300);
                        continue;
                    }
                    Err(e) => return Err(e),
                }
                match watch {
                    Some(secs) => tokio::time::sleep(Duration::from_secs(secs.max(5))).await,
                    None => break,
                }
            }
        }
        Cmd::Send { to, amount_zat, memo } => {
            let mut db = wallet::open_db(c)?;
            let txid = send::send(c, &mut db, &to, amount_zat, memo.as_deref()).await?;
            println!("sent txid={txid}");
        }
        Cmd::InspectTx { txid } => {
            dev_only(c, "inspect-tx")?;
            let db = wallet::open_db(c)?;
            let mut client = c.connect().await?;
            let outs = sync::inspect_tx(c.params(), &mut client, &db, &txid).await?;
            if outs.is_empty() {
                println!("no outputs decryptable by this wallet");
            }
            for (pool, idx, zat, kind, memo) in outs {
                println!(
                    "OUTPUT pool={pool} action={idx} value={} ZEC transfer={kind} memo={}",
                    deposits::format_zec(zat),
                    memo.display()
                );
            }
        }
        Cmd::Probe { blocks, max_txs } => {
            let mut client = c.connect().await?;
            let cfg = cover::CoverCfg::from_env()?;
            let r = sync::probe(c.params(), &mut client, blocks.max(1), max_txs, &cfg).await?;
            let cv = &r.cover;
            println!("network:        {}", c.network.as_str());
            println!("blocks:         {} (tip {})", r.blocks, r.tip);
            println!("txs (all):      {}", r.all_txs);
            println!("compact blocks: {} bytes in {} ms", r.compact_bytes, r.compact_ms);
            println!(
                "cover fetch:    {} shielded txs, fetched {}, failed {}, retries {}",
                cv.candidates, cv.fetched, cv.failed, cv.retries
            );
            println!(
                "cover traffic:  {} bytes ({:.1} KiB/block, {:.1} KiB/tx) in {} ms (concurrency {}, {} rps)",
                cv.bytes,
                cv.bytes as f64 / 1024.0 / r.blocks.max(1) as f64,
                cv.bytes as f64 / 1024.0 / cv.fetched.max(1) as f64,
                cv.ms,
                cfg.concurrency,
                cfg.rps
            );
            println!("parse check:    {}/{} OK", r.parsed_ok, r.parsed);
            if r.parsed_ok < r.parsed || cv.failed > 0 {
                bail!("some transactions failed to fetch or parse");
            }
        }
        Cmd::Deposits { json } => {
            dev_only(c, "deposits")?;
            let all = deposits::list(&c.wallet_db_path())?;
            if all.is_empty() && !json {
                eprintln!("no incoming shielded notes");
            }
            let tip = wallet::open_db(c).ok().and_then(|db| {
                use zcash_client_backend::data_api::WalletRead;
                db.chain_height().ok().flatten().map(u32::from)
            });
            for d in &all {
                print_deposit(d, json, tip)?;
            }
        }
        Cmd::SeedEncrypt { keep_plaintext } => {
            c.secure_dirs()?;
            seed::migrate(c, keep_plaintext)?;
            println!("encrypted seed: {}", c.seed_age_path().display());
            if !keep_plaintext {
                println!("plaintext {} wiped and removed", c.seed_path().display());
            }
        }
        Cmd::SeedKeygen { out } => {
            use age::secrecy::ExposeSecret;
            let id = age::x25519::Identity::generate();
            let body = Zeroizing::new(format!(
                "# unzeen pool seed key. Keep apart from the encrypted seed and its backups.\n# public: {}\n{}\n",
                id.to_public(),
                id.to_string().expose_secret()
            ));
            seed::write_new_0600(&out, body.as_bytes())?;
            println!("age identity written to {} (0600)", out.display());
        }
        Cmd::AnonKey { out } => {
            let sk: Zeroizing<[u8; 32]> = Zeroizing::new(rand::random());
            seed::write_new_0600(&out, hex::encode(*sk).as_bytes())?;
            let pk = SigningKey::from_bytes(&sk).verifying_key().to_bytes();
            println!("anon pubkey: {}", pubkey_to_b58(&pk));
        }
        Cmd::MemoDeposit {
            anon_key,
            expiry_mins,
            nonce,
        } => {
            dev_only(c, "memo-deposit")?;
            let hexs = Zeroizing::new(std::fs::read_to_string(&anon_key).context("reading anon key")?);
            let sk: [u8; 32] = hex::decode(hexs.trim())
                .ok()
                .and_then(|v| v.try_into().ok())
                .ok_or_else(|| anyhow!("anon key file must hold 32 bytes hex"))?;
            let sk = SigningKey::from_bytes(&sk);
            let policy = service::policy_from_env(c)?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            let m = Unz1Body {
                op: Op::Deposit,
                venue: Venue::None,
                mint: [0; 32],
                min_out: 0,
                anon_pubkey: [0; 32],
                nonce: nonce.unwrap_or_else(rand::random),
                expiry: u32::try_from(now + expiry_mins * 60)?,
                target: Target::None,
            }
            .sign(&sk, policy.chain);
            println!("anon pubkey: {}", pubkey_to_b58(&m.body.anon_pubkey));
            println!("memo:        {}", m.encode());
        }
        Cmd::SignRequest {
            anon_key,
            method,
            path,
            body,
        } => {
            dev_only(c, "sign-request")?;
            let hexs = Zeroizing::new(std::fs::read_to_string(&anon_key).context("reading anon key")?);
            let sk: [u8; 32] = hex::decode(hexs.trim())
                .ok()
                .and_then(|v| v.try_into().ok())
                .ok_or_else(|| anyhow!("anon key file must hold 32 bytes hex"))?;
            let sk = SigningKey::from_bytes(&sk);
            let chain = service::policy_from_env(c)?.chain;
            let ts = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
            let h = unzeen_protocol::api_auth::sign_request(
                chain,
                &sk,
                &method.to_uppercase(),
                &path,
                body.as_bytes(),
                rand::random(),
                ts,
            );
            println!(
                "-H x-unzeen-pubkey:{} -H x-unzeen-nonce:{} -H x-unzeen-ts:{} -H x-unzeen-sig:{}",
                h.pubkey, h.nonce, h.ts, h.sig
            );
        }
        Cmd::Balance { pubkey } => {
            dev_only(c, "balance")?;
            let pk = pubkey_from_b58(&pubkey).ok_or_else(|| anyhow!("pubkey must be base58 of 32 bytes"))?;
            let url = std::env::var("DATABASE_URL").context("DATABASE_URL")?;
            let ledger = unzeen_ledger::Ledger::connect(&url, service::policy_from_env(c)?).await?;
            match ledger.balance(&pk).await? {
                None => println!("no balance row"),
                Some(b) => println!(
                    "available={} ZEC held={} ZEC frozen={}",
                    deposits::format_zec(b.available_zat),
                    deposits::format_zec(b.held_zat),
                    b.frozen
                ),
            }
        }
        Cmd::WalletBalance => {
            use zcash_client_backend::data_api::{WalletRead, wallet::ConfirmationsPolicy};
            let db = wallet::open_db(c)?;
            let k = service::policy_from_env(c)?.confirmations.max(1);
            let conf = ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::new(k).expect("max(1)"));
            match db
                .get_wallet_summary(conf)
                .map_err(|e| anyhow!("wallet summary: {e}"))?
            {
                None => println!("wallet not synced yet (run `serve --once` or `sync`)"),
                Some(s) => {
                    let (mut spend, mut change, mut pending, mut total) = (0u64, 0u64, 0u64, 0u64);
                    for b in s.account_balances().values() {
                        spend += u64::from(b.spendable_value());
                        change += u64::from(b.change_pending_confirmation());
                        pending += u64::from(b.value_pending_spendability());
                        total += u64::from(b.total());
                    }
                    println!("network:            {}", c.network.as_str());
                    println!("synced to height:   {}", u32::from(s.chain_tip_height()));
                    println!("confirmations (K):  {k}");
                    println!("spendable:          {} ZEC", deposits::format_zec(spend));
                    println!("change pending:     {} ZEC", deposits::format_zec(change));
                    println!("pending (received): {} ZEC", deposits::format_zec(pending));
                    println!("total:              {} ZEC", deposits::format_zec(total));
                }
            }
        }
        Cmd::LedgerStats => {
            let url = std::env::var("DATABASE_URL").context("DATABASE_URL")?;
            let ledger = unzeen_ledger::Ledger::connect(&url, service::policy_from_env(c)?).await?;
            for (status, n) in ledger.deposit_stats().await? {
                println!("{status:>15} {n}");
            }
        }
    }
    Ok(())
}

async fn rebalance_cmd(c: &Common, cmd: RebalanceCmd, target: &str) -> anyhow::Result<()> {
    use rebalance::{RebalanceCfg, Trigger};
    let policy = service::policy_from_env(c)?;
    let solana = policy
        .chain
        .solana()
        .ok_or_else(|| anyhow::anyhow!("rebalance: Solana pools only (Robinhood Chain is the next step)"))?;
    let cfg = RebalanceCfg::from_env(c, solana)?;
    let cfg = match target {
        "sol" => cfg,
        "zec-spl" | "zec_spl" => cfg.zec_spl()?,
        other => bail!("--target: sol | zec-spl (got {other:?})"),
    };
    let ledger = || async {
        let url = std::env::var("DATABASE_URL").context("DATABASE_URL")?;
        let l = unzeen_ledger::Ledger::connect(&url, policy).await?;
        if let Err(msg) = l.check_pool_network(c.network.as_str(), cfg.network).await? {
            bail!("refusing to run: {msg}");
        }
        anyhow::Ok(l)
    };
    let zec = |z: u64| deposits::format_zec(z);
    let sol = |l: u64| format!("{}.{:09}", l / 1_000_000_000, l % 1_000_000_000);
    match cmd {
        RebalanceCmd::Quote => {
            let oc = oneclick::HttpOneClick::from_env()?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            let (q, expected) = rebalance::dry_quote(&cfg, &oc, now).await?;
            println!(
                "mode:           {}",
                cfg.dry_reason()
                    .map_or("LIVE (mainnet sends allowed)".into(), |r| format!("dry-run: {r}"))
            );
            println!(
                "jwt:            {}",
                if oc.has_jwt() { "set" } else { "not set (+0.25% fee)" }
            );
            println!("lot:            {} ZEC", zec(q.amount_in));
            let out = |x: u64| {
                if cfg.target == "zec_spl" {
                    format!("{} ZEC SPL", zec(x))
                } else {
                    format!("{} SOL", sol(x))
                }
            };
            println!("target:         {}", cfg.target);
            println!("amountOut:      {}", out(q.amount_out));
            println!("minAmountOut:   {}", out(q.min_amount_out));
            println!(
                "timeEstimate:   {} s",
                q.time_estimate_secs.map_or("-".into(), |t| t.to_string())
            );
            match expected {
                Some(e) => {
                    let dev = (q.min_amount_out as f64 / e as f64 - 1.0) * 10_000.0;
                    let ok = oneclick::price_ok(q.min_amount_out, e, cfg.max_deviation_bps);
                    println!("reference:      {} (1Click /v0/tokens; ZEC SPL: parity)", out(e));
                    println!(
                        "min vs ref:     {dev:+.0} bps (limit -{} bps) {}",
                        cfg.max_deviation_bps,
                        if ok { "OK" } else { "REFUSED" }
                    );
                }
                None => println!("reference:      unavailable (a live rebalance would be refused)"),
            }
        }
        RebalanceCmd::Check if cfg.target == "zec_spl" => {
            let l = ledger().await?;
            let inv = l
                .quote_inventory(cfg.network, unzeen_ledger::rebalance::ZEC_SPL_MINT)
                .await?;
            let committed = l.committed_zec_spl(cfg.network).await?;
            println!(
                "network:        {} / zcash {} / target zec_spl",
                cfg.network,
                c.network.as_str()
            );
            match inv {
                Some((t, age)) => println!(
                    "stock:          {} ZEC SPL on vaults + rebalance address (age {age} s)",
                    zec(u64::try_from(t).unwrap_or(u64::MAX))
                ),
                None => println!("stock:          none (relayer v8 writes pool_quote_inventory)"),
            }
            println!("committed:      {} ZEC SPL (queued ZEC-pair buys)", zec(committed));
            println!("threshold:      {} ZEC SPL free", zec(cfg.min_free_lamports));
            let live = l.live_rebalance(cfg.network, cfg.target).await?;
            println!(
                "live:           {}",
                live.map_or("none".into(), |r| format!("#{} {}", r.id, r.status))
            );
            println!(
                "trigger:        {:?}",
                rebalance::current_trigger(&cfg, &l, true).await?
            );
        }
        RebalanceCmd::Check => {
            let l = ledger().await?;
            let inv = l.sol_inventory(cfg.network).await?;
            let committed = l.committed_sol(cfg.network).await?;
            let hist = l.rebalance_history(cfg.network, cfg.target).await?;
            println!("network:        {} / zcash {}", cfg.network, c.network.as_str());
            println!(
                "mode:           {}",
                cfg.dry_reason().map_or("LIVE".into(), |r| format!("dry-run: {r}"))
            );
            match &inv {
                Some(i) => {
                    println!(
                        "vaults:         {} SOL in {} vaults (age {} s)",
                        sol(i.vault_lamports),
                        i.vault_count,
                        i.age_secs
                    );
                    println!("rebalance addr: {} SOL undistributed", sol(i.rebalance_lamports));
                    println!(
                        "free:           {} SOL (threshold {})",
                        sol(rebalance::free_lamports(&cfg, i, committed)),
                        sol(cfg.min_free_lamports)
                    );
                }
                None => println!("inventory:      none (relayer v7 writes pool_sol_inventory)"),
            }
            println!("committed:      {} SOL (queued jobs)", sol(committed));
            println!(
                "last 24 h:      {} of {} allowed; since last: {}",
                hist.last_24h,
                cfg.max_per_day,
                hist.since_last_secs.map_or("-".into(), |s| format!("{s} s"))
            );
            let live = l.live_rebalance(cfg.network, cfg.target).await?;
            println!(
                "live:           {}",
                live.map_or("none".into(), |r| format!("#{} {}", r.id, r.status))
            );
            let t = rebalance::evaluate(&cfg, inv.as_ref(), committed, Some(&hist));
            println!(
                "trigger:        {}",
                match t {
                    Trigger::Need { .. } => "NEED (a rebalance would be planned)",
                    Trigger::Enough { .. } => "enough SOL",
                    Trigger::NoInventory => "no inventory",
                    Trigger::StaleInventory => "inventory stale",
                    Trigger::DailyCap => "daily cap reached",
                    Trigger::Cooldown => "cooldown",
                }
            );
        }
        RebalanceCmd::Status { limit } => {
            let l = ledger().await?;
            for r in l.list_rebalances(cfg.network, limit.clamp(1, 500)).await? {
                println!(
                    "#{:<5} {:<7} {:<12} {} lot={} ZEC quote={} got={} 1click={} err={} created={} finished={}",
                    r.id,
                    r.target,
                    r.status,
                    if r.dry_run { "dry " } else { "live" },
                    zec(r.lot_zat),
                    r.amount_out_quote.map_or("-".into(), sol),
                    r.amount_out.map_or("-".into(), sol),
                    r.oc_status.as_deref().unwrap_or("-"),
                    r.error_code.as_deref().unwrap_or("-"),
                    r.created_unix,
                    r.finished_unix.map_or("-".into(), |t| t.to_string()),
                );
            }
        }
        RebalanceCmd::Plan { force, now } => {
            let l = ledger().await?;
            if !force {
                let t = rebalance::current_trigger(&cfg, &l, true).await?;
                if !matches!(t, Trigger::Need { .. }) {
                    bail!("trigger says no ({t:?}); use --force to plan anyway");
                }
            }
            let delay = if now {
                0.0
            } else {
                cfg.delay_min_secs + (cfg.delay_max_secs - cfg.delay_min_secs) * rand::random::<f64>()
            };
            let dry = cfg.dry_reason().is_some();
            match l
                .plan_rebalance(cfg.network, cfg.target, cfg.lot_zat, delay, dry, force)
                .await?
            {
                Some(id) => println!(
                    "planned #{id} ({}), due in {delay:.0} s; executed by `serve --rebalance`",
                    if dry { "dry-run" } else { "LIVE" }
                ),
                None => bail!("a rebalance is already live on {}", cfg.network),
            }
        }
        RebalanceCmd::Close { id, status } => {
            let l = ledger().await?;
            if l.close_rebalance(id, &status).await? {
                println!("#{id} closed as {status}");
            } else {
                bail!("#{id} is not in attention/planned");
            }
        }
    }
    Ok(())
}

fn print_deposit(d: &Deposit, json: bool, tip: Option<u32>) -> anyhow::Result<()> {
    let confs = match (d.mined_height, tip) {
        (Some(h), Some(t)) if t >= h => Some(t - h + 1),
        _ => None,
    };
    if json {
        let mut v = serde_json::to_value(d)?;
        v["confirmations"] = serde_json::json!(confs);
        println!("{v}");
    } else {
        println!(
            "DEPOSIT pool={} txid={} action={} value={} ZEC height={} confs={} memo={}",
            d.pool,
            d.txid,
            d.action_index,
            d.value_zec(),
            d.mined_height.map_or("UNMINED".into(), |h| h.to_string()),
            confs.map_or("-".into(), |n| n.to_string()),
            d.memo.as_ref().map_or("(not fetched yet)".into(), |m| m.display()),
        );
    }
    Ok(())
}

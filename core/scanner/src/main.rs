//! unzeen-scanner — Unzeen pool wallet and deposit scanner.
//!
//! Service:
//!   serve        sync + feed every incoming note into the Postgres ledger (no deposit data
//!                in stdout/logs)
//! Operator:
//!   init, address, send, probe, seed-keygen, seed-encrypt, ledger-stats
//! Dev only (print deposit data / anon keys; refused on mainnet unless UNZEEN_DEV_PRINT=1):
//!   sync, deposits, inspect-tx, anon-key, memo-deposit, balance
//!
//! Wallet state and keys live in $UNZEEN_HOME/<network>/{data,keys} (default ~/.unzeen),
//! created 0700 with umask 077.

mod blocks;
mod config;
mod deposits;
mod memo;
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
        /// Amount in zatoshis (max 5_000_000 = 0.05 ZEC).
        #[arg(long)]
        amount_zat: u64,
        /// Text memo (ZIP-302 UTF-8, <= 512 bytes).
        #[arg(long)]
        memo: Option<String>,
    },
    /// DEV: fetch a tx from lightwalletd and decrypt it with the pool keys (prints memos).
    InspectTx { txid: String },
    /// Read-only check: parse recent full shielded txs from lightwalletd (no wallet needed).
    Probe {
        #[arg(long, default_value_t = 200)]
        blocks: u32,
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
    /// DEV: print the ledger balance of an anon pubkey (base58).
    Balance { pubkey: String },
    /// Deposit counts by status (no identifying data).
    LedgerStats,
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
        Cmd::Serve { interval, once } => service::serve(c, interval, once).await?,
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
            loop {
                let res: anyhow::Result<u32> = async {
                    if client.is_none() {
                        client = Some(c.connect().await?);
                    }
                    let rep = sync::sync(c.params(), client.as_mut().expect("set"), &mut db).await?;
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
            let (found, ok) = sync::probe(c.params(), &mut client, blocks.max(1), max_txs).await?;
            println!("probe: {ok}/{found} shielded txs parsed OK ({})", c.network.as_str());
            if ok < found {
                bail!("some transactions failed to parse");
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

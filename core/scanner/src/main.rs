//! unzeen-scanner — pool wallet for Unzeen (Zcash TESTNET only).
//!
//! Commands:
//!   init      generate pool seed (keys/), create wallet DB, print Orchard UA + UFVK
//!   address   re-print the pool UA / UFVK
//!   sync      sync with lightwalletd, fetch memos, print new incoming Orchard notes
//!   deposits  list all incoming Orchard notes known to the wallet
//!
//! Privacy: this tool only prints to stdout for local dev use. It never writes deposit
//! data to log files; tracing logs carry heights/counters only.

mod blocks;
mod config;
mod deposits;
mod memo;
mod send;
mod sync;
mod wallet;

use std::time::Duration;

use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{config::Common, deposits::Deposit};

#[derive(Parser)]
#[command(name = "unzeen-scanner", about = "Unzeen pool wallet / Orchard deposit scanner (testnet)")]
struct Cli {
    #[command(flatten)]
    common: Common,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Generate the pool seed and wallet; print Orchard-only UA and UFVK.
    Init {
        /// Wallet birthday height (default: chain tip - 10).
        #[arg(long, env = "UNZEEN_BIRTHDAY")]
        birthday: Option<u32>,
    },
    /// Print the pool's Orchard-only UA and UFVK.
    Address,
    /// Sync to chain tip and print newly found incoming Orchard notes.
    Sync {
        /// Keep running: re-sync every N seconds.
        #[arg(long)]
        watch: Option<u64>,
        /// Print all known deposits, not only those found in this run.
        #[arg(long)]
        all: bool,
        /// JSON lines output.
        #[arg(long)]
        json: bool,
    },
    /// Send shielded ZEC with an optional text memo (testnet; mainnet gated). Run `sync` first.
    Send {
        /// Recipient address (UA / shielded).
        #[arg(long)]
        to: String,
        /// Amount in zatoshis (max 5_000_000 = 0.05 ZEC).
        #[arg(long)]
        amount_zat: u64,
        /// Text memo (ZIP-302 UTF-8, <= 512 bytes).
        #[arg(long)]
        memo: Option<String>,
    },
    /// Fetch a tx from lightwalletd and decrypt it with the pool's viewing keys (prints memos).
    InspectTx {
        txid: String,
    },
    /// Read-only check: parse recent full shielded txs from lightwalletd (no wallet needed).
    Probe {
        /// How many recent blocks to look at.
        #[arg(long, default_value_t = 200)]
        blocks: u32,
        /// Stop after this many shielded txs.
        #[arg(long, default_value_t = 5)]
        max_txs: usize,
    },
    /// List all incoming Orchard/Ironwood notes known to the wallet.
    Deposits {
        #[arg(long)]
        json: bool,
    },
}

fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    // Treat empty values from .env (e.g. `LIGHTWALLETD_URL=`) as "not set".
    for key in ["UNZEEN_NETWORK", "LIGHTWALLETD_URL", "UNZEEN_DATA_DIR", "UNZEEN_KEYS_DIR", "UNZEEN_BIRTHDAY"] {
        if std::env::var_os(key).is_some_and(|v| v.is_empty()) {
            // SAFETY: no other threads exist yet (the tokio runtime is built below).
            unsafe { std::env::remove_var(key) };
        }
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run())
}

async fn run() -> anyhow::Result<()> {
    // tonic's TLS needs an explicit rustls crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_env("RUST_LOG").unwrap_or_else(|_| "info,schemerz=warn".into()))
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let c = &cli.common;
    if c.network == config::NetName::Main {
        tracing::warn!("UNZEEN_NETWORK=main: REAL ZEC. Use only with lead approval and dust amounts.");
    }

    match cli.cmd {
        Cmd::Init { birthday } => {
            let out = wallet::init(c, birthday).await?;
            println!("network:   {}", c.network.as_str());
            println!("birthday:  {}", out.birthday);
            println!("seed:      {} (mode 0600, NEVER commit)", c.seed_path().display());
            println!("wallet db: {}", c.wallet_db_path().display());
            println!();
            println!("Unified Address (Orchard-only receiver):");
            println!("{}", out.ua_orchard);
            println!();
            println!("UFVK (viewing key: reveals ALL deposits+memos, keep private):");
            println!("{}", out.ufvk);
        }
        Cmd::Address => {
            let out = wallet::show(c)?;
            println!("birthday: {}", out.birthday);
            println!("ua:       {}", out.ua_orchard);
            println!("ufvk:     {}", out.ufvk);
        }
        Cmd::Sync { watch, all, json } => {
            let db_path = c.wallet_db_path();
            let mut db = wallet::open_db(c)?;
            let mut client = c.connect().await?;
            let mut seen = if all {
                deposits::Cursor::default()
            } else {
                deposits::current_cursor(&db_path)?
            };
            loop {
                let rep = sync::sync(c.params(), &mut client, &mut db).await?;
                tracing::info!(
                    tip = rep.tip,
                    scanned = rep.scanned_blocks,
                    enhanced = rep.enhanced_txs,
                    "sync complete"
                );
                let new = deposits::list(&db_path, seen)?;
                // Only advance past notes whose memo is already known, so a note found
                // before its tx was enhanced is reported again once the memo arrives.
                for d in &new {
                    print_deposit(d, json)?;
                    if d.memo.is_some() {
                        seen.advance(d);
                    }
                }
                if new.is_empty() && !json {
                    eprintln!("no new incoming shielded notes (tip {})", rep.tip);
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
                anyhow::bail!("some transactions failed to parse");
            }
        }
        Cmd::Deposits { json } => {
            let all = deposits::list(&c.wallet_db_path(), deposits::Cursor::default())?;
            if all.is_empty() && !json {
                eprintln!("no incoming shielded notes");
            }
            for d in &all {
                print_deposit(d, json)?;
            }
        }
    }
    Ok(())
}

fn print_deposit(d: &Deposit, json: bool) -> anyhow::Result<()> {
    if json {
        println!("{}", serde_json::to_string(d)?);
    } else {
        println!(
            "DEPOSIT pool={} txid={} action={} value={} ZEC height={} memo={}",
            d.pool,
            d.txid,
            d.action_index,
            d.value_zec(),
            d.mined_height.map_or("unmined".into(), |h| h.to_string()),
            d.memo.as_ref().map_or("(not fetched yet)".into(), |m| m.display()),
        );
    }
    Ok(())
}

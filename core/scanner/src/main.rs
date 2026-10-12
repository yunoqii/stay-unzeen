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
    /// List all incoming Orchard notes known to the wallet.
    Deposits {
        #[arg(long)]
        json: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
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

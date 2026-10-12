//! Configuration from the environment (repo-root `.env` is loaded by `main`).
//!
//! Secret values (DATABASE_URL password, ONECLICK_JWT) are never printed: `Config`
//! implements `Debug` by hand and only reports whether a secret is set.

use std::net::SocketAddr;

use anyhow::{Context, anyhow, bail};
use unzeen_ledger::Policy;
use unzeen_protocol::{ChainId, SolanaCluster, ZcashNet};

#[derive(Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    /// "test" | "main" (UNZEEN_NETWORK).
    pub network: &'static str,
    /// "devnet" | "mainnet-beta" (UNZEEN_SOLANA_CLUSTER), written into relayer jobs.
    pub cluster: &'static str,
    pub policy: Policy,
    /// Overrides the UA published by the scanner in `pool_meta`.
    pub pool_address: Option<String>,
    pub rate: RateConfig,
    pub exec: ExecConfig,
    pub fees: Fees,
    pub venues: Vec<String>,
    /// Mainnet actions are refused unless UNZEEN_ALLOW_MAINNET_ACTIONS=1 (lead approval).
    pub actions_enabled: bool,
    pub limits: Limits,
    pub cors_origins: Vec<String>,
}

#[derive(Clone)]
pub struct RateConfig {
    /// Fixed lamports per ZEC (DEVNET_ZEC_SOL_RATE, devnet only).
    pub fixed_lamports_per_zec: Option<u64>,
    pub oneclick_url: String,
    pub oneclick_jwt: Option<String>,
    pub cache_secs: u64,
    pub max_stale_secs: u64,
    /// Spread against the user in basis points (buy: fewer lamports, sell: fewer zat).
    pub spread_bps: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct ExecConfig {
    /// Per-action execution jitter (API.md: batches + random 0–20 s). On by default.
    pub jitter_min_secs: f64,
    pub jitter_max_secs: f64,
    pub withdraw_token_delay_min_secs: f64,
    pub withdraw_token_delay_max_secs: f64,
    pub zec_payout_delay_min_secs: f64,
    pub zec_payout_delay_max_secs: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Fees {
    pub create_fee_zat: u64,
    pub withdraw_zec_fee_zat: u64,
    /// SOL dropped to every withdraw_token recipient for its own fees.
    pub withdraw_token_gas_lamports: u64,
    /// Pool cost per withdraw_token part besides the gas drop (ATA rent + tx fee).
    pub withdraw_token_cost_lamports: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Per peer socket address (never X-Forwarded-For). Behind a local reverse proxy this
    /// is effectively a global limit; per-client limiting then belongs to the proxy.
    pub ip_per_sec: f64,
    pub ip_burst: f64,
    /// Signed requests per anon key.
    pub key_per_min: f64,
    pub key_burst: f64,
    pub max_ws: usize,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind", &self.bind)
            .field("network", &self.network)
            .field("cluster", &self.cluster)
            .field("rate_fixed", &self.rate.fixed_lamports_per_zec.is_some())
            .field("oneclick_jwt_set", &self.rate.oneclick_jwt.is_some())
            .field("venues", &self.venues)
            .field("actions_enabled", &self.actions_enabled)
            .finish_non_exhaustive()
    }
}

/// Env var, with empty values treated as unset.
pub fn var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn num<T: std::str::FromStr>(key: &str, default: T) -> anyhow::Result<T> {
    match var(key) {
        Some(v) => v.trim().parse().map_err(|_| anyhow!("{key} must be a number")),
        None => Ok(default),
    }
}

/// Parse a decimal SOL amount ("11.47") into lamports.
pub fn sol_to_lamports(s: &str) -> Option<u64> {
    let s = s.trim();
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() && frac.is_empty() || frac.len() > 9 {
        return None;
    }
    if !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let i: u64 = if int.is_empty() { 0 } else { int.parse().ok()? };
    let f: u64 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<9}").parse().ok()?
    };
    i.checked_mul(1_000_000_000)?.checked_add(f)
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let network: &'static str = match var("UNZEEN_NETWORK").as_deref().unwrap_or("test") {
            "test" | "testnet" => "test",
            "main" | "mainnet" => "main",
            other => bail!("UNZEEN_NETWORK={other:?}: expected test | main"),
        };
        let solana: SolanaCluster = var("UNZEEN_SOLANA_CLUSTER")
            .unwrap_or_else(|| "devnet".into())
            .parse()
            .map_err(|e: String| anyhow!(e))?;
        let cluster = match solana {
            SolanaCluster::Devnet => "devnet",
            SolanaCluster::MainnetBeta => "mainnet-beta",
        };
        let zcash = if network == "main" {
            ZcashNet::Mainnet
        } else {
            ZcashNet::Testnet
        };
        // Only two legal chain ids: 0202 (Zcash testnet + Solana devnet) and 0101 (mainnet +
        // mainnet-beta). Mixed combinations would sign memos/requests for a network nobody runs.
        if (zcash == ZcashNet::Mainnet) != (solana == SolanaCluster::MainnetBeta) {
            bail!(
                "UNZEEN_NETWORK={network} with UNZEEN_SOLANA_CLUSTER={}: networks must match \
                 (test+devnet or main+mainnet-beta)",
                if solana == SolanaCluster::Devnet {
                    "devnet"
                } else {
                    "mainnet-beta"
                }
            );
        }
        let policy = Policy {
            chain: ChainId::new(zcash, solana),
            confirmations: num::<u32>("UNZEEN_CONFIRMATIONS", 3)?.max(1),
            min_deposit_zat: num("MIN_DEPOSIT_ZAT", 100_000)?,
            min_action_zat: num("MIN_ACTION_ZAT", 100_000)?,
        };

        let fixed = match (solana, var("DEVNET_ZEC_SOL_RATE")) {
            (SolanaCluster::Devnet, Some(v)) => Some(
                sol_to_lamports(&v)
                    .filter(|l| *l > 0)
                    .context("DEVNET_ZEC_SOL_RATE must be a positive decimal (SOL per 1 ZEC)")?,
            ),
            // Never a fixed rate with real money.
            (SolanaCluster::MainnetBeta, Some(_)) => bail!("DEVNET_ZEC_SOL_RATE is not allowed on mainnet-beta"),
            _ => None,
        };
        let jmin: f64 = num("UNZEEN_EXEC_JITTER_MIN_SECS", 3.0)?;
        let jmax: f64 = num("UNZEEN_EXEC_JITTER_MAX_SECS", 20.0)?;
        if !(0.0..=3600.0).contains(&jmin) || jmax < jmin || jmax > 3600.0 {
            bail!("UNZEEN_EXEC_JITTER_MIN_SECS/MAX_SECS: need 0 <= min <= max <= 3600");
        }
        let cfg = Config {
            bind: var("API_BIND")
                .unwrap_or_else(|| "127.0.0.1:8080".into())
                .parse()
                .context("API_BIND must be host:port")?,
            database_url: var("DATABASE_URL").context("DATABASE_URL is required")?,
            network,
            cluster,
            policy,
            pool_address: var("UNZEEN_POOL_ADDRESS"),
            rate: RateConfig {
                fixed_lamports_per_zec: fixed,
                oneclick_url: var("ONECLICK_URL").unwrap_or_else(|| "https://1click.chaindefuser.com".into()),
                oneclick_jwt: var("ONECLICK_JWT"),
                cache_secs: num("RATE_CACHE_SECS", 45)?,
                max_stale_secs: num("RATE_MAX_STALE_SECS", 300)?,
                spread_bps: num::<u64>("UNZEEN_RATE_SPREAD_BPS", 50)?.min(2_000),
            },
            exec: ExecConfig {
                jitter_min_secs: jmin,
                jitter_max_secs: jmax,
                withdraw_token_delay_min_secs: num("WITHDRAW_TOKEN_DELAY_MIN_SECS", 30.0)?,
                withdraw_token_delay_max_secs: num("WITHDRAW_TOKEN_DELAY_MAX_SECS", 300.0)?,
                zec_payout_delay_min_secs: num("ZEC_PAYOUT_DELAY_MIN_SECS", 60.0)?,
                zec_payout_delay_max_secs: num("ZEC_PAYOUT_DELAY_MAX_SECS", 600.0)?,
            },
            fees: Fees {
                create_fee_zat: num("CREATE_FEE_ZAT", 100_000)?,
                withdraw_zec_fee_zat: num("WITHDRAW_ZEC_FEE_ZAT", 15_000)?,
                withdraw_token_gas_lamports: num("WITHDRAW_TOKEN_GAS_LAMPORTS", 2_000_000)?,
                withdraw_token_cost_lamports: num("WITHDRAW_TOKEN_COST_LAMPORTS", 2_100_000)?,
            },
            venues: var("UNZEEN_VENUES")
                .unwrap_or_else(|| "pumpfun".into())
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect(),
            actions_enabled: solana == SolanaCluster::Devnet
                || var("UNZEEN_ALLOW_MAINNET_ACTIONS").as_deref() == Some("1"),
            limits: Limits {
                ip_per_sec: num("API_RL_IP_PER_SEC", 20.0)?,
                ip_burst: num("API_RL_IP_BURST", 60.0)?,
                key_per_min: num("API_RL_KEY_PER_MIN", 60.0)?,
                key_burst: num("API_RL_KEY_BURST", 20.0)?,
                max_ws: num("API_MAX_WS", 2_000)?,
            },
            cors_origins: var("API_CORS_ORIGINS")
                .map(|v| {
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
        };
        Ok(cfg)
    }

    pub fn zcash_net(&self) -> zcash_protocol::consensus::NetworkType {
        if self.network == "main" {
            zcash_protocol::consensus::NetworkType::Main
        } else {
            zcash_protocol::consensus::NetworkType::Test
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sol_parse() {
        assert_eq!(sol_to_lamports("11.47"), Some(11_470_000_000));
        assert_eq!(sol_to_lamports("1"), Some(1_000_000_000));
        assert_eq!(sol_to_lamports(".5"), Some(500_000_000));
        assert_eq!(sol_to_lamports("0.000000001"), Some(1));
        assert_eq!(sol_to_lamports("0.0000000001"), None);
        assert_eq!(sol_to_lamports("-1"), None);
        assert_eq!(sol_to_lamports("1e3"), None);
        assert_eq!(sol_to_lamports(""), None);
    }
}

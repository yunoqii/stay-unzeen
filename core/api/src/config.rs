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
    /// Relayer-published token media (`UNZEEN_MEDIA_DIR`, default `$UNZEEN_HOME/<cluster>/media`).
    pub media_dir: std::path::PathBuf,
    pub rate: RateConfig,
    pub exec: ExecConfig,
    /// `create` accepted only when a relayer executes it (UNZEEN_CREATE_ENABLED=1). D6.
    pub create_enabled: bool,
    pub fees: Fees,
    pub venues: Vec<String>,
    /// Mainnet actions are refused unless UNZEEN_ALLOW_MAINNET_ACTIONS=1 (lead approval).
    pub actions_enabled: bool,
    pub limits: Limits,
    pub cors_origins: Vec<String>,
    /// Creator rules of Unzeen launches (API v0.5).
    pub launch: LaunchConfig,
    /// Token intel (docs/INTEL.md).
    pub intel: IntelConfig,
}

#[derive(Clone, Copy, Debug)]
pub struct LaunchConfig {
    /// Lock of the creator's initial-buy tokens, seconds (0 = off). UNZEEN_CREATOR_LOCK_SECS.
    pub lock_secs: u64,
    /// Cap of the creator's position through the pool, basis points of the supply (0 = off).
    pub cap_bps: u64,
    /// Total supply of a launch, base units (pump.fun: 1e9 tokens x 1e6).
    pub total_supply: u64,
    /// Initial virtual reserves of the launch curve (pump.fun Global: 30 SOL / 1.073e15).
    pub virtual_sol_lamports: u64,
    pub virtual_token_reserves: u64,
}

impl LaunchConfig {
    pub fn cap_tokens(&self) -> u64 {
        ((self.total_supply as u128) * (self.cap_bps as u128) / 10_000) as u64
    }

    pub fn rules(&self) -> unzeen_ledger::CreatorRules {
        unzeen_ledger::CreatorRules {
            lock_secs: self.lock_secs,
            cap_tokens: self.cap_tokens(),
        }
    }

    pub fn curve(&self) -> crate::launch::Curve {
        crate::launch::Curve {
            virtual_sol: self.virtual_sol_lamports,
            virtual_tokens: self.virtual_token_reserves,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct IntelConfig {
    /// Full per-mint trade feed is on (UNZEEN_INTEL_FULL_TRADES=1): filters whales / dev.
    pub full_trades: bool,
    /// Max pending CA requests (UNZEEN_INTEL_QUEUE_MAX).
    pub queue_max: i64,
    /// `whale` tag threshold, lamports (UNZEEN_WHALE_LAMPORTS).
    pub whale_lamports: i64,
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
    /// D2: buy/sell/create run in epochs. Boundaries are spaced uniformly at random in
    /// [epoch_min, epoch_max] seconds (default 30..60), independent of request arrivals.
    pub epoch_min_secs: f64,
    pub epoch_max_secs: f64,
    /// "Max privacy" epochs (default 300..900 s = 5..15 min).
    pub max_epoch_min_secs: f64,
    pub max_epoch_max_secs: f64,
    pub withdraw_token_delay_min_secs: f64,
    pub withdraw_token_delay_max_secs: f64,
    pub zec_payout_delay_min_secs: f64,
    pub zec_payout_delay_max_secs: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Fees {
    /// `exec: "now"`: flat fee for the priority lane (pool-wide quantized priority fee; no Jito), zat.
    pub now_fee_zat: u64,
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
            credit_jitter: num::<u32>("UNZEEN_CONFIRMATIONS_JITTER", 3)?.min(10),
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
        let range = |kmin: &str, dmin: f64, kmax: &str, dmax: f64| -> anyhow::Result<(f64, f64)> {
            let (a, b): (f64, f64) = (num(kmin, dmin)?, num(kmax, dmax)?);
            if !(1.0..=7200.0).contains(&a) || b < a || b > 7200.0 {
                bail!("{kmin}/{kmax}: need 1 <= min <= max <= 7200");
            }
            Ok((a, b))
        };
        let (emin, emax) = range("UNZEEN_EPOCH_MIN_SECS", 30.0, "UNZEEN_EPOCH_MAX_SECS", 60.0)?;
        let (mmin, mmax) = range(
            "UNZEEN_MAX_PRIVACY_EPOCH_MIN_SECS",
            300.0,
            "UNZEEN_MAX_PRIVACY_EPOCH_MAX_SECS",
            900.0,
        )?;
        let launch = LaunchConfig {
            lock_secs: num("UNZEEN_CREATOR_LOCK_SECS", 86_400)?,
            cap_bps: num("UNZEEN_CREATOR_CAP_BPS", 500)?,
            total_supply: num("UNZEEN_LAUNCH_TOTAL_SUPPLY", 1_000_000_000_000_000)?,
            virtual_sol_lamports: num("UNZEEN_LAUNCH_VIRTUAL_SOL_LAMPORTS", 30_000_000_000)?,
            virtual_token_reserves: num("UNZEEN_LAUNCH_VIRTUAL_TOKEN_RESERVES", 1_073_000_000_000_000)?,
        };
        if launch.cap_bps > 10_000 {
            bail!("UNZEEN_CREATOR_CAP_BPS must be 0..10000");
        }
        if launch.virtual_sol_lamports == 0
            || launch.total_supply == 0
            || launch.virtual_token_reserves <= launch.cap_tokens()
        {
            bail!("UNZEEN_LAUNCH_*: need virtual reserves > 0 and > the creator cap");
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
            media_dir: match var("UNZEEN_MEDIA_DIR") {
                Some(d) => d.into(),
                None => {
                    let home = var("UNZEEN_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| {
                        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".unzeen")
                    });
                    home.join(cluster).join("media")
                }
            },
            rate: RateConfig {
                fixed_lamports_per_zec: fixed,
                oneclick_url: var("ONECLICK_URL").unwrap_or_else(|| "https://1click.chaindefuser.com".into()),
                oneclick_jwt: var("ONECLICK_JWT"),
                cache_secs: num("RATE_CACHE_SECS", 45)?,
                max_stale_secs: num("RATE_MAX_STALE_SECS", 120)?,
                spread_bps: num::<u64>("UNZEEN_RATE_SPREAD_BPS", 50)?.min(2_000),
            },
            exec: ExecConfig {
                epoch_min_secs: emin,
                epoch_max_secs: emax,
                max_epoch_min_secs: mmin,
                max_epoch_max_secs: mmax,
                withdraw_token_delay_min_secs: num("WITHDRAW_TOKEN_DELAY_MIN_SECS", 30.0)?,
                withdraw_token_delay_max_secs: num("WITHDRAW_TOKEN_DELAY_MAX_SECS", 300.0)?,
                zec_payout_delay_min_secs: num("ZEC_PAYOUT_DELAY_MIN_SECS", 60.0)?,
                zec_payout_delay_max_secs: num("ZEC_PAYOUT_DELAY_MAX_SECS", 600.0)?,
            },
            create_enabled: var("UNZEEN_CREATE_ENABLED").as_deref() == Some("1"),
            fees: Fees {
                // Flat; pays for the pool's priority lane, not for one tx's exact fee.
                now_fee_zat: num("UNZEEN_NOW_FEE_ZAT", 5_000)?,
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
            launch,
            intel: IntelConfig {
                full_trades: var("UNZEEN_INTEL_FULL_TRADES").as_deref() == Some("1"),
                queue_max: num::<i64>("UNZEEN_INTEL_QUEUE_MAX", 256)?.clamp(1, 100_000),
                whale_lamports: num::<i64>("UNZEEN_WHALE_LAMPORTS", 1_000_000_000)?.max(1),
            },
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

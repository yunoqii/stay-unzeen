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
    /// Fair launch (API v0.6). Off by default: everything fair-launch is invisible.
    pub fair: FairConfig,
    /// Verify snapshots (API v0.7).
    pub verify: VerifyConfig,
    /// Daily public stats (API v0.9).
    pub stats: StatsConfig,
    /// Token chat and cover traffic (API v0.12).
    pub chat: ChatConfig,
    /// Quote assets of non-SOL pairs (API v0.13).
    pub quotes: QuotesConfig,
    /// Scenarios (API v0.19).
    pub scenarios: ScenariosConfig,
    /// Trading comfort (API v0.28): Pulse, ETA, Jupiter quotes.
    pub comfort: ComfortConfig,
}

/// API v0.28 "Trading comfort".
#[derive(Clone, Debug)]
pub struct ComfortConfig {
    /// Pulse "About to graduate" threshold, % (UNZEEN_PULSE_GRADUATING_PCT, 1..99, default 70).
    pub graduating_pct: u32,
    /// Pace window of the ETA (UNZEEN_PULSE_ETA_WINDOW_SECS, 120..3600, default 600).
    pub eta_window_secs: u32,
    /// `GET /api/quote` (Jupiter); `None` = off (devnet, Robinhood Chain, UNZEEN_QUOTE=0).
    pub quote: Option<JupiterQuoteConfig>,
    /// Background timers of this module (Pulse, progress sampling, quote rounds). Always on in
    /// the server; integration tests turn them off and drive the steps themselves.
    pub timers: bool,
}

impl Default for ComfortConfig {
    fn default() -> Self {
        Self {
            graduating_pct: 70,
            eta_window_secs: 600,
            quote: None,
            timers: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct JupiterQuoteConfig {
    /// Quote API base (JUPITER_QUOTE_URL, default https://api.jup.ag/swap/v1): `<base>/quote`.
    pub url: String,
    /// `x-api-key` (JUPITER_API_KEY); keyless when absent. Never logged.
    pub api_key: Option<String>,
    /// Upstream requests per second at most (UNZEEN_QUOTE_RPS, default 1).
    pub rps: f64,
    /// One quoting round of the whole grid every this many seconds ± 20 % (UNZEEN_QUOTE_ROUND_SECS,
    /// 60..3600, default 600).
    pub round_secs: u32,
    /// Graduated tokens quoted per round (UNZEEN_QUOTE_MAX_MINTS, 1..200, default 40).
    pub max_mints: u32,
}

/// Scenarios (API v0.19, docs/analysis/scenarios.md). Off: no `features.scenarios`, the ops
/// answer like unknown ops.
#[derive(Clone, Debug, Default)]
pub struct ScenariosConfig {
    /// UNZEEN_SCENARIOS=1.
    pub enabled: bool,
    /// K_scn (UNZEEN_SCENARIO_KEY_FILE, 32 bytes hex, 0600, outside the DB and `.env`):
    /// seals withdrawal addresses, launch meta, bid ciphertexts and chat text of plans.
    /// Present iff `enabled`.
    pub key: Option<ChatKey>,
}

/// ZEC SPL (Zcash on Solana, bridged; launchpads-a.md): 8 decimals like ZEC.
pub const ZEC_SPL_MINT: &str = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

/// One quote asset of a network (API v0.13 `PoolInfo.quotes[]`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuoteCfg {
    /// "USDC" | "USD1" | "ZEC".
    pub quote: &'static str,
    pub mint: &'static str,
    pub decimals: u8,
    pub bridged: bool,
    /// Venues with this pair (devnet: pump.fun and Raydium use different USDC mints).
    pub venues: &'static [&'static str],
}

impl QuoteCfg {
    pub fn is_zec(&self) -> bool {
        self.quote == "ZEC"
    }
}

#[derive(Clone, Debug, Default)]
pub struct QuotesConfig {
    /// Enabled quotes (UNZEEN_QUOTES, symbols; default mainnet "USDC,ZEC", devnet "USDC").
    pub list: Vec<QuoteCfg>,
    /// ZEC SPL parity spread, bps (UNZEEN_ZEC_SPL_SPREAD_BPS, default 30): cost of refilling
    /// the stock through 1Click.
    pub zec_spread_bps: u64,
    /// Initial virtual quote reserves of a pump.fun ZEC curve, ZEC SPL units (creator cap of
    /// ZEC-pair launches; UNZEEN_LAUNCH_VIRTUAL_ZEC_UNITS, default 2.7189 ZEC, on-chain 13.10).
    pub zec_virtual_units: u64,
}

/// The registry (on-chain facts 13.10, launchpads-a.md / adapters `pool-a.ts`).
pub fn known_quotes(mainnet: bool) -> Vec<QuoteCfg> {
    if mainnet {
        vec![
            QuoteCfg {
                quote: "ZEC",
                mint: ZEC_SPL_MINT,
                decimals: 8,
                bridged: true,
                venues: &["pumpfun", "raydium-launchlab"],
            },
            QuoteCfg {
                quote: "USDC",
                mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                decimals: 6,
                bridged: false,
                venues: &["pumpfun", "meteora-dbc", "raydium-launchlab"],
            },
            QuoteCfg {
                quote: "USD1",
                mint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
                decimals: 6,
                bridged: false,
                venues: &["meteora-dbc", "raydium-launchlab"],
            },
        ]
    } else {
        vec![
            QuoteCfg {
                quote: "USDC",
                mint: "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT",
                decimals: 6,
                bridged: false,
                venues: &["meteora-dbc", "raydium-launchlab"],
            },
            QuoteCfg {
                quote: "USDC",
                mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                decimals: 6,
                bridged: false,
                venues: &["pumpfun"],
            },
        ]
    }
}

impl QuotesConfig {
    /// The quote asset of `quote` on `venue` (None: not enabled there).
    pub fn for_venue(&self, quote: &str, venue: &str) -> Option<&QuoteCfg> {
        self.list.iter().find(|q| q.quote == quote && q.venues.contains(&venue))
    }

    pub fn by_mint(&self, mint: &str) -> Option<&QuoteCfg> {
        self.list.iter().find(|q| q.mint == mint)
    }

    /// Every quote mint the pool may hold on this network (also disabled ones: Verify must
    /// still see a stock left from before).
    pub fn all_mints(mainnet: bool) -> Vec<QuoteCfg> {
        known_quotes(mainnet)
    }
}

/// K_chat: 32 bytes per network, outside the database (UNZEEN_CHAT_KEY_FILE). Never printed.
#[derive(Clone)]
pub struct ChatKey(pub [u8; 32]);

impl std::fmt::Debug for ChatKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ChatKey(<redacted>)")
    }
}

/// Chat (API.md v0.12, docs/analysis/chat.md).
#[derive(Clone, Debug)]
pub struct ChatConfig {
    /// UNZEEN_CHAT=1. Off: no `features.chat`, chat ops answer like unknown ops, GET → 404.
    pub enabled: bool,
    /// UNZEEN_NOOP=1: `op:"noop"` accepted (R8), `features.noop`.
    pub noop: bool,
    /// UNZEEN_CHAT_MIN_ACCOUNT_ZAT (default 0.05 ZEC mainnet, 0.001 devnet).
    pub min_account_zat: u64,
    /// Present iff `enabled`.
    pub key: Option<ChatKey>,
}

/// Reads the hex K_chat file (64 hex chars, comments with '#' allowed).
pub fn load_chat_key(path: &std::path::Path) -> anyhow::Result<ChatKey> {
    let s = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let hexs: String = s
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<String>()
        .trim()
        .to_string();
    let b: [u8; 32] = hex::decode(&hexs)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| anyhow!("UNZEEN_CHAT_KEY_FILE must hold 32 bytes hex"))?;
    Ok(ChatKey(b))
}

/// `GET /api/stats` (API.md v0.9, H6).
#[derive(Clone, Copy, Debug)]
pub struct StatsConfig {
    /// Snapshot at 00:00 UTC every day (UNZEEN_STATS_DAILY; default: on for mainnet, off for
    /// devnet where the operator runs `unzeen-api stats-snapshot`).
    pub daily: bool,
    pub params: unzeen_ledger::stats::StatsParams,
}

/// Verify (API.md v0.7).
#[derive(Clone, Copy, Debug)]
pub struct VerifyConfig {
    /// Daily snapshot at 00:00 UTC (UNZEEN_VERIFY_DAILY; default: on for mainnet, off for
    /// devnet where the operator runs `unzeen-api verify-snapshot`).
    pub daily: bool,
    pub timing: unzeen_ledger::verify::VerifyTiming,
    /// Owner proof responses are padded to exactly this (65536: constant, never reveals the asset count).
    pub proof_bucket: usize,
}

/// Fair launch (API.md v0.6). Internal until 28.10.
#[derive(Clone, Debug)]
pub struct FairConfig {
    /// UNZEEN_FAIR_LAUNCH=1. false: /api/launches* → 404, fl_* → 400 like an unknown op.
    pub enabled: bool,
    /// Allowed bid windows, seconds (UNZEEN_FL_WINDOWS_SECS, default 120,300,600,1800).
    pub windows_secs: Vec<u32>,
    /// Hold tiers, zat, ascending (UNZEEN_FL_HOLD_TIERS_ZAT; default per network).
    pub hold_tiers_zat: Vec<u64>,
    /// Cap of the total launch buy, bps of the supply (UNZEEN_FL_MAX_TOTAL_BPS, 2500).
    pub max_total_bps: u64,
    /// Below this many valid bids the public count is "<N" (5).
    pub min_bids_for_count: u32,
    /// drand relays, tried round-robin (UNZEEN_DRAND_URLS).
    pub drand_urls: Vec<String>,
    /// Venue fee bound for the launch min_out (UNZEEN_FL_FEE_BOUND_BPS, 300) + 50 bps slippage.
    pub fee_bound_bps: u64,
    pub slippage_bps: u64,
    /// No verified beacon this long after the round time → failed (drand_unavailable). 3600.
    pub drand_give_up_secs: u64,
    /// No rate / curve this long after the round time → failed (venue_unavailable). 600.
    pub rate_give_up_secs: u64,
}

pub const DRAND_RELAYS: [&str; 4] = [
    "https://api.drand.sh",
    "https://api2.drand.sh",
    "https://api3.drand.sh",
    "https://drand.cloudflare.com",
];

/// Hold tiers: mainnet 0.05/0.1/0.25/0.5/1/2.5/5/10 ZEC; devnet 0.001..0.05 TAZ (the devnet
/// curve is ~30x cheaper and TAZ is scarce).
pub fn default_hold_tiers(mainnet: bool) -> Vec<u64> {
    if mainnet {
        vec![
            5_000_000,
            10_000_000,
            25_000_000,
            50_000_000,
            100_000_000,
            250_000_000,
            500_000_000,
            1_000_000_000,
        ]
    } else {
        vec![100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000]
    }
}

fn list<T: std::str::FromStr>(key: &str) -> anyhow::Result<Option<Vec<T>>> {
    match var(key) {
        None => Ok(None),
        Some(v) => v
            .split(',')
            .map(|x| {
                x.trim()
                    .parse::<T>()
                    .map_err(|_| anyhow!("{key}: comma-separated numbers"))
            })
            .collect::<anyhow::Result<Vec<T>>>()
            .map(Some),
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LaunchConfig {
    /// Lock of the creator's initial-buy tokens, seconds (0 = off). UNZEEN_CREATOR_LOCK_SECS.
    pub lock_secs: u64,
    /// Cap of the creator's position through the pool, basis points of the supply (0 = off).
    pub cap_bps: u64,
    /// Total supply of a launch, base units (pump.fun: 1e9 tokens x 1e6).
    pub total_supply: u128,
    /// Initial virtual reserves of the launch curve (pump.fun Global: 30 SOL / 1.073e15).
    pub virtual_sol_lamports: u128,
    pub virtual_token_reserves: u128,
    /// The UNZEEN_LAUNCH_VIRTUAL_* values were set explicitly (not defaults). Fair launch uses
    /// env curve values only then; otherwise it needs the network curve (`launch_curves`).
    pub curve_from_env: bool,
    /// Upper bound of the creator fee on a launch buy, bps (API v0.9; used only when the
    /// relayer did not report the exact fee). UNZEEN_LAUNCH_CREATOR_FEE_BPS_PUMPFUN (30),
    /// UNZEEN_LAUNCH_CREATOR_FEE_BPS_DBC (40).
    pub launch_fee_bps_pumpfun: u32,
    pub launch_fee_bps_dbc: u32,
    /// API v0.26: pump.fun bonding-curve trade fee in curve estimates and in
    /// `PoolInfo.venues[].curve.feeBps` (UNZEEN_TRADE_FEE_BPS_PUMPFUN, 125).
    pub trade_fee_bps_pumpfun: u32,
    /// MIN_CLAIM_ZAT: smallest claim, zat (default 10 000 = 0.0001 ZEC, never above
    /// MIN_ACTION_ZAT).
    pub min_claim_zat: u64,
}

impl LaunchConfig {
    pub fn cap_tokens(&self) -> u128 {
        self.total_supply.saturating_mul(self.cap_bps as u128) / 10_000
    }

    pub fn rules(&self) -> unzeen_ledger::CreatorRules {
        unzeen_ledger::CreatorRules {
            lock_secs: self.lock_secs,
            cap_tokens: self.cap_tokens(),
            launch_fee_bps_pumpfun: self.launch_fee_bps_pumpfun,
            launch_fee_bps_dbc: self.launch_fee_bps_dbc,
            min_claim_zat: self.min_claim_zat,
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
    /// Discovery list of /tokens (UNZEEN_DISCOVERY=1, API v0.12). Off: no `features.discovery`,
    /// `GET /api/tokens?source=discovery` answers like an unknown path.
    pub discovery: bool,
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
    /// v0.20: the rate is ZEC → ETH on Robinhood Chain (wei per ZEC) instead of ZEC → SOL.
    pub hood: bool,
    /// v0.22 (hood): buy/sell need a positive token price not older than this
    /// (UNZEEN_PRICE_MAX_AGE_SECS, default 300; the hood relayer writes prices every 1–2 min).
    pub price_max_age_secs: u64,
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
/// GAP-5: why token metadata could not be published safely on mainnet (`None` = fine).
/// Pinata wins; otherwise the base must be https on a public host name (no localhost,
/// loopback/private/link-local IPs, `.local`/`.lan`/`.internal`, no bare IPv6).
pub fn metadata_problem(base: Option<&str>, pinata: bool) -> Option<String> {
    if pinata {
        return None;
    }
    let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) else {
        return Some("neither PINATA_JWT nor UNZEEN_METADATA_BASE_URL is set".into());
    };
    let Some(rest) = base.strip_prefix("https://") else {
        return Some("UNZEEN_METADATA_BASE_URL is not https".into());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') || authority.starts_with('[') {
        return Some("UNZEEN_METADATA_BASE_URL host is not a public DNS name".into());
    }
    let host = authority.split(':').next().unwrap_or("").to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    let private_ip = host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| {
        ip.is_loopback()
            || ip.is_private()
            || ip.is_link_local()
            || ip.is_unspecified()
            || ip.is_broadcast()
            || ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1])
    });
    let local_name = host.is_empty()
        || !host.contains('.')
        || host == "localhost"
        || [
            ".localhost",
            ".local",
            ".lan",
            ".internal",
            ".home",
            ".test",
            ".invalid",
        ]
        .iter()
        .any(|s| host.ends_with(s));
    if private_ip || local_name {
        return Some(format!("UNZEEN_METADATA_BASE_URL host {host:?} is not public"));
    }
    None
}

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
/// Decimal price of one whole token in native units of the chain (SOL → lamports ×1e9, ETH → wei
/// ×1e18), for spot estimates.
pub fn price_to_units(s: &str, trade: unzeen_protocol::TradeNet) -> Option<u128> {
    match trade {
        unzeen_protocol::TradeNet::Solana(_) => {
            // Lamports have 9 decimals: a longer fraction is truncated (spot estimates only).
            let t = match s.split_once('.') {
                Some((i, f)) => format!("{i}.{}", &f[..f.len().min(9)]),
                None => s.to_string(),
            };
            sol_to_lamports(&t).map(u128::from)
        }
        unzeen_protocol::TradeNet::Hood(_) => eth_to_wei(s),
    }
}

/// Decimal ETH (≤ 18 fractional digits; longer fractions are truncated) → wei.
pub fn eth_to_wei(s: &str) -> Option<u128> {
    let s = s.trim();
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty() && frac.is_empty() {
        return None;
    }
    if !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let frac = &frac[..frac.len().min(18)];
    let i: u128 = if int.is_empty() { 0 } else { int.parse().ok()? };
    let f: u128 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<18}").parse().ok()?
    };
    i.checked_mul(1_000_000_000_000_000_000)?.checked_add(f)
}

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
        let zcash = if network == "main" {
            ZcashNet::Mainnet
        } else {
            ZcashNet::Testnet
        };
        // v0.20: UNZEEN_CHAIN = solana (default) | hood. A hood instance has its own pool wallet,
        // DB and chain id (0111 / 0212, network from the Zcash network), RELAYER v13.
        let chain = match var("UNZEEN_CHAIN").as_deref().unwrap_or("solana") {
            "solana" => {
                let solana: SolanaCluster = var("UNZEEN_SOLANA_CLUSTER")
                    .unwrap_or_else(|| "devnet".into())
                    .parse()
                    .map_err(|e: String| anyhow!(e))?;
                ChainId::new(zcash, solana)
            }
            "hood" => ChainId::hood(
                zcash,
                if zcash == ZcashNet::Mainnet {
                    unzeen_protocol::HoodNet::Mainnet
                } else {
                    unzeen_protocol::HoodNet::Testnet
                },
            ),
            other => bail!("UNZEEN_CHAIN={other:?}: expected solana | hood"),
        };
        // Only the matching pairs (0101, 0202, 0111, 0212). Mixed combinations would sign
        // memos/requests for a network nobody runs.
        if ChainId::from_bytes(chain.to_bytes()).is_none() {
            bail!(
                "UNZEEN_NETWORK={network} with UNZEEN_SOLANA_CLUSTER: networks must match \
                 (test+devnet or main+mainnet-beta)"
            );
        }
        let trade = chain.trade;
        let hood = matches!(trade, unzeen_protocol::TradeNet::Hood(_));
        let cluster: &'static str = trade.network();
        let mainnet = trade.is_mainnet();
        // GAP-5: a token URI is written on chain forever. On Solana mainnet `create` needs
        // Pinata or a PUBLIC https media base, never a local/http one (127.0.0.1 in the URI).
        if mainnet
            && !hood
            && var("UNZEEN_CREATE_ENABLED").as_deref() == Some("1")
            && let Some(why) = metadata_problem(var("UNZEEN_METADATA_BASE_URL").as_deref(), var("PINATA_JWT").is_some())
        {
            bail!(
                "refusing to start: UNZEEN_CREATE_ENABLED=1 on mainnet but {why}. Set PINATA_JWT, or \
                 UNZEEN_METADATA_BASE_URL=https://<public API domain>/media, or UNZEEN_CREATE_ENABLED=0"
            );
        }
        let policy = Policy {
            chain,
            confirmations: num::<u32>("UNZEEN_CONFIRMATIONS", 3)?.max(1),
            min_deposit_zat: num("MIN_DEPOSIT_ZAT", 100_000)?,
            min_action_zat: num("MIN_ACTION_ZAT", 100_000)?,
            credit_jitter: num::<u32>("UNZEEN_CONFIRMATIONS_JITTER", 3)?.min(10),
        };

        // Fixed test rate: SOL per ZEC (devnet) or ETH per ZEC (hood-testnet); never with real money.
        let fixed_key = if hood {
            "DEVNET_ZEC_ETH_RATE"
        } else {
            "DEVNET_ZEC_SOL_RATE"
        };
        let fixed = match var(fixed_key) {
            Some(_) if mainnet => bail!("{fixed_key} is not allowed on mainnet"),
            Some(v) if hood => Some(
                eth_to_wei(&v)
                    .and_then(|w| u64::try_from(w).ok())
                    .filter(|w| *w > 0)
                    .context("DEVNET_ZEC_ETH_RATE must be a positive decimal (ETH per 1 ZEC)")?,
            ),
            Some(v) => Some(
                sol_to_lamports(&v)
                    .filter(|l| *l > 0)
                    .context("DEVNET_ZEC_SOL_RATE must be a positive decimal (SOL per 1 ZEC)")?,
            ),
            None => None,
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
            curve_from_env: var("UNZEEN_LAUNCH_VIRTUAL_SOL_LAMPORTS").is_some(),
            launch_fee_bps_pumpfun: num::<u32>("UNZEEN_LAUNCH_CREATOR_FEE_BPS_PUMPFUN", 30)?.min(10_000),
            launch_fee_bps_dbc: num::<u32>("UNZEEN_LAUNCH_CREATOR_FEE_BPS_DBC", 40)?.min(10_000),
            trade_fee_bps_pumpfun: num::<u32>(
                "UNZEEN_TRADE_FEE_BPS_PUMPFUN",
                unzeen_ledger::curve::PUMPFUN_TRADE_FEE_BPS,
            )?
            .min(5_000),
            min_claim_zat: num::<u64>("MIN_CLAIM_ZAT", 10_000)?.clamp(1, policy.min_action_zat.max(1)),
        };
        let fair = FairConfig {
            enabled: var("UNZEEN_FAIR_LAUNCH").as_deref() == Some("1"),
            windows_secs: list("UNZEEN_FL_WINDOWS_SECS")?.unwrap_or_else(|| vec![120, 300, 600, 1800]),
            hold_tiers_zat: list("UNZEEN_FL_HOLD_TIERS_ZAT")?.unwrap_or_else(|| default_hold_tiers(mainnet)),
            max_total_bps: num("UNZEEN_FL_MAX_TOTAL_BPS", 2_500)?,
            min_bids_for_count: num("UNZEEN_FL_MIN_BIDS_FOR_COUNT", 5)?,
            drand_urls: var("UNZEEN_DRAND_URLS")
                .map(|v| {
                    v.split(',')
                        .map(|s| s.trim().trim_end_matches('/').to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_else(|| DRAND_RELAYS.iter().map(|s| s.to_string()).collect()),
            fee_bound_bps: num::<u64>("UNZEEN_FL_FEE_BOUND_BPS", 300)?.min(5_000),
            slippage_bps: 50,
            drand_give_up_secs: 3_600,
            rate_give_up_secs: 600,
        };
        if fair.windows_secs.is_empty() || fair.windows_secs.iter().any(|w| !(60..=86_400).contains(w)) {
            bail!("UNZEEN_FL_WINDOWS_SECS: 60..86400 seconds each");
        }
        if fair.hold_tiers_zat.is_empty()
            || !fair.hold_tiers_zat.windows(2).all(|w| w[0] < w[1])
            || fair.hold_tiers_zat[0] < policy.min_action_zat
        {
            bail!("UNZEEN_FL_HOLD_TIERS_ZAT: strictly ascending, each >= MIN_ACTION_ZAT");
        }
        if fair.max_total_bps == 0 || fair.max_total_bps > 5_000 || fair.drand_urls.is_empty() {
            bail!("UNZEEN_FL_MAX_TOTAL_BPS must be 1..5000 (far from graduation); UNZEEN_DRAND_URLS non-empty");
        }
        if launch.cap_bps > 10_000 {
            bail!("UNZEEN_CREATOR_CAP_BPS must be 0..10000");
        }
        if launch.virtual_sol_lamports == 0
            || launch.total_supply == 0
            || launch.virtual_token_reserves <= launch.cap_tokens()
        {
            bail!("UNZEEN_LAUNCH_*: need virtual reserves > 0 and > the creator cap");
        }
        let quote_round_secs = num::<u32>("UNZEEN_QUOTE_ROUND_SECS", 600)?.clamp(60, 3_600);
        let quote_max_mints = num::<u32>("UNZEEN_QUOTE_MAX_MINTS", 40)?.clamp(1, 200);
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
                hood,
                price_max_age_secs: num::<u64>("UNZEEN_PRICE_MAX_AGE_SECS", 300)?.clamp(60, 3_600),
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
                // Native units: lamports (SOL drop + ATA rent/fee) or wei on hood (0.00005 ETH drop,
                // 0.00001 ETH transfer fee).
                withdraw_token_gas_lamports: num(
                    "WITHDRAW_TOKEN_GAS_LAMPORTS",
                    if hood { 50_000_000_000_000 } else { 2_000_000 },
                )?,
                withdraw_token_cost_lamports: num(
                    "WITHDRAW_TOKEN_COST_LAMPORTS",
                    if hood { 10_000_000_000_000 } else { 2_100_000 },
                )?,
            },
            venues: var("UNZEEN_VENUES")
                .unwrap_or_else(|| if hood { "pons".into() } else { "pumpfun".into() })
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect(),
            actions_enabled: !mainnet || var("UNZEEN_ALLOW_MAINNET_ACTIONS").as_deref() == Some("1"),
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
                discovery: var("UNZEEN_DISCOVERY").as_deref() == Some("1"),
            },
            fair,
            verify: VerifyConfig {
                daily: match var("UNZEEN_VERIFY_DAILY").as_deref() {
                    Some("1") => true,
                    Some("0") => false,
                    _ => mainnet,
                },
                timing: unzeen_ledger::verify::VerifyTiming::default(),
                proof_bucket: 65_536,
            },
            stats: StatsConfig {
                daily: match var("UNZEEN_STATS_DAILY").as_deref() {
                    Some("1") => true,
                    Some("0") => false,
                    _ => mainnet,
                },
                params: unzeen_ledger::stats::StatsParams {
                    sol_round_lamports: num::<u64>("UNZEEN_STATS_SOL_ROUND_LAMPORTS", 100_000_000)?.max(1),
                    // Never finer than 0.01 ZEC (H6: the total must not resolve single deposits).
                    zec_round_zat: num::<u64>("UNZEEN_STATS_ZEC_ROUND_ZAT", 100_000_000)?.max(1_000_000),
                    ..unzeen_ledger::stats::StatsParams::default()
                },
            },
            quotes: {
                // Robinhood Chain: ETH pairs only (Pons), no SPL quote assets.
                let wanted = if hood {
                    String::new()
                } else {
                    var("UNZEEN_QUOTES").unwrap_or_else(|| if mainnet { "USDC,ZEC".into() } else { "USDC".into() })
                };
                let wanted: Vec<String> = wanted
                    .split(',')
                    .map(|v| v.trim().to_uppercase())
                    .filter(|v| !v.is_empty())
                    .collect();
                for w in &wanted {
                    if !["USDC", "USD1", "ZEC"].contains(&w.as_str()) {
                        bail!("UNZEEN_QUOTES: unknown quote {w:?} (USDC | USD1 | ZEC)");
                    }
                }
                QuotesConfig {
                    list: known_quotes(mainnet)
                        .into_iter()
                        .filter(|q| wanted.iter().any(|w| w == q.quote))
                        .collect(),
                    zec_spread_bps: num::<u64>("UNZEEN_ZEC_SPL_SPREAD_BPS", 30)?.min(1000),
                    zec_virtual_units: num::<u64>("UNZEEN_LAUNCH_VIRTUAL_ZEC_UNITS", 271_890_000)?.max(1),
                }
            },
            chat: {
                let enabled = var("UNZEEN_CHAT").as_deref() == Some("1");
                let key = if enabled {
                    let p = var("UNZEEN_CHAT_KEY_FILE")
                        .ok_or_else(|| anyhow!("UNZEEN_CHAT=1 needs UNZEEN_CHAT_KEY_FILE (unzeen-api chat-keygen)"))?;
                    Some(load_chat_key(std::path::Path::new(&p))?)
                } else {
                    None
                };
                ChatConfig {
                    enabled,
                    noop: var("UNZEEN_NOOP").as_deref() == Some("1"),
                    min_account_zat: num::<u64>(
                        "UNZEEN_CHAT_MIN_ACCOUNT_ZAT",
                        if mainnet { 5_000_000 } else { 100_000 },
                    )?,
                    key,
                }
            },
            comfort: ComfortConfig {
                graduating_pct: num::<u32>("UNZEEN_PULSE_GRADUATING_PCT", 70)?.clamp(1, 99),
                eta_window_secs: num::<u32>("UNZEEN_PULSE_ETA_WINDOW_SECS", 600)?.clamp(120, 3_600),
                // Jupiter has no devnet; Robinhood Chain has no Jupiter.
                quote: (mainnet && !hood && var("UNZEEN_QUOTE").as_deref() != Some("0")).then(|| JupiterQuoteConfig {
                    url: var("JUPITER_QUOTE_URL").unwrap_or_else(|| "https://api.jup.ag/swap/v1".into()),
                    api_key: var("JUPITER_API_KEY").filter(|k| !k.trim().is_empty()),
                    rps: var("UNZEEN_QUOTE_RPS")
                        .and_then(|v| v.parse::<f64>().ok())
                        .filter(|r| *r > 0.0 && *r <= 50.0)
                        .unwrap_or(1.0),
                    round_secs: quote_round_secs,
                    max_mints: quote_max_mints,
                }),
                timers: true,
            },
            scenarios: {
                let enabled = var("UNZEEN_SCENARIOS").as_deref() == Some("1");
                let key = if enabled {
                    let p = var("UNZEEN_SCENARIO_KEY_FILE").ok_or_else(|| {
                        anyhow!("UNZEEN_SCENARIOS=1 needs UNZEEN_SCENARIO_KEY_FILE (32 bytes hex, like the chat key)")
                    })?;
                    let path = std::path::Path::new(&p);
                    // K_scn: owner-only file (review-scenarios п. 13).
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let mode = std::fs::metadata(path)
                            .with_context(|| format!("reading {}", path.display()))?
                            .permissions()
                            .mode();
                        if mode & 0o077 != 0 {
                            bail!("UNZEEN_SCENARIO_KEY_FILE must be mode 0600 (owner only)");
                        }
                    }
                    Some(load_chat_key(path).context("UNZEEN_SCENARIO_KEY_FILE")?)
                } else {
                    None
                };
                ScenariosConfig { enabled, key }
            },
        };
        // Venues of another chain cannot be enabled (pons only on hood, the rest only on Solana).
        let on_hood = matches!(cfg.policy.chain.trade, unzeen_protocol::TradeNet::Hood(_));
        if let Some(v) = cfg
            .venues
            .iter()
            .find(|v| crate::actions::HOOD_VENUES.contains(&v.as_str()) != on_hood)
        {
            bail!("UNZEEN_VENUES: {v} is not a venue of this server's chain");
        }
        // K_scn and K_chat are different keys: one leaked key must not open the other's data.
        if let (Some(a), Some(b)) = (&cfg.scenarios.key, &cfg.chat.key)
            && a.0 == b.0
        {
            bail!("UNZEEN_SCENARIO_KEY_FILE holds the same key as UNZEEN_CHAT_KEY_FILE; use a separate key");
        }
        // Fair launch on Robinhood Chain needs a relayer path (Pons launchAndBuy) that does not
        // exist yet; the math is ready (u128).
        if hood && cfg.fair.enabled {
            bail!("UNZEEN_FAIR_LAUNCH=1 is not supported on Robinhood Chain yet");
        }
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
    #[test]
    fn gap5_metadata_problem() {
        use super::metadata_problem as m;
        assert!(m(None, true).is_none());
        assert!(m(Some("http://127.0.0.1:8080/media"), true).is_none(), "Pinata wins");
        assert!(m(Some("https://api.unzeen.xyz/media"), false).is_none());
        assert!(m(Some("https://api.unzeen.xyz:8443/media"), false).is_none());
        assert!(m(Some("https://8.8.8.8/media"), false).is_none());
        for bad in [
            None,
            Some(""),
            Some("http://127.0.0.1:8080/media"),
            Some("http://api.unzeen.xyz/media"),
            Some("https://127.0.0.1/media"),
            Some("https://localhost:8080/media"),
            Some("https://10.0.0.5/media"),
            Some("https://192.168.1.2/media"),
            Some("https://172.16.0.1/media"),
            Some("https://100.64.1.1/media"),
            Some("https://169.254.0.1/media"),
            Some("https://0.0.0.0/media"),
            Some("https://[::1]/media"),
            Some("https://mac.local/media"),
            Some("https://box.lan/media"),
            Some("https://vps/media"),
            Some("https://user@api.unzeen.xyz/media"),
        ] {
            assert!(m(bad, false).is_some(), "{bad:?} must be refused");
        }
    }

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

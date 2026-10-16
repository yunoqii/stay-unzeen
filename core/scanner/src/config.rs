//! Runtime configuration (env / CLI).
//!
//! The network is chosen ONLY via `UNZEEN_NETWORK` (`test` | `main`), never hard-coded.
//! It is persisted next to the wallet DB at `init` and checked on every open, so a
//! testnet wallet can never be pointed at mainnet by accident (and vice versa).

use std::path::PathBuf;

use anyhow::{Context, bail};
use clap::Args;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_protocol::consensus::Network;

pub const NETWORK_FILE: &str = "network";
/// GAP-9: which pool instance (trade chain) owns this wallet directory.
pub const CHAIN_FILE: &str = "chain";
/// GAP-9: held (flock) by a running `serve` for the life of the process.
pub const SERVE_LOCK_FILE: &str = "serve.lock";

/// Trade chain of the pool instance (`UNZEEN_CHAIN`). Each chain has its own pool wallet:
/// a Solana pool and a Robinhood Chain (hood) pool must never share a wallet directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ChainName {
    Solana,
    Hood,
}

impl ChainName {
    pub fn as_str(self) -> &'static str {
        match self {
            ChainName::Solana => "solana",
            ChainName::Hood => "hood",
        }
    }
}

/// Default state root of an instance under `UNZEEN_HOME`: `<net>` for Solana (unchanged, so
/// existing wallets stay where they are), `hood-<net>` for Robinhood Chain.
pub fn instance_dir_name(chain: ChainName, net: NetName) -> String {
    match chain {
        ChainName::Solana => net.as_str().to_string(),
        ChainName::Hood => format!("hood-{}", net.as_str()),
    }
}

/// What to do with a wallet directory given its `chain` marker (pure, for tests).
#[derive(Debug, PartialEq, Eq)]
pub enum ChainCheck {
    Ok,
    /// Marker absent on testnet: a wallet from before GAP-9; adopt it (marker written).
    AdoptLegacy,
    Refuse(String),
}

pub fn chain_check(stored: Option<&str>, want: ChainName, net: NetName, dir: &std::path::Path) -> ChainCheck {
    match stored.map(str::trim) {
        Some(s) if s == want.as_str() => ChainCheck::Ok,
        // A dev/user wallet that pays several pools (e.g. ~/.unzeen/dev-user), never a pool.
        Some("any") if net == NetName::Test => ChainCheck::Ok,
        Some(other) => ChainCheck::Refuse(format!(
            "refusing to open the wallet in {}: it belongs to the {other:?} pool instance, but UNZEEN_CHAIN={}. \
             Each chain needs its own UNZEEN_DATA_DIR/UNZEEN_KEYS_DIR (default ~/.unzeen/{}/...)",
            dir.display(),
            want.as_str(),
            instance_dir_name(want, net)
        )),
        None if net == NetName::Test => ChainCheck::AdoptLegacy,
        None => ChainCheck::Refuse(format!(
            "refusing to open the mainnet wallet in {}: no `{CHAIN_FILE}` marker. If this really is the \
             {} pool's wallet, write it once: echo {} > {}/{CHAIN_FILE}",
            dir.display(),
            want.as_str(),
            want.as_str(),
            dir.display()
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum NetName {
    Test,
    Main,
}

impl NetName {
    pub fn params(self) -> Network {
        match self {
            NetName::Test => Network::TestNetwork,
            NetName::Main => Network::MainNetwork,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            NetName::Test => "test",
            NetName::Main => "main",
        }
    }
    pub fn default_lightwalletd(self) -> &'static str {
        match self {
            NetName::Test => "https://testnet.zec.rocks:443",
            NetName::Main => "https://zec.rocks:443",
        }
    }
    /// Public fallbacks, tried in order when the primary is down (checked 2026-10-12).
    /// Testnet has no second working public server today (zaino.testnet.unsafe.zec.rocks
    /// answered 503); set LIGHTWALLETD_FALLBACK_URLS when one appears.
    pub fn default_fallbacks(self) -> &'static [&'static str] {
        match self {
            NetName::Test => &[],
            NetName::Main => &["https://na.zec.rocks:443", "https://eu.zec.rocks:443"],
        }
    }
    /// `chainName` reported by lightwalletd `GetLightdInfo`.
    pub fn lightd_chain_name(self) -> &'static str {
        match self {
            NetName::Test => "test",
            NetName::Main => "main",
        }
    }
    pub fn zcash_net(self) -> unzeen_protocol::ZcashNet {
        match self {
            NetName::Test => unzeen_protocol::ZcashNet::Testnet,
            NetName::Main => unzeen_protocol::ZcashNet::Mainnet,
        }
    }
}

/// Legacy plaintext seed (day 1). Only read by `seed-encrypt`, or with an explicit
/// UNZEEN_ALLOW_PLAINTEXT_SEED=1 on testnet.
pub const SEED_FILE: &str = "pool.mnemonic";
/// age-encrypted seed.
pub const SEED_FILE_AGE: &str = "pool.mnemonic.age";
pub const WALLET_DB: &str = "wallet.sqlite";
pub const ACCOUNT_NAME: &str = "unzeen-pool";

#[derive(Debug, Clone, Args)]
pub struct Common {
    /// Zcash network: `test` (TAZ) or `main` (real ZEC — only with lead's approval).
    #[arg(long, env = "UNZEEN_NETWORK", value_enum, default_value = "test")]
    pub network: NetName,

    /// lightwalletd gRPC endpoint. Default: testnet.zec.rocks:443 (test) / zec.rocks:443 (main).
    #[arg(long, env = "LIGHTWALLETD_URL")]
    pub lightwalletd_url: Option<String>,

    /// Comma-separated fallback endpoints, tried in order if the primary fails.
    /// Default: none (test) / na.zec.rocks, eu.zec.rocks (main).
    #[arg(long, env = "LIGHTWALLETD_FALLBACK_URLS", value_delimiter = ',')]
    pub lightwalletd_fallbacks: Option<Vec<String>>,

    /// Final audit A8: lightwalletd of ANOTHER operator used only to broadcast pool txs
    /// (payouts, rebalance). The scan server then never sees which txs are the pool's, and
    /// cannot pair a payout broadcast with the user's wallet fetching it. Unset: broadcasts go
    /// through the scan servers (warned at `serve` start on mainnet). No fallback to them.
    #[arg(long, env = "LIGHTWALLETD_SEND_URL")]
    pub lightwalletd_send_url: Option<String>,

    /// Pool instance: `solana` (default) or `hood` (Robinhood Chain). Picks the default wallet
    /// directories and is recorded in the wallet's `chain` marker (GAP-9).
    #[arg(long, env = "UNZEEN_CHAIN", value_enum, default_value = "solana")]
    pub chain: ChainName,

    /// Directory for wallet state (sqlite). Default: $UNZEEN_HOME/<network>/data (Solana) or
    /// $UNZEEN_HOME/hood-<network>/data (hood).
    #[arg(long, env = "UNZEEN_DATA_DIR")]
    pub data_dir_override: Option<PathBuf>,

    /// Directory for secret material (seed). Default: $UNZEEN_HOME/<network>/keys (Solana) or
    /// $UNZEEN_HOME/hood-<network>/keys (hood).
    #[arg(long, env = "UNZEEN_KEYS_DIR")]
    pub keys_dir_override: Option<PathBuf>,
}

/// Root for wallet state and keys: `UNZEEN_HOME`, default `~/.unzeen` (outside the repo and
/// outside ~/Desktop, which may be cloud-synced).
pub fn unzeen_home() -> PathBuf {
    if let Some(h) = std::env::var_os("UNZEEN_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".unzeen")
}

/// Restrict a path to the owner (0700 for dirs, 0600 for files). No-op if missing.
pub fn restrict_perms(path: &std::path::Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = if meta.is_dir() { 0o700 } else { 0o600 };
            if meta.permissions().mode() & 0o777 != mode {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
                    .with_context(|| format!("chmod {}", path.display()))?;
            }
        }
    }
    Ok(())
}

impl Common {
    pub fn params(&self) -> Network {
        self.network.params()
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir_override.clone().unwrap_or_else(|| {
            unzeen_home()
                .join(instance_dir_name(self.chain, self.network))
                .join("data")
        })
    }

    pub fn keys_dir(&self) -> PathBuf {
        self.keys_dir_override.clone().unwrap_or_else(|| {
            unzeen_home()
                .join(instance_dir_name(self.chain, self.network))
                .join("keys")
        })
    }

    /// Primary endpoint followed by fallbacks.
    pub fn lwd_urls(&self) -> Vec<String> {
        let mut v = vec![
            self.lightwalletd_url
                .clone()
                .unwrap_or_else(|| self.network.default_lightwalletd().to_string()),
        ];
        match &self.lightwalletd_fallbacks {
            Some(f) => v.extend(f.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())),
            None => v.extend(self.network.default_fallbacks().iter().map(|s| s.to_string())),
        }
        v.dedup();
        v
    }

    /// Create data/keys dirs (0700) and tighten permissions of existing state files.
    pub fn secure_dirs(&self) -> anyhow::Result<()> {
        for d in [self.data_dir(), self.keys_dir()] {
            std::fs::create_dir_all(&d).with_context(|| format!("creating {}", d.display()))?;
            restrict_perms(&d)?;
        }
        let db = self.wallet_db_path();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            restrict_perms(std::path::Path::new(&format!("{}{suffix}", db.display())))?;
        }
        for f in [self.seed_path(), self.seed_age_path()] {
            restrict_perms(&f)?;
        }
        Ok(())
    }

    /// Record the network of a freshly created wallet.
    pub fn write_network_marker(&self) -> anyhow::Result<()> {
        std::fs::write(self.data_dir().join(NETWORK_FILE), self.network.as_str())?;
        Ok(())
    }

    /// Refuse to operate on a wallet created for a different network.
    pub fn check_network_marker(&self) -> anyhow::Result<()> {
        let p = self.data_dir().join(NETWORK_FILE);
        let stored = std::fs::read_to_string(&p)
            .with_context(|| format!("missing {} (wallet created by an older build?)", p.display()))?;
        if stored.trim() != self.network.as_str() {
            bail!(
                "wallet in {} was created for network {:?}, but UNZEEN_NETWORK={}",
                self.data_dir().display(),
                stored.trim(),
                self.network.as_str()
            );
        }
        Ok(())
    }

    /// GAP-9: record which pool instance owns a freshly created wallet.
    pub fn write_chain_marker(&self) -> anyhow::Result<()> {
        std::fs::write(self.data_dir().join(CHAIN_FILE), self.chain.as_str())?;
        Ok(())
    }

    /// GAP-9: refuse a wallet that belongs to the other chain's instance. Testnet wallets from
    /// before the marker are adopted (marker written); mainnet ones must be marked by hand.
    pub fn check_chain_marker(&self) -> anyhow::Result<()> {
        let dir = self.data_dir();
        let stored = std::fs::read_to_string(dir.join(CHAIN_FILE)).ok();
        match chain_check(stored.as_deref(), self.chain, self.network, &dir) {
            ChainCheck::Ok => Ok(()),
            ChainCheck::AdoptLegacy => {
                tracing::warn!(
                    chain = self.chain.as_str(),
                    "wallet had no chain marker; adopted (testnet)"
                );
                self.write_chain_marker()
            }
            ChainCheck::Refuse(msg) => bail!(msg),
        }
    }

    /// GAP-9: one `serve` per wallet. Holds an exclusive flock on `data/serve.lock` until the
    /// returned file is dropped (process exit); a second instance fails at start.
    pub fn lock_serve(&self) -> anyhow::Result<std::fs::File> {
        let p = self.data_dir().join(SERVE_LOCK_FILE);
        let f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&p)
            .with_context(|| format!("opening {}", p.display()))?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: valid fd owned by `f`; LOCK_NB never blocks.
            if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                bail!(
                    "refusing to start: another `serve` already runs on the wallet in {} ({SERVE_LOCK_FILE} is locked)",
                    self.data_dir().display()
                );
            }
        }
        Ok(f)
    }

    pub fn wallet_db_path(&self) -> PathBuf {
        self.data_dir().join(WALLET_DB)
    }

    pub fn seed_path(&self) -> PathBuf {
        self.keys_dir().join(SEED_FILE)
    }

    pub fn seed_age_path(&self) -> PathBuf {
        self.keys_dir().join(SEED_FILE_AGE)
    }

    /// Connect to the first healthy lightwalletd (primary, then fallbacks). A server is
    /// healthy if `GetLightdInfo` answers with this network's chain name.
    pub async fn connect(&self) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        let mut last_err = None;
        for url in self.lwd_urls() {
            match self.connect_one(&url).await {
                Ok(c) => return Ok(c),
                Err(e) => {
                    tracing::warn!(server = %url, error = %format!("{e:#}"), "lightwalletd unavailable, trying next");
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no lightwalletd configured")))
    }

    /// A8: connection for broadcasts: `LIGHTWALLETD_SEND_URL` if set (never falls back to the
    /// scan servers), else the scan servers.
    pub async fn connect_send(&self) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        match self.send_url() {
            Some(url) => self.connect_one(&url).await,
            None => self.connect().await,
        }
    }

    pub fn send_url(&self) -> Option<String> {
        self.lightwalletd_send_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    }

    /// Operator check of any lightwalletd (read-only `GetLightdInfo`).
    pub async fn lightd_info(&self, url: &str) -> anyhow::Result<zcash_client_backend::proto::service::LightdInfo> {
        let mut client = self.connect_raw(url).await?;
        Ok(client
            .get_lightd_info(zcash_client_backend::proto::service::Empty {})
            .await
            .context("GetLightdInfo")?
            .into_inner())
    }

    async fn connect_one(&self, url: &str) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        let mut client = self.connect_raw(url).await?;
        let info = client
            .get_lightd_info(zcash_client_backend::proto::service::Empty {})
            .await
            .context("GetLightdInfo")?
            .into_inner();
        if info.chain_name != self.network.lightd_chain_name() {
            bail!(
                "{url} serves chain {:?}, expected {:?}",
                info.chain_name,
                self.network.lightd_chain_name()
            );
        }
        Ok(client)
    }

    async fn connect_raw(&self, url: &str) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        let uri: tonic::transport::Uri = url
            .parse()
            .with_context(|| format!("invalid LIGHTWALLETD_URL {url:?}"))?;
        let mut ep = Endpoint::from(uri.clone())
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(120));
        match uri.scheme_str() {
            Some("https") => {
                let host = uri.host().context("LIGHTWALLETD_URL has no host")?;
                ep = ep.tls_config(
                    ClientTlsConfig::new()
                        .domain_name(host.to_string())
                        .assume_http2(true)
                        .with_webpki_roots(),
                )?;
            }
            Some("http") => {}
            other => bail!("unsupported scheme {other:?} in LIGHTWALLETD_URL (use http/https)"),
        }
        let channel = ep
            .connect()
            .await
            .with_context(|| format!("connecting to lightwalletd at {url}"))?;
        // Compact block streams can be large.
        Ok(CompactTxStreamerClient::new(channel).max_decoding_message_size(64 * 1024 * 1024))
    }
}

#[cfg(test)]
mod tests {
    //! Offline checks that the pinned pre-release librustzcash line handles BOTH networks
    //! (no network access, no funds).
    use super::NetName;
    use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
    use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkUpgrade, Parameters};

    const SEED: [u8; 32] = [7u8; 32];

    fn ua(net: NetName) -> String {
        let p = net.params();
        let usk = UnifiedSpendingKey::from_seed(&p, &SEED, zip32_account()).unwrap();
        let (ua, _) = usk
            .to_unified_full_viewing_key()
            .default_address(UnifiedAddressRequest::ORCHARD)
            .unwrap();
        assert!(ua.has_orchard() && !ua.has_sapling() && !ua.has_transparent());
        ua.encode(&p)
    }

    fn zip32_account() -> zip32::AccountId {
        zip32::AccountId::ZERO
    }

    #[test]
    fn address_prefixes_per_network() {
        assert!(ua(NetName::Main).starts_with("u1"));
        assert!(ua(NetName::Test).starts_with("utest1"));
    }

    #[test]
    fn branch_ids_current_tips() {
        // Testnet past NU7 activation (4_465_026) must resolve to branch 0x77190AD9.
        let t = NetName::Test.params();
        assert_eq!(
            t.activation_height(NetworkUpgrade::Nu7),
            Some(BlockHeight::from_u32(4_465_026))
        );
        assert_eq!(
            u32::from(BranchId::for_height(&t, BlockHeight::from_u32(4_492_736))),
            0x7719_0ad9
        );
        // Mainnet: no NU7; current heights are NU6.3 (Ironwood).
        let m = NetName::Main.params();
        assert_eq!(m.activation_height(NetworkUpgrade::Nu7), None);
        assert_eq!(
            BranchId::for_height(&m, BlockHeight::from_u32(3_500_000)),
            BranchId::for_height(&m, m.activation_height(NetworkUpgrade::Nu6_3).unwrap())
        );
    }

    #[test]
    fn fallbacks_and_chain_names() {
        assert!(
            NetName::Main
                .default_fallbacks()
                .iter()
                .all(|u| u.starts_with("https://"))
        );
        assert_eq!(NetName::Test.lightd_chain_name(), "test");
        assert_eq!(NetName::Main.lightd_chain_name(), "main");
    }

    #[test]
    fn gap9_default_dirs_differ_per_chain() {
        use super::{ChainName, instance_dir_name};
        assert_eq!(instance_dir_name(ChainName::Solana, NetName::Main), "main");
        assert_eq!(instance_dir_name(ChainName::Solana, NetName::Test), "test");
        assert_eq!(instance_dir_name(ChainName::Hood, NetName::Main), "hood-main");
        assert_eq!(instance_dir_name(ChainName::Hood, NetName::Test), "hood-test");
    }

    #[test]
    fn gap9_chain_marker_rules() {
        use super::{ChainCheck, ChainName, chain_check};
        let d = std::path::Path::new("/w");
        assert_eq!(
            chain_check(Some("solana\n"), ChainName::Solana, NetName::Main, d),
            ChainCheck::Ok
        );
        assert_eq!(
            chain_check(Some("hood"), ChainName::Hood, NetName::Main, d),
            ChainCheck::Ok
        );
        assert!(matches!(
            chain_check(Some("solana"), ChainName::Hood, NetName::Main, d),
            ChainCheck::Refuse(m) if m.contains("\"solana\" pool instance")
        ));
        assert!(matches!(
            chain_check(Some("hood"), ChainName::Solana, NetName::Test, d),
            ChainCheck::Refuse(_)
        ));
        assert_eq!(
            chain_check(None, ChainName::Solana, NetName::Test, d),
            ChainCheck::AdoptLegacy
        );
        assert_eq!(
            chain_check(Some("any"), ChainName::Hood, NetName::Test, d),
            ChainCheck::Ok
        );
        assert!(matches!(
            chain_check(Some("any"), ChainName::Hood, NetName::Main, d),
            ChainCheck::Refuse(_)
        ));
        assert!(matches!(
            chain_check(None, ChainName::Hood, NetName::Main, d),
            ChainCheck::Refuse(_)
        ));
    }

    #[test]
    fn gap9_marker_and_serve_lock_on_disk() {
        use super::{ChainName, Common};
        let dir = std::env::temp_dir().join(format!("unzeen-gap9-{}", rand::random::<u64>()));
        let mk = |chain| Common {
            network: NetName::Main,
            chain,
            lightwalletd_url: None,
            lightwalletd_fallbacks: None,
            lightwalletd_send_url: None,
            data_dir_override: Some(dir.join("data")),
            keys_dir_override: Some(dir.join("keys")),
        };
        let sol = mk(ChainName::Solana);
        let hood = mk(ChainName::Hood);
        sol.secure_dirs().unwrap();
        assert!(sol.check_chain_marker().is_err(), "mainnet without marker is refused");
        sol.write_chain_marker().unwrap();
        sol.check_chain_marker().unwrap();
        let e = hood.check_chain_marker().unwrap_err().to_string();
        assert!(e.contains("belongs to the \"solana\" pool instance"), "{e}");
        let held = sol.lock_serve().unwrap();
        assert!(hood.lock_serve().is_err(), "second serve on the same wallet is refused");
        drop(held);
        hood.lock_serve().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_endpoints() {
        assert_eq!(NetName::Test.default_lightwalletd(), "https://testnet.zec.rocks:443");
        assert_eq!(NetName::Main.default_lightwalletd(), "https://zec.rocks:443");
    }
}

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
}

pub const SEED_FILE: &str = "pool.mnemonic";
pub const WALLET_DB: &str = "wallet.sqlite";
pub const ACCOUNT_NAME: &str = "unzeen-pool";

#[derive(Debug, Clone, Args)]
pub struct Common {
    /// Zcash network: `test` (TAZ) or `main` (real ZEC — only with lead's approval).
    #[arg(long, env = "UNZEEN_NETWORK", value_enum, default_value = "test")]
    pub network: NetName,

    /// lightwalletd gRPC endpoint, e.g. https://testnet.zec.rocks:443 or http://127.0.0.1:9067.
    /// Default: testnet.zec.rocks:443 (test) / zec.rocks:443 (main).
    #[arg(long, env = "LIGHTWALLETD_URL")]
    pub lightwalletd_url: Option<String>,

    /// Directory for wallet state (sqlite). Must not be committed.
    #[arg(long, env = "UNZEEN_DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,

    /// Directory for secret material (seed). Must be git-ignored (`keys/`).
    #[arg(long, env = "UNZEEN_KEYS_DIR", default_value = "./keys")]
    pub keys_dir: PathBuf,
}

impl Common {
    pub fn params(&self) -> Network {
        self.network.params()
    }

    pub fn lwd_url(&self) -> &str {
        self.lightwalletd_url
            .as_deref()
            .unwrap_or_else(|| self.network.default_lightwalletd())
    }

    /// Record the network of a freshly created wallet.
    pub fn write_network_marker(&self) -> anyhow::Result<()> {
        std::fs::write(self.data_dir.join(NETWORK_FILE), self.network.as_str())?;
        Ok(())
    }

    /// Refuse to operate on a wallet created for a different network.
    pub fn check_network_marker(&self) -> anyhow::Result<()> {
        let p = self.data_dir.join(NETWORK_FILE);
        let stored = std::fs::read_to_string(&p)
            .with_context(|| format!("missing {} (wallet created by an older build?)", p.display()))?;
        if stored.trim() != self.network.as_str() {
            bail!(
                "wallet in {} was created for network {:?}, but UNZEEN_NETWORK={}",
                self.data_dir.display(),
                stored.trim(),
                self.network.as_str()
            );
        }
        Ok(())
    }

    pub fn wallet_db_path(&self) -> PathBuf {
        self.data_dir.join(WALLET_DB)
    }

    pub fn seed_path(&self) -> PathBuf {
        self.keys_dir.join(SEED_FILE)
    }

    pub async fn connect(&self) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        let url = self.lwd_url();
        let uri: tonic::transport::Uri =
            url.parse().with_context(|| format!("invalid LIGHTWALLETD_URL {url:?}"))?;
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
        assert_eq!(t.activation_height(NetworkUpgrade::Nu7), Some(BlockHeight::from_u32(4_465_026)));
        assert_eq!(u32::from(BranchId::for_height(&t, BlockHeight::from_u32(4_492_736))), 0x7719_0ad9);
        // Mainnet: no NU7; current heights are NU6.3 (Ironwood).
        let m = NetName::Main.params();
        assert_eq!(m.activation_height(NetworkUpgrade::Nu7), None);
        assert_eq!(
            BranchId::for_height(&m, BlockHeight::from_u32(3_500_000)),
            BranchId::for_height(&m, m.activation_height(NetworkUpgrade::Nu6_3).unwrap())
        );
    }

    #[test]
    fn default_endpoints() {
        assert_eq!(NetName::Test.default_lightwalletd(), "https://testnet.zec.rocks:443");
        assert_eq!(NetName::Main.default_lightwalletd(), "https://zec.rocks:443");
    }
}

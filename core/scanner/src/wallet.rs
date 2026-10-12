//! Pool wallet bootstrap: seed generation, wallet DB, account, address/UFVK output.

use std::io::Write as _;
use std::path::Path;

use anyhow::{Context, anyhow, bail};
use bip0039::{Count, English, Mnemonic};
use rand::{rand_core::UnwrapErr, rngs::SysRng};

/// OS CSPRNG; panics if the OS RNG fails (there is no safe fallback).
#[allow(non_upper_case_globals)]
pub const OsRng: UnwrapErr<SysRng> = UnwrapErr(SysRng);
type OsRngT = UnwrapErr<SysRng>;
use secrecy::{ExposeSecret, SecretVec, Zeroize};
use zcash_client_backend::{
    data_api::{AccountBirthday, WalletRead, WalletWrite},
    proto::service,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::UnifiedAddressRequest;
use zcash_protocol::consensus::{NetworkUpgrade, Parameters};

use crate::config::{ACCOUNT_NAME, Common};

pub type Db = WalletDb<rusqlite::Connection, zcash_protocol::consensus::Network, SystemClock, OsRngT>;

pub fn open_db(common: &Common) -> anyhow::Result<Db> {
    let path = common.wallet_db_path();
    if !path.exists() {
        bail!("wallet DB {} not found — run `init` first", path.display());
    }
    common.check_network_marker()?;
    Ok(WalletDb::for_path(path, common.params(), SystemClock, OsRng)?)
}

pub struct InitOutput {
    pub ua_orchard: String,
    pub ufvk: String,
    pub birthday: u32,
}

pub async fn init(common: &Common, birthday: Option<u32>) -> anyhow::Result<InitOutput> {
    let net = common.params();
    let seed_path = common.seed_path();
    let db_path = common.wallet_db_path();
    if seed_path.exists() || db_path.exists() {
        bail!(
            "refusing to overwrite existing pool wallet ({} / {}). Move them away first.",
            seed_path.display(),
            db_path.display()
        );
    }

    let mut client = common.connect().await?;
    let tip: u32 = client
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner()
        .height
        .try_into()?;

    // A fresh pool wallet cannot have received anything before now; default birthday is
    // slightly below the tip to tolerate small reorgs.
    let sapling = u32::from(net.activation_height(NetworkUpgrade::Sapling).unwrap());
    let bday = birthday.unwrap_or(tip.saturating_sub(10)).max(sapling + 1);
    if bday > tip {
        bail!("birthday {bday} is above chain tip {tip}");
    }

    // Birthday = chain state as of the block *before* the birthday height.
    // NOTE: this request reveals the birthday to the lightwalletd operator (acceptable on testnet;
    // in prod use our own lightwalletd).
    let treestate = client
        .get_tree_state(service::BlockId { height: u64::from(bday - 1), hash: vec![] })
        .await?
        .into_inner();
    let birthday = AccountBirthday::from_treestate(treestate, None)
        .map_err(|e| anyhow!("bad tree state from lightwalletd: {e:?}"))?;

    // Generate the seed and persist it before touching the DB.
    let mnemonic: Mnemonic<English> = Mnemonic::generate(Count::Words24);
    std::fs::create_dir_all(&common.keys_dir)?;
    write_secret_file(&seed_path, mnemonic.phrase().as_bytes())?;

    let seed = {
        let mut s = mnemonic.to_seed("");
        let v = SecretVec::new(s.to_vec());
        s.zeroize();
        v
    };

    std::fs::create_dir_all(&common.data_dir)?;
    common.write_network_marker()?;
    let mut db = WalletDb::for_path(&db_path, net, SystemClock, OsRng)?;
    init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone())))
        .map_err(|e| anyhow!("wallet DB migration failed: {e:?}"))?;
    let (account_id, usk) = db.create_account(ACCOUNT_NAME, &seed, &birthday, None)?;

    let ufvk = usk.to_unified_full_viewing_key();
    let (ua, _) = db
        .get_next_available_address(account_id, UnifiedAddressRequest::ORCHARD)?
        .ok_or_else(|| anyhow!("could not derive an Orchard-only unified address"))?;

    Ok(InitOutput {
        ua_orchard: ua.encode(&net),
        ufvk: ufvk.encode(&net).map_err(|e| anyhow!("UFVK encoding failed: {e:?}"))?,
        birthday: u32::from(birthday.height()),
    })
}

/// Print the pool's Orchard-only UA and UFVK from the existing wallet DB.
pub fn show(common: &Common) -> anyhow::Result<InitOutput> {
    let net = common.params();
    let db = open_db(common)?;
    let (account_id, ufvk) = db
        .get_unified_full_viewing_keys()?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("no account in wallet DB"))?;
    let ua = db
        .get_last_generated_address_matching(account_id, UnifiedAddressRequest::ORCHARD)?
        .ok_or_else(|| anyhow!("no Orchard address generated yet"))?;
    let birthday = db.get_account_birthday(account_id)?;
    Ok(InitOutput {
        ua_orchard: ua.encode(&net),
        ufvk: ufvk.encode(&net).map_err(|e| anyhow!("UFVK encoding failed: {e:?}"))?,
        birthday: u32::from(birthday),
    })
}

fn write_secret_file(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    f.write_all(data)?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    Ok(())
}

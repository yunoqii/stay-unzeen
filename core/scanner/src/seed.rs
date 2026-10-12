//! Pool seed at rest: age-encrypted `keys/pool.mnemonic.age`.
//!
//! Key source (env), first match wins:
//! - `UNZEEN_SEED_KEY_FILE`: path to an age X25519 identity file (`AGE-SECRET-KEY-1...`).
//!   Preferred: keep it outside the repo and away from the ciphertext's backups.
//! - `UNZEEN_SEED_PASSPHRASE`: passphrase (scrypt). Visible in the process env.
//!
//! The plaintext `pool.mnemonic` from day 1 is read only by `seed-encrypt` (migration) or,
//! on testnet, with `UNZEEN_ALLOW_PLAINTEXT_SEED=1`.

use std::io::{Read as _, Write as _};
use std::path::Path;

use age::secrecy::SecretString;
use anyhow::{Context, anyhow, bail};
use zeroize::Zeroizing;

use crate::config::{Common, NetName};

pub enum SeedKey {
    Passphrase(SecretString),
    Identity(Box<age::x25519::Identity>),
}

impl SeedKey {
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        if let Some(p) = std::env::var_os("UNZEEN_SEED_KEY_FILE").filter(|v| !v.is_empty()) {
            let raw = Zeroizing::new(
                std::fs::read_to_string(&p)
                    .with_context(|| format!("reading UNZEEN_SEED_KEY_FILE {}", Path::new(&p).display()))?,
            );
            let line = raw
                .lines()
                .map(str::trim)
                .find(|l| l.starts_with("AGE-SECRET-KEY-"))
                .ok_or_else(|| anyhow!("no AGE-SECRET-KEY in UNZEEN_SEED_KEY_FILE"))?;
            let id: age::x25519::Identity = line.parse().map_err(|e| anyhow!("bad age identity: {e}"))?;
            return Ok(Some(SeedKey::Identity(Box::new(id))));
        }
        if let Ok(p) = std::env::var("UNZEEN_SEED_PASSPHRASE")
            && !p.is_empty()
        {
            return Ok(Some(SeedKey::Passphrase(SecretString::from(p))));
        }
        Ok(None)
    }

    pub fn require() -> anyhow::Result<Self> {
        Self::from_env()?.ok_or_else(|| {
            anyhow!("no seed key: set UNZEEN_SEED_KEY_FILE (age identity file) or UNZEEN_SEED_PASSPHRASE")
        })
    }

    fn encrypt(&self, plain: &[u8]) -> anyhow::Result<Vec<u8>> {
        let enc = match self {
            SeedKey::Passphrase(p) => age::Encryptor::with_user_passphrase(p.clone()),
            SeedKey::Identity(id) => {
                let r = id.to_public();
                age::Encryptor::with_recipients(std::iter::once(&r as &dyn age::Recipient))?
            }
        };
        let mut out = Vec::new();
        let mut w = enc.wrap_output(&mut out)?;
        w.write_all(plain)?;
        w.finish()?;
        Ok(out)
    }

    fn decrypt(&self, ct: &[u8]) -> anyhow::Result<Zeroizing<Vec<u8>>> {
        let dec = age::Decryptor::new(ct)?;
        let mut r = match self {
            SeedKey::Passphrase(p) => {
                let id = age::scrypt::Identity::new(p.clone());
                dec.decrypt(std::iter::once(&id as &dyn age::Identity))
            }
            SeedKey::Identity(id) => dec.decrypt(std::iter::once(id.as_ref() as &dyn age::Identity)),
        }
        .map_err(|e| anyhow!("cannot decrypt seed (wrong key/passphrase?): {e}"))?;
        let mut out = Zeroizing::new(Vec::new());
        r.read_to_end(&mut out)?;
        Ok(out)
    }
}

/// Write the mnemonic encrypted (create_new, 0600). Verifies the round trip.
pub fn write_encrypted(path: &Path, phrase: &str, key: &SeedKey) -> anyhow::Result<()> {
    let ct = key.encrypt(phrase.as_bytes())?;
    if key.decrypt(&ct)?.as_slice() != phrase.as_bytes() {
        bail!("seed encryption round-trip failed");
    }
    write_new_0600(path, &ct)
}

/// Load the pool mnemonic phrase.
pub fn load_phrase(c: &Common) -> anyhow::Result<Zeroizing<String>> {
    let age_path = c.seed_age_path();
    if age_path.exists() {
        let ct = std::fs::read(&age_path).with_context(|| format!("reading {}", age_path.display()))?;
        let plain = SeedKey::require()?.decrypt(&ct)?;
        let s = std::str::from_utf8(&plain).map_err(|_| anyhow!("seed is not UTF-8"))?;
        return Ok(Zeroizing::new(s.trim().to_string()));
    }
    let plain_path = c.seed_path();
    if plain_path.exists() {
        if c.network == NetName::Test && std::env::var("UNZEEN_ALLOW_PLAINTEXT_SEED").as_deref() == Ok("1") {
            tracing::warn!("using PLAINTEXT seed (testnet, UNZEEN_ALLOW_PLAINTEXT_SEED=1); run `seed-encrypt`");
            let s = Zeroizing::new(std::fs::read_to_string(&plain_path)?);
            return Ok(Zeroizing::new(s.trim().to_string()));
        }
        bail!(
            "seed is stored in plaintext at {}; run `seed-encrypt` first",
            plain_path.display()
        );
    }
    bail!("no pool seed in {}", c.keys_dir().display())
}

/// Migrate `pool.mnemonic` -> `pool.mnemonic.age`, then overwrite and delete the plaintext.
pub fn migrate(c: &Common, keep_plaintext: bool) -> anyhow::Result<()> {
    let plain_path = c.seed_path();
    let age_path = c.seed_age_path();
    if age_path.exists() {
        bail!("{} already exists", age_path.display());
    }
    let key = SeedKey::require()?;
    let phrase = Zeroizing::new(
        std::fs::read_to_string(&plain_path).with_context(|| format!("reading {}", plain_path.display()))?,
    );
    let phrase = Zeroizing::new(phrase.trim().to_string());
    <bip0039::Mnemonic<bip0039::English>>::from_phrase(phrase.as_str())
        .map_err(|e| anyhow!("plaintext seed is not a valid mnemonic: {e:?}"))?;
    write_encrypted(&age_path, &phrase, &key)?;
    if !keep_plaintext {
        let len = std::fs::metadata(&plain_path)?.len() as usize;
        let mut f = std::fs::OpenOptions::new().write(true).open(&plain_path)?;
        f.write_all(&vec![0u8; len])?;
        f.sync_all()?;
        drop(f);
        std::fs::remove_file(&plain_path)?;
    }
    Ok(())
}

pub fn write_new_0600(path: &Path, data: &[u8]) -> anyhow::Result<()> {
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
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_identity_and_passphrase() {
        let phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
        let dir = std::env::temp_dir().join(format!("unzeen-seed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, key) in [
            SeedKey::Identity(Box::new(age::x25519::Identity::generate())),
            SeedKey::Passphrase(SecretString::from("correct horse battery staple".to_string())),
        ]
        .into_iter()
        .enumerate()
        {
            let p = dir.join(format!("s{i}.age"));
            let _ = std::fs::remove_file(&p);
            write_encrypted(&p, phrase, &key).unwrap();
            let ct = std::fs::read(&p).unwrap();
            assert!(!ct.windows(7).any(|w| w == b"abandon"));
            assert_eq!(key.decrypt(&ct).unwrap().as_slice(), phrase.as_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        let wrong = SeedKey::Passphrase(SecretString::from("nope".to_string()));
        assert!(wrong.decrypt(&std::fs::read(dir.join("s1.age")).unwrap()).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

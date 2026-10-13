import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAddress, type Address } from "viem";
import { english, generateMnemonic, HDKey, hdKeyToAccount, type HDAccount } from "viem/accounts";
import { PKG_ROOT } from "../env";
import {
  CreatorPubkeyFile,
  ensureDir,
  FileCreatorIndexCounter,
  type CreatorIndexCounter,
} from "../keys";
import { ageCipher, isInside, type SecretCipher } from "../keystore";

/**
 * EVM (secp256k1) keys of the pool for Robinhood Chain.
 *
 * ONE BIP-39 mnemonic (24 words), separate from every Solana secret, stored in
 * its own dir (`$UNZEEN_HOME/hood-<net>/evm`) as `evm-seed.txt`, age-encrypted
 * to `evm-seed.txt.age` exactly like the Solana vaults (src/keystore.ts). The
 * mnemonic is importable into any EVM wallet (recovery). Nothing here logs
 * secrets; scripts print addresses only.
 *
 * BIP-44, coin type 60, one hardened account per role (branch), external chain 0:
 *   m/44'/60'/<branch>'/0/<index>
 *     branch 0 vault      trading vaults (one vault per mint, sharded)
 *     branch 1 creator    fresh address per launch (deployer + creatorFeeRecipient), never reused
 *     branch 2 attest     index 0 = Verify operator key (EIP-712), 1 = fair-launch commitments
 *     branch 3 rebalance  receives ETH from NEAR Intents 1Click
 *     branch 4 funder     funds creator addresses in round amounts (never a vault)
 */

export const EVM_BRANCH = { vault: 0, creator: 1, attest: 2, rebalance: 3, funder: 4 } as const;
export type EvmRole = keyof typeof EVM_BRANCH;

export const ATTEST_INDEX = { verify: 0, fair: 1 } as const;

export function evmPath(role: EvmRole, index: number): `m/44'/60'/${string}` {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new RangeError(`bad index ${index}`);
  return `m/44'/60'/${EVM_BRANCH[role]}'/0/${index}`;
}

const SEED_FILE = "evm-seed.txt";
const WORDS = new Set(english);

/** Validates shape and wordlist membership (BIP-39 checksum is checked by `mnemonicChecksumOk`). */
export function parseMnemonic(text: string): string {
  const words = text.normalize("NFKD").trim().split(/\s+/);
  if (words.length !== 24 && words.length !== 12) throw new Error("EVM seed: expected 12 or 24 BIP-39 words");
  if (!words.every((w) => WORDS.has(w))) throw new Error("EVM seed: word not in the BIP-39 English list");
  if (!mnemonicChecksumOk(words)) throw new Error("EVM seed: bad BIP-39 checksum");
  return words.join(" ");
}

function mnemonicChecksumOk(words: string[]): boolean {
  const index = new Map(english.map((w, i) => [w, i] as const));
  let bits = "";
  for (const w of words) bits += (index.get(w) ?? 0).toString(2).padStart(11, "0");
  const csLen = bits.length / 33;
  const entBits = bits.slice(0, bits.length - csLen);
  const ent = Buffer.alloc(entBits.length / 8);
  for (let i = 0; i < ent.length; i++) ent[i] = Number.parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
  const hash = createHash("sha256").update(ent).digest();
  const cs = hash[0]!.toString(2).padStart(8, "0").slice(0, csLen);
  return cs === bits.slice(bits.length - csLen);
}

/** BIP-39 seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic"), no passphrase. */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return pbkdf2Sync(Buffer.from(mnemonic.normalize("NFKD"), "utf8"), Buffer.from("mnemonic", "utf8"), 2048, 64, "sha512");
}

/**
 * Derives accounts of the pool. Accounts are viem `LocalAccount`s (sign
 * locally, the key never leaves the process). Cached per path.
 */
export class EvmKeyring {
  private readonly master: HDKey;
  private readonly cache = new Map<string, HDAccount>();

  constructor(
    mnemonic: string,
    private readonly counter: CreatorIndexCounter | null = null,
    /** Public list of creator addresses (indexer, T1 rule); null = not recorded. */
    readonly registry: CreatorPubkeyFile | null = null,
  ) {
    this.master = HDKey.fromMasterSeed(mnemonicToSeed(parseMnemonic(mnemonic)));
  }

  account(role: EvmRole, index = 0): HDAccount {
    const p = evmPath(role, index);
    let acc = this.cache.get(p);
    if (!acc) {
      acc = hdKeyToAccount(this.master, { path: p });
      this.cache.set(p, acc);
    }
    return acc;
  }

  vault(index: number): HDAccount {
    return this.account("vault", index);
  }

  funder(index = 0): HDAccount {
    return this.account("funder", index);
  }

  rebalance(index = 0): HDAccount {
    return this.account("rebalance", index);
  }

  attest(purpose: keyof typeof ATTEST_INDEX = "verify"): HDAccount {
    return this.account("attest", ATTEST_INDEX[purpose]);
  }

  /** Creator of launch `index`; recorded in the public creator list BEFORE it is used. */
  creator(index: number): HDAccount {
    const acc = this.account("creator", index);
    this.registry?.record(getAddress(acc.address));
    return acc;
  }

  /** Reserves a never-used creator index (durable before it returns). */
  async allocateCreator(): Promise<number> {
    if (!this.counter) throw new Error("EvmKeyring: no creator index counter");
    return this.counter.next();
  }

  vaultAddresses(count: number): Address[] {
    return Array.from({ length: count }, (_, i) => this.vault(i).address);
  }
}

// ---------------------------------------------------------------------------
// Encrypted storage
// ---------------------------------------------------------------------------

export interface EvmKeyStoreOptions {
  /** null = plaintext (testnet / tests only). */
  cipher: SecretCipher | null;
  /** Refuse to work without a cipher (mainnet). */
  requireEncryption?: boolean;
}

export class EvmKeyStore {
  private constructor(
    readonly dir: string,
    private readonly cipher: SecretCipher | null,
  ) {}

  static open(dir: string, o: EvmKeyStoreOptions): EvmKeyStore {
    if (!o.cipher && o.requireEncryption) {
      throw new Error("EVM keys must be encrypted here: set HOOD_KEYS_AGE_KEY_FILE (or SOLANA_KEYS_AGE_KEY_FILE)");
    }
    ensureDir(dir);
    const files = fs.readdirSync(dir);
    if (!o.cipher && files.includes(`${SEED_FILE}.age`)) {
      throw new Error("EVM seed is age-encrypted: set HOOD_KEYS_AGE_KEY_FILE");
    }
    if (o.cipher && files.includes(SEED_FILE)) {
      throw new Error("plaintext EVM seed next to the cipher; encrypt it first (age -r <recipient>) and shred the plaintext");
    }
    return new EvmKeyStore(dir, o.cipher);
  }

  get encrypted(): boolean {
    return this.cipher !== null;
  }

  private get seedPath(): string {
    return path.join(this.dir, this.cipher ? `${SEED_FILE}.age` : SEED_FILE);
  }

  /** 24-word mnemonic, created on first use (never overwritten). */
  async mnemonic(): Promise<string> {
    if (!fs.existsSync(this.seedPath)) {
      const m = generateMnemonic(english, 256);
      const plain = Buffer.from(`${m}\n`, "utf8");
      const data = this.cipher ? await this.cipher.encrypt(plain) : plain;
      fs.writeFileSync(this.seedPath, data, { mode: 0o600, flag: "wx" });
    }
    const raw = fs.readFileSync(this.seedPath);
    const plain = this.cipher ? Buffer.from(await this.cipher.decrypt(raw)) : raw;
    return parseMnemonic(plain.toString("utf8"));
  }

  /** Keyring with the file creator counter and the public creator list of this dir. */
  async keyring(opts: { counter?: CreatorIndexCounter; registry?: CreatorPubkeyFile | null } = {}): Promise<EvmKeyring> {
    const counter = opts.counter ?? new FileCreatorIndexCounter(path.join(this.dir, "creator-counter.json"));
    const registry = opts.registry !== undefined ? opts.registry : new CreatorPubkeyFile(path.join(this.dir, "creator-addresses.json"));
    return new EvmKeyring(await this.mnemonic(), counter, registry);
  }
}

/**
 * age identity for the EVM keys: HOOD_KEYS_AGE_KEY_FILE / HOOD_KEYS_AGE_KEY,
 * falling back to the Solana identity (SOLANA_KEYS_AGE_KEY_FILE / _KEY): one
 * identity per host is fine as long as it lives outside every key dir.
 */
export async function resolveEvmCipher(keysDir: string, env: NodeJS.ProcessEnv = process.env): Promise<{ cipher: SecretCipher; source: string } | null> {
  for (const [inlineVar, fileVar] of [
    ["HOOD_KEYS_AGE_KEY", "HOOD_KEYS_AGE_KEY_FILE"],
    ["SOLANA_KEYS_AGE_KEY", "SOLANA_KEYS_AGE_KEY_FILE"],
  ] as const) {
    const inline = env[inlineVar]?.trim();
    if (inline) return { cipher: await ageCipher(parseIdentity(inline, inlineVar)), source: inlineVar };
    const fileRaw = env[fileVar]?.trim();
    if (!fileRaw) continue;
    const file = path.resolve(PKG_ROOT, fileRaw.startsWith("~/") ? path.join(process.env.HOME ?? "", fileRaw.slice(1)) : fileRaw);
    if (isInside(file, keysDir)) throw new Error(`${fileVar} must be outside the EVM keys dir`);
    if (!fs.existsSync(file)) throw new Error(`${fileVar} does not exist`);
    if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error(`${fileVar} is readable by group/others; chmod 600 it`);
    return { cipher: await ageCipher(parseIdentity(fs.readFileSync(file, "utf8"), fileVar)), source: fileVar };
  }
  return null;
}

function parseIdentity(text: string, what: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("AGE-SECRET-KEY-1"));
  if (!line) throw new Error(`${what}: no AGE-SECRET-KEY-1… identity found`);
  return line;
}

/** Opens the EVM key store for a network: mainnet requires encryption. */
export async function openEvmKeys(
  keysDir: string,
  network: "mainnet" | "testnet",
  env: NodeJS.ProcessEnv = process.env,
  warn: (m: string) => void = () => undefined,
): Promise<EvmKeyStore> {
  const c = await resolveEvmCipher(keysDir, env);
  if (!c && network === "testnet") warn("EVM keys are NOT encrypted (set HOOD_KEYS_AGE_KEY_FILE)");
  return EvmKeyStore.open(keysDir, { cipher: c?.cipher ?? null, requireEncryption: network === "mainnet" });
}

/** Random bytes32 hex (salts etc.). */
export function randomBytes32(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

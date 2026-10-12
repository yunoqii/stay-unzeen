import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { PKG_ROOT } from "./env";
import { ensureDir } from "./keys";

/**
 * Encrypted storage of the pool's Solana secrets (review-day3 N9).
 *
 * Secrets: `vault-<n>.json` (Solana CLI keypair) and `creator-master.hex`
 * (seed of all per-launch creator addresses). On disk they are
 * `<name>.age`: the same bytes, age-encrypted (X25519) to the identity from
 * SOLANA_KEYS_AGE_KEY_FILE (or SOLANA_KEYS_AGE_KEY). `age -d -i <key> vault-0.json.age`
 * gives back the CLI keypair, so the files stay usable with standard tools.
 *
 * The identity must live OUTSIDE the keys dir (otherwise a copy of the dir is
 * a copy of the keys); `resolveAgeIdentity` refuses that. Public files
 * (alt-*.json lookup tables, creator-counter.json) stay in clear.
 *
 * Nothing here logs secrets or key material.
 */

export const SECRET_RE = /^(vault-\d+\.json|creator-master\.hex)$/;
const VAULT_RE = /^vault-(\d+)\.json(\.age)?$/;
const CREATOR_SEED = "creator-master.hex";

export interface SecretCipher {
  /** Public recipient (age1…), safe to print. */
  readonly recipient: string;
  encrypt(plain: Uint8Array): Promise<Uint8Array>;
  decrypt(cipher: Uint8Array): Promise<Uint8Array>;
}

// age-encryption is ESM-only; this package is CommonJS, so load it lazily.
type AgeModule = typeof import("age-encryption");
let ageMod: Promise<AgeModule> | null = null;
function age(): Promise<AgeModule> {
  ageMod ??= import("age-encryption");
  return ageMod;
}

/** New X25519 age identity (`AGE-SECRET-KEY-1…`), compatible with age / rage CLIs. */
export async function generateAgeIdentity(): Promise<string> {
  return (await age()).generateX25519Identity();
}

export async function ageCipher(identity: string): Promise<SecretCipher> {
  const a = await age();
  const recipient = await a.identityToRecipient(identity);
  return {
    recipient,
    async encrypt(plain) {
      const e = new a.Encrypter();
      e.addRecipient(recipient);
      return e.encrypt(plain);
    },
    async decrypt(data) {
      const d = new a.Decrypter();
      d.addIdentity(identity);
      return d.decrypt(data, "uint8array");
    },
  };
}

export interface ResolvedIdentity {
  identity: string;
  /** Where it came from (variable / file path), never the key itself. */
  source: string;
}

/**
 * Reads the age identity for the Solana keys:
 * - SOLANA_KEYS_AGE_KEY_FILE: identity file (age-keygen format), must be outside `keysDir`
 *   and not readable by group/others;
 * - SOLANA_KEYS_AGE_KEY: the identity itself (e.g. systemd credential / secret manager).
 * Null when neither is set (plaintext mode, devnet only).
 */
export function resolveAgeIdentity(keysDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedIdentity | null {
  const inline = env.SOLANA_KEYS_AGE_KEY?.trim();
  if (inline) return { identity: parseIdentity(inline, "SOLANA_KEYS_AGE_KEY"), source: "SOLANA_KEYS_AGE_KEY" };
  const fileVar = env.SOLANA_KEYS_AGE_KEY_FILE?.trim();
  if (!fileVar) return null;
  const file = path.resolve(PKG_ROOT, expandHome(fileVar));
  if (isInside(file, keysDir)) {
    throw new Error("SOLANA_KEYS_AGE_KEY_FILE must be outside the Solana keys dir");
  }
  if (!fs.existsSync(file)) throw new Error(`SOLANA_KEYS_AGE_KEY_FILE does not exist (create it: pnpm keys:encrypt)`);
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    throw new Error("SOLANA_KEYS_AGE_KEY_FILE is readable by group/others; chmod 600 it");
  }
  return { identity: parseIdentity(fs.readFileSync(file, "utf8"), "SOLANA_KEYS_AGE_KEY_FILE"), source: file };
}

/** Writes a fresh identity file (0600, never overwrites). Returns its public recipient. */
export async function createAgeIdentityFile(file: string, keysDir: string): Promise<string> {
  if (isInside(file, keysDir)) throw new Error("the age identity must be outside the Solana keys dir");
  ensureDir(path.dirname(file));
  const identity = await generateAgeIdentity();
  const recipient = await (await age()).identityToRecipient(identity);
  const body = `# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`;
  fs.writeFileSync(file, body, { mode: 0o600, flag: "wx" });
  return recipient;
}

function parseIdentity(text: string, what: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("AGE-SECRET-KEY-1"));
  if (!line) throw new Error(`${what}: no AGE-SECRET-KEY-1… identity found`);
  return line;
}

export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  return p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;
}

export interface KeyStoreOptions {
  /** null = plaintext files (devnet / tests only). */
  cipher: SecretCipher | null;
  /** Refuse to work without a cipher (mainnet). */
  requireEncryption?: boolean;
}

/**
 * The pool's Solana key directory. With a cipher it only reads/writes
 * `*.age` secrets and refuses to start while plaintext secrets are still
 * there (run the migration first, `pnpm keys:encrypt`).
 */
export class KeyStore {
  private constructor(
    readonly dir: string,
    private readonly cipher: SecretCipher | null,
  ) {}

  static open(dir: string, o: KeyStoreOptions): KeyStore {
    if (!o.cipher && o.requireEncryption) {
      throw new Error("Solana keys must be encrypted here: set SOLANA_KEYS_AGE_KEY_FILE (see pnpm keys:encrypt)");
    }
    ensureDir(dir);
    const ks = new KeyStore(dir, o.cipher);
    if (!o.cipher && fs.readdirSync(dir).some((f) => f.endsWith(".age"))) {
      // Never fall back to plaintext here: ensureVaults would mint NEW keys.
      throw new Error("Solana keys are age-encrypted: set SOLANA_KEYS_AGE_KEY_FILE");
    }
    if (o.cipher) {
      const plain = ks.plaintextSecrets();
      if (plain.length > 0) {
        throw new Error(`${plain.length} plaintext secret file(s) in the keys dir; run pnpm keys:encrypt first`);
      }
    }
    return ks;
  }

  /** Store for `migrate()` only: accepts plaintext secrets next to the cipher. */
  static forMigration(dir: string, cipher: SecretCipher): KeyStore {
    ensureDir(dir);
    return new KeyStore(dir, cipher);
  }

  get encrypted(): boolean {
    return this.cipher !== null;
  }

  /** Plaintext secret files present in the dir (names only). */
  plaintextSecrets(): string[] {
    return fs.readdirSync(this.dir).filter((f) => SECRET_RE.test(f));
  }

  /** All vaults ordered by index. */
  async vaults(): Promise<Keypair[]> {
    const ext = this.cipher ? ".age" : "";
    const files = fs
      .readdirSync(this.dir)
      .map((f) => ({ f, m: VAULT_RE.exec(f) }))
      .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null && (x.m[2] ?? "") === ext)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
    const out: Keypair[] = [];
    for (const x of files) out.push(parseKeypair(await this.readSecret(x.f.replace(/\.age$/, "")), x.f));
    return out;
  }

  /** Creates vault-0..vault-(count-1) that do not exist yet. Returns all vaults. */
  async ensureVaults(count: number): Promise<Keypair[]> {
    for (let i = 0; i < count; i++) {
      const name = `vault-${i}.json`;
      if (!this.hasSecret(name)) await this.writeSecret(name, Buffer.from(JSON.stringify(Array.from(Keypair.generate().secretKey))));
    }
    return this.vaults();
  }

  /** 64-byte creator master seed (created on first use). */
  async creatorSeed(): Promise<Buffer> {
    if (!this.hasSecret(CREATOR_SEED)) await this.writeSecret(CREATOR_SEED, Buffer.from(randomBytes(64).toString("hex")));
    const seed = Buffer.from((await this.readSecret(CREATOR_SEED)).toString("utf8").trim(), "hex");
    if (seed.length !== 64) throw new Error(`${CREATOR_SEED}: expected 64 bytes hex`);
    return seed;
  }

  /**
   * Encrypts every plaintext secret in place, without loss:
   * write `<name>.age.tmp` -> decrypt and compare -> rename to `<name>.age`
   * -> overwrite the plaintext with random bytes -> unlink. Re-running after a
   * crash is safe (an existing `.age` is verified against the plaintext).
   */
  async migrate(): Promise<{ encrypted: string[] }> {
    if (!this.cipher) throw new Error("no cipher configured");
    const done: string[] = [];
    for (const name of this.plaintextSecrets()) {
      const file = path.join(this.dir, name);
      const plain = fs.readFileSync(file);
      const target = `${file}.age`;
      if (fs.existsSync(target)) {
        const existing = Buffer.from(await this.cipher.decrypt(fs.readFileSync(target)));
        if (!existing.equals(plain)) throw new Error(`${name}: both plaintext and a different .age exist; resolve by hand`);
      } else {
        const tmp = `${target}.tmp`;
        const enc = await this.cipher.encrypt(plain);
        writeDurable(tmp, enc);
        const back = Buffer.from(await this.cipher.decrypt(fs.readFileSync(tmp)));
        if (!back.equals(plain)) {
          fs.unlinkSync(tmp);
          throw new Error(`${name}: encryption round-trip mismatch`);
        }
        fs.renameSync(tmp, target);
        fsyncDir(this.dir);
      }
      shred(file, plain.length);
      done.push(name);
    }
    return { encrypted: done };
  }

  private hasSecret(name: string): boolean {
    return fs.existsSync(path.join(this.dir, this.cipher ? `${name}.age` : name));
  }

  private async readSecret(name: string): Promise<Buffer> {
    if (!this.cipher) return fs.readFileSync(path.join(this.dir, name));
    return Buffer.from(await this.cipher.decrypt(fs.readFileSync(path.join(this.dir, `${name}.age`))));
  }

  private async writeSecret(name: string, plain: Buffer): Promise<void> {
    const file = path.join(this.dir, this.cipher ? `${name}.age` : name);
    const data = this.cipher ? await this.cipher.encrypt(plain) : plain;
    fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
  }
}

function parseKeypair(buf: Buffer, file: string): Keypair {
  const raw: unknown = JSON.parse(buf.toString("utf8"));
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    throw new Error(`${file}: expected a 64-byte JSON array (Solana CLI keypair)`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

function writeDurable(file: string, data: Uint8Array): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // not supported on every platform; rename is still atomic
  }
}

/**
 * Best effort: overwrite with random bytes, then unlink. On SSD/APFS
 * (copy-on-write, snapshots) old blocks may survive; the real protection is
 * the encrypted volume (ARCHITECTURE "Зашифрованный том").
 */
function shred(file: string, len: number): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.writeSync(fd, randomBytes(Math.max(len, 1)), 0, Math.max(len, 1), 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(file);
}

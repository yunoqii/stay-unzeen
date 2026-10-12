import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Key storage for the pool. Everything lives in `keysDir` (gitignored,
 * files are 0600). Nothing here logs secrets.
 *
 * - vault-<n>.json: trading vault keypairs, Solana CLI format (64-byte array).
 * - creator-master.hex: 64-byte seed for per-launch creator addresses.
 * - creator-counter.json: next unused creator index (no mapping to users).
 */

const VAULT_RE = /^vault-(\d+)\.json$/;

/** Creates the key dir and forces 0700 (mkdir's mode only applies on creation). */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function writeSecret(file: string, data: string): void {
  fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
}

export function readKeypairFile(file: string): Keypair {
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    throw new Error(`${path.basename(file)}: expected a 64-byte JSON array (Solana CLI keypair)`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

/** Creates vault-0..vault-(count-1) that do not exist yet. Returns all vaults. */
export function ensureVaults(keysDir: string, count: number): Keypair[] {
  ensureDir(keysDir);
  for (let i = 0; i < count; i++) {
    const file = path.join(keysDir, `vault-${i}.json`);
    if (!fs.existsSync(file)) {
      writeSecret(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
    }
  }
  return loadVaults(keysDir);
}

/** Loads all vault-<n>.json, ordered by n. */
export function loadVaults(keysDir: string): Keypair[] {
  if (!fs.existsSync(keysDir)) return [];
  return fs
    .readdirSync(keysDir)
    .map((f) => ({ f, m: VAULT_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => readKeypairFile(path.join(keysDir, x.f)));
}

// ---------------------------------------------------------------------------
// SLIP-0010 ed25519 (hardened only), Solana path m/44'/501'/<index>'/0'.
// ---------------------------------------------------------------------------

const HARDENED = 0x80000000;

export function slip10Master(seed: Uint8Array): { key: Buffer; chainCode: Buffer } {
  const I = createHmac("sha512", "ed25519 seed").update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

export function slip10Child(
  parent: { key: Buffer; chainCode: Buffer },
  index: number,
): { key: Buffer; chainCode: Buffer } {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new RangeError(`bad index ${index}`);
  const data = Buffer.alloc(37);
  data[0] = 0;
  parent.key.copy(data, 1);
  data.writeUInt32BE(index + HARDENED, 33);
  const I = createHmac("sha512", parent.chainCode).update(data).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

export function slip10DerivePath(seed: Uint8Array, hardenedPath: readonly number[]): Buffer {
  let node = slip10Master(seed);
  for (const i of hardenedPath) node = slip10Child(node, i);
  return node.key;
}

export function deriveCreatorKeypair(masterSeed: Uint8Array, index: number): Keypair {
  return Keypair.fromSeed(slip10DerivePath(masterSeed, [44, 501, index, 0]));
}

/**
 * Source of never-reused creator HD indexes. Behind an interface so the
 * counter can move to Postgres (a sequence) without touching the adapter.
 * Must be atomic across processes: two launches never get the same index.
 * Stores no mapping to users or tokens.
 */
export interface CreatorIndexCounter {
  /** Reserves and returns the next unused index (durable before it returns). */
  next(): Promise<number>;
}

/** Single-process file counter (`creator-counter.json`, 0600, atomic rename). */
export class FileCreatorIndexCounter implements CreatorIndexCounter {
  constructor(private readonly file: string) {}

  async next(): Promise<number> {
    let next = 0;
    if (fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as { next?: unknown };
      if (typeof parsed.next === "number" && Number.isInteger(parsed.next) && parsed.next >= 0) next = parsed.next;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ next: next + 1 }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return next;
  }
}

/** In-memory counter for tests and dry runs. */
export class MemoryCreatorIndexCounter implements CreatorIndexCounter {
  constructor(private value = 0) {}
  async next(): Promise<number> {
    return this.value++;
  }
}

/**
 * Fresh creator address per launch. The creator is public on chain
 * (pump.fun `creator`), so it must never be a user's wallet and never be
 * reused between launches. Fees accrue to it; the key is re-derivable from
 * the master seed + index to collect them later.
 */
export class CreatorKeyring {
  private readonly seed: Buffer;
  private readonly counter: CreatorIndexCounter;

  constructor(keysDir: string, counter?: CreatorIndexCounter) {
    ensureDir(keysDir);
    const seedFile = path.join(keysDir, "creator-master.hex");
    if (!fs.existsSync(seedFile)) writeSecret(seedFile, randomBytes(64).toString("hex"));
    this.seed = Buffer.from(fs.readFileSync(seedFile, "utf8").trim(), "hex");
    if (this.seed.length !== 64) throw new Error("creator-master.hex: expected 64 bytes hex");
    this.counter = counter ?? new FileCreatorIndexCounter(path.join(keysDir, "creator-counter.json"));
  }

  /** Reserves the next unused index (persisted before it is returned). */
  allocate(): Promise<number> {
    return this.counter.next();
  }

  keypair(index: number): Keypair {
    return deriveCreatorKeypair(this.seed, index);
  }

  publicKey(index: number): PublicKey {
    return this.keypair(index).publicKey;
  }
}

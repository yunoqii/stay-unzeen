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

/**
 * Legacy plaintext helpers must never run on an encrypted dir: they would
 * create NEW plaintext keys next to the encrypted ones (lost funds, split pool).
 */
function refuseEncrypted(keysDir: string): void {
  if (fs.existsSync(keysDir) && fs.readdirSync(keysDir).some((f) => f.endsWith(".age"))) {
    throw new Error("keys dir is age-encrypted: use KeyStore (src/keystore.ts)");
  }
}

/** Creates vault-0..vault-(count-1) that do not exist yet. Returns all vaults. */
export function ensureVaults(keysDir: string, count: number): Keypair[] {
  refuseEncrypted(keysDir);
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
  refuseEncrypted(keysDir);
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

/**
 * File counter (`creator-counter.json`, 0600, atomic rename) guarded by an
 * exclusive lock file, so two relayer processes on one host never get the
 * same index (review-day3 L-10). Several hosts: use the Postgres counter.
 */
export class FileCreatorIndexCounter implements CreatorIndexCounter {
  constructor(
    private readonly file: string,
    private readonly lockTimeoutMs = 10_000,
  ) {}

  /** Current next value without reserving it (migration to Postgres). */
  peek(): number {
    if (!fs.existsSync(this.file)) return 0;
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as { next?: unknown };
    return typeof parsed.next === "number" && Number.isInteger(parsed.next) && parsed.next >= 0 ? parsed.next : 0;
  }

  async next(): Promise<number> {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lock, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Stale lock of a crashed process (older than the timeout): take it over.
        const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
        if (age > this.lockTimeoutMs) fs.rmSync(lock, { force: true });
        else if (Date.now() > deadline) throw new Error("creator counter is locked by another process");
        else await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      const next = this.peek();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ next: next + 1 }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return next;
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
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
 *
 * `new CreatorKeyring(seed, counter)` with a seed from the (encrypted)
 * KeyStore; `new CreatorKeyring(keysDir)` = legacy plaintext dir (tests, dev).
 */
/**
 * PUBLIC list of creator addresses of pool launches (`creator-pubkeys.json`
 * in the keys dir, 0644 inside the 0700 dir). Written when an address is
 * derived, i.e. BEFORE the create transaction is signed, so the token
 * indexer recognizes an Unzeen launch even before the relayer records the
 * create in `trades` (T1 race, docs/INTEL.md rule 7). Only public keys: the
 * indexer never gets the creator master seed (it would let it derive the
 * private keys that collect creator fees). Creator addresses are public on
 * chain anyway (pump.fun `creator`); the file maps nothing to users.
 */
export class CreatorPubkeyFile {
  private cache: Set<string> | null = null;
  constructor(readonly file: string) {}

  static inDir(keysDir: string): CreatorPubkeyFile {
    return new CreatorPubkeyFile(path.join(keysDir, "creator-pubkeys.json"));
  }

  read(): Set<string> {
    if (!fs.existsSync(this.file)) return new Set();
    const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as { pubkeys?: unknown };
    return new Set(Array.isArray(j.pubkeys) ? j.pubkeys.filter((x): x is string => typeof x === "string") : []);
  }

  /** Adds addresses (atomic rename). Sync: called right before signing a create. */
  record(...pubkeys: string[]): void {
    const cur = this.cache ?? this.read();
    const before = cur.size;
    for (const k of pubkeys) cur.add(k);
    this.cache = cur;
    if (cur.size === before && fs.existsSync(this.file)) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pubkeys: [...cur].sort() }), { mode: 0o644 });
    fs.renameSync(tmp, this.file);
  }
}

export class CreatorKeyring {
  private readonly seed: Buffer;
  private readonly counter: CreatorIndexCounter;
  /** Public creator list for the indexer (T1); null = not recorded (tests). */
  readonly registry: CreatorPubkeyFile | null;

  constructor(keysDirOrSeed: string | Uint8Array, counter?: CreatorIndexCounter, registry?: CreatorPubkeyFile | null) {
    if (typeof keysDirOrSeed === "string") {
      const keysDir = keysDirOrSeed;
      refuseEncrypted(keysDir);
      ensureDir(keysDir);
      const seedFile = path.join(keysDir, "creator-master.hex");
      if (!fs.existsSync(seedFile)) writeSecret(seedFile, randomBytes(64).toString("hex"));
      this.seed = Buffer.from(fs.readFileSync(seedFile, "utf8").trim(), "hex");
      this.counter = counter ?? new FileCreatorIndexCounter(path.join(keysDir, "creator-counter.json"));
    } else {
      if (!counter) throw new Error("CreatorKeyring: an index counter is required with an explicit seed");
      this.seed = Buffer.from(keysDirOrSeed);
      this.counter = counter;
    }
    if (this.seed.length !== 64) throw new Error("creator master seed: expected 64 bytes");
    this.registry =
      registry !== undefined ? registry : typeof keysDirOrSeed === "string" ? CreatorPubkeyFile.inDir(keysDirOrSeed) : null;
  }

  /** Reserves the next unused index (persisted before it is returned). */
  allocate(): Promise<number> {
    return this.counter.next();
  }

  keypair(index: number): Keypair {
    return deriveCreatorKeypair(this.seed, index);
  }

  /** Derives the creator address; records it in the public list BEFORE it is used in a create. */
  publicKey(index: number): PublicKey {
    const pk = this.keypair(index).publicKey;
    this.registry?.record(pk.toBase58());
    return pk;
  }
}

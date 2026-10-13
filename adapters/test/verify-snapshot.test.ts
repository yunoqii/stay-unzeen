import { randomBytes } from "node:crypto";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attestSigMessage, signDetached, verifyDetached, verifyVaultMessage } from "../src/ed25519";
import { loadRepoEnv } from "../src/env";
import type { Attester } from "../src/attest";
import { AttestExecutor } from "../src/relayer/executors";
import { PostgresJobQueue, rowToSpec } from "../src/relayer/postgres-queue";
import { ATTEST_PATH, FAIR_ATTEST_PATH, deriveAttestKeypair } from "../src/attest";
import {
  GMA_LIMIT,
  MinSlotNotReachedError,
  PgVerifySnapshotStore,
  SlotMismatchError,
  VaultSnapshotter,
  collectVaultSnapshot,
  readAtLeast,
  readOnOneSlot,
  tokenAmountOf,
  verifyFrozen,
  type FinalizedReader,
  type SlotAccounts,
} from "../src/relayer/verify-snapshot";

const ROOT = "ab".repeat(32);

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function sysAccount(lamports: number): AccountInfo<Buffer> {
  return { lamports, owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false, rentEpoch: 0 };
}

function tokenAccount(program: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint, state = 1): AccountInfo<Buffer> {
  const d = Buffer.alloc(program.equals(TOKEN_2022_PROGRAM_ID) ? 170 : 165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = state;
  return { lamports: 2_039_280, owner: program, data: d, executable: false, rentEpoch: 0 };
}

class FakeReader implements FinalizedReader {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly mintOwners = new Map<string, PublicKey>();
  /** Slot answered per call (cycled); default constant 100. */
  slots: number[] = [100];
  calls = 0;
  pins: (number | undefined)[] = [];
  async read(keys: readonly PublicKey[], minContextSlot?: number): Promise<SlotAccounts> {
    if (keys.length > GMA_LIMIT) throw new Error("too many keys");
    this.pins.push(minContextSlot);
    const slot = Math.max(this.slots[this.calls++ % this.slots.length]!, minContextSlot ?? 0);
    return { slot, accounts: keys.map((k) => this.accounts.get(k.toBase58()) ?? null) };
  }
  async owners(keys: readonly PublicKey[]): Promise<(PublicKey | null)[]> {
    return keys.map((k) => this.mintOwners.get(k.toBase58()) ?? null);
  }
}

// ---------------------------------------------------------------------------

describe("ed25519 detached signatures", () => {
  it("vault message format and signature verify against the Solana address", () => {
    const kp = Keypair.generate();
    const a = kp.publicKey.toBase58();
    const msg = verifyVaultMessage("0202", 7, a);
    expect(msg.toString("utf8")).toBe(`unzeen/verify/v1/vault\n0202\n7\n${a}`);
    const sig = signDetached(kp, msg);
    expect(verifyDetached(a, msg, sig)).toBe(true);
    expect(verifyDetached(a, verifyVaultMessage("0202", 8, a), sig)).toBe(false);
    expect(verifyDetached(Keypair.generate().publicKey.toBase58(), msg, sig)).toBe(false);
    expect(verifyDetached(a, msg, "notbase58!")).toBe(false);
  });
  it("Solana's own ed25519 (Keypair.secretKey) agrees: signing is deterministic", () => {
    const kp = Keypair.fromSeed(new Uint8Array(32).fill(7));
    const m = attestSigMessage(ROOT);
    expect(m.length).toBe(32);
    expect(signDetached(kp, m)).toBe(signDetached(kp, m));
  });
  it("attest message: exactly 32 bytes of the 64-hex memo", () => {
    expect(attestSigMessage(ROOT).equals(Buffer.alloc(32, 0xab))).toBe(true);
    expect(() => attestSigMessage("AB".repeat(32))).toThrow();
    expect(() => attestSigMessage("ab")).toThrow();
  });
});

describe("AttestExecutor out_sig", () => {
  it("signs hex_decode(job memo) with the attestation key, independent of the chain memo", async () => {
    const key = Keypair.generate();
    const fake = {
      key,
      result: async (signature: string) => ({ signature, slot: 5, signer: key.publicKey.toBase58(), memo: ROOT, networkFee: 5000n, blockTime: 1 }),
    } as unknown as Attester;
    const ex = new AttestExecutor(fake);
    const r = await ex.result({ kind: "attest", memo: ROOT, purpose: "fair" }, { signature: "s", lastValidBlockHeight: 1, vault: key.publicKey.toBase58(), sentAt: 0 });
    expect(r?.kind).toBe("attest");
    if (r?.kind !== "attest") throw new Error();
    expect(verifyDetached(key.publicKey.toBase58(), Buffer.alloc(32, 0xab), r.outSig!)).toBe(true);
    expect(r.blockTime).toBe(1);
  });

  it("F2: no blockTime yet -> not readable (re-read later, never confirmed without out_block_time)", async () => {
    const key = Keypair.generate();
    const fake = {
      key,
      result: async (signature: string) => ({ signature, slot: 5, signer: key.publicKey.toBase58(), memo: ROOT, networkFee: 5000n, blockTime: null }),
    } as unknown as Attester;
    const r = await new AttestExecutor(fake).result({ kind: "attest", memo: ROOT, purpose: "fair" }, { signature: "s", lastValidBlockHeight: 1, vault: key.publicKey.toBase58(), sentAt: 0 });
    expect(r).toBeNull();
  });
});

describe("F14: two attestation keys", () => {
  const seed = new Uint8Array(64).fill(3);
  it("distinct HD paths; meta.purpose picks the key; no marker -> fair key", async () => {
    expect(ATTEST_PATH).toEqual([44, 501, 0x7ffffffd, 2]);
    expect(FAIR_ATTEST_PATH).toEqual([44, 501, 0x7ffffffd, 3]);
    const v = deriveAttestKeypair(seed, "verify");
    const f = deriveAttestKeypair(seed, "fair");
    expect(v.publicKey.equals(f.publicKey)).toBe(false);
    expect(deriveAttestKeypair(seed).publicKey.equals(v.publicKey)).toBe(true);
    const row = (meta: unknown) => ({
      id: "1", part: 0, op: "attest", venue: null, mint: null, lamports_in: null, token_amount: null, min_out: null, meta, dest: null,
      gas_lamports: null, network: "devnet", attempts: 1, status: "claimed", signature: null, last_valid_block_height: null, vault: null,
      sent_at_ms: null, not_before_ms: "0",
    });
    expect(rowToSpec(row({ memo: ROOT, purpose: "verify" }), "devnet")).toEqual({ kind: "attest", memo: ROOT, purpose: "verify" });
    expect(rowToSpec(row({ memo: ROOT, purpose: "fair" }), "devnet")).toEqual({ kind: "attest", memo: ROOT, purpose: "fair" });
    expect(rowToSpec(row({ memo: ROOT }), "devnet")).toEqual({ kind: "attest", memo: ROOT, purpose: "fair" });
    expect(() => rowToSpec(row({ memo: ROOT, purpose: "x" }), "devnet")).toThrow(/purpose/);

    const fake = (key: Keypair) =>
      ({ key, result: async (signature: string) => ({ signature, slot: 5, signer: key.publicKey.toBase58(), memo: ROOT, networkFee: 0n, blockTime: 9 }) }) as unknown as Attester;
    const ex = new AttestExecutor({ verify: fake(v), fair: fake(f) });
    expect(ex.ownSigner({ kind: "attest", memo: ROOT, purpose: "verify" }).publicKey.equals(v.publicKey)).toBe(true);
    expect(ex.ownSigner({ kind: "attest", memo: ROOT, purpose: "fair" }).publicKey.equals(f.publicKey)).toBe(true);
    const r = await ex.result({ kind: "attest", memo: ROOT, purpose: "verify" }, { signature: "s", lastValidBlockHeight: 1, vault: "x", sentAt: 0 });
    if (r?.kind !== "attest") throw new Error();
    expect(r.blockTime).toBe(9);
    expect(verifyDetached(v.publicKey.toBase58(), Buffer.alloc(32, 0xab), r.outSig!)).toBe(true);
    expect(verifyDetached(f.publicKey.toBase58(), Buffer.alloc(32, 0xab), r.outSig!)).toBe(false);
  });
});

describe("readOnOneSlot", () => {
  const keys = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);
  it("one chunk: one call, its slot", async () => {
    const r = new FakeReader();
    const out = await readOnOneSlot(r, keys(10));
    expect(out.slot).toBe(100);
    expect(out.accounts).toHaveLength(10);
    expect(r.calls).toBe(1);
  });
  it("several chunks on different slots: re-read pinned to the highest slot", async () => {
    const r = new FakeReader();
    r.slots = [100, 101, 102]; // first round: 100, 101, 102 -> mismatch; second round pinned to 102
    const out = await readOnOneSlot(r, keys(250));
    expect(out.slot).toBe(102);
    expect(out.accounts).toHaveLength(250);
    expect(r.pins.slice(3)).toEqual([102, 102, 102]);
  });
  it("never consistent: throws instead of mixing slots", async () => {
    const r = new FakeReader();
    let s = 0;
    r.read = async (k) => ({ slot: s++, accounts: k.map(() => null) });
    await expect(readOnOneSlot(r, keys(150), 3)).rejects.toBeInstanceOf(SlotMismatchError);
  });
});

describe("token account parsing", () => {
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  it("amount only for the right program, mint, owner and an initialized account", () => {
    expect(tokenAmountOf(tokenAccount(TOKEN_PROGRAM_ID, mint, owner, 5n), TOKEN_PROGRAM_ID, mint, owner)).toBe(5n);
    expect(tokenAmountOf(tokenAccount(TOKEN_2022_PROGRAM_ID, mint, owner, 6n), TOKEN_2022_PROGRAM_ID, mint, owner)).toBe(6n);
    expect(tokenAmountOf(tokenAccount(TOKEN_PROGRAM_ID, mint, owner, 5n), TOKEN_2022_PROGRAM_ID, mint, owner)).toBe(0n);
    expect(tokenAmountOf(tokenAccount(TOKEN_PROGRAM_ID, mint, owner, 5n), TOKEN_PROGRAM_ID, owner, owner)).toBe(0n);
    expect(tokenAmountOf(tokenAccount(TOKEN_PROGRAM_ID, mint, mint, 5n), TOKEN_PROGRAM_ID, mint, owner)).toBe(0n);
    expect(tokenAmountOf(tokenAccount(TOKEN_PROGRAM_ID, mint, owner, 5n, 0), TOKEN_PROGRAM_ID, mint, owner)).toBe(0n);
    expect(tokenAmountOf(tokenAccount(TOKEN_PROGRAM_ID, mint, owner, 5n, 2), TOKEN_PROGRAM_ID, mint, owner)).toBe(5n); // frozen still held
    expect(tokenAmountOf(null, TOKEN_PROGRAM_ID, mint, owner)).toBe(0n);
  });
});

describe("collectVaultSnapshot", () => {
  it("vaults/attest/partner always, creators only when they hold something; signed; one slot", async () => {
    const r = new FakeReader();
    const [v1, v2, att, partner, c0, c1] = Array.from({ length: 6 }, () => Keypair.generate());
    const m1 = Keypair.generate().publicKey; // spl-token
    const m2 = Keypair.generate().publicKey; // token-2022
    const ghost = Keypair.generate().publicKey; // no account
    r.mintOwners.set(m1.toBase58(), TOKEN_PROGRAM_ID);
    r.mintOwners.set(m2.toBase58(), TOKEN_2022_PROGRAM_ID);
    r.accounts.set(v1!.publicKey.toBase58(), sysAccount(5_000_000));
    r.accounts.set(c1!.publicKey.toBase58(), sysAccount(1));
    const ata = (m: PublicKey, o: PublicKey, p: PublicKey) => getAssociatedTokenAddressSync(m, o, true, p).toBase58();
    r.accounts.set(ata(m1, v1!.publicKey, TOKEN_PROGRAM_ID), tokenAccount(TOKEN_PROGRAM_ID, m1, v1!.publicKey, 1_000n));
    r.accounts.set(ata(m2, v2!.publicKey, TOKEN_2022_PROGRAM_ID), tokenAccount(TOKEN_2022_PROGRAM_ID, m2, v2!.publicKey, 42n));
    r.accounts.set(ata(m1, v2!.publicKey, TOKEN_PROGRAM_ID), tokenAccount(TOKEN_PROGRAM_ID, m1, v2!.publicKey, 0n));

    const snap = await collectVaultSnapshot(
      r,
      { id: 3, chainId: "0202" },
      [
        { key: v1!, always: true },
        { key: v2!, always: true },
        { key: v1!, always: false }, // duplicate: kept once, "always" wins
        { key: att!, always: true },
        { key: partner!, always: true },
        { key: c0!, always: false },
        { key: c1!, always: false },
      ],
      [m1.toBase58(), m2.toBase58(), ghost.toBase58(), m1.toBase58()],
    );
    expect(snap.slot).toBe(100);
    expect(snap.unknownMints).toBe(1);
    const addrs = snap.vaults.map((v) => v.address);
    expect(addrs).toEqual([...addrs].sort());
    expect(new Set(addrs)).toEqual(new Set([v1, v2, att, partner, c1].map((k) => k!.publicKey.toBase58())));
    const byAddr = new Map(snap.vaults.map((v) => [v.address, v]));
    expect(byAddr.get(v1!.publicKey.toBase58())).toMatchObject({ lamports: 5_000_000n, tokens: [{ mint: m1.toBase58(), amount: "1000" }] });
    expect(byAddr.get(v2!.publicKey.toBase58())).toMatchObject({ lamports: 0n, tokens: [{ mint: m2.toBase58(), amount: "42" }] });
    expect(byAddr.get(att!.publicKey.toBase58())!.tokens).toEqual([]);
    for (const v of snap.vaults) expect(verifyDetached(v.address, verifyVaultMessage("0202", 3, v.address), v.sig)).toBe(true);
  });
  it("refuses a malformed chain id", async () => {
    await expect(collectVaultSnapshot(new FakeReader(), { id: 1, chainId: "zz" }, [], [])).rejects.toThrow(/chain/);
  });
});

/** A finalized RPC that is `lag` ms behind: slot = finalizedAt(now); minContextSlot above it -> -32016. */
class LaggingReader extends FakeReader {
  constructor(private readonly finalized: () => number, private readonly ignorePin = false) {
    super();
  }
  override async read(keys: readonly PublicKey[], minContextSlot?: number): Promise<SlotAccounts> {
    this.pins.push(minContextSlot);
    const slot = this.finalized();
    if (!this.ignorePin && minContextSlot !== undefined && slot < minContextSlot) {
      throw new Error("failed to get info about account: Minimum context slot has not been reached (-32016)");
    }
    return { slot, accounts: keys.map((k) => this.accounts.get(k.toBase58()) ?? null) };
  }
}

describe("E2: snapshot read pinned to min_slot", () => {
  const keys = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);
  it("waits until finalized reaches min_slot, then reads at >= min_slot", async () => {
    let now = 0;
    const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
    const r = new LaggingReader(() => 1_000 + Math.floor(now / 400)); // +1 slot / 400 ms
    const out = await readAtLeast(r, keys(3), 1_020, 120_000, clock);
    expect(out.slot).toBeGreaterThanOrEqual(1_020);
    expect(r.pins.every((p) => p !== undefined && p >= 1_020)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(8_000); // ~20 slots of finality lag
  });
  it("an RPC that ignores minContextSlot is not trusted with an older slot", async () => {
    await expect(readOnOneSlot(new LaggingReader(() => 900, true), keys(2), 6, 1_000)).rejects.toBeInstanceOf(MinSlotNotReachedError);
  });
  it("never past the freeze: snapshotter reports late and writes nothing", async () => {
    let now = 1_000;
    const writes: number[] = [];
    const s = new VaultSnapshotter({
      store: { pending: async () => ({ id: 4, chainId: "0202", freezeUntil: 6_000, minSlot: 5_000 }), write: async (id) => (writes.push(id), true) },
      reader: new LaggingReader(() => 100),
      signers: async () => [{ key: Keypair.generate(), always: true }],
      mints: { mints: async () => [] },
      now: () => now,
      sleep: async (ms) => void (now += ms),
    });
    expect(await s.tick()).toBe("late");
    expect(writes).toEqual([]);
    expect(now).toBeLessThan(6_000);
  });
  it("without min_slot (core before the column) the read is unpinned as before", async () => {
    const r = new FakeReader();
    const snap = await collectVaultSnapshot(r, { id: 1, chainId: "0202" }, [{ key: Keypair.generate(), always: true }], []);
    expect(snap.slot).toBe(100);
    expect(r.pins).toEqual([undefined]);
  });
});

describe("VaultSnapshotter", () => {
  it("idle without a pending snapshot; late when the freeze ended while reading", async () => {
    const writes: number[] = [];
    let now = 1_000;
    let pending: { id: number; chainId: string; freezeUntil: number } | null = null;
    const s = new VaultSnapshotter({
      store: { pending: async () => pending, write: async (id) => (writes.push(id), true) },
      reader: new FakeReader(),
      signers: async () => [{ key: Keypair.generate(), always: true }],
      mints: { mints: async () => [] },
      now: () => now,
    });
    expect(await s.tick()).toBe("idle");
    pending = { id: 9, chainId: "0202", freezeUntil: 2_000 };
    expect(await s.tick()).toBe("written");
    expect(writes).toEqual([9]);
    now = 5_000;
    expect(await s.tick()).toBe("late");
    expect(writes).toEqual([9]);
  });
});

// ---------------------------------------------------------------------------
// live Postgres: freeze in claim, out_sig, verify_vaults writes
// ---------------------------------------------------------------------------

loadRepoEnv();
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("Verify v4 (live Postgres, temp schema)", () => {
  const schema = `relayer_v4_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let q: PostgresJobQueue;
  let has0009 = false;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    has0009 =
      (await admin.query(`SELECT to_regclass('public.verify_vaults') IS NOT NULL AS ok`)).rows[0].ok === true &&
      (await admin.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='relayer_jobs' AND column_name='out_sig') AS ok`)).rows[0].ok === true;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const tables = ["relayer_jobs", "tokens", "trades", ...(has0009 ? ["verify_snapshots", "verify_vaults"] : [])];
    for (const t of tables) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    for (const t of ["relayer_jobs", "trades", ...(has0009 ? ["verify_snapshots"] : [])]) {
      await admin.query(`CREATE SEQUENCE ${schema}.${t}_seq`);
      await admin.query(`ALTER TABLE ${schema}.${t} ALTER COLUMN id SET DEFAULT nextval('${schema}.${t}_seq')`);
    }
    pool = new pg.Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema}` });
    q = new PostgresJobQueue({ pool, network: "devnet" });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const claim = (lane?: "now" | "batch" | "attest") => q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000, ...(lane ? { lane } : {}) });
  const snapshot = async (status: string, freezeSecs: number, network = "devnet") =>
    (
      await pool.query<{ id: number }>(
        `INSERT INTO verify_snapshots (network, chain_id, kind, status, freeze_until)
         VALUES ($1, '0202', 'manual', $2, now() + $3 * interval '1 second') RETURNING id`,
        [network, status, freezeSecs],
      )
    ).rows[0]!.id;

  it("freeze: no new buy / fair_create in either lane while freezing/collecting (attest exempt, E21); in-flight recovery continues", async (ctx) => {
    if (!has0009) ctx.skip();
    const mint = Keypair.generate();
    await pool.query(`INSERT INTO relayer_jobs (op, venue, mint, lamports_in, min_out, network, exec_mode) VALUES ('buy','pumpfun',$1,1000,1,'devnet','now')`, [mint.publicKey.toBase58()]);
    await pool.query(`INSERT INTO relayer_jobs (op, venue, mint, lamports_in, min_out, network, exec_mode) VALUES ('buy','pumpfun',$1,1000,1,'devnet','delayed')`, [mint.publicKey.toBase58()]);
    await pool.query(
      `INSERT INTO relayer_jobs (op, venue, lamports_in, min_out, meta, network, mint_secret, exec_mode)
       VALUES ('fair_create','pumpfun',1000000,5,'{"name":"F","symbol":"F"}','devnet',$1,'now')`,
      [Buffer.from(Keypair.generate().secretKey)],
    );
    await pool.query(`INSERT INTO relayer_jobs (op, meta, network, exec_mode) VALUES ('attest', $1, 'devnet', 'delayed')`, [{ memo: ROOT }]);
    // an in-flight row whose lease ran out (must still be recovered during the freeze)
    const inflight = (
      await pool.query<{ id: string }>(
        `INSERT INTO relayer_jobs (op, venue, mint, lamports_in, min_out, network, exec_mode, status, signature, last_valid_block_height, vault, claimed_by, lease_until)
         VALUES ('buy','pumpfun',$1,1000,1,'devnet','delayed','sent','sigX',5,'V','old', now() - interval '1 second') RETURNING id`,
        [mint.publicKey.toBase58()],
      )
    ).rows[0]!.id;

    const other = await snapshot("collecting", 60, "mainnet-beta"); // other network: no effect
    const sid = await snapshot("freezing", 60);
    expect(await verifyFrozen(pool, "devnet")).toBe(true);
    expect(await claim("now")).toBeNull();
    const rec = await claim("batch");
    expect(rec?.id).toBe(inflight); // recovery of the in-flight row only
    expect(await claim("batch")).toBeNull();
    // E21: attest is not frozen (attestation key, no vault / ledger movement) and has its own lane
    expect((await claim("attest"))?.spec.kind).toBe("attest");
    expect(await claim()).toBeNull();

    await pool.query(`UPDATE verify_snapshots SET status = 'collecting' WHERE id = $1`, [sid]);
    expect(await claim("now")).toBeNull();
    // expired freeze no longer blocks (core skips the snapshot)
    await pool.query(`UPDATE verify_snapshots SET freeze_until = now() - interval '1 second' WHERE id = $1`, [sid]);
    expect(await verifyFrozen(pool, "devnet")).toBe(false);
    const ops = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const j = await claim();
      if (j) ops.add(j.spec.kind);
    }
    expect(ops).toEqual(new Set(["buy", "fair_create"]));
    await pool.query(`DELETE FROM verify_snapshots WHERE id IN ($1, $2)`, [sid, other]);
  });

  it("attest confirm writes out_sig (attestation key over hex_decode(meta.memo))", async (ctx) => {
    if (!has0009) ctx.skip();
    await pool.query(`DELETE FROM relayer_jobs`);
    const key = Keypair.generate();
    const id = (await pool.query<{ id: string }>(`INSERT INTO relayer_jobs (op, meta, network, exec_mode) VALUES ('attest', $1, 'devnet', 'delayed') RETURNING id`, [{ memo: ROOT }])).rows[0]!.id;
    const b = (await claim())!;
    expect(b.id).toBe(id);
    const outSig = signDetached(key, attestSigMessage(ROOT));
    await q.reportSent(b, { signature: "sigA", lastValidBlockHeight: 9, vault: key.publicKey.toBase58(), sentAt: Date.now() });
    await q.reportResult(b, {
      status: "executed",
      execution: { kind: "attest", signature: "sigA", slot: 7, vault: key.publicKey.toBase58(), memo: ROOT, networkFee: 5000n, blockTime: 1, outSig },
    });
    const r = (await pool.query(`SELECT status, out_memo, out_sig, vault, meta->>'memo' AS memo FROM relayer_jobs WHERE id = $1`, [id])).rows[0];
    expect(r.status).toBe("confirmed");
    expect(r.out_sig).toBe(outSig);
    // what core's detached_ok checks
    expect(verifyDetached(r.vault, Buffer.from(r.memo, "hex"), r.out_sig)).toBe(true);
  });

  it("F2: attest blockTime goes to out_block_time once core adds it", async (ctx) => {
    if (!has0009) ctx.skip();
    await pool.query(`DELETE FROM relayer_jobs`);
    await pool.query(`ALTER TABLE relayer_jobs ADD COLUMN IF NOT EXISTS out_block_time BIGINT`);
    const q2 = new PostgresJobQueue({ pool, network: "devnet" }); // fresh column cache
    const id = (await pool.query<{ id: string }>(`INSERT INTO relayer_jobs (op, meta, network, exec_mode) VALUES ('attest', $1, 'devnet', 'delayed') RETURNING id`, [{ memo: ROOT, purpose: "verify" }])).rows[0]!.id;
    const b = (await q2.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    expect(b.spec).toEqual({ kind: "attest", memo: ROOT, purpose: "verify" });
    await q2.reportSent(b, { signature: "sigB", lastValidBlockHeight: 9, vault: "K", sentAt: Date.now() });
    await q2.reportResult(b, { status: "executed", execution: { kind: "attest", signature: "sigB", slot: 8, vault: "K", memo: ROOT, networkFee: 5000n, blockTime: 1_760_000_000, outSig: "S" } });
    const r = (await pool.query(`SELECT status, out_block_time, out_sig FROM relayer_jobs WHERE id = $1`, [id])).rows[0];
    expect(r).toEqual({ status: "confirmed", out_block_time: "1760000000", out_sig: "S" });
  });

  it("verify_vaults + slot in one transaction, only while collecting and inside the freeze; second writer loses", async (ctx) => {
    if (!has0009) ctx.skip();
    const store = new PgVerifySnapshotStore(pool, "devnet");
    expect(await store.pending()).toBeNull();
    const frz = await snapshot("freezing", 60);
    expect(await store.pending()).toBeNull(); // not collecting yet
    await pool.query(`UPDATE verify_snapshots SET status = 'collecting' WHERE id = $1`, [frz]);
    const p = (await store.pending())!;
    expect(p).toMatchObject({ id: frz, chainId: "0202" });
    expect(p.freezeUntil).toBeGreaterThan(Date.now());

    const kp = Keypair.generate();
    const a = kp.publicKey.toBase58();
    const row = { address: a, lamports: 123n, tokens: [{ mint: a, amount: "5" }], sig: signDetached(kp, verifyVaultMessage("0202", frz, a)) };
    expect(await store.write(frz, 4242, [row])).toBe(true);
    expect(await store.write(frz, 4243, [{ ...row, lamports: 999n }])).toBe(false); // already done: rolled back
    const s = (await pool.query(`SELECT solana_slot, assets_done_at IS NOT NULL AS done FROM verify_snapshots WHERE id = $1`, [frz])).rows[0];
    expect(s).toEqual({ solana_slot: "4242", done: true });
    const v = (await pool.query(`SELECT address, lamports, tokens, sig FROM verify_vaults WHERE snapshot_id = $1`, [frz])).rows;
    expect(v).toEqual([{ address: a, lamports: "123", tokens: [{ mint: a, amount: "5" }], sig: row.sig }]);
    expect(await store.pending()).toBeNull();

    // past freeze_until: nothing written
    const late = await snapshot("collecting", 60);
    await pool.query(`UPDATE verify_snapshots SET freeze_until = now() - interval '1 second' WHERE id = $1`, [late]);
    expect(await store.pending()).toBeNull();
    expect(await store.write(late, 1, [row])).toBe(false);
    expect((await pool.query(`SELECT count(*)::int AS n FROM verify_vaults WHERE snapshot_id = $1`, [late])).rows[0].n).toBe(0);
  });
});

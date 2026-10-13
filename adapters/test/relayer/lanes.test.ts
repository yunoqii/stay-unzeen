import { describe, expect, it } from "vitest";
import { Keypair, type Signer } from "@solana/web3.js";
import { Relayer, type RelayerEvent } from "../../src/relayer/engine";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { cryptoRng, seededRng } from "../../src/relayer/random";
import type { JobSpec } from "../../src/relayer/types";
import { VaultPool } from "../../src/relayer/vaults";
import type { SignedTx } from "../../src/tx";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, vaults } from "./fakes";

const MINT_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const MINT_B = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";
const buy = (mint: string): JobSpec => ({ kind: "buy", venue: "pumpfun", mint, lamportsIn: 1_000_000n, minOut: 1n });

/** Chi-square statistic of observed counts against a uniform distribution. */
function chiSquare(counts: number[]): number {
  const n = counts.reduce((a, b) => a + b, 0);
  const e = n / counts.length;
  return counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
}

describe("R-relayer-1: now lane", () => {
  it("now job is taken at once, past the epoch; lanes never take each other's jobs", async () => {
    const t = 1_700_000_000_000;
    const q = new InMemoryJobQueue(seededRng(1));
    const epoch = t + 45_000; // core: next epoch boundary
    const d1 = q.enqueue(buy(MINT_A), { notBefore: epoch, execMode: "delayed" });
    const m1 = q.enqueue(buy(MINT_A), { notBefore: epoch, execMode: "max" });
    const n = q.enqueue(buy(MINT_B), { notBefore: t, execMode: "now" });

    const L = 3_600_000;
    expect(await q.claim({ workerId: "w", now: t, leaseMs: L, lane: "batch" })).toBeNull(); // epoch not reached
    const c = await q.claim({ workerId: "w", now: t, leaseMs: L, lane: "now" });
    expect(c?.id).toBe(n.id);
    // delayed/max are never in the now lane, even when due
    expect(await q.claim({ workerId: "w", now: epoch, leaseMs: L, lane: "now" })).toBeNull();
    const got = [
      (await q.claim({ workerId: "w", now: epoch, leaseMs: L, lane: "batch" }))!.id,
      (await q.claim({ workerId: "w", now: epoch, leaseMs: L, lane: "batch" }))!.id,
    ];
    expect(got.sort()).toEqual([d1.id, m1.id].sort());
    expect(await q.claim({ workerId: "w", now: epoch, leaseMs: L, lane: "batch" })).toBeNull();
  });

  it("a now job executes while the batch lane is busy with an epoch", async () => {
    const chain = new FakeChain();
    const clock = new FakeClock(1_700_000_000_000, chain);
    const inv = new FakeInventory();
    const pool = new VaultPool(vaults(2, inv), inv, seededRng(2));
    const q = new InMemoryJobQueue(seededRng(2));

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let batchInSubmit!: () => void;
    const reached = new Promise<void>((r) => (batchInSubmit = r));
    class Gated extends FakeExecutor {
      private readonly mintOf = new Map<string, string>();
      override async prepare(spec: JobSpec, vault: Signer) {
        const tx = await super.prepare(spec, vault);
        if (spec.kind === "buy") this.mintOf.set(tx.signature, spec.mint);
        return tx;
      }
      override async submit(tx: SignedTx): Promise<void> {
        if (this.mintOf.get(tx.signature) === MINT_A) {
          batchInSubmit();
          await gate;
        }
        return super.submit(tx);
      }
    }
    const ex = new Gated(chain);
    const events: RelayerEvent[] = [];
    const relayer = new Relayer({ queue: q, pool, executors: { trade: { pumpfun: ex }, withdraw: ex }, probe: chain, clock, rng: seededRng(2), onEvent: (e) => events.push(e) });

    const d = q.enqueue(buy(MINT_A), { notBefore: clock.now(), execMode: "delayed" });
    const batch = relayer.tick("batch");
    await reached; // the batch lane is mid-send
    const n = q.enqueue(buy(MINT_B), { notBefore: clock.now(), execMode: "now" });
    expect(await relayer.tick("now")).toBe(true);
    expect(q.get(n.id)!.state).toBe("executed");
    expect(q.get(d.id)!.state).toBe("queued"); // still in flight
    release();
    expect(await batch).toBe(true);
    expect(q.get(d.id)!.state).toBe("executed");
    // R-relayer-6: events carry kind/outcome only, nothing about the mode.
    for (const e of events) expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(["event", "kind"]));
    expect(JSON.stringify(events)).not.toMatch(/now|delayed|max|lane/);
  });
});

describe("N-4: batch order inside an epoch is random", () => {
  it("in-memory queue: uniform permutation (statistical)", async () => {
    const K = 6;
    const TRIALS = 1_200;
    const firstPos = new Array(K).fill(0); // which inserted job is executed first
    const posOfFirstInserted = new Array(K).fill(0); // where the earliest request ends up
    let insertionOrder = 0;
    const t = 1_700_000_000_000;
    for (let trial = 0; trial < TRIALS; trial++) {
      const q = new InMemoryJobQueue(cryptoRng);
      for (let i = 0; i < K; i++) q.enqueue(buy(MINT_A), { notBefore: t, id: `j${i}`, execMode: i % 2 ? "max" : "delayed" });
      const order: number[] = [];
      for (;;) {
        const c = await q.claim({ workerId: "w", now: t, leaseMs: 60_000, lane: "batch" });
        if (!c) break;
        order.push(Number(c.id.slice(1)));
        await q.reportResult(c, { status: "failed", code: "internal", message: "x" });
      }
      expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
      firstPos[order[0]!]++;
      posOfFirstInserted[order.indexOf(0)]++;
      if (order.every((v, i) => v === i)) insertionOrder++;
    }
    // df = 5: p = 1e-4 at 25.7. A FIFO queue would give 6000.
    expect(chiSquare(firstPos)).toBeLessThan(25.7);
    expect(chiSquare(posOfFirstInserted)).toBeLessThan(25.7);
    expect(insertionOrder / TRIALS).toBeLessThan(0.02); // 1/720 expected
  });

  it("different epochs keep their order (earlier not_before first)", async () => {
    const t = 1_700_000_000_000;
    const q = new InMemoryJobQueue(cryptoRng);
    q.enqueue(buy(MINT_A), { notBefore: t + 1, id: "late" });
    q.enqueue(buy(MINT_A), { notBefore: t, id: "early" });
    expect((await q.claim({ workerId: "w", now: t + 2, leaseMs: 1, lane: "batch" }))!.id).toBe("early");
  });
});

describe("RELAYER v5 §3: attest lane", () => {
  const ROOT = "cd".repeat(32);
  const attest = (purpose: "fair" | "verify"): JobSpec => ({ kind: "attest", memo: ROOT, purpose });
  const fairCreate = (): JobSpec => ({ kind: "fair_create", venue: "pumpfun", meta: { name: "F", symbol: "F" }, lamportsIn: 1_000_000n, minOut: 1n, mintKeypair: Keypair.generate() });

  it("in-memory queue: attest only in its lane, fair before verify; no lane = attest first", async () => {
    const t = 1_700_000_000_000;
    const L = 60_000;
    const q = new InMemoryJobQueue(seededRng(3));
    const v = q.enqueue(attest("verify"), { notBefore: t - 10_000, execMode: "delayed" });
    const fc = q.enqueue(fairCreate(), { notBefore: t - 20_000, execMode: "now" });
    const f = q.enqueue(attest("fair"), { notBefore: t, execMode: "now" });
    const claim = (lane?: "now" | "batch" | "attest") => q.claim({ workerId: "w", now: t, leaseMs: L, ...(lane ? { lane } : {}) });
    expect((await claim("attest"))!.id).toBe(f.id);
    expect((await claim("attest"))!.id).toBe(v.id);
    expect(await claim("attest")).toBeNull();
    expect((await claim("now"))!.id).toBe(fc.id);
    expect(await claim("now")).toBeNull();
    expect(await claim("batch")).toBeNull();

    const q2 = new InMemoryJobQueue(seededRng(4));
    q2.enqueue(fairCreate(), { notBefore: t - 20_000, execMode: "now" });
    const a = q2.enqueue(attest("fair"), { notBefore: t, execMode: "now" });
    expect((await q2.claim({ workerId: "w", now: t, leaseMs: L }))!.id).toBe(a.id);
  });

  it("the fair-launch root goes out while the now lane is stuck in a long fair_create", async () => {
    const chain = new FakeChain();
    const clock = new FakeClock(1_700_000_000_000, chain);
    const inv = new FakeInventory();
    const pool = new VaultPool(vaults(1, inv), inv, seededRng(5));
    const q = new InMemoryJobQueue(seededRng(5));
    const attestKey = Keypair.generate();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inSubmit!: () => void;
    const reached = new Promise<void>((r) => (inSubmit = r));
    const kinds = new Map<string, JobSpec["kind"]>();
    class Gated extends FakeExecutor {
      override async prepare(spec: JobSpec, vault: Signer) {
        const tx = await super.prepare(spec, vault);
        kinds.set(tx.signature, spec.kind);
        return tx;
      }
      override async submit(tx: SignedTx): Promise<void> {
        if (kinds.get(tx.signature) === "fair_create") {
          inSubmit();
          await gate;
        }
        return super.submit(tx);
      }
    }
    const ex = new Gated(chain);
    // attest signs with its own key (no vault lease), like AttestExecutor
    const attestEx = Object.assign(Object.create(ex) as Gated, { ownSigner: () => attestKey });
    const relayer = new Relayer({ queue: q, pool, executors: { trade: { pumpfun: ex }, withdraw: ex, attest: attestEx }, probe: chain, clock, rng: seededRng(5) });

    const fc = q.enqueue(fairCreate(), { notBefore: clock.now(), execMode: "now" });
    const nowLane = relayer.tick("now");
    await reached; // fair_create is mid-send on the only vault
    const a = q.enqueue(attest("fair"), { notBefore: clock.now(), execMode: "now" });
    expect(await relayer.tick("now")).toBe(false); // the now lane never takes it
    expect(await relayer.tick("attest")).toBe(true);
    expect(q.get(a.id)!.state).toBe("executed");
    const ex1 = q.get(a.id)!.result;
    expect(ex1?.status === "executed" && ex1.execution.kind === "attest" && ex1.execution.vault).toBe(attestKey.publicKey.toBase58());
    expect(q.get(fc.id)!.state).toBe("queued"); // still in flight
    release();
    expect(await nowLane).toBe(true);
    expect(q.get(fc.id)!.state).toBe("executed");
  });
});

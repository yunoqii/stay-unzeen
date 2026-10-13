import { Keypair, type Signer } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/errors";
import type { FairPlanConfig } from "../../src/fair-bundle";
import type { FairLegResult, PreparedFairBundle } from "../../src/pumpfun";
import { Relayer, type RelayerEvent } from "../../src/relayer/engine";
import type { FairBundler } from "../../src/relayer/fair-bundler";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { MemoryMintVaults } from "../../src/relayer/mint-vaults";
import { seededRng } from "../../src/relayer/random";
import type { BundleLeg, FairCreateJobSpec, JobSpec } from "../../src/relayer/types";
import { VaultPool } from "../../src/relayer/vaults";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, vaults } from "./fakes";

const SOL = 1_000_000_000n;
const PLAN: FairPlanConfig = { maxLegs: 5, maxPerVault: null, createReserve: 1_000n, legReserve: 1_000n, quantum: 1_000n, minLeg: 10_000n };

type SendBehavior = "land" | "drop" | "preflight-slippage" | "relay-error-land" | "unbundled-first-only";

class FakeBundler implements FairBundler {
  readonly plan = PLAN;
  readonly bundleTries = 2;
  tipFresh = true;
  behaviors: SendBehavior[] = [];
  readonly prepared: { spec: FairCreateJobSpec; legs: { vault: string; lamports: bigint }[]; sigs: string[] }[] = [];
  readonly sent: string[][] = [];
  sentRecorded: (sigs: string[]) => boolean = () => true;
  orderViolations = 0;
  private n = 0;
  constructor(private readonly chain: FakeChain) {}

  available() {
    return this.tipFresh;
  }
  async prepare(spec: FairCreateJobSpec, legs: readonly { vault: Signer; lamports: bigint }[]): Promise<PreparedFairBundle> {
    const b = ++this.n;
    const lvbh = this.chain.height + 150;
    const signed = legs.map((l, k) => ({
      signature: `b${b}-${k}`,
      raw: new Uint8Array([b, k]),
      blockhash: `bh${b}`,
      lastValidBlockHeight: lvbh,
      vault: l.vault.publicKey.toBase58(),
      lamports: l.lamports,
      expectedOut: l.lamports * 1000n,
      minOut: 1n,
    }));
    this.prepared.push({ spec, legs: signed.map((s) => ({ vault: s.vault, lamports: s.lamports })), sigs: signed.map((s) => s.signature) });
    return { kind: "fair_bundle", mint: spec.mintKeypair.publicKey.toBase58(), creator: "C", creatorIndex: 0, legs: signed, blockhash: `bh${b}`, lastValidBlockHeight: lvbh };
  }
  async send(raws: readonly Uint8Array[]): Promise<void> {
    const b = raws[0]![0]!;
    const sigs = raws.map((_, k) => `b${b}-${k}`);
    if (!this.sentRecorded(sigs)) this.orderViolations++;
    this.sent.push(sigs);
    const beh = this.behaviors.shift() ?? "land";
    switch (beh) {
      case "land":
        for (const s of sigs) this.chain.land(s);
        return;
      case "drop":
        return;
      case "unbundled-first-only":
        this.chain.land(sigs[0]!);
        for (const s of sigs.slice(1)) this.chain.land(s, { InstructionError: [3, { Custom: 6042 }] });
        return;
      case "relay-error-land":
        for (const s of sigs) this.chain.land(s);
        throw new AdapterError("venue_unavailable", "jito HTTP 502", { stage: "confirm" });
      case "preflight-slippage":
        throw new AdapterError("slippage", "sim", { stage: "preflight" });
    }
  }
  resends = 0;
  async resend(): Promise<void> {
    this.resends++;
  }
  async freshQuote(lamports: bigint): Promise<bigint> {
    return lamports * 1000n;
  }
  async legResult(signature: string, vault: string, mint: string): Promise<FairLegResult | null> {
    return {
      venue: "pumpfun", kind: "buy", signature, slot: 7, mint, vault, tokenAmount: 2_000n, solAmount: 100_000n, networkFee: 5_000n,
      blockTime: 1, decimals: 6, amountsKnown: true, fromEvent: true, creatorFee: 50n,
    };
  }
  async expired(lvbh: number): Promise<boolean> {
    return this.chain.height > lvbh;
  }
  discovered: BundleLeg[] = [];
  async discoverLegs(): Promise<BundleLeg[]> {
    return this.discovered;
  }

}

/** Records the spec of every single-tx prepare (capped fallback check). */
class SpecExecutor extends FakeExecutor {
  readonly specs: JobSpec[] = [];
  override async prepare(spec: JobSpec, vault: Signer) {
    this.specs.push(spec);
    return super.prepare(spec, vault);
  }
}

function setup(balances: bigint[]) {
  const chain = new FakeChain();
  const clock = new FakeClock(1_700_000_000_000, chain);
  const rng = seededRng(7);
  const inv = new FakeInventory();
  const vs = vaults(balances.length, inv);
  vs.forEach((v, i) => inv.sol.set(v.publicKey.toBase58(), balances[i]!));
  const pool = new VaultPool(vs, inv, rng);
  const queue = new InMemoryJobQueue(rng);
  const trade = new SpecExecutor(chain);
  const fb = new FakeBundler(chain);
  const mintVaults = new MemoryMintVaults();
  const events: RelayerEvent[] = [];
  const relayer = new Relayer({
    queue, pool, executors: { trade: { pumpfun: trade }, withdraw: trade }, probe: chain, mintVaults, clock, rng, fairBundler: fb,
    pollMs: 2_000, resolveTimeoutMs: 120_000, onEvent: (e) => events.push(e),
  });
  const mint = Keypair.generate();
  const spec: FairCreateJobSpec = { kind: "fair_create", venue: "pumpfun", meta: { name: "F", symbol: "F" }, lamportsIn: 9n * SOL, minOut: 1_000n, mintKeypair: mint };
  const add = (s: JobSpec = spec) => {
    const j = queue.enqueue(s, { notBefore: clock.now() });
    const recorded = () => queue.get(j.id)!.attempts;
    trade.sentRecorded = (sig) => recorded().some((a) => a.signature === sig);
    fb.sentRecorded = (sigs) => {
      const a = recorded().at(-1);
      return !!a && a.signature === sigs[0] && sigs.slice(1).every((s, k) => a.bundle?.legs[k]?.signature === s);
    };
    return j.id;
  };
  const run = async (id: string, n = 8) => {
    for (let i = 0; i < n && !["executed", "failed"].includes(queue.get(id)!.state); i++) await relayer.tick();
    return queue.get(id)!;
  };
  return { chain, clock, inv, vs, pool, queue, trade, fb, mintVaults, relayer, spec, mint, add, run, events };
}

describe("fair-launch v2 engine (Jito bundle, mocked)", () => {
  it("one vault suffices: v1 single tx, no bundle", async () => {
    const t = setup([10n * SOL, 1n * SOL]);
    const j = await t.run(t.add());
    expect(j.state).toBe("executed");
    expect(t.fb.sent).toHaveLength(0);
    expect(t.trade.specs[0]).toMatchObject({ kind: "fair_create", lamportsIn: 9n * SOL });
  });

  it("bundle: every leg recorded before the send, mint pinned to leg 0, totals aggregated (consolidation = core's jobs, v7)", async () => {
    const t = setup([4n * SOL, 4n * SOL, 4n * SOL]);
    const id = t.add();
    const j = await t.run(id);
    expect(j.state).toBe("executed");
    expect(t.fb.orderViolations).toBe(0);
    expect(t.trade.specs).toHaveLength(0);
    const p = t.fb.prepared[0]!;
    expect(p.legs.length).toBe(3);
    expect(p.legs.reduce((s, l) => s + l.lamports, 0n)).toBe(9n * SOL);
    expect(p.spec.mintKeypair).toBe(t.mint);
    const a = j.attempts[0]!;
    expect(a.signature).toBe(p.sigs[0]);
    expect(a.vault).toBe(p.legs[0]!.vault);
    expect(a.bundle!.legs.map((l) => l.signature)).toEqual(p.sigs.slice(1));
    expect(await t.mintVaults.get(t.mint.publicKey.toBase58())).toBe(p.legs[0]!.vault);
    const r = j.result;
    if (r?.status !== "executed" || r.execution.kind !== "create") throw new Error("not executed");
    // leg 0 (FakeExecutor create: 1000 tok / 50000 lam / fee 5000) + 2 legs (2000 / 100000 / 5000)
    expect(r.execution.tokenAmount).toBe(5_000n);
    expect(r.execution.solAmount).toBe(250_000n);
    expect(r.execution.networkFee).toBe(15_000n);
    expect(r.execution.signature).toBe(p.sigs[0]);
    expect(r.execution.legs!.map((l) => l.signature)).toEqual(p.sigs.slice(1));
  });

  it("bundle not landing: resends the whole bundle (never leg 0 alone), new bundle only after expiry, same mint", async () => {
    const t = setup([4n * SOL, 4n * SOL, 4n * SOL]);
    t.fb.behaviors = ["drop", "land"];
    const j = await t.run(t.add());
    expect(j.state).toBe("executed");
    expect(t.fb.sent).toHaveLength(2);
    expect(t.fb.resends).toBeGreaterThan(0);
    expect(t.chain.rebroadcasts).toBe(0); // leg 0 never rebroadcast through the Sender path
    expect(t.fb.prepared.every((p) => p.spec.mintKeypair === t.mint)).toBe(true);
    // second bundle keeps the pinned create vault (D4)
    expect(t.fb.prepared[1]!.legs[0]!.vault).toBe(t.fb.prepared[0]!.legs[0]!.vault);
  });

  it("bundle tries exhausted: ONE capped tx with min_out scaled, same mint and pinned vault", async () => {
    const t = setup([4n * SOL, 4n * SOL, 4n * SOL]);
    t.fb.behaviors = ["drop", "drop"];
    const j = await t.run(t.add(), 12);
    expect(j.state).toBe("executed");
    expect(t.fb.sent).toHaveLength(2);
    const s = t.trade.specs.at(-1)!;
    if (s.kind !== "fair_create") throw new Error();
    expect(s.mintKeypair).toBe(t.mint);
    expect(s.lamportsIn).toBeLessThan(9n * SOL);
    expect(s.lamportsIn).toBeGreaterThan(3n * SOL);
    expect(s.minOut).toBe((1_000n * s.lamportsIn * 1000n) / (9n * SOL * 1000n) || 1n);
    expect(t.trade.prepared.at(-1)!.vault).toBe(t.fb.prepared[0]!.legs[0]!.vault);
  });

  it("Jito unavailable (no fresh tip floor): capped single tx right away, no bundle", async () => {
    const t = setup([4n * SOL, 4n * SOL]);
    t.fb.tipFresh = false;
    const j = await t.run(t.add());
    expect(j.state).toBe("executed");
    expect(t.fb.prepared).toHaveLength(0);
    expect(t.trade.specs).toHaveLength(1);
  });

  it("relay error after acceptance: resolved on chain, no second bundle", async () => {
    const t = setup([4n * SOL, 4n * SOL, 4n * SOL]);
    t.fb.behaviors = ["relay-error-land"];
    const j = await t.run(t.add());
    expect(j.state).toBe("executed");
    expect(t.fb.sent).toHaveLength(1);
  });

  it("preflight rejection of leg 0: nothing relayed, final error", async () => {
    const t = setup([4n * SOL, 4n * SOL, 4n * SOL]);
    t.fb.behaviors = ["preflight-slippage"];
    const j = await t.run(t.add());
    expect(j.state).toBe("failed");
    expect(j.result).toMatchObject({ status: "failed", code: "slippage" });
  });

  it("uncled / unbundled: leg 0 landed alone, other legs failed -> launch settles with leg 0 only", async () => {
    const t = setup([4n * SOL, 4n * SOL, 4n * SOL]);
    t.fb.behaviors = ["unbundled-first-only"];
    const j = await t.run(t.add());
    const r = j.result;
    if (r?.status !== "executed" || r.execution.kind !== "create") throw new Error("not executed");
    expect(r.execution.tokenAmount).toBe(1_000n);
    expect(r.execution.legs).toBeUndefined();
  });

  it("restart without leg records (Postgres w/o bundle_legs): waits for expiry, then discovers legs on chain", async () => {
    const t = setup([4n * SOL, 4n * SOL, 4n * SOL]);
    const id = t.add();
    // A crashed worker recorded only leg 0 (no raw bytes, no legs), and the bundle landed.
    const claimed = (await t.queue.claim({ workerId: "dead", now: t.clock.now(), leaseMs: 1 }))!;
    const v0 = t.vs[0]!.publicKey.toBase58();
    await t.queue.reportSent(claimed, { signature: "L0", lastValidBlockHeight: t.chain.height + 50, vault: v0, sentAt: t.clock.now() });
    await t.mintVaults.assign(t.mint.publicKey.toBase58(), v0);
    t.chain.land("L0");
    t.chain.land("L1");
    t.fb.discovered = [{ signature: "L1", vault: t.vs[1]!.publicKey.toBase58() }];
    t.queue.expireLease(id);
    await t.relayer.tick(); // landed, blockhash still valid -> retry later
    expect(t.queue.get(id)!.state).toBe("queued");
    t.clock.t = t.queue.get(id)!.notBefore;
    t.chain.height += 100;
    const j = await t.run(id);
    const r = j.result;
    if (r?.status !== "executed" || r.execution.kind !== "create") throw new Error("not executed");
    expect(r.execution.legs!.map((l) => l.signature)).toEqual(["L1"]);
    expect(r.execution.tokenAmount).toBe(3_000n);
    expect(t.fb.prepared).toHaveLength(0); // nothing re-signed
  });

  it("not enough SOL anywhere: retried as pool_liquidity, nothing signed", async () => {
    const t = setup([5_000n, 5_000n]);
    const id = t.add();
    await t.relayer.tick();
    expect(t.queue.get(id)!.result).toMatchObject({ status: "retry", code: "pool_liquidity" });
    expect(t.fb.prepared).toHaveLength(0);
    expect(t.trade.specs).toHaveLength(0);
  });

  it("no bundler (devnet): fair_create is the v1 single tx even when one vault is short", async () => {
    const chain = new FakeChain();
    const clock = new FakeClock(1_700_000_000_000, chain);
    const inv = new FakeInventory();
    const vs = vaults(2, inv, 10n * SOL);
    const queue = new InMemoryJobQueue(seededRng(1));
    const trade = new SpecExecutor(chain);
    const r = new Relayer({ queue, pool: new VaultPool(vs, inv, seededRng(1)), executors: { trade: { pumpfun: trade }, withdraw: trade }, probe: chain, clock });
    const mint = Keypair.generate();
    const j = queue.enqueue({ kind: "fair_create", venue: "pumpfun", meta: { name: "F", symbol: "F" }, lamportsIn: 9n * SOL, minOut: 1n, mintKeypair: mint }, { notBefore: 0 });
    await r.tick();
    expect(queue.get(j.id)!.state).toBe("executed");
    expect(trade.specs[0]).toMatchObject({ lamportsIn: 9n * SOL });
  });
});

import { bundleOf } from "../../src/relayer/postgres-queue";
describe("bundle_legs column (proposed core 0015)", () => {
  it("round-trips [{sig, vault}], ignores malformed / NULL (legs are then rediscovered)", () => {
    expect(bundleOf([{ sig: "s1", vault: "v1" }])).toEqual({ bundle: { legs: [{ signature: "s1", vault: "v1" }] } });
    expect(bundleOf(null)).toEqual({});
    expect(bundleOf([])).toEqual({});
    expect(bundleOf([{ sig: 1, vault: "v" }])).toEqual({});
    expect(bundleOf(Array.from({ length: 5 }, () => ({ sig: "s", vault: "v" })))).toEqual({});
  });
});

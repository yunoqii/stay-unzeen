import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/errors";
import { Relayer, type RelayerEvent } from "../../src/relayer/engine";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { seededRng } from "../../src/relayer/random";
import type { JobSpec } from "../../src/relayer/types";
import { MemoryMintVaults, type MintVaults } from "../../src/relayer/mint-vaults";
import { VaultPool } from "../../src/relayer/vaults";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, MINT, vaults } from "./fakes";

const BUY: JobSpec = { kind: "buy", venue: "pumpfun", mint: MINT, lamportsIn: 1_000_000n, minOut: 1n };

function setup(nVaults = 3, mintVaults?: MintVaults) {
  const chain = new FakeChain();
  const clock = new FakeClock(1_700_000_000_000, chain);
  const rng = seededRng(7);
  const inv = new FakeInventory();
  const vs = vaults(nVaults, inv);
  const pool = new VaultPool(vs, inv, rng);
  const queue = new InMemoryJobQueue(rng);
  const ex = new FakeExecutor(chain);
  const events: RelayerEvent[] = [];
  const relayer = new Relayer({
    queue,
    pool,
    executors: { trade: { pumpfun: ex }, withdraw: ex },
    probe: chain,
    ...(mintVaults ? { mintVaults } : {}),
    clock,
    rng,
    pollMs: 2_000,
    resolveTimeoutMs: 120_000,
    onEvent: (e) => events.push(e),
  });
  const add = (spec: JobSpec = BUY) => {
    const j = queue.enqueue(spec, { notBefore: clock.now() });
    ex.sentRecorded = (sig) => queue.get(j.id)!.attempts.some((a) => a.signature === sig);
    return j.id;
  };
  return { chain, clock, inv, vs, pool, queue, ex, relayer, events, add };
}

describe("relayer engine: happy path", () => {
  it("records the signature BEFORE broadcasting, executes with on-chain amounts", async () => {
    const t = setup();
    const id = t.add();
    expect(await t.relayer.tick()).toBe(true);
    const j = t.queue.get(id)!;
    expect(j.state).toBe("executed");
    expect(t.ex.orderViolations).toEqual([]);
    expect(j.attempts.map((a) => a.signature)).toEqual(["sig1"]);
    expect(j.result).toMatchObject({ status: "executed", execution: { tokenAmount: 123n, solAmount: 456n } });
    expect(await t.relayer.tick()).toBe(false);
  });

  it("respects not_before: nothing is claimed early", async () => {
    const t = setup();
    t.queue.enqueue(BUY, { notBefore: t.clock.now() + 10_000 });
    expect(await t.relayer.tick()).toBe(false);
    t.clock.t += 10_000;
    expect(await t.relayer.tick()).toBe(true);
  });
});

describe("relayer engine: idempotent retries (no double buy)", () => {
  it("transport error after the tx really went out -> no second transaction", async () => {
    const t = setup();
    const id = t.add();
    t.ex.behaviors = ["land-then-transport-error"];
    await t.relayer.tick();
    expect(t.ex.prepared).toHaveLength(1);
    expect(t.ex.submitted).toEqual(["sig1"]);
    expect(t.queue.get(id)!.state).toBe("executed");
  });

  it("transport error, tx dropped -> waits for blockhash expiry, then exactly one resend", async () => {
    const t = setup();
    const id = t.add();
    t.ex.behaviors = ["transport-error-dropped", "land"];
    await t.relayer.tick();
    const j = t.queue.get(id)!;
    expect(j.state).toBe("executed");
    expect(t.ex.submitted).toEqual(["sig1", "sig2"]);
    // sig2 was only built after sig1 could no longer land
    expect(j.attempts.map((a) => a.signature)).toEqual(["sig1", "sig2"]);
    expect(j.result).toMatchObject({ execution: { signature: "sig2" } });
    expect(t.events.some((e) => e.event === "resend")).toBe(true);
  });

  it("crash after reportSent: the next claim finds the landed tx and does not send again", async () => {
    const t = setup();
    const id = t.add();
    // Worker 1 records + broadcasts, then dies before reporting.
    const claimed = (await t.queue.claim({ workerId: "w1", now: t.clock.now(), leaseMs: 60_000 }))!;
    await t.queue.reportSent(claimed, {
      signature: "sigX",
      lastValidBlockHeight: t.chain.height + 150,
      vault: t.vs[0]!.publicKey.toBase58(),
      sentAt: t.clock.now(),
    });
    t.chain.land("sigX");
    t.queue.expireLease(id);
    await t.relayer.tick();
    const j = t.queue.get(id)!;
    expect(j.state).toBe("executed");
    expect(t.ex.prepared).toHaveLength(0);
    expect(j.result).toMatchObject({ execution: { signature: "sigX" } });
  });

  it("previous attempt still pending past the wait budget -> retry later, never a parallel tx", async () => {
    const t = setup();
    const id = t.add();
    const claimed = (await t.queue.claim({ workerId: "w1", now: t.clock.now(), leaseMs: 60_000 }))!;
    await t.queue.reportSent(claimed, {
      signature: "sigP",
      lastValidBlockHeight: t.chain.height + 1_000_000, // never expires within the test
      vault: t.vs[0]!.publicKey.toBase58(),
      sentAt: t.clock.now(),
      rawTx: Buffer.from([1]).toString("base64"),
    });
    t.queue.expireLease(id);
    await t.relayer.tick();
    const j = t.queue.get(id)!;
    expect(j.state).toBe("queued");
    expect(j.result?.status).toBe("retry");
    expect(t.ex.prepared).toHaveLength(0);
    expect(t.chain.rebroadcasts).toBeGreaterThan(0); // same bytes re-sent, not a new tx
  });

  it("'processed' (unconfirmed) status is not treated as landed", async () => {
    const t = setup();
    const id = t.add();
    const claimed = (await t.queue.claim({ workerId: "w1", now: t.clock.now(), leaseMs: 60_000 }))!;
    await t.queue.reportSent(claimed, {
      signature: "sigQ",
      lastValidBlockHeight: t.chain.height + 1_000_000,
      vault: t.vs[0]!.publicKey.toBase58(),
      sentAt: t.clock.now(),
    });
    t.chain.processed.add("sigQ");
    t.queue.expireLease(id);
    await t.relayer.tick();
    expect(t.queue.get(id)!.state).toBe("queued");
    expect(t.ex.prepared).toHaveLength(0);
  });

  it("RPC errors while probing do not count as 'expired'", async () => {
    const t = setup();
    const id = t.add();
    t.ex.behaviors = ["land-then-transport-error"];
    t.chain.failProbe = 3;
    await t.relayer.tick();
    expect(t.queue.get(id)!.state).toBe("executed");
    expect(t.ex.submitted).toEqual(["sig1"]);
  });

  it("landed but unreadable -> retry (never executed with zero amounts), then executed", async () => {
    const t = setup();
    const id = t.add();
    t.ex.unreadable = 1;
    await t.relayer.tick();
    expect(t.queue.get(id)!.state).toBe("queued");
    t.clock.t += 10_000;
    await t.relayer.tick();
    const j = t.queue.get(id)!;
    expect(j.state).toBe("executed");
    expect(t.ex.submitted).toEqual(["sig1"]);
  });

  it("stale lease: reportSent fails and nothing is broadcast", async () => {
    const t = setup();
    const id = t.add();
    const c1 = (await t.queue.claim({ workerId: "w1", now: t.clock.now(), leaseMs: 1 }))!;
    t.queue.expireLease(id);
    await t.queue.claim({ workerId: "w2", now: t.clock.now(), leaseMs: 60_000 });
    await expect(
      t.queue.reportSent(c1, { signature: "s", lastValidBlockHeight: 1, vault: "v", sentAt: 0 }),
    ).rejects.toThrow(/lease lost/);
  });
});

describe("relayer engine: error codes", () => {
  it("preflight slippage -> failed/slippage, no resend", async () => {
    const t = setup();
    const id = t.add();
    t.ex.behaviors = ["preflight-slippage"];
    await t.relayer.tick();
    expect(t.queue.get(id)!.result).toMatchObject({ status: "failed", code: "slippage" });
    expect(t.ex.submitted).toHaveLength(1);
  });

  it("landed with a program error -> failed with the program's code", async () => {
    const t = setup();
    const id = t.add();
    t.ex.behaviors = ["landed-error"];
    await t.relayer.tick();
    expect(t.queue.get(id)!.result).toMatchObject({ status: "failed", code: "slippage", signature: "sig1" });
  });

  it("preflight 'blockhash not found' -> immediate rebuild", async () => {
    const t = setup();
    const id = t.add();
    t.ex.behaviors = ["preflight-blockhash", "land"];
    await t.relayer.tick();
    expect(t.queue.get(id)!.state).toBe("executed");
    expect(t.ex.submitted).toEqual(["sig1", "sig2"]);
  });

  it("graduated before sending -> failed/graduated", async () => {
    const t = setup();
    const id = t.add();
    t.ex.prepareError = new AdapterError("graduated", "left the curve");
    await t.relayer.tick();
    expect(t.queue.get(id)!.result).toMatchObject({ status: "failed", code: "graduated" });
    expect(t.ex.submitted).toHaveLength(0);
  });

  it("no vault with enough SOL -> pool_liquidity, retried, then failed after maxClaims", async () => {
    const t = setup(2);
    for (const v of t.vs) t.inv.sol.set(v.publicKey.toBase58(), 10n);
    const id = t.add();
    for (let i = 0; i < 10; i++) {
      t.clock.t += 600_000;
      await t.relayer.tick();
    }
    const j = t.queue.get(id)!;
    expect(j.result).toMatchObject({ status: "failed", code: "pool_liquidity" });
    expect(j.claims).toBe(3);
    expect(t.ex.prepared).toHaveLength(0);
  });

  it("events carry no ids, signatures or amounts", async () => {
    const t = setup();
    t.add();
    await t.relayer.tick();
    for (const e of t.events) expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(["event", "kind"]));
    expect(JSON.stringify(t.events)).not.toMatch(/sig\d|[1-9A-HJ-NP-Za-km-z]{32,}/);
  });
});

describe("relayer engine: vault rules", () => {
  it("one in-flight tx per vault: a concurrent job on the only vault is deferred", async () => {
    const t = setup(1);
    t.add();
    t.add();
    t.ex.behaviors = ["transport-error-dropped"]; // keeps the first job busy waiting for expiry
    const [a, b] = await Promise.all([t.relayer.tick(), t.relayer.tick()]);
    expect(a && b).toBe(true);
    const states = t.queue.all().map((j) => j.result?.status);
    expect(states).toContain("retry"); // the second could not get a vault
    expect(t.ex.prepared.length).toBeGreaterThanOrEqual(1);
  });

  it("buys rotate across vaults (never the same vault twice in a row)", async () => {
    const t = setup(3);
    for (let i = 0; i < 30; i++) {
      t.add();
      t.clock.t += 1_000;
      await t.relayer.tick();
    }
    const seq = t.ex.prepared.map((p) => p.vault);
    expect(new Set(seq).size).toBe(3);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });
});

describe("relayer engine: one vault per mint (D4)", () => {
  const MINT2 = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

  it("first buy pins the mint; later buys, sell-all and every withdraw part use that vault", async () => {
    const mv = new MemoryMintVaults();
    const t = setup(4, mv);
    t.add();
    await t.relayer.tick();
    const pinned = await mv.get(MINT);
    expect(pinned).toBe(t.ex.prepared[0]!.vault);
    for (const v of t.vs) t.inv.tokens.set(`${v.publicKey.toBase58()}:${MINT}`, v.publicKey.toBase58() === pinned ? 10_000n : 5_000n);
    for (let i = 0; i < 5; i++) {
      t.add();
      t.clock.t += 1_000;
      await t.relayer.tick();
    }
    t.add({ kind: "sell", venue: "pumpfun", mint: MINT, amount: 10_000n, minLamports: 1n }); // all of it, one tx
    await t.relayer.tick();
    const dest = "Dest111111111111111111111111111111111111111";
    for (let p = 0; p < 3; p++) {
      t.add({ kind: "withdraw", mint: MINT, to: dest, amount: 1_000n });
      await t.relayer.tick();
    }
    expect(new Set(t.ex.prepared.map((p) => p.vault))).toEqual(new Set([pinned]));
    expect(t.queue.all().every((j) => j.state === "executed")).toBe(true);
  });

  it("a busy pinned vault means wait (retry), never another vault", async () => {
    const mv = new MemoryMintVaults();
    const t = setup(3, mv);
    const pinned = t.vs[1]!.publicKey.toBase58();
    await mv.assign(MINT, pinned);
    await t.pool.lockVault(pinned); // another job holds it
    const id = t.add();
    await t.relayer.tick();
    expect(t.ex.prepared).toEqual([]);
    expect(t.queue.get(id)!.result).toMatchObject({ status: "retry" });
    await t.pool.release(pinned);
    t.clock.t += 5_000;
    await t.relayer.tick();
    expect(t.ex.prepared.map((p) => p.vault)).toEqual([pinned]);
  });

  it("pinned vault short of tokens -> pool_liquidity, other vaults are not used", async () => {
    const mv = new MemoryMintVaults();
    const t = setup(3, mv);
    await mv.assign(MINT, t.vs[0]!.publicKey.toBase58());
    t.inv.tokens.set(`${t.vs[2]!.publicKey.toBase58()}:${MINT}`, 1_000_000n);
    const id = t.add({ kind: "sell", venue: "pumpfun", mint: MINT, amount: 10n, minLamports: 1n });
    await t.relayer.tick();
    expect(t.ex.prepared).toEqual([]);
    expect(t.queue.get(id)!.result).toMatchObject({ code: "pool_liquidity" });
  });

  it("new mints and creates go to the least loaded vaults; create pins its new mint", async () => {
    const mv = new MemoryMintVaults();
    const t = setup(3, mv);
    const [a, b, c] = t.vs.map((v) => v.publicKey.toBase58()) as [string, string, string];
    for (let i = 0; i < 3; i++) await mv.assign(`OldA${i}`, a);
    for (let i = 0; i < 2; i++) await mv.assign(`OldB${i}`, b);
    t.add({ kind: "buy", venue: "pumpfun", mint: MINT2, lamportsIn: 1n, minOut: 1n });
    await t.relayer.tick();
    expect(await mv.get(MINT2)).toBe(c); // c had 0 pins (a=3, b=2)
    const id = t.add({ kind: "create", venue: "pumpfun", meta: { name: "N", symbol: "N" }, lamportsIn: 0n, minOut: 0n });
    t.clock.t += 1_000;
    await t.relayer.tick();
    const e = t.queue.get(id)!.result;
    expect(e).toMatchObject({ status: "executed", execution: { kind: "create" } });
    const created = t.ex.prepared.at(-1)!;
    expect([b, c]).toContain(created.vault); // a (3 pins) is above the median
    expect(await mv.get(`NewMint${created.signature.slice(3)}`)).toBe(created.vault);
  });

  it("two first buys of one mint race: the loser does not trade, retries on the winner's vault", async () => {
    const mv = new MemoryMintVaults();
    const t = setup(3, mv);
    const v2 = t.vs[2]!.publicKey.toBase58();
    const real = mv.assign.bind(mv);
    let raced = false;
    // Another worker pins the mint to vault 2 between our get() and assign().
    mv.assign = async (mint, vault) => {
      if (!raced) {
        raced = true;
        await real(mint, v2);
      }
      return real(mint, vault);
    };
    t.add();
    await t.relayer.tick();
    t.clock.t += 5_000;
    await t.relayer.tick();
    expect(t.ex.prepared.map((p) => p.vault)).toEqual([v2]);
  });
});


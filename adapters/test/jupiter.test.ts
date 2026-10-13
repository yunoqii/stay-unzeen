import fs from "node:fs";
import path from "node:path";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../src/errors";
import {
  JUPITER_KEYLESS_INTERVAL_MS,
  JupiterAdapter,
  JupiterClient,
  checkBuild,
  fillMarket,
  jupiterHttpError,
  jupiterOptionsFromEnv,
  parseBuild,
  routeStatus,
  slippageForMinOut,
  swapAmounts,
  tokenAmountOf,
  type JupiterBuild,
} from "../src/jupiter";
import { SENDER_TIP_ACCOUNTS, senderTip } from "../src/sender";
import { SendGate, type Broadcaster } from "../src/tx";
import { Relayer } from "../src/relayer/engine";
import { InMemoryJobQueue } from "../src/relayer/memory-queue";
import { seededRng } from "../src/relayer/random";
import { VaultPool } from "../src/relayer/vaults";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, vaults } from "./relayer/fakes";

/**
 * Fixtures: live read-only `/swap/v2/build` answers (mainnet, 2026-10-12) for a
 * random throw-away taker, SOL <-> Fartcoin (pump.fun mint, graduated).
 */
const FIX = path.resolve(__dirname, "fixtures");
const MINT = new PublicKey("9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump");
const SOL = NATIVE_MINT.toBase58();
const raw = (side: "buy" | "sell") => fs.readFileSync(path.join(FIX, `jupiter-build-${side}.json`), "utf8");
const FIX_TAKER = (() => {
  const b = JSON.parse(raw("buy")) as JupiterBuild;
  return b.setupInstructions[0]!.accounts[0]!.pubkey;
})();

/** The fixture re-addressed to `vault` (taker and its ATAs), as Jupiter would answer for it. */
function fixtureFor(side: "buy" | "sell", vault: PublicKey): JupiterBuild {
  const old = new PublicKey(FIX_TAKER);
  const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID).toBase58();
  const s = raw(side)
    .split(ata(old, NATIVE_MINT)).join(ata(vault, NATIVE_MINT))
    .split(ata(old, MINT)).join(ata(vault, MINT))
    .split(FIX_TAKER).join(vault.toBase58());
  return parseBuild(JSON.parse(s));
}

const clone = (b: JupiterBuild): JupiterBuild => JSON.parse(JSON.stringify(b));

describe("JupiterClient", () => {
  it("build URL: ExactIn params only, no priority fee / tip / platform fee; key only as header", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response(raw("buy"), { status: 200 });
    }) as unknown as typeof fetch;
    const req = { inputMint: SOL, outputMint: MINT.toBase58(), amount: 10_000_000n, taker: FIX_TAKER, slippageBps: 300 };
    await new JupiterClient({ fetchImpl, gate: new SendGate(0) }).build(req);
    await new JupiterClient({ fetchImpl, gate: new SendGate(0), apiKey: "k-secret" }).build(req);
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.jup.ag/swap/v2/build");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      inputMint: SOL,
      outputMint: MINT.toBase58(),
      amount: "10000000",
      taker: FIX_TAKER,
      slippageBps: "300",
      maxAccounts: "48",
      wrapAndUnwrapSol: "true",
    });
    for (const c of calls) expect(c.url).not.toMatch(/tip|computeUnitPrice|prioritization|platformFee|k-secret/i);
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(calls[1]!.headers["x-api-key"]).toBe("k-secret");
  });

  it("one FIFO gate: keyless requests are >= 2 s apart (0.5 rps), keyed 1 s", async () => {
    for (const [key, gap] of [[null, 2_000], ["k", 1_000]] as const) {
      let t = 0;
      const at: number[] = [];
      const gate = new SendGate(key ? 1_000 : JUPITER_KEYLESS_INTERVAL_MS, () => t, async (ms) => void (t += ms));
      const fetchImpl = (async () => (at.push(t), new Response(raw("buy")))) as unknown as typeof fetch;
      const c = new JupiterClient({ fetchImpl, gate, apiKey: key });
      const req = { inputMint: SOL, outputMint: MINT.toBase58(), amount: 1n, taker: FIX_TAKER, slippageBps: 0 };
      await Promise.all([c.build(req), c.build(req), c.build(req)]);
      expect(at).toEqual([0, gap, 2 * gap]);
    }
    // env can slow it down, never speed it past the plan limit
    expect(jupiterOptionsFromEnv({ JUPITER_MIN_INTERVAL_MS: "100" }).client.minIntervalMs).toBe(2_000);
    expect(jupiterOptionsFromEnv({ JUPITER_API_KEY: "k", JUPITER_MIN_INTERVAL_MS: "100" }).client.minIntervalMs).toBe(1_000);
    expect(jupiterOptionsFromEnv({ JUPITER_MIN_INTERVAL_MS: "5000" }).client.minIntervalMs).toBe(5_000);
  });

  it("HTTP errors: 429 / 5xx / network -> venue_unavailable (retried), no route -> not_found; no key in messages", async () => {
    expect(jupiterHttpError(429, null).code).toBe("venue_unavailable");
    expect(jupiterHttpError(503, null).code).toBe("venue_unavailable");
    expect(jupiterHttpError(400, { error: "Could not find any route", errorCode: "COULD_NOT_FIND_ANY_ROUTE" }).code).toBe("not_found");
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET https://api.jup.ag/?x=k-secret");
    }) as unknown as typeof fetch;
    const e = await new JupiterClient({ fetchImpl, gate: new SendGate(0), apiKey: "k-secret" })
      .build({ inputMint: SOL, outputMint: MINT.toBase58(), amount: 1n, taker: FIX_TAKER, slippageBps: 0 })
      .then(() => null, (x: unknown) => x as AdapterError);
    expect(e).toBeInstanceOf(AdapterError);
    if (!e) throw new Error("expected a failure");
    expect(e.code).toBe("venue_unavailable");
    expect(e.message).not.toMatch(/k-secret|jup\.ag/);
    expect(() => parseBuild({ inAmount: "1" })).toThrow(/malformed/);
  });
});

describe("checkBuild: allowlist of what Jupiter may make the vault sign", () => {
  const vault = Keypair.generate().publicKey;
  const ctx = (side: "buy" | "sell", b: JupiterBuild) => ({
    side,
    taker: vault,
    mint: MINT,
    amountIn: BigInt(b.inAmount),
    minOut: BigInt(b.otherAmountThreshold),
  });

  it("live buy / sell builds pass; Jupiter's compute budget is dropped", () => {
    for (const side of ["buy", "sell"] as const) {
      const b = fixtureFor(side, vault);
      const ixs = checkBuild(b, ctx(side, b));
      expect(ixs.some((i) => i.programId.equals(ComputeBudgetProgram.programId))).toBe(false);
      expect(ixs.filter((i) => i.programId.toBase58() === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).toHaveLength(1);
      expect(ixs.length).toBe(b.setupInstructions.length + 1 + (b.cleanupInstruction ? 1 : 0));
    }
  });

  it("refuses anything that could move vault funds elsewhere or add fees", () => {
    const b = fixtureFor("buy", vault);
    const thief = Keypair.generate().publicKey.toBase58();
    const refuse = (mut: (x: JupiterBuild) => void, re: RegExp) => {
      const x = clone(b);
      mut(x);
      expect(() => checkBuild(x, ctx("buy", b)), String(re)).toThrow(re);
    };
    refuse((x) => (x.tipInstruction = x.setupInstructions[1]!), /tip/);
    refuse((x) => x.otherInstructions.push(x.setupInstructions[1]!), /other/);
    refuse((x) => (x.setupInstructions[1]!.accounts[1]!.pubkey = thief), /system transfer target/);
    refuse((x) => {
      // wrap more than the buy amount
      const d = Buffer.from(x.setupInstructions[1]!.data, "base64");
      d.writeBigUInt64LE(BigInt(b.inAmount) + 1n, 4);
      x.setupInstructions[1]!.data = d.toString("base64");
    }, /wrap amount/);
    refuse((x) => (x.setupInstructions[3]!.accounts[2]!.pubkey = thief), /ata owner/);
    refuse((x) => (x.swapInstruction.programId = SystemProgram.programId.toBase58()), /swap program/);
    refuse((x) => (x.swapInstruction.accounts[0]!.isSigner = true), /foreign signer/);
    refuse((x) => (x.cleanupInstruction!.accounts[1]!.pubkey = thief), /cleanup/);
    refuse((x) => x.setupInstructions.push({ programId: "BPFLoaderUpgradeab1e11111111111111111111111", accounts: [], data: "" }), /setup program/);
    refuse((x) => (x.inAmount = "1"), /amount in/);
    refuse((x) => (x.outputMint = SOL), /mints/);
    refuse((x) => (x.computeBudgetInstructions[0]!.programId = thief), /compute budget program/);
  });

  it("slippage: route below minOut, or a floor below minOut after a re-quote", () => {
    const b = fixtureFor("buy", vault);
    const e1 = (() => {
      try {
        checkBuild(b, { ...ctx("buy", b), minOut: BigInt(b.outAmount) + 1n });
      } catch (e) {
        return e as AdapterError;
      }
    })();
    expect(e1?.code).toBe("slippage");
    const x = clone(b);
    x.otherAmountThreshold = (BigInt(b.otherAmountThreshold) - 1n).toString();
    expect(() => checkBuild(x, ctx("buy", b))).toThrow(/threshold/);
  });

  it("slippage / route helpers", () => {
    expect(slippageForMinOut(10_000n, 9_700n)).toBe(300);
    expect(slippageForMinOut(10_000n, 9_701n)).toBe(299); // rounded down: floor >= minOut
    expect(slippageForMinOut(10_000n, 10_001n)).toBe(0);
    expect(routeStatus({ routePlan: [{ swapInfo: { label: "Pump.fun" } }] })).toBe("curve");
    expect(routeStatus({ routePlan: [{ swapInfo: { label: "Dynamic Bonding Curve" } }] })).toBe("curve");
    expect(routeStatus({ routePlan: [{ swapInfo: { label: "Pump.fun Amm" } }] })).toBe("graduated");
    expect(routeStatus(fixtureFor("sell", vault))).toBe("graduated");
  });
});

// ---------------------------------------------------------------------------
// executed amounts
// ---------------------------------------------------------------------------

function fakeLandedTx(o: {
  keys: PublicKey[];
  pre: number[];
  post: number[];
  fee: number;
  tokens: { owner: string; mint: string; pre: bigint; post: bigint; decimals: number };
}) {
  const tb = (amount: bigint) => [{ accountIndex: 9, mint: o.tokens.mint, owner: o.tokens.owner, uiTokenAmount: { amount: amount.toString(), decimals: o.tokens.decimals } }];
  return {
    slot: 1,
    blockTime: 1_760_000_000,
    transaction: { message: { getAccountKeys: () => ({ length: o.keys.length, get: (i: number) => o.keys[i] }) } },
    meta: { fee: o.fee, err: null, preBalances: o.pre, postBalances: o.post, preTokenBalances: tb(o.tokens.pre), postTokenBalances: tb(o.tokens.post), loadedAddresses: undefined },
  } as never;
}

describe("swapAmounts / fillMarket", () => {
  const vault = Keypair.generate().publicKey;
  const tip = new PublicKey(SENDER_TIP_ACCOUNTS[3]!);
  const newAta = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;

  it("buy: SOL of the trade excludes network fee, tip and the new ATA rent", () => {
    const lamportsIn = 10_000_000;
    const fee = 5_000 + 7_000; // signature + priority
    const rent = 2_039_280;
    const vPre = 1_000_000_000;
    const vPost = vPre - lamportsIn - fee - 5_000 - rent;
    const tx = fakeLandedTx({
      keys: [vault, tip, newAta, pool],
      pre: [vPre, 100, 0, 5_000_000_000],
      post: [vPost, 5_100, rent, 5_000_000_000 + lamportsIn],
      fee,
      tokens: { owner: vault.toBase58(), mint: MINT.toBase58(), pre: 0n, post: 6_669_042n, decimals: 6 },
    });
    expect(swapAmounts(tx, "buy", vault, MINT)).toEqual({ tokenAmount: 6_669_042n, solAmount: 10_000_000n, networkFee: 12_000n, decimals: 6 });
  });

  it("sell: SOL received excludes network fee and tip", () => {
    const fee = 12_000;
    const recv = 1_496_922_866;
    const tx = fakeLandedTx({
      keys: [vault, tip, pool],
      pre: [50_000_000, 0, 9e12],
      post: [50_000_000 + recv - fee - 5_000, 5_000, 9e12 - recv],
      fee,
      tokens: { owner: vault.toBase58(), mint: MINT.toBase58(), pre: 1_000_000_000n, post: 0n, decimals: 6 },
    });
    expect(swapAmounts(tx, "sell", vault, MINT)).toMatchObject({ tokenAmount: 1_000_000_000n, solAmount: BigInt(recv) });
  });

  it("price / cap from a fill", () => {
    // 0.01 SOL for 6.669042 tokens (6 decimals), supply 1e9 tokens
    expect(fillMarket(10_000_000n, 6_669_042n, 6, 10n ** 15n)).toEqual({ priceSol: "0.00149946574035671", marketCapSol: "1499465.74035671" });
    expect(() => fillMarket(1n, 0n, 6, 1n)).toThrow();
  });

  it("token account amount at offset 64", () => {
    const d = Buffer.alloc(165);
    d.writeBigUInt64LE(77n, 64);
    expect(tokenAmountOf(d)).toBe(77n);
    expect(tokenAmountOf(null)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// adapter: signing through the pool pipeline, simulation guard, devnet
// ---------------------------------------------------------------------------

function fakeConnection(vault: PublicKey, build: JupiterBuild, sim: { lamports: (pre: number) => number; tokens: bigint; err?: unknown; others?: { key: PublicKey; pre: bigint; post: bigint | null }[] }) {
  const VAULT_LAMPORTS = 1_000_000_000;
  const tokenAcc = (amount: bigint) => {
    const d = Buffer.alloc(165);
    d.writeBigUInt64LE(amount, 64);
    return d;
  };
  const simulated: VersionedTransaction[] = [];
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => {
        const o = sim.others?.find((x) => x.key.equals(k));
        if (o) {
          const d = tokenAcc(o.pre);
          vault.toBuffer().copy(d, 32); // a token account OF THE VAULT (e.g. its USDC stock)
          return { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data: d, executable: false };
        }
        return k.equals(MINT) ? { owner: TOKEN_PROGRAM_ID, lamports: 1, data: Buffer.alloc(82), executable: false } : { owner: SystemProgram.programId, lamports: VAULT_LAMPORTS, data: Buffer.alloc(0), executable: false };
      }),
    getAccountInfo: async () => null,
    getAddressLookupTable: async (key: PublicKey) => {
      const addrs = build.addressesByLookupTableAddress[key.toBase58()];
      if (!addrs) return { value: null };
      return {
        value: new AddressLookupTableAccount({
          key,
          state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs.map((a) => new PublicKey(a)) },
        }),
      };
    },
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 1_000 }),
    simulateTransaction: async (tx: VersionedTransaction, cfg?: { accounts?: { addresses: string[] } }) => {
      simulated.push(tx);
      const extra = (cfg?.accounts?.addresses ?? []).slice(2).map((a) => {
        const o = sim.others?.find((x) => x.key.toBase58() === a);
        if (!o || o.post === null) return null;
        const d = tokenAcc(o.post);
        vault.toBuffer().copy(d, 32);
        return { lamports: 2_039_280, data: [d.toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 };
      });
      return {
        value: {
          err: sim.err ?? null,
          logs: [],
          accounts: [
            { lamports: sim.lamports(VAULT_LAMPORTS), data: ["", "base64"], owner: SystemProgram.programId.toBase58(), executable: false, rentEpoch: 0 },
            { lamports: 2_039_280, data: [tokenAcc(sim.tokens).toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
            ...extra,
          ],
        },
      };
    },
  };
  return { conn: conn as unknown as Connection, simulated };
}

describe("JupiterAdapter", () => {
  const vault = Keypair.generate();
  const PRICE = 20_000; // the pool-wide quantized price
  const pipeline = { tip: senderTip(5_000n, () => 0), broadcaster: { name: "fake", send: async () => undefined, trySend: async () => undefined } as Broadcaster };

  const adapterFor = (build: JupiterBuild | JupiterBuild[], sim: Parameters<typeof fakeConnection>[2], cluster = "mainnet-beta") => {
    const answers = Array.isArray(build) ? [...build] : [build];
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(answers.length > 1 ? answers.shift() : answers[0]));
    }) as unknown as typeof fetch;
    const { conn, simulated } = fakeConnection(vault.publicKey, Array.isArray(build) ? build[build.length - 1]! : build, sim);
    const a = new JupiterAdapter({ connection: conn, cluster, client: new JupiterClient({ fetchImpl, gate: new SendGate(0) }), priorityMicroLamports: PRICE, pipeline });
    return { a, urls, simulated };
  };

  it("buy: v0 tx with OUR prefix (limit, pool price, Sender tip), Jupiter's price dropped; guard simulated", async () => {
    const b = fixtureFor("buy", vault.publicKey);
    const minOut = BigInt(b.otherAmountThreshold);
    const { a, simulated } = adapterFor(b, { lamports: (p) => p - 10_000_000 - 2_039_280 - 30_000, tokens: BigInt(b.outAmount) });
    const p = await a.prepareBuy(MINT.toBase58(), 10_000_000n, minOut, { vault });
    expect(p).toMatchObject({ kind: "buy", mint: MINT.toBase58(), vault: vault.publicKey.toBase58(), expectedOut: BigInt(b.outAmount) });
    expect(simulated).toHaveLength(1);
    const tx = VersionedTransaction.deserialize(p.raw);
    expect(tx.version).toBe(0);
    expect(bs58.encode(tx.signatures[0]!)).toBe(p.signature);
    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: Object.entries(b.addressesByLookupTableAddress).map(([k, v]) => new AddressLookupTableAccount({ key: new PublicKey(k), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: v.map((x) => new PublicKey(x)) } })) });
    const ixs = tx.message.compiledInstructions.map((ci) => ({ program: keys.get(ci.programIdIndex)!.toBase58(), data: Buffer.from(ci.data), accounts: ci.accountKeyIndexes.map((i) => keys.get(i)!.toBase58()) }));
    const cb = ComputeBudgetProgram.programId.toBase58();
    // prefix: limit, price, tip -- and no other compute budget instruction anywhere
    expect(ixs[0]!.program).toBe(cb);
    expect(ixs[0]!.data[0]).toBe(2); // SetComputeUnitLimit
    expect(ixs[0]!.data.readUInt32LE(1)).toBe(700_000);
    expect(ixs[1]!.program).toBe(cb);
    expect(ixs[1]!.data[0]).toBe(3); // SetComputeUnitPrice
    expect(ixs[1]!.data.readBigUInt64LE(1)).toBe(BigInt(PRICE));
    expect(ixs[2]!.program).toBe(SystemProgram.programId.toBase58());
    expect(ixs[2]!.accounts[1]).toBe(SENDER_TIP_ACCOUNTS[0]);
    expect(ixs.filter((i) => i.program === cb)).toHaveLength(2);
    expect(ixs.some((i) => i.program === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")).toBe(true);
  });

  it("rebuilds once with the exact tolerance when core's minOut is tighter than the default", async () => {
    const b1 = fixtureFor("buy", vault.publicKey);
    const out = BigInt(b1.outAmount);
    const minOut = out - out / 200n; // 0.5 %
    const b2 = clone(b1);
    b2.otherAmountThreshold = minOut.toString();
    const { a, urls } = adapterFor([b1, b2], { lamports: (p) => p - 10_100_000, tokens: out });
    await a.prepareBuy(MINT.toBase58(), 10_000_000n, minOut, { vault });
    expect(urls.map((u) => new URL(u).searchParams.get("slippageBps"))).toEqual(["300", String(slippageForMinOut(out, minOut))]);
  });

  it("guard: simulated fill below minOut -> slippage; vault drained -> refused; both before any send", async () => {
    const b = fixtureFor("buy", vault.publicKey);
    const minOut = BigInt(b.otherAmountThreshold);
    const low = adapterFor(b, { lamports: (p) => p - 10_100_000, tokens: minOut - 1n });
    await expect(low.a.prepareBuy(MINT.toBase58(), 10_000_000n, minOut, { vault })).rejects.toMatchObject({ code: "slippage", stage: "preflight" });
    const drain = adapterFor(b, { lamports: (p) => p - 500_000_000, tokens: BigInt(b.outAmount) });
    await expect(drain.a.prepareBuy(MINT.toBase58(), 10_000_000n, minOut, { vault })).rejects.toMatchObject({ code: "venue_unavailable", stage: "preflight" });
    const s = fixtureFor("sell", vault.publicKey);
    const sellLow = adapterFor(s, { lamports: (p) => p + Number(s.otherAmountThreshold) - 100_000, tokens: 0n });
    await expect(sellLow.a.prepareSell(MINT.toBase58(), 1_000_000_000n, BigInt(s.otherAmountThreshold), { vault })).rejects.toMatchObject({ code: "slippage" });
    const sellOk = adapterFor(s, { lamports: (p) => p + Number(s.outAmount), tokens: 0n });
    await expect(sellOk.a.prepareSell(MINT.toBase58(), 1_000_000_000n, BigInt(s.otherAmountThreshold), { vault })).resolves.toMatchObject({ kind: "sell" });
  });

  it("guard (audit A7): a route that takes ANOTHER vault asset (USDC stock) is refused, even with SOL >= minOut", async () => {
    const s = fixtureFor("sell", vault.publicKey);
    // a writable account of Jupiter's swap instruction, presented as the vault's USDC stock account
    const own = [getAssociatedTokenAddressSync(MINT, vault.publicKey, false, TOKEN_PROGRAM_ID), getAssociatedTokenAddressSync(NATIVE_MINT, vault.publicKey, false, TOKEN_PROGRAM_ID)].map((k) => k.toBase58());
    const victim = new PublicKey(s.swapInstruction.accounts.find((a) => a.isWritable && !a.isSigner && !own.includes(a.pubkey))!.pubkey);
    const forged = adapterFor(s, { lamports: (p) => p + Number(s.outAmount), tokens: 0n, others: [{ key: victim, pre: 50_000_000n, post: 0n }] });
    await expect(forged.a.prepareSell(MINT.toBase58(), 1_000_000_000n, BigInt(s.otherAmountThreshold), { vault })).rejects.toThrow(/another token account of the vault/);
    const closed = adapterFor(s, { lamports: (p) => p + Number(s.outAmount), tokens: 0n, others: [{ key: victim, pre: 1n, post: null }] });
    await expect(closed.a.prepareSell(MINT.toBase58(), 1_000_000_000n, BigInt(s.otherAmountThreshold), { vault })).rejects.toThrow(/another token account/);
    const untouched = adapterFor(s, { lamports: (p) => p + Number(s.outAmount), tokens: 0n, others: [{ key: victim, pre: 50_000_000n, post: 50_000_000n }] });
    await expect(untouched.a.prepareSell(MINT.toBase58(), 1_000_000_000n, BigInt(s.otherAmountThreshold), { vault })).resolves.toMatchObject({ kind: "sell" });
    // the simulation asked for that account too
    expect(untouched.simulated).toHaveLength(1);
  });

  it("devnet -> venue_unavailable without asking Jupiter; create -> bad_request", async () => {
    const b = fixtureFor("buy", vault.publicKey);
    const { a, urls } = adapterFor(b, { lamports: (p) => p, tokens: 0n }, "devnet");
    await expect(a.prepareBuy(MINT.toBase58(), 10_000_000n, 1n, { vault })).rejects.toMatchObject({ code: "venue_unavailable" });
    expect(urls).toHaveLength(0);
    await expect(a.prepareCreate({ name: "a", symbol: "b", uri: "u" }, 0n, 0n)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("program errors: Jupiter / venue slippage -> slippage", () => {
    const { a } = adapterFor(fixtureFor("buy", vault.publicKey), { lamports: (p) => p, tokens: 0n });
    expect(a.classify(new Error("x"), ["Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001."]).code).toBe("slippage");
    expect(a.classify(new Error("failed"), ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771"]).code).toBe("slippage");
    expect(a.classify(new Error("Program failed: exceeded CUs meter at BPF instruction"), null).code).toBe("venue_unavailable");
  });
});

describe("relayer: venue jupiter without an executor (devnet)", () => {
  it("fails venue_unavailable before anything is signed", async () => {
    const chain = new FakeChain();
    const clock = new FakeClock(1_700_000_000_000, chain);
    const inv = new FakeInventory();
    const pool = new VaultPool(vaults(1, inv), inv, seededRng(9));
    const q = new InMemoryJobQueue(seededRng(9));
    const ex = new FakeExecutor(chain);
    const relayer = new Relayer({ queue: q, pool, executors: { trade: { pumpfun: ex }, withdraw: ex }, probe: chain, clock, rng: seededRng(9) });
    const j = q.enqueue({ kind: "buy", venue: "jupiter", mint: MINT.toBase58(), lamportsIn: 1_000_000n, minOut: 1n }, { notBefore: clock.now() });
    expect(await relayer.tick()).toBe(true);
    expect(q.get(j.id)!.state).toBe("failed");
    expect(q.get(j.id)!.result).toMatchObject({ status: "failed", code: "venue_unavailable" });
    expect(ex.prepared).toHaveLength(0);
  });
});

/** Opt-in live check (read-only, mainnet): JUPITER_LIVE=1 pnpm vitest run test/jupiter.test.ts */
describe.skipIf(process.env.JUPITER_LIVE !== "1")("live /swap/v2/build (read-only, random taker, nothing signed)", () => {
  it("answers and passes the allowlist", async () => {
    const taker = Keypair.generate().publicKey;
    const c = new JupiterClient({ apiKey: process.env.JUPITER_API_KEY ?? null });
    const b = await c.build({ inputMint: SOL, outputMint: MINT.toBase58(), amount: 10_000_000n, taker: taker.toBase58(), slippageBps: 300 });
    expect(() => checkBuild(b, { side: "buy", taker, mint: MINT, amountIn: 10_000_000n, minOut: BigInt(b.otherAmountThreshold) })).not.toThrow();
  }, 30_000);
});

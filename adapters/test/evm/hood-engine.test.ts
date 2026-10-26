/**
 * review-hood-final fixes, engine level (fakes, no network):
 * #1 RPC errors never re-execute; #5 send time from SentClock, not updated_at;
 * #5/#8 landed-but-unreadable -> attention, never failed; #6 prices never "0".
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicClient, custom, HttpRequestError, type Address, type Hex, type PublicClient } from "viem";
import { AdapterError } from "../../src/errors";
import { hoodMainnet } from "../../src/evm/chain";
import { EvmExecutor } from "../../src/evm/executor";
import { EvmFeeCache } from "../../src/evm/fees";
import { EvmKeyring } from "../../src/evm/keys";
import { LifiClient, LIFI_DIAMOND_4663 } from "../../src/evm/lifi";
import { ATTEST_NO_GAS_RETRY_MS, HoodRelayer, type HoodRelayerEvent } from "../../src/evm/relayer/engine";
import { MemoryLaunchStore, MemorySentClock } from "../../src/evm/relayer/launches";
import { writeTokenPrices } from "../../src/evm/relayer/pool-state";
import type { HoodClaimedJob, HoodJobResult, HoodQueue } from "../../src/evm/relayer/queue";
import { MemoryMintVaults } from "../../src/relayer/mint-vaults";
import { MemoryVaultLock } from "../../src/relayer/vaults";
import { TEST_MNEMONIC } from "./cases";

const kr = new EvmKeyring(TEST_MNEMONIC);
const TOKEN = "0xcd70E319F13D4611F2e5f5D603C52724bCea3300" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;

/** Minimal chain: answers are programmable per method. */
function chain(h: Record<string, (params: unknown) => unknown>): PublicClient {
  return createPublicClient({
    chain: hoodMainnet,
    transport: custom({
      async request({ method, params }) {
        const f = h[method];
        if (!f) throw new Error(`unexpected ${method}`);
        return f(params);
      },
    }),
  }) as PublicClient;
}

function setup(o: { client: PublicClient; job: HoodClaimedJob; clock?: MemorySentClock; adapter?: Record<string, unknown> }) {
  const results: HoodJobResult[] = [];
  const events: HoodRelayerEvent[] = [];
  let claimed = false;
  const queue: HoodQueue = {
    claim: async () => (claimed ? null : ((claimed = true), o.job)),
    reportSent: async () => undefined,
    reportResult: async (_j, r) => void results.push(r),
    status: async () => null,
  };
  const ex = new EvmExecutor({ read: o.client, chainId: 4663, fees: new EvmFeeCache(200_000_000n, async () => 1n), allowSend: true });
  const calls: string[] = [];
  const adapter = new Proxy(o.adapter ?? {}, {
    get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : async () => (calls.push(String(k)), Promise.reject(new Error(`adapter.${String(k)} must not be called`)))),
  });
  const relayer = new HoodRelayer({
    queue,
    adapter: adapter as never,
    executor: ex,
    keyring: kr,
    vaults: [kr.vault(0)],
    mintVaults: new MemoryMintVaults(),
    lock: new MemoryVaultLock(),
    launches: new MemoryLaunchStore(),
    sentClock: o.clock ?? new MemorySentClock(),
    withdrawer: {} as never,
    sleep: async () => undefined,
    onEvent: (e) => void events.push(e),
  });
  return { relayer, results, events, calls };
}

const buyJob = (claims = 1, sentAt = Date.now()): HoodClaimedJob => ({
  id: "7",
  spec: { kind: "buy", token: TOKEN, weiIn: 10n ** 16n, minOut: 1n },
  notBefore: 0,
  claims,
  sent: { hash: HASH, nonce: 5, vault: kr.vault(0).address, sentAt },
  leaseId: "l",
});

describe("#1 lookup: only 'not found' is unknown", () => {
  it("receipt null -> unknown; 429 -> throws (never 'not sent')", async () => {
    const ok = new EvmExecutor({
      read: chain({ eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null }),
      chainId: 4663,
      fees: new EvmFeeCache(1n, async () => 1n),
      allowSend: false,
    });
    expect((await ok.lookup(HASH)).state).toBe("unknown");
    const limited = new EvmExecutor({
      read: chain({
        eth_getTransactionReceipt: () => {
          throw new HttpRequestError({ url: "https://rpc", status: 429 });
        },
      }),
      chainId: 4663,
      fees: new EvmFeeCache(1n, async () => 1n),
      allowSend: false,
    });
    await expect(limited.lookup(HASH)).rejects.toMatchObject({ code: "venue_unavailable" });
  });

  it("engine: RPC error on a recorded tx -> retry, nothing re-executed", async () => {
    const client = chain({
      eth_getTransactionReceipt: () => {
        throw new HttpRequestError({ url: "https://rpc", status: 429 });
      },
    });
    const { relayer, results, calls } = setup({ client, job: buyJob(1, 0) });
    await relayer.tick();
    expect(results[0]!.status).toBe("retry");
    expect(calls).toEqual([]); // no buy
  });

  it("engine: nonce taken but hash unknown everywhere twice -> only then re-executed", async () => {
    const client = chain({ eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null, eth_getTransactionCount: () => "0x9" });
    const { relayer, calls } = setup({ client, job: buyJob(1, 0) });
    await relayer.tick();
    expect(calls).toContain("buy"); // re-executed after the double check (fake adapter refuses, job retried)
  });
});

describe("#5 send time: SentClock, not updated_at", () => {
  it("updated_at says 'old', clock says 'just sent' -> wait, no re-execution", async () => {
    const clock = new MemorySentClock();
    await clock.mark("7", HASH, Date.now());
    const client = chain({ eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null, eth_getTransactionCount: () => "0x5" });
    const { relayer, results, calls } = setup({ client, job: buyJob(3, 0), clock });
    await relayer.tick();
    expect(results[0]).toMatchObject({ status: "retry", message: "tx not visible yet" });
    expect(calls).toEqual([]);
  });

  it("clock past the grace, nonce free, unknown on every provider -> execute anew", async () => {
    const clock = new MemorySentClock();
    await clock.mark("7", HASH, Date.now() - 120_000);
    const client = chain({ eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null, eth_getTransactionCount: () => "0x5" });
    const { relayer, calls } = setup({ client, job: buyJob(1, Date.now()), clock });
    await relayer.tick();
    expect(calls).toContain("buy");
  });
});

describe("#5/#8 landed but amounts unreadable", () => {
  const receipt = {
    transactionHash: HASH,
    blockHash: `0x${"22".repeat(32)}`,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    from: kr.vault(0).address,
    to: TOKEN,
    cumulativeGasUsed: "0x1",
    gasUsed: "0x1",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    type: "0x2",
  };
  const adapter = {
    resultFromReceipt: async () => ({ amountsKnown: false, kind: "buy", sideTxs: [], route: "curve" }),
  };
  it("never failed: needs_review at once (RELAYER v15, ZEC stays held), re-parsed later", async () => {
    const client = chain({ eth_getTransactionReceipt: () => receipt });
    const a = setup({ client, job: buyJob(2), adapter });
    await a.relayer.tick();
    expect(a.results[0]).toMatchObject({ status: "needs_review" });
    expect(a.events.some((e) => e.event === "needs_review")).toBe(true);
    // A receipt that cannot even be parsed -> needs_review too (not failed).
    const b = setup({ client, job: buyJob(1), adapter: { resultFromReceipt: async () => Promise.reject(new AdapterError("internal", "launch receipt without TokenLaunched", { stage: "confirm" })) } });
    await b.relayer.tick();
    expect(b.results[0]!.status).toBe("needs_review");
  });

  it("adapter 'landed but event not found' errors are stage=confirm (retry, not failed)", async () => {
    const e = new AdapterError("internal", "buy landed but CurveBuy not found", { signature: HASH, stage: "confirm" });
    expect(e.stage).toBe("confirm");
  });
});

describe("#6 prices: never 0", () => {
  it("writes real quotes, skips zero / unreadable ones", async () => {
    const writes: unknown[][] = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.startsWith("SELECT mint FROM mint_vaults")) return { rows: [{ mint: TOKEN }, { mint: kr.vault(1).address }, { mint: kr.vault(2).address }] };
        writes.push(params);
        return { rows: [] };
      },
    };
    const adapter = {
      quote: async (m: Address) => {
        if (m === TOKEN) return { priceEth: "0.000000016", marketCapEth: "16", status: "graduated", amountOut: 5n };
        if (m === kr.vault(1).address) return { priceEth: "0", marketCapEth: "0", status: "graduated", amountOut: 0n };
        throw new Error("quoter down");
      },
    };
    const r = await writeTokenPrices(db as never, "hood", adapter as never);
    expect(r).toEqual({ written: 1, skipped: 2 });
    expect(writes).toEqual([[TOKEN, "0.000000016", "16", "graduated"]]);
  });
});

describe("#7 LI.FI: a rejected route is final", () => {
  it("rejection code is internal (failed), not a transient retry", () => {
    const c = new LifiClient(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    try {
      c.validate({ tool: "x", action: {}, estimate: {}, transactionRequest: { to: LIFI_DIAMOND_4663, data: "0x", chainId: 4663 } }, {
        fromToken: "0x0000000000000000000000000000000000000000",
        toToken: TOKEN,
        fromAmount: 1n,
        vault: kr.vault(0).address,
        minOut: 1n,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AdapterError).apiCode).toBe("internal");
    }
  });
});

describe("relayer:hood mainnet guard", () => {
  it("refuses to start without UNZEEN_ALLOW_HOOD_MAINNET=yes", () => {
    const r = spawnSync("npx", ["tsx", path.join(__dirname, "../../scripts/relayer-hood.ts")], {
      env: { ...process.env, UNZEEN_HOOD: "on", HOOD_NETWORK: "mainnet", UNZEEN_ALLOW_HOOD_MAINNET: "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hood mainnet sends are disabled/);
  }, 70_000);
});

describe("attest without gas on the attestation key", () => {
  it("waits ATTEST_NO_GAS_RETRY_MS (pool_liquidity), signs and sends nothing", async () => {
    const asked: string[] = [];
    const client = chain({
      eth_getBalance: (p) => (asked.push(String((p as unknown[])[0]).toLowerCase()), "0x0"),
    });
    const job: HoodClaimedJob = { id: "9", spec: { kind: "attest", memo: "ab".repeat(32), purpose: "verify" }, notBefore: 0, claims: 1, sent: null, leaseId: "l" };
    const before = Date.now();
    const { relayer, results } = setup({ client, job });
    await relayer.tick();
    const r = results[0]!;
    expect(r.status).toBe("retry");
    expect(r.status === "retry" && r.code).toBe("pool_liquidity");
    expect(r.status === "retry" && r.notBefore >= before + ATTEST_NO_GAS_RETRY_MS).toBe(true);
    expect(asked).toEqual([kr.attest("verify").address.toLowerCase()]);
  });
});

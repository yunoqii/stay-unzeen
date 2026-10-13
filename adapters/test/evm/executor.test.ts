import { describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  encodeErrorResult,
  HttpRequestError,
  keccak256,
  parseTransaction,
  RawContractError,
  type Hex,
  type PublicClient,
} from "viem";
import { RateLimiter, hoodMainnet, loadHoodConfig } from "../../src/evm/chain";
import { classifyEvmError } from "../../src/evm/errors";
import { EvmExecutor } from "../../src/evm/executor";
import { EvmFeeCache, FEE_LOWER_INTERVAL_MS, quantizeGasLimit } from "../../src/evm/fees";
import { EvmKeyring } from "../../src/evm/keys";
import { NonceManager } from "../../src/evm/nonce";
import { ponsV2CurveAbi } from "../../src/evm/pons/abi/curve";
import { PONS_ERROR_ABI } from "../../src/evm/pons/adapter";
import { checkVerifySnapshot, signVerifySnapshot } from "../../src/evm/attest";
import { TEST_MNEMONIC } from "./cases";

describe("fee profile", () => {
  it("gas limit: estimate x1.2 rounded up to 100k buckets", () => {
    expect(quantizeGasLimit(1n)).toBe(100_000n);
    expect(quantizeGasLimit(150_000n)).toBe(200_000n);
    expect(quantizeGasLimit(4_560_000n)).toBe(5_500_000n);
    expect(quantizeGasLimit(83_333n)).toBe(100_000n);
    expect(quantizeGasLimit(83_334n)).toBe(200_000n);
    expect(() => quantizeGasLimit(0n)).toThrow();
  });

  it("maxFeePerGas is a constant: rises at once when base fee x4 does not fit, falls only after a day", async () => {
    let base = 20_000_000n; // 0.02 gwei
    let now = 0;
    const fc = new EvmFeeCache(200_000_000n, async () => base, () => now);
    expect(fc.profile()).toEqual({ type: "eip1559", maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n });
    await fc.refresh();
    expect(fc.maxFeePerGas).toBe(200_000_000n);
    base = 120_000_000n; // x4 = 0.48 gwei -> 0.5 gwei
    await fc.refresh();
    expect(fc.maxFeePerGas).toBe(500_000_000n);
    base = 20_000_000n;
    now += FEE_LOWER_INTERVAL_MS - 1;
    await fc.refresh();
    expect(fc.maxFeePerGas).toBe(500_000_000n);
    now += 1;
    await fc.refresh();
    expect(fc.maxFeePerGas).toBe(200_000_000n);
  });
});

describe("nonce manager", () => {
  it("serializes per address, advances only on broadcast, re-reads after an error", async () => {
    let reads = 0;
    const nm = new NonceManager(async () => {
      reads++;
      return 10;
    });
    const a = "0x00000000000000000000000000000000000000Aa" as const;
    const order: number[] = [];
    const slow = (n: number) => new Promise<{ value: number; broadcast: boolean }>((r) => setTimeout(() => (order.push(n), r({ value: n, broadcast: true })), 20));
    const got = await Promise.all([nm.withNonce(a, slow), nm.withNonce(a, slow), nm.withNonce(a, async (n) => ({ value: n, broadcast: true }))]);
    expect(got).toEqual([10, 11, 12]);
    expect(order).toEqual([10, 11]);
    expect(reads).toBe(1);
    expect(await nm.withNonce(a, async (n) => ({ value: n, broadcast: false }))).toBe(13);
    expect(nm.peek(a)).toBe(13);
    await expect(nm.withNonce(a, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(nm.peek(a)).toBeUndefined();
    await nm.withNonce(a, async (n) => ({ value: n, broadcast: true }));
    expect(reads).toBe(2);
  });
});

describe("rate limiter", () => {
  it("token bucket: burst then rps", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(2, 2, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    await rl.take();
    await rl.take();
    expect(sleeps).toEqual([]);
    await rl.take();
    expect(sleeps).toEqual([500]);
  });
});

describe("hood config", () => {
  it("testnet by default, public RPC, mainnet read-only unless approved", () => {
    const c = loadHoodConfig({ UNZEEN_HOME: "/x" });
    expect(c.network).toBe("testnet");
    expect(c.chainId).toBe(46630);
    expect(c.rpcSource).toBe("public");
    expect(c.allowSend).toBe(true);
    expect(c.keysDir).toBe("/x/hood-testnet/evm");
    const m = loadHoodConfig({ HOOD_NETWORK: "mainnet", HOOD_RPC_URL_MAINNET: "https://k.example/abc" });
    expect(m.chainId).toBe(4663);
    expect(m.allowSend).toBe(false);
    expect(m.rpcSource).toBe("HOOD_RPC_URL_MAINNET");
    expect(m.maxRps).toBe(20);
    expect(loadHoodConfig({ HOOD_NETWORK: "mainnet", UNZEEN_ALLOW_HOOD_MAINNET: "yes" }).allowSend).toBe(true);
    expect(() => loadHoodConfig({ HOOD_NETWORK: "devnet" })).toThrow();
  });
});

/** Minimal sequencer mock: records raw txs, answers receipts. */
function mockChain(opts: { sendErrors?: string[]; revert?: Hex; baseFee?: bigint } = {}) {
  const raws: Hex[] = [];
  const errors = [...(opts.sendErrors ?? [])];
  let countReads = 0;
  const client = createPublicClient({
    chain: hoodMainnet,
    transport: custom({
      async request({ method, params }) {
        switch (method) {
          case "eth_chainId":
            return "0x1237";
          case "eth_estimateGas":
            return "0x249f0"; // 150 000
          case "eth_getTransactionCount":
            countReads++;
            return "0x5";
          case "eth_blockNumber":
            return "0x64";
          case "eth_getBlockByNumber":
            return { number: "0x64", baseFeePerGas: `0x${(opts.baseFee ?? 20_000_000n).toString(16)}`, timestamp: "0x1", hash: `0x${"11".repeat(32)}`, transactions: [] };
          case "eth_sendRawTransaction": {
            const e = errors.shift();
            if (e) throw new Error(e);
            const raw = (params as Hex[])[0]!;
            raws.push(raw);
            return keccak256(raw);
          }
          case "eth_getTransactionReceipt": {
            const h = (params as Hex[])[0]!;
            return {
              transactionHash: h,
              blockHash: `0x${"22".repeat(32)}`,
              blockNumber: "0x64",
              transactionIndex: "0x0",
              from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
              to: "0x00000000000000000000000000000000000000bb",
              cumulativeGasUsed: "0x249f0",
              gasUsed: "0x249f0",
              effectiveGasPrice: "0x1312d00",
              contractAddress: null,
              logs: [],
              logsBloom: `0x${"00".repeat(256)}`,
              status: opts.revert ? "0x0" : "0x1",
              type: "0x2",
            };
          }
          case "eth_call":
            if (opts.revert) throw Object.assign(new RawContractError({ data: opts.revert }), {});
            return "0x";
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
    }),
  }) as PublicClient;
  return { client, raws, countReads: () => countReads };
}

describe("EVM executor", () => {
  const kr = new EvmKeyring(TEST_MNEMONIC);
  const call = { to: "0x00000000000000000000000000000000000000bb" as const, data: "0x1234" as Hex, value: 7n };

  it("signs type-2, tip 0, the constant maxFee, quantized gas, sequential nonces", async () => {
    const m = mockChain();
    const fees = new EvmFeeCache(200_000_000n, async () => 20_000_000n);
    const ex = new EvmExecutor({ read: m.client, chainId: 4663, fees, allowSend: true, pollingIntervalMs: 1 });
    const r1 = await ex.send(kr.vault(0), call);
    const r2 = await ex.send(kr.vault(0), call);
    const [t1, t2] = m.raws.map((r) => parseTransaction(r));
    expect(t1!.type).toBe("eip1559");
    expect(t1!.chainId).toBe(4663);
    expect(t1!.maxPriorityFeePerGas ?? 0n).toBe(0n);
    expect(t1!.maxFeePerGas).toBe(200_000_000n);
    expect(t1!.gas).toBe(200_000n);
    expect(t1!.value).toBe(7n);
    expect([t1!.nonce, t2!.nonce]).toEqual([5, 6]);
    expect(m.countReads()).toBe(1);
    expect(r1.networkFee).toBe(150_000n * 20_000_000n);
    expect(r1.hash).toBe(keccak256(m.raws[0]!));
    expect(r2.gasLimit).toBe(200_000n);
  });

  it("refuses to send on a read-only network before touching the RPC", async () => {
    const m = mockChain();
    const ex = new EvmExecutor({ read: m.client, chainId: 4663, fees: new EvmFeeCache(1n, async () => 1n), allowSend: false });
    await expect(ex.send(kr.vault(0), call)).rejects.toMatchObject({ code: "venue_unavailable", stage: "build" });
    expect(m.raws).toEqual([]);
  });

  it("base fee rejection: refresh the cache and retry once", async () => {
    const m = mockChain({ sendErrors: ["max fee per gas less than block base fee"] });
    let base = 20_000_000n;
    const fees = new EvmFeeCache(200_000_000n, async () => base);
    base = 100_000_000n;
    const ex = new EvmExecutor({ read: m.client, chainId: 4663, fees, allowSend: true, pollingIntervalMs: 1 });
    await ex.send(kr.vault(0), call);
    expect(parseTransaction(m.raws[0]!).maxFeePerGas).toBe(400_000_000n);
  });

  it("nonce too low: venue_unavailable (never broadcast), nonce re-read next time", async () => {
    const m = mockChain({ sendErrors: ["nonce too low"] });
    const ex = new EvmExecutor({ read: m.client, chainId: 4663, fees: new EvmFeeCache(200_000_000n, async () => 1n), allowSend: true, pollingIntervalMs: 1 });
    await expect(ex.send(kr.vault(0), call)).rejects.toMatchObject({ code: "venue_unavailable", stage: "preflight" });
    await ex.send(kr.vault(0), call);
    expect(m.countReads()).toBe(2);
  });

  it("a landed revert is decoded into the API code with the hash attached", async () => {
    const data = encodeErrorResult({ abi: ponsV2CurveAbi, errorName: "SlippageExceeded", args: [1n, 2n] });
    const m = mockChain({ revert: data });
    const ex = new EvmExecutor({ read: m.client, chainId: 4663, fees: new EvmFeeCache(200_000_000n, async () => 1n), allowSend: true, errorAbi: PONS_ERROR_ABI, pollingIntervalMs: 1 });
    const e = await ex.send(kr.vault(0), call, { gasLimit: 300_000n }).catch((x) => x);
    expect(e.code).toBe("slippage");
    expect(e.landedErr).toBe(true);
    expect(e.signature).toBe(keccak256(m.raws[0]!));
  });
});

describe("EVM error classification", () => {
  it("custom errors -> API codes", () => {
    const mk = (errorName: string, args: readonly unknown[] = []) =>
      new ContractFunctionRevertedError({ abi: ponsV2CurveAbi, functionName: "buy", data: encodeErrorResult({ abi: ponsV2CurveAbi, errorName: errorName as never, args: args as never }) });
    expect(classifyEvmError(mk("SlippageExceeded", [1n, 2n])).apiCode).toBe("slippage");
    expect(classifyEvmError(mk("CurveGraduated")).apiCode).toBe("graduated");
    const ins = classifyEvmError(mk("ERC20InsufficientBalance", ["0x00000000000000000000000000000000000000aa", 1n, 2n]));
    expect(ins.code).toBe("insufficient_tokens");
    expect(ins.apiCode).toBe("pool_liquidity");
    expect(classifyEvmError(mk("NotInitialized")).apiCode).toBe("not_found");
  });

  it("raw revert data is decoded with the merged Pons ABI", () => {
    const data = encodeErrorResult({ abi: ponsV2CurveAbi, errorName: "CurveGraduated" });
    const err = new BaseError("estimate failed", { cause: new RawContractError({ data }) });
    expect(classifyEvmError(err, "preflight", undefined, PONS_ERROR_ABI).code).toBe("graduated");
  });

  it("funds and transport", () => {
    expect(classifyEvmError(new Error("insufficient funds for gas * price + value")).apiCode).toBe("pool_liquidity");
    expect(classifyEvmError(new HttpRequestError({ url: "https://x" })).apiCode).toBe("venue_unavailable");
    expect(classifyEvmError(new Error("weird")).apiCode).toBe("internal");
  });
});

describe("Verify EIP-712 statement", () => {
  it("signs with the address's key, bound to the chain id", async () => {
    const kr = new EvmKeyring(TEST_MNEMONIC);
    const acc = kr.vault(0);
    const sig = await signVerifySnapshot(acc, 4663, "snap-1", 123n);
    const st = { snapshotId: "snap-1", address: acc.address, blockNumber: 123n };
    expect(await checkVerifySnapshot(4663, st, sig)).toBe(true);
    expect(await checkVerifySnapshot(46630, st, sig)).toBe(false);
    expect(await checkVerifySnapshot(4663, { ...st, blockNumber: 124n }, sig)).toBe(false);
    expect(await checkVerifySnapshot(4663, { ...st, address: kr.vault(1).address }, sig)).toBe(false);
  });
});

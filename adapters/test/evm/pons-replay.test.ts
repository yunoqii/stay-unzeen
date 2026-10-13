/**
 * Read-only replay of real Robinhood Chain mainnet data (recorded by
 * `pnpm evm:fixtures`, test/fixtures/evm/pons-mainnet.json.gz). No network.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  toFunctionSelector,
  type AbiFunction,
  type Hex,
  type PublicClient,
} from "viem";
import { hoodMainnet } from "../../src/evm/chain";
import { CURVE_FUNCTIONS_IN_BYTECODE, ponsV2CurveAbi } from "../../src/evm/pons/abi/curve";
import { ponsV2LaunchAndBuyAbi } from "../../src/evm/pons/abi/launch-and-buy.generated";
import { ponsV2LaunchFactoryAbi } from "../../src/evm/pons/abi/factory.generated";
import { ponsV2TokenAbi, TOKEN_FUNCTIONS_IN_BYTECODE } from "../../src/evm/pons/abi/token";
import { PONS_V2_MAINNET } from "../../src/evm/pons/addresses";
import { priceRealBuy, priceRealSell, readOnlyAdapter, type RealBuyCase, type RealSellCase } from "./cases";
import { replayClient, type RpcFixture } from "./replay";

interface Fixture {
  buyCase: RealBuyCase;
  sellCase: RealSellCase;
  launchCase: { hash: Hex; input: Hex; value: string; token: Hex; curve: Hex; recipient: Hex; tokensReceived: string };
  live: { token: Hex; curve: Hex; head: string; status: string; quoteBuy: Record<string, string>; quoteSell: Record<string, string>; terms: Record<string, unknown> };
  code: { curve: Hex; token: Hex };
  rpc: RpcFixture;
}

const fx = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "../fixtures/evm/pons-mainnet.json.gz"))).toString("utf8"),
) as Fixture;

function selectorsIn(code: Hex): Set<string> {
  // PUSH4 <selector> (0x63) occurrences in runtime bytecode.
  const out = new Set<string>();
  const hex = code.slice(2);
  for (let i = 0; i + 10 <= hex.length; i += 2) if (hex.slice(i, i + 2) === "63") out.add(hex.slice(i + 2, i + 10));
  return out;
}

describe("pons ABI provenance", () => {
  it("every hand-written curve function is in the live curve bytecode", () => {
    const sel = selectorsIn(fx.code.curve);
    for (const name of CURVE_FUNCTIONS_IN_BYTECODE) {
      const f = ponsV2CurveAbi.find((x) => x.type === "function" && x.name === name) as AbiFunction;
      expect(sel.has(toFunctionSelector(f).slice(2)), name).toBe(true);
    }
  });

  it("every hand-written token function is in the live token bytecode", () => {
    const sel = selectorsIn(fx.code.token);
    for (const name of TOKEN_FUNCTIONS_IN_BYTECODE) {
      const f = ponsV2TokenAbi.find((x) => x.type === "function" && x.name === name) as AbiFunction;
      expect(sel.has(toFunctionSelector(f).slice(2)), name).toBe(true);
    }
  });

  it("pinned code hashes match the recorded mainnet code", () => {
    for (const [addr, want] of [
      [PONS_V2_MAINNET.factory, PONS_V2_MAINNET.codeHash.factory],
      [PONS_V2_MAINNET.launchAndBuy, PONS_V2_MAINNET.codeHash.launchAndBuy],
      [PONS_V2_MAINNET.feeEscrow, PONS_V2_MAINNET.codeHash.feeEscrow],
    ] as const) {
      const code = fx.rpc[JSON.stringify(["eth_getCode", [addr.toLowerCase(), "latest"]])] as Hex;
      expect(keccak256(code)).toBe(want);
    }
  });

  it("a real mainnet launchAndBuy decodes and re-encodes byte-for-byte with the Sourcify ABI", () => {
    const d = decodeFunctionData({ abi: ponsV2LaunchAndBuyAbi, data: fx.launchCase.input });
    expect(d.functionName).toBe("launchAndBuy");
    const re = encodeFunctionData({ abi: ponsV2LaunchAndBuyAbi, functionName: "launchAndBuy", args: d.args as never });
    expect(re).toBe(fx.launchCase.input);
    const [params, , , , , recipient] = d.args as readonly [{ creatorFeeRecipient: string }, bigint, string, bigint, bigint, string, readonly string[]];
    expect(recipient.toLowerCase()).toBe(fx.launchCase.recipient.toLowerCase());
    expect(params.creatorFeeRecipient).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("pons local math vs real mainnet trades", () => {
  const client = replayClient(fx.rpc);
  const adapter = readOnlyAdapter(client);

  it("reproduces a real buy exactly (tokensOut, fee, tax) from the state one block earlier", async () => {
    const q = await priceRealBuy(adapter, client, fx.buyCase);
    expect(q.tokensOut.toString()).toBe(fx.buyCase.tokensOut);
    expect(q.fee.toString()).toBe(fx.buyCase.fee);
    expect(q.tax.toString()).toBe(fx.buyCase.tax);
  });

  it("reproduces a real sell exactly (quoteOut, fee, creator tax)", async () => {
    const q = await priceRealSell(adapter, fx.sellCase);
    expect(q.quoteOut.toString()).toBe(fx.sellCase.quoteOut);
    expect(q.fee.toString()).toBe(fx.sellCase.fee);
    expect(q.tax.toString()).toBe(fx.sellCase.tax);
  });
});

describe("pons adapter reads (replay)", () => {
  const client = replayClient(fx.rpc);
  const adapter = readOnlyAdapter(client);

  it("verifies the deployment pins", async () => {
    await adapter.verifyDeployment();
  });

  it("status and quotes match the recorded run", async () => {
    expect(await adapter.status(fx.live.token)).toBe(fx.live.status);
    const qb = await adapter.quote(fx.live.token, "buy", BigInt(fx.live.quoteBuy.amountIn!));
    expect(qb.amountOut.toString()).toBe(fx.live.quoteBuy.amountOut);
    expect(qb.priceEth).toBe(fx.live.quoteBuy.priceEth);
    expect(qb.marketCapEth).toBe(fx.live.quoteBuy.marketCapEth);
    const qs = await adapter.quote(fx.live.token, "sell", BigInt(fx.live.quoteSell.amountIn!));
    expect(qs.amountOut.toString()).toBe(fx.live.quoteSell.amountOut);
    expect(qs.blockNumber.toString()).toBe(fx.live.head);
  });

  it("factory terms (launch fee, snipe tax, config 0)", async () => {
    const t = await adapter.factoryTerms();
    expect(t.launchFee).toBe(500_000_000_000_000n);
    expect(t.snipeTaxStartBps).toBe(9900n);
    expect(t.snipeTaxSeconds).toBe(3n);
    expect(t.config.curveFeeBps).toBe(100n);
    expect(t.config.graduationThreshold).toBe(42n * 10n ** 17n);
  });

  it("sends are refused on a read-only (mainnet) executor before any RPC", async () => {
    const e = await adapter.buy(fx.live.token, 1n, 1n).catch((x) => x);
    expect(e.code).toBe("venue_unavailable");
    expect(e.stage).toBe("build");
    const e2 = await adapter.create({ name: "x", symbol: "X" }, 1n).catch((x) => x);
    expect(e2.code).toBe("venue_unavailable");
  });
});

describe("pons adapter: unknown token and graduated phase (mock RPC)", () => {
  function mockFactory(exists: boolean, phase: number): PublicClient {
    const result = {
      token: "0x00000000000000000000000000000000000000aa",
      curve: "0x00000000000000000000000000000000000000bb",
      deployer: "0x00000000000000000000000000000000000000cc",
      creatorFeeRecipient: "0x00000000000000000000000000000000000000cc",
      pairToken: "0x0000000000000000000000000000000000000000",
      graduationThreshold: 42n * 10n ** 17n,
      poolFee: 0,
      tickSpacing: 200,
      creatorTaxBps: 0,
      buybackEnabled: false,
      phase,
      sweptQuote: 0n,
      sweptTokens: 0n,
      sweptAt: 0n,
      exists,
    } as const;
    return createPublicClient({
      chain: hoodMainnet,
      transport: custom({
        async request({ method, params }) {
          const to = ((params as [{ to?: string }])?.[0]?.to ?? "").toLowerCase();
          if (method === "eth_call" && to === PONS_V2_MAINNET.factory.toLowerCase())
            return encodeFunctionResult({ abi: ponsV2LaunchFactoryAbi, functionName: "getLaunchedToken", result });
          if (method === "eth_call") return `0x${"00".repeat(128)}`; // StateView.getSlot0: pool not initialized
          throw new Error(`unexpected ${method}`);
        },
      }),
    }) as PublicClient;
  }

  it("not a Pons token -> not_found (404)", async () => {
    const e = await readOnlyAdapter(mockFactory(false, 0)).status("0x00000000000000000000000000000000000000aa").catch((x) => x);
    expect(e.code).toBe("not_found");
    expect(e.apiCode).toBe("not_found");
  });

  it("graduated: status graduated; v4 pool missing -> 503; rescued (no pool) -> 409 graduated; seeding -> 503", async () => {
    const a = readOnlyAdapter(mockFactory(true, 2));
    expect(await a.status("0x00000000000000000000000000000000000000aa")).toBe("graduated");
    const e = await a.quote("0x00000000000000000000000000000000000000aa", "buy", 1n).catch((x) => x);
    expect(e.apiCode).toBe("venue_unavailable");
    const r = await readOnlyAdapter(mockFactory(true, 3)).quote("0x00000000000000000000000000000000000000aa", "sell", 1n).catch((x) => x);
    expect(r.apiCode).toBe("graduated");
    const s = await readOnlyAdapter(mockFactory(true, 1)).quote("0x00000000000000000000000000000000000000aa", "sell", 1n).catch((x) => x);
    expect(s.message).toMatch(/graduation in progress/);
  });

  it("bad address -> bad_request", async () => {
    const e = await readOnlyAdapter(mockFactory(true, 0)).status("nope" as Hex).catch((x) => x);
    expect(e.code).toBe("bad_request");
  });
});

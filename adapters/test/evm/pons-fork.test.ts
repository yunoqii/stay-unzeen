/**
 * End-to-end Pons adapter test on a LOCAL anvil fork of Robinhood Chain mainnet
 * (4663). Transactions go to the local fork only; mainnet itself is only read
 * (anvil fetches state lazily). Opt-in:
 *   pnpm test:fork            (HOOD_FORK=1; needs `anvil` from Foundry)
 * Fork source: HOOD_FORK_URL, else HOOD_RPC_URL_MAINNET, else public dRPC.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, getAddress, http, parseEther, type PublicClient } from "viem";
import { english, generateMnemonic } from "viem/accounts";
import { AdapterError } from "../../src/errors";
import { loadRepoEnv } from "../../src/env";
import { hoodMainnet } from "../../src/evm/chain";
import { EvmExecutor } from "../../src/evm/executor";
import { EvmFeeCache } from "../../src/evm/fees";
import { EvmKeyring } from "../../src/evm/keys";
import { ponsV2CurveAbi } from "../../src/evm/pons/abi/curve";
import { ponsV2TokenAbi } from "../../src/evm/pons/abi/token";
import { PonsAdapter, PONS_ERROR_ABI } from "../../src/evm/pons/adapter";
import { freshCurveState, quoteBuy } from "../../src/evm/pons/math";
import { MemoryCreatorIndexCounter } from "../../src/keys";

loadRepoEnv();
const enabled = process.env.HOOD_FORK === "1" && spawnSync("anvil", ["--version"]).status === 0;
const forkUrl = process.env.HOOD_FORK_URL?.trim() || process.env.HOOD_RPC_URL_MAINNET?.trim() || "https://robinhood.drpc.org";

describe.skipIf(!enabled)("pons adapter on an anvil fork of 4663", () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  let adapter: PonsAdapter;
  let ex: EvmExecutor;
  let kr: EvmKeyring;
  let fees: EvmFeeCache;
  const port = 18600 + Math.floor(Math.random() * 300);
  const url = `http://127.0.0.1:${port}`;
  let token: `0x${string}`;
  let curve: `0x${string}`;

  beforeAll(async () => {
    anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
    client = createPublicClient({ chain: hoodMainnet, transport: http(url, { retryCount: 0 }) }) as PublicClient;
    for (let i = 0; i < 100; i++) {
      try {
        await client.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    fees = new EvmFeeCache(200_000_000n, async () => (await client.getBlock()).baseFeePerGas ?? 0n);
    await fees.refresh();
    ex = new EvmExecutor({ read: client, chainId: 4663, fees, allowSend: true, errorAbi: PONS_ERROR_ABI, pollingIntervalMs: 50 });
    // Fresh random seed per run: no collision with real mainnet state of well-known test addresses.
    kr = new EvmKeyring(generateMnemonic(english, 256), new MemoryCreatorIndexCounter());
    for (const a of [kr.funder().address, kr.vault(0).address, kr.vault(1).address]) {
      await client.request({ method: "anvil_setBalance" as never, params: [a, `0x${parseEther("20").toString(16)}`] as never });
    }
    adapter = new PonsAdapter({ executor: ex, keyring: kr, vault: kr.vault(0) });
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("verifies the pinned deployment", async () => {
    await adapter.verifyDeployment();
  });

  it("create: fresh funded creator, launchAndBuy in one tx, exact first-buy amount", async () => {
    const terms = await adapter.factoryTerms();
    const initialBuy = parseEther("0.05");
    const res = await adapter.create({ name: "Fork Test", symbol: "FORK" }, initialBuy);
    token = res.token;
    curve = res.curve;
    const creator = kr.account("creator", 0).address;
    expect(res.creator).toBe(getAddress(creator));
    expect(res.creatorIndex).toBe(0);
    expect(res.vault).toBe(getAddress(kr.vault(0).address));
    // Exact: fresh curve, recipient exempt from snipe tax.
    const exp = quoteBuy(freshCurveState({ ...terms.config, creatorTaxBps: 0n, snipeTaxStartBps: terms.snipeTaxStartBps, snipeTaxSeconds: terms.snipeTaxSeconds }), initialBuy, 0n);
    expect(res.tokenAmount).toBe(exp.tokensOut);
    expect(res.quoteAmount).toBe(initialBuy);
    expect(res.snipeTax).toBe(0n);
    expect(res.launchFee).toBe(terms.launchFee);
    // Funding in round amounts from the funder, never from a vault.
    const fund = res.sideTxs.find((t) => t.kind === "fund")!;
    expect(fund.value! % parseEther("0.01")).toBe(0n);
    const fundTx = await client.getTransaction({ hash: fund.hash });
    expect(getAddress(fundTx.from)).toBe(getAddress(kr.funder().address));
    expect(getAddress(fundTx.to!)).toBe(getAddress(creator));
    // Approve right after the buy.
    expect(res.sideTxs.some((t) => t.kind === "approve")).toBe(true);
    // On chain: deployer = creatorFeeRecipient = fresh creator; tokens on the vault.
    const info = await adapter.launchInfo(token);
    expect(info.deployer).toBe(getAddress(creator));
    expect(info.creatorFeeRecipient).toBe(getAddress(creator));
    const bal = await client.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [kr.vault(0).address] });
    expect(bal).toBe(res.tokenAmount);
    // THE fee profile on the launch tx.
    const tx = await client.getTransaction({ hash: res.hash });
    expect(tx.type).toBe("eip1559");
    expect(tx.maxPriorityFeePerGas).toBe(0n);
    expect(tx.maxFeePerGas).toBe(fees.maxFeePerGas);
    expect((tx.gas ?? 1n) % 100_000n).toBe(0n);
    expect(await adapter.status(token)).toBe("curve");
  }, 120_000);

  it("create refuses to reuse a creator that already launched", async () => {
    await expect(adapter.create({ name: "Again", symbol: "AGN" }, parseEther("0.01"), { creatorIndex: 0 })).rejects.toMatchObject({ code: "internal" });
  });

  it("buy by a non-exempt vault waits out the snipe tax and matches the quote exactly", async () => {
    // Anvil only advances block.timestamp on new blocks: pin the next one inside the window.
    const launchedAt = await client.readContract({ address: curve, abi: ponsV2CurveAbi, functionName: "launchedAt" });
    const q = await adapter.quote(token, "buy", parseEther("0.02"), { recipient: kr.vault(1).address });
    expect(q.snipeTaxBps > 0n).toBe(true); // a sniper would pay now
    const e = await adapter.buy(token, parseEther("0.02"), 1n, { vault: kr.vault(1), snipeTax: "fail" }).catch((x) => x);
    if (BigInt(Math.floor(Date.now() / 1000)) - 2n < launchedAt + 3n) expect(e.code).toBe("venue_unavailable");
    const res = await adapter.buy(token, parseEther("0.02"), 1n, { vault: kr.vault(1) });
    expect(res.snipeTax).toBe(0n);
    const blk = await client.getBlock({ blockNumber: res.blockNumber });
    expect(blk.timestamp >= launchedAt + 3n).toBe(true);
  }, 60_000);

  it("buy / sell amounts equal the local quote", async () => {
    const qb = await adapter.quote(token, "buy", parseEther("0.01"));
    const b = await adapter.buy(token, parseEther("0.01"), qb.amountOut);
    expect(b.tokenAmount).toBe(qb.amountOut);
    expect(b.quoteAmount).toBe(parseEther("0.01"));
    const half = b.tokenAmount / 2n;
    const qs = await adapter.quote(token, "sell", half);
    const s = await adapter.sell(token, half, qs.amountOut);
    expect(s.quoteAmount).toBe(qs.amountOut);
    expect(s.tokenAmount).toBe(half);
    expect(s.sideTxs).toEqual([]); // approved right after the buy
  }, 60_000);

  it("maps reverts to API codes", async () => {
    const qb = await adapter.quote(token, "buy", parseEther("0.01"));
    const e1 = await adapter.buy(token, parseEther("0.01"), qb.amountOut * 2n).catch((e) => e);
    expect(e1).toBeInstanceOf(AdapterError);
    expect(e1.code).toBe("slippage");
    expect(e1.apiCode).toBe("slippage");
    expect(e1.stage).toBe("preflight");
    const e2 = await adapter.sell(token, 10n ** 30n, 0n).catch((e) => e);
    expect(e2.code).toBe("insufficient_tokens");
    expect(e2.apiCode).toBe("pool_liquidity");
    const e3 = await adapter.status("0x000000000000000000000000000000000000dEaD").catch((e) => e);
    expect(e3.code).toBe("not_found");
  }, 60_000);

  it("parallel sends from one vault are serialized by the nonce mutex", async () => {
    const [a, b] = await Promise.all([
      adapter.buy(token, parseEther("0.001"), 1n),
      adapter.buy(token, parseEther("0.001"), 1n),
    ]);
    expect(a.hash).not.toBe(b.hash);
  }, 60_000);

  it("a buy past the threshold is clamped with a refund, then the token is graduated", async () => {
    const q = await adapter.quote(token, "buy", parseEther("8"));
    expect(q.refund! > 0n).toBe(true);
    const res = await adapter.buy(token, parseEther("8"), 1n);
    expect(res.refund).toBe(q.refund);
    expect(res.tokenAmount).toBe(q.amountOut);
    expect(await adapter.status(token)).toBe("graduated");
    const e = await adapter.buy(token, parseEther("0.01"), 1n).catch((x) => x);
    expect(e.code).toBe("graduated");
    expect(e.apiCode).toBe("graduated");
  }, 120_000);
});

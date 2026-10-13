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
import { PonsFeeSweeper, reconcileCreator } from "../../src/evm/pons/creator";
import { FunderPool } from "../../src/evm/funders";
import { EvmWithdrawer, roundDownSig } from "../../src/evm/withdraw";
import { LifiClient } from "../../src/evm/lifi";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { MemoryCreatorIndexCounter } from "../../src/keys";

loadRepoEnv();
const enabled = process.env.HOOD_FORK === "1" && spawnSync("anvil", ["--version"]).status === 0;
const forkUrl = process.env.HOOD_FORK_URL?.trim() || process.env.HOOD_RPC_URL_MAINNET?.trim() || "https://robinhood.drpc.org";

describe.skipIf(!enabled)("pons adapter on an anvil fork of 4663", () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  let adapter: PonsAdapter;
  let funders: FunderPool;
  let ex: EvmExecutor;
  let kr: EvmKeyring;
  let fees: EvmFeeCache;
  const port = 18600 + Math.floor(Math.random() * 300);
  const url = `http://127.0.0.1:${port}`;
  let token: `0x${string}`;
  let startBlock: bigint;
  const PONS_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as const;
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
    startBlock = await client.getBlockNumber();
    fees = new EvmFeeCache(200_000_000n, async () => (await client.getBlock()).baseFeePerGas ?? 0n);
    await fees.refresh();
    ex = new EvmExecutor({ read: client, chainId: 4663, fees, allowSend: true, errorAbi: PONS_ERROR_ABI, pollingIntervalMs: 50 });
    // Fresh random seed per run: no collision with real mainnet state of well-known test addresses.
    kr = new EvmKeyring(generateMnemonic(english, 256), new MemoryCreatorIndexCounter());
    for (const a of [kr.funder(0).address, kr.funder(1).address, kr.funder(2).address, kr.vault(0).address, kr.vault(1).address, kr.rebalance(0).address]) {
      await client.request({ method: "anvil_setBalance" as never, params: [a, `0x${parseEther("20").toString(16)}`] as never });
    }
    funders = new FunderPool({ executor: ex, keyring: kr, count: 3 });
    adapter = new PonsAdapter({ executor: ex, keyring: kr, funders });
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
    const res = await adapter.create({ name: "Fork Test", symbol: "FORK" }, initialBuy, { vault: kr.vault(0) });
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
    expect(funders.accounts().map((a) => getAddress(a.address))).toContain(getAddress(fundTx.from)); // a rotating funder, never a vault
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
    await expect(adapter.create({ name: "Again", symbol: "AGN" }, parseEther("0.01"), { creatorIndex: 0, vault: kr.vault(0) })).rejects.toMatchObject({ code: "internal" });
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
    const qb = await adapter.quote(token, "buy", parseEther("0.01"), { recipient: kr.vault(0).address });
    const b = await adapter.buy(token, parseEther("0.01"), qb.amountOut, { vault: kr.vault(0) });
    expect(b.tokenAmount).toBe(qb.amountOut);
    expect(b.quoteAmount).toBe(parseEther("0.01"));
    const half = b.tokenAmount / 2n;
    const qs = await adapter.quote(token, "sell", half);
    const s = await adapter.sell(token, half, qs.amountOut, { vault: kr.vault(0) });
    expect(s.quoteAmount).toBe(qs.amountOut);
    expect(s.tokenAmount).toBe(half);
    expect(s.sideTxs).toEqual([]); // approved right after the buy
  }, 60_000);

  it("maps reverts to API codes", async () => {
    const qb = await adapter.quote(token, "buy", parseEther("0.01"), { recipient: kr.vault(0).address });
    const e1 = await adapter.buy(token, parseEther("0.01"), qb.amountOut * 2n, { vault: kr.vault(0) }).catch((e) => e);
    expect(e1).toBeInstanceOf(AdapterError);
    expect(e1.code).toBe("slippage");
    expect(e1.apiCode).toBe("slippage");
    expect(e1.stage).toBe("preflight");
    const e2 = await adapter.sell(token, 10n ** 30n, 0n, { vault: kr.vault(0) }).catch((e) => e);
    expect(e2.code).toBe("insufficient_tokens");
    expect(e2.apiCode).toBe("pool_liquidity");
    const e3 = await adapter.status("0x000000000000000000000000000000000000dEaD").catch((e) => e);
    expect(e3.code).toBe("not_found");
  }, 60_000);

  it("parallel sends from one vault are serialized by the nonce mutex", async () => {
    const [a, b] = await Promise.all([
      adapter.buy(token, parseEther("0.001"), 1n, { vault: kr.vault(0) }),
      adapter.buy(token, parseEther("0.001"), 1n, { vault: kr.vault(0) }),
    ]);
    expect(a.hash).not.toBe(b.hash);
  }, 60_000);

  it("a buy past the threshold is clamped with a refund, then the token is graduated", async () => {
    const q = await adapter.quote(token, "buy", parseEther("8"), { recipient: kr.vault(0).address });
    expect(q.refund! > 0n).toBe(true);
    const res = await adapter.buy(token, parseEther("8"), 1n, { vault: kr.vault(0) });
    expect(res.refund).toBe(q.refund);
    expect(res.tokenAmount).toBe(q.amountOut);
    expect(await adapter.status(token)).toBe("graduated");
  }, 120_000);

  it("graduated: v4 pool pending -> venue_unavailable; seeded -> sell and buy through Uniswap v4", async () => {
    let info = await adapter.launchInfo(token);
    if (info.phase === 1) {
      const e = await adapter.buy(token, parseEther("0.01"), 1n, { vault: kr.vault(0) }).catch((x) => x);
      expect(e.code).toBe("venue_unavailable");
      await adapter.seedGraduatedPool(token, kr.vault(1));
      info = await adapter.launchInfo(token);
    }
    expect(info.phase).toBe(2); // PoolCreated
    const vault = kr.vault(0).address;
    const held = await client.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [vault] });
    const amount = held / 3n;
    const qs = await adapter.quote(token, "sell", amount);
    expect(qs.route).toBe("uniswap-v4");
    const ethBefore = await client.getBalance({ address: vault });
    const s = await adapter.sell(token, amount, qs.amountOut, { vault: kr.vault(0) });
    expect(s.route).toBe("uniswap-v4");
    expect(s.quoteAmount).toBe(qs.amountOut);
    expect(s.tokenAmount).toBe(amount);
    expect(s.sideTxs.length).toBeGreaterThan(0); // Permit2 approvals before the first v4 sell
    const ethAfter = await client.getBalance({ address: vault });
    const fees = s.networkFee + s.sideTxs.reduce((a, t) => a + t.networkFee, 0n);
    expect(ethAfter - ethBefore + fees).toBe(s.quoteAmount); // event-derived ETH == balance delta
    // second sell: no approvals any more
    const s2 = await adapter.sell(token, amount / 2n, 1n, { vault: kr.vault(0) });
    expect(s2.sideTxs).toEqual([]);
    const qb = await adapter.quote(token, "buy", parseEther("0.05"), { recipient: kr.vault(0).address });
    const b = await adapter.buy(token, parseEther("0.05"), qb.amountOut, { vault: kr.vault(0) });
    expect(b.route).toBe("uniswap-v4");
    expect(b.tokenAmount).toBe(qb.amountOut);
    expect(b.feeInToken).toBe(true);
    const e2 = await adapter.sell(token, amount / 4n, 10n ** 30n, { vault: kr.vault(0) }).catch((x) => x);
    expect(e2.code).toBe("slippage");
  }, 180_000);

  it("withdraw: vault gas drop (Solana parity) + vault ERC-20 transfer to a fresh address, rounded parts, no double drop", async () => {
    const w = new EvmWithdrawer({ executor: ex, funder: kr.funder(), isPoolAddress: (a) => a === getAddress(kr.vault(1).address) });
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const held = await client.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [kr.vault(0).address] });
    const part = roundDownSig(held / 10n, 3);
    const r1 = await w.withdrawToken({ vault: kr.vault(0), token, to, amount: part });
    expect(r1.received).toBe(part);
    expect(r1.drop?.value).toBe(w.gasDropWei);
    const dropTx = await client.getTransaction({ hash: r1.drop!.hash });
    expect(getAddress(dropTx.from)).toBe(getAddress(kr.vault(0).address)); // the same vault: no new link
    expect(await client.getBalance({ address: to })).toBe(w.gasDropWei);
    const r2 = await w.withdrawToken({ vault: kr.vault(0), token, to, amount: part });
    expect(r2.drop).toBeNull();
    expect((await w.withdrawToken({ vault: kr.vault(0), token, to, amount: part + 1n }).catch((e) => e)).code).toBe("bad_request");
    expect((await w.withdrawToken({ vault: kr.vault(0), token, to: PONS_HOOK, amount: part }).catch((e) => e)).code).toBe("bad_request");
    expect((await w.withdrawToken({ vault: kr.vault(0), token, to: kr.vault(1).address, amount: part }).catch((e) => e)).code).toBe("bad_request");
    const e = await w.withdrawEth({ vault: kr.vault(0), to, amount: parseEther("0.0123") });
    expect(e.received).toBe(parseEther("0.0123"));
  }, 120_000);

  it("fee sweep: graduated launch (escrow) and a curve launch (sweepFees -> claim -> vault)", async () => {
    let i = 0;
    const sweeper = new PonsFeeSweeper({ adapter, executor: ex, keyring: kr, pickVault: () => kr.vault(i++ % 2), minCollectWei: 1n, sleep: async () => undefined });
    const t0 = await sweeper.inspect({ creatorIndex: 0, token });
    expect(t0.escrow > 0n).toBe(true); // graduation swept the curve fees into the escrow
    const vb = async () => (await client.getBalance({ address: kr.vault(0).address })) + (await client.getBalance({ address: kr.vault(1).address }));
    const v0 = await vb();
    const o0 = await sweeper.sweepOne(t0);
    expect(o0.steps.map((s) => s.kind)).toContain("claim");
    expect(o0.collected > 0n).toBe(true);
    expect(o0.collected % 100_000_000_000_000n).toBe(0n);
    expect((await vb()) - v0).toBe(o0.collected); // vaults only received here
    // A second, still-curve launch with some volume.
    const c = await adapter.create({ name: "Fees", symbol: "FEES" }, parseEther("0.02"), { creatorTaxBps: 300, vault: kr.vault(0) });
    const b = await adapter.buy(c.token, parseEther("0.3"), 1n, { vault: kr.vault(1) });
    await adapter.sell(c.token, b.tokenAmount / 2n, 1n, { vault: kr.vault(1) });
    const t1 = await sweeper.inspect({ creatorIndex: c.creatorIndex!, token: c.token });
    expect(t1.curvePending > 0n).toBe(true);
    const res = await sweeper.runOnce([{ creatorIndex: c.creatorIndex!, token: c.token }]);
    expect(res.failed).toBe(0);
    const kinds = res.outcomes[0]!.steps.map((s) => s.kind);
    expect(kinds).toEqual(["curve_sweep", "claim", "to_vault"]);
    for (const st of res.outcomes[0]!.steps) {
      const tx = await client.getTransaction({ hash: st.hash });
      expect(getAddress(tx.from)).toBe(c.creator); // H7: only the creator signs
    }
    const after = await sweeper.inspect({ creatorIndex: c.creatorIndex!, token: c.token });
    expect(after.curvePending).toBe(0n);
    expect(after.escrow).toBe(0n);
  }, 180_000);

  it("reconcile: launched / unused / stuck creator refunded to the funder", async () => {
    const fromBlock = startBlock;
    const l = await reconcileCreator({ adapter, executor: ex, keyring: kr }, 0, { fromBlock });
    expect(l.status).toBe("launched");
    if (l.status === "launched") expect(l.token).toBe(token);
    const u = await reconcileCreator({ adapter, executor: ex, keyring: kr }, 50, { fromBlock });
    expect(u.status).toBe("unused");
    // Stuck: funded, sent a tx, no launch.
    const stuck = kr.account("creator", 51);
    await ex.transfer(kr.funder(1), stuck.address, parseEther("0.01"));
    await ex.transfer(stuck, stuck.address, 0n);
    const fBefore = await client.getBalance({ address: kr.rebalance(0).address });
    const r = await reconcileCreator({ adapter, executor: ex, keyring: kr }, 51, { fromBlock });
    expect(r.status).toBe("refunded");
    if (r.status === "refunded") {
      const tx = await client.getTransaction({ hash: r.hash });
      expect(getAddress(tx.to!)).toBe(getAddress(kr.rebalance(0).address)); // back to the source, not to one funder
      expect((await client.getBalance({ address: kr.rebalance(0).address })) - fBefore).toBe(r.value);
    }
    expect((await reconcileCreator({ adapter, executor: ex, keyring: kr }, 51, { fromBlock })).status).toBe("empty");
  }, 120_000);

  it.skipIf(process.env.HOOD_FORK_LIFI !== "1")("LI.FI fallback route executes on the fork (only the vault address is sent)", async () => {
    const lifiAdapter = new PonsAdapter({ executor: ex, keyring: kr, funders, lifi: new LifiClient() });
    const live = process.env.HOOD_FORK_LIFI_TOKEN ?? "0xcd70E319F13D4611F2e5f5D603C52724bCea3300";
    const info = await lifiAdapter.launchInfo(live as `0x${string}`);
    const r = await (lifiAdapter as unknown as { tradeLifi: (...a: unknown[]) => Promise<{ route: string; tokenAmount: bigint; amountsKnown: boolean }> }).tradeLifi(info, "buy", parseEther("0.001"), 1n, kr.vault(1));
    expect(r.route).toBe("lifi");
    expect(r.amountsKnown).toBe(true);
    expect(r.tokenAmount > 0n).toBe(true);
  }, 120_000);
});

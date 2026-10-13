/**
 * Records READ-ONLY mainnet fixtures for the Pons adapter tests
 * (test/fixtures/evm/pons-mainnet.json.gz). No transaction is ever sent.
 *   pnpm evm:fixtures
 *
 * RPC: HOOD_RPC_URL_MAINNET, else the public dRPC endpoint (eth_getLogs over
 * a few thousand blocks; the official public RPC throttles bursts).
 * Picks: a recent real buy and sell on Pons curves that the local math must
 * reproduce exactly (state at block-1), a real launchAndBuy, a live curve for
 * quote/status replay, and runtime bytecode (selector + code-hash tests).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createPublicClient, getAddress, keccak256, parseEventLogs, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { loadRepoEnv } from "../src/env";
import { hoodMainnet } from "../src/evm/chain";
import { ponsV2CurveAbi } from "../src/evm/pons/abi/curve";
import { ponsV2LaunchAndBuyAbi } from "../src/evm/pons/abi/launch-and-buy.generated";
import { PONS_V2_MAINNET } from "../src/evm/pons/addresses";
import { priceRealBuy, priceRealSell, readOnlyAdapter, type RealBuyCase, type RealSellCase } from "../test/evm/cases";
import { recordingTransport, type RpcFixture } from "../test/evm/replay";

const OUT = path.resolve(__dirname, "../test/fixtures/evm/pons-mainnet.json.gz");
const BUY_TOPIC = toEventSelector("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
const SELL_TOPIC = toEventSelector("CurveSell(address,address,uint256,uint256,uint256,uint256)");
const LAUNCHED_TOPIC = toEventSelector("Launched(address,address,address,address,uint256,uint256)");

async function main(): Promise<void> {
  loadRepoEnv();
  const url = process.env.HOOD_RPC_URL_MAINNET?.trim() || "https://robinhood.drpc.org";
  const fx: RpcFixture = {};
  const rec = createPublicClient({ chain: hoodMainnet, transport: recordingTransport(url, fx) }) as PublicClient;
  // Plain client for discovery (logs are not part of the fixture).
  const discoveryUrl = process.env.HOOD_DISCOVERY_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
  const plain = createPublicClient({ chain: hoodMainnet, transport: recordingTransport(discoveryUrl, {}) }) as PublicClient;
  const adapter = readOnlyAdapter(rec);

  const head = await plain.getBlockNumber();
  const span = 3000n;
  const logs = async (topic: Hex, address?: Address) => {
    const out = [];
    for (let to = head; to > head - 3n * span && out.length < 40; to -= span) {
      const r = await plain.request({
        method: "eth_getLogs",
        params: [{ fromBlock: `0x${(to - span + 1n).toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [topic], ...(address ? { address } : {}) }],
      });
      out.push(...(r as { address: Address; transactionHash: Hex; blockNumber: Hex; logIndex: Hex }[]));
    }
    return out;
  };

  // --- real buy (not from the launch router: those land in the launch block) ---
  let buyCase: RealBuyCase | null = null;
  for (const l of (await logs(BUY_TOPIC)).reverse().slice(0, 25)) {
    const rc = await rec.getTransactionReceipt({ hash: l.transactionHash });
    const ev = parseEventLogs({ abi: ponsV2CurveAbi, logs: rc.logs, eventName: "CurveBuy" });
    if (ev.length !== 1) continue;
    const e = ev[0]!;
    if (getAddress(e.args.buyer) === getAddress(PONS_V2_MAINNET.launchAndBuy)) continue;
    const refund = parseEventLogs({ abi: ponsV2CurveAbi, logs: rc.logs, eventName: "CurveBuyRefunded" })[0]?.args.refund ?? 0n;
    const c: RealBuyCase = {
      hash: l.transactionHash,
      curve: getAddress(e.address),
      recipient: getAddress(e.args.recipient),
      blockNumber: rc.blockNumber.toString(),
      quoteIn: e.args.quoteIn.toString(),
      tokensOut: e.args.tokensOut.toString(),
      fee: e.args.fee.toString(),
      tax: e.args.tax.toString(),
      refund: refund.toString(),
    };
    try {
      const q = await priceRealBuy(adapter, rec, c);
      if (q.tokensOut.toString() === c.tokensOut && (q.fee).toString() === c.fee && q.tax.toString() === c.tax) {
        buyCase = c;
        break;
      }
      console.error(`buy ${l.transactionHash.slice(0, 10)}: state moved inside the block, next`);
    } catch (e2) {
      console.error(`buy ${l.transactionHash.slice(0, 10)}: ${(e2 as Error).message.split("\n")[0]}`);
    }
  }
  if (!buyCase) throw new Error("no reproducible buy found");
  console.log(`buy case ${buyCase.hash}`);

  // --- real sell ---
  let sellCase: RealSellCase | null = null;
  for (const l of (await logs(SELL_TOPIC)).reverse().slice(0, 25)) {
    const rc = await rec.getTransactionReceipt({ hash: l.transactionHash });
    const ev = parseEventLogs({ abi: ponsV2CurveAbi, logs: rc.logs, eventName: "CurveSell" });
    if (ev.length !== 1) continue;
    const e = ev[0]!;
    const c: RealSellCase = {
      hash: l.transactionHash,
      curve: getAddress(e.address),
      blockNumber: rc.blockNumber.toString(),
      tokensIn: e.args.tokensIn.toString(),
      quoteOut: e.args.quoteOut.toString(),
      fee: e.args.fee.toString(),
      tax: e.args.tax.toString(),
    };
    try {
      const q = await priceRealSell(adapter, c);
      if (q.quoteOut.toString() === c.quoteOut && q.fee.toString() === c.fee && q.tax.toString() === c.tax) {
        sellCase = c;
        break;
      }
    } catch {
      // next candidate
    }
  }
  if (!sellCase) throw new Error("no reproducible sell found");
  console.log(`sell case ${sellCase.hash}`);

  // --- real launchAndBuy (router event) ---
  const launchedLogs = await logs(LAUNCHED_TOPIC, PONS_V2_MAINNET.launchAndBuy);
  const ll = launchedLogs[launchedLogs.length - 1];
  if (!ll) throw new Error("no recent launchAndBuy found");
  const launchTx = await rec.getTransaction({ hash: ll.transactionHash });
  await rec.getTransactionReceipt({ hash: ll.transactionHash });
  const launchEv = parseEventLogs({ abi: ponsV2LaunchAndBuyAbi, logs: (await rec.getTransactionReceipt({ hash: ll.transactionHash })).logs, eventName: "Launched" })[0]!;
  console.log(`launch case ${ll.transactionHash}`);

  // --- live curve: quote / status replay at a pinned head ---
  const live = { token: buyCase.curve, curve: buyCase.curve, head: "0" };
  const tokenOfCurve = await rec.readContract({ address: buyCase.curve, abi: ponsV2CurveAbi, functionName: "token" });
  live.token = getAddress(tokenOfCurve);
  const status = await adapter.status(live.token);
  const qb = await adapter.quote(live.token, "buy", 10_000_000_000_000_000n).catch((e) => ({ error: (e as Error).message }));
  const qs = await adapter.quote(live.token, "sell", 1_000_000_000_000_000_000_000_000n).catch((e) => ({ error: (e as Error).message }));
  live.head = (await rec.getBlockNumber()).toString();
  const terms = await adapter.factoryTerms();
  await adapter.verifyDeployment();
  await adapter.status(launchEv.args.token).catch(() => undefined);

  // --- bytecode ---
  const curveCode = (await rec.getCode({ address: buyCase.curve })) ?? "0x";
  const tokenCode = (await rec.getCode({ address: live.token })) ?? "0x";

  const out = {
    recordedAt: new Date().toISOString(),
    chainId: 4663,
    rpcHost: new URL(url).host,
    buyCase,
    sellCase,
    launchCase: {
      hash: ll.transactionHash,
      input: launchTx.input,
      value: launchTx.value.toString(),
      token: getAddress(launchEv.args.token),
      curve: getAddress(launchEv.args.curve),
      recipient: getAddress(launchEv.args.recipient),
      tokensReceived: launchEv.args.tokensReceived.toString(),
      quoteSpent: launchEv.args.quoteSpent.toString(),
    },
    live: { ...live, status, quoteBuy: stringify(qb), quoteSell: stringify(qs), terms: stringify(terms) },
    code: { curve: curveCode, token: tokenCode, curveHash: keccak256(curveCode) },
    rpc: fx,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(out)));
  console.log(`wrote ${OUT} (${Object.keys(fx).length} rpc answers)`);
}

function stringify(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

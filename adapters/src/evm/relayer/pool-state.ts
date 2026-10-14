import { randomInt } from "node:crypto";
import type { Pool } from "pg";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type LocalAccount } from "viem";
import { AdapterError } from "../../errors";
import { planFunding } from "../../rebalance";
import { LAUNCH_CURVE_UPSERT, type LaunchCurve } from "../../relayer/launch-curves";
import { PgVerifySnapshotStore, type SnapshotRequest } from "../../relayer/verify-snapshot";
import { signVerifySnapshot } from "../attest";
import type { EvmExecutor, OnSigned, SentEvmTx } from "../executor";
import type { EvmKeyring } from "../keys";
import { ponsV2TokenAbi } from "../pons/abi/token";
import type { PonsAdapter } from "../pons/adapter";
import { freshCurveState } from "../pons/math";
import type { HoodNetworkId } from "./queue";

/**
 * Pool-level state of the hood instance (RELAYER v14 §2–4). Public data only;
 * logs carry counts.
 */

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = parseAbi([
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);

// ---------------------------------------------------------------------------
// launch_curves (hood*, 'pons')
// ---------------------------------------------------------------------------

/**
 * Pons launch config 0 as a constant-product launch curve: virtual quote =
 * phantomQuote (wei), virtual tokens = supply, real (sellable) tokens =
 * supply - reserved allocation, total = supply. Same shape core uses for pump.fun.
 */
export async function ponsLaunchCurve(adapter: PonsAdapter): Promise<LaunchCurve> {
  const t = await adapter.factoryTerms();
  if (!t.config.enabled) throw new Error("pons launch config disabled");
  const s = freshCurveState({ ...t.config, creatorTaxBps: 0n, snipeTaxStartBps: t.snipeTaxStartBps, snipeTaxSeconds: t.snipeTaxSeconds });
  return {
    venue: "pons",
    virtualSolLamports: t.config.phantomQuote,
    virtualTokenReserves: t.config.supply,
    realTokenReserves: t.config.supply - s.reservedTokens,
    tokenTotalSupply: t.config.supply,
  };
}

export async function writePonsLaunchCurve(db: Pool, network: HoodNetworkId, adapter: PonsAdapter): Promise<LaunchCurve> {
  const c = await ponsLaunchCurve(adapter);
  await db.query(LAUNCH_CURVE_UPSERT, [network, c.venue, c.virtualSolLamports.toString(), c.virtualTokenReserves.toString(), c.realTokenReserves.toString(), c.tokenTotalSupply.toString()]);
  return c;
}

// ---------------------------------------------------------------------------
// pool_sol_inventory (hood*: wei)
// ---------------------------------------------------------------------------

export interface HoodInventory {
  vaultWei: bigint;
  vaultCount: number;
  rebalanceWei: bigint;
  block: bigint;
}

/** Σ ETH of all trading vaults + the rebalance address, read in ONE eth_call at one block. */
export async function readInventory(ex: EvmExecutor, vaults: readonly Address[], rebalance: Address): Promise<HoodInventory> {
  const block = await ex.read.getBlockNumber({ cacheTime: 0 });
  const bal = await ethBalances(ex, [...vaults, rebalance], block);
  return { vaultWei: bal.slice(0, vaults.length).reduce((a, b) => a + b, 0n), vaultCount: vaults.length, rebalanceWei: bal[vaults.length]!, block };
}

export async function writeInventory(db: Pool, network: HoodNetworkId, inv: HoodInventory): Promise<void> {
  await db.query(
    `INSERT INTO pool_sol_inventory (network, vault_lamports, vault_count, rebalance_lamports, slot, updated_at)
     VALUES ($1, $2::numeric, $3, $4::numeric, $5, now())
     ON CONFLICT (network) DO UPDATE SET vault_lamports = EXCLUDED.vault_lamports, vault_count = EXCLUDED.vault_count,
       rebalance_lamports = EXCLUDED.rebalance_lamports, slot = EXCLUDED.slot, updated_at = now()`,
    [network, inv.vaultWei.toString(), inv.vaultCount, inv.rebalanceWei.toString(), inv.block.toString()],
  );
}

async function ethBalances(ex: EvmExecutor, addrs: readonly Address[], block: bigint): Promise<bigint[]> {
  const r = await ex.read.multicall({
    allowFailure: false,
    blockNumber: block,
    contracts: addrs.map((a) => ({ address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getEthBalance", args: [a] }) as const),
  });
  return r as bigint[];
}

// ---------------------------------------------------------------------------
// fund_vaults (rebalance address -> vaults, ONE tx)
// ---------------------------------------------------------------------------

/** Round amounts: each vault's share rounded DOWN to this step (0.001 ETH). */
export const FUND_STEP_WEI = 1_000_000_000_000_000n;

export interface HoodFundPlan {
  transfers: { vault: Address; wei: bigint }[];
  total: bigint;
}

/**
 * Water-fill the poorest vaults (same rule as Solana `planFunding`), each share
 * rounded down to `step`, recipients in RANDOM order. Depends on balances only.
 */
export function planHoodFunding(weiIn: bigint, balances: readonly { vault: Address; wei: bigint }[], step = FUND_STEP_WEI): HoodFundPlan {
  const plan = planFunding(weiIn, balances.map((b) => ({ vault: b.vault, lamports: b.wei })));
  const transfers = plan.map((t) => ({ vault: getAddress(t.vault), wei: (t.lamports / step) * step })).filter((t) => t.wei > 0n);
  for (let i = transfers.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [transfers[i], transfers[j]] = [transfers[j]!, transfers[i]!];
  }
  return { transfers, total: transfers.reduce((a, t) => a + t.wei, 0n) };
}

/**
 * ONE tx from the rebalance address: Multicall3.aggregate3Value sends each
 * vault its share (internal calls, atomic: all or nothing, like the Solana
 * multi-transfer). Never vault -> vault.
 */
export async function fundVaults(
  ex: EvmExecutor,
  rebalance: LocalAccount,
  vaults: readonly Address[],
  weiIn: bigint,
  onSigned?: OnSigned,
): Promise<{ sent: SentEvmTx; plan: HoodFundPlan }> {
  if (vaults.some((v) => getAddress(v) === getAddress(rebalance.address))) throw new AdapterError("internal", "rebalance address is a vault");
  const have = await ex.balance(rebalance.address);
  const block = await ex.read.getBlockNumber({ cacheTime: 0 });
  const balances = await ethBalances(ex, vaults, block);
  const gasReserve = 2_000_000n * ex.fees.maxFeePerGas;
  const budget = weiIn < have - gasReserve ? weiIn : have - gasReserve;
  if (budget <= 0n) throw new AdapterError("insufficient_sol", "rebalance address has no ETH to spread");
  const plan = planHoodFunding(budget, vaults.map((v, i) => ({ vault: v, wei: balances[i]! })));
  if (plan.total === 0n) throw new AdapterError("bad_request", "amount below one funding step");
  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3Value",
    args: [plan.transfers.map((t) => ({ target: t.vault, allowFailure: false, value: t.wei, callData: "0x" as Hex }))],
  });
  const sent = await ex.send(rebalance, { to: MULTICALL3, data, value: plan.total }, onSigned ? { onSigned } : {});
  return { sent, plan };
}

// ---------------------------------------------------------------------------
// Verify v3 snapshot (verify_vaults on hood)
// ---------------------------------------------------------------------------

export interface HoodSnapshotSigner {
  account: LocalAccount;
  /** false: listed only when it holds ETH or tokens (creators). */
  always: boolean;
}

export interface HoodVaultRow {
  address: Address;
  wei: bigint;
  tokens: { mint: Address; amount: string }[];
  sig: Hex;
}

/**
 * Balances of every pool address at ONE block >= `minSlot` (core's highest
 * settled block), ETH + every pool ERC-20 in a single Multicall3 eth_call, each
 * address signing the EIP-712 statement {snapshotId, address, blockNumber}
 * (src/evm/attest.ts). Arbitrum blocks are soft-final at once (FCFS sequencer);
 * the L1 `finalized` tag lags ~18 min, far beyond the 120 s freeze, so `latest`
 * is used (documented trust assumption: the sequencer does not reorg).
 */
export async function collectHoodSnapshot(
  ex: EvmExecutor,
  req: Pick<SnapshotRequest, "id" | "minSlot" | "freezeUntil">,
  chainId: number,
  signers: readonly HoodSnapshotSigner[],
  mints: readonly Address[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ block: bigint; rows: HoodVaultRow[] }> {
  let block = await ex.read.getBlockNumber({ cacheTime: 0 });
  while (req.minSlot !== undefined && block < BigInt(req.minSlot)) {
    if (Date.now() + 1_000 >= req.freezeUntil) throw new Error("block has not reached min_slot before the freeze ended");
    await sleep(500);
    block = await ex.read.getBlockNumber({ cacheTime: 0 });
  }
  const byAddr = new Map<Address, HoodSnapshotSigner>();
  for (const s of signers) {
    const a = getAddress(s.account.address);
    const prev = byAddr.get(a);
    byAddr.set(a, prev ? { account: s.account, always: prev.always || s.always } : s);
  }
  const addrs = [...byAddr.keys()].sort();
  const toks = [...new Set(mints.map((m) => getAddress(m)))].sort();
  // review-hood-final #12: creators never hold pool tokens -> ETH only; token reads only for
  // always-listed addresses. viem splits the multicall into several eth_calls, all at `block`.
  const tokenHolders = addrs.filter((a) => byAddr.get(a)!.always);
  const calls = [
    ...addrs.map((a) => ({ address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getEthBalance", args: [a] }) as const),
    ...tokenHolders.flatMap((a) => toks.map((t) => ({ address: t, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [a] }) as const)),
  ];
  const res = (await ex.read.multicall({ allowFailure: true, blockNumber: block, batchSize: 16_384, contracts: calls as never })) as { status: string; result?: bigint }[];
  const rows: HoodVaultRow[] = [];
  for (const [i, a] of addrs.entries()) {
    const eth = res[i];
    if (eth?.status !== "success") throw new Error("eth balance unreadable");
    const tokens: HoodVaultRow["tokens"] = [];
    const h = tokenHolders.indexOf(a);
    if (h >= 0) {
      toks.forEach((t, j) => {
        const r = res[addrs.length + h * toks.length + j];
        if (r?.status !== "success") throw new Error("token balance unreadable"); // never under-report
        if ((r.result ?? 0n) > 0n) tokens.push({ mint: t, amount: r.result!.toString() });
      });
    }
    const s = byAddr.get(a)!;
    if (!s.always && eth.result === 0n && tokens.length === 0) continue;
    rows.push({ address: a, wei: eth.result!, tokens, sig: await signVerifySnapshot(s.account, chainId, String(req.id), block) });
  }
  return { block, rows };
}

/** One poll: pending hood snapshot -> collect -> write (same store/transaction rules as Solana). */
export async function hoodSnapshotTick(o: {
  db: Pool;
  network: HoodNetworkId;
  ex: EvmExecutor;
  chainId: number;
  signers: () => Promise<HoodSnapshotSigner[]>;
  mints: () => Promise<Address[]>;
}): Promise<"idle" | "written" | "lost" | "late"> {
  const store = new PgVerifySnapshotStore(o.db, o.network as never);
  const req = await store.pending();
  if (!req) return "idle";
  let snap: { block: bigint; rows: HoodVaultRow[] };
  try {
    snap = await collectHoodSnapshot(o.ex, req, o.chainId, await o.signers(), await o.mints());
  } catch {
    return "late";
  }
  if (Date.now() >= req.freezeUntil) return "late";
  const ok = await store.write(
    req.id,
    Number(snap.block),
    snap.rows.map((r) => ({ address: r.address, lamports: r.wei, tokens: r.tokens, sig: r.sig })),
  );
  return ok ? "written" : "lost";
}

/** Pool signers of a hood snapshot: vaults, funders, rebalance, attest keys (always) + creators holding anything. */
export function hoodSnapshotSigners(kr: EvmKeyring, vaultCount: number, funderCount: number, creatorCount: number): HoodSnapshotSigner[] {
  const always = [
    ...Array.from({ length: vaultCount }, (_, i) => kr.vault(i)),
    ...Array.from({ length: funderCount }, (_, i) => kr.funder(i)),
    kr.rebalance(0),
    kr.attest("verify"),
    kr.attest("fair"),
  ].map((account) => ({ account, always: true }));
  const creators = Array.from({ length: creatorCount }, (_, i) => ({ account: kr.account("creator", i), always: false }));
  return [...always, ...creators];
}

export async function hoodPoolMints(db: Pool, network: HoodNetworkId): Promise<Address[]> {
  const r = await db.query<{ mint: string }>(`SELECT mint FROM mint_vaults WHERE network = $1`, [network]);
  return r.rows.map((x) => getAddress(x.mint));
}

// ---------------------------------------------------------------------------
// Token prices (review-hood-final #7): every 1-2 min, for the tokens the pool holds
// ---------------------------------------------------------------------------

/** Probe size for a v4 price: 0.001 ETH in. */
export const PRICE_PROBE_WEI = 1_000_000_000_000_000n;

/**
 * Public price of every pool token: curve tokens from the curve state (spot),
 * graduated ones from the Uniswap v4 pool through V4Quoter (exact-in probe).
 * NEVER writes "0": no readable price -> the row is left as it was (core refuses
 * trades on a stale price). Returns counts only.
 */
export async function writeTokenPrices(db: Pool, network: HoodNetworkId, adapter: PonsAdapter): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  for (const mint of await hoodPoolMints(db, network)) {
    try {
      const q = await adapter.quote(mint, "buy", PRICE_PROBE_WEI);
      if (!/^\d+(\.\d+)?$/.test(q.priceEth) || /^0(\.0*)?$/.test(q.priceEth) || q.amountOut === 0n) {
        skipped++;
        continue;
      }
      await db.query(
        `UPDATE tokens SET price_sol = $2::numeric, market_cap_sol = $3::numeric, status = $4, updated_at = now() WHERE mint = $1`,
        [mint, q.priceEth, q.marketCapEth, q.status],
      );
      written++;
    } catch {
      skipped++;
    }
  }
  return { written, skipped };
}

import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  maxUint256,
  parseAbi,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { AdapterError } from "../../errors";
import type { CurveStatus } from "../../types";
import { ceilToStep } from "../fees";
import { CREATOR_FUNDING_DEFAULTS, creatorReserveWei } from "./creator-funding";
import type { EvmExecutor, OnSigned, SentEvmTx } from "../executor";
import type { EvmKeyring } from "../keys";
import type {
  EvmCreateOptions,
  EvmLaunchpadAdapter,
  EvmQuote,
  EvmSideTx,
  EvmTokenMeta,
  EvmTradeOptions,
  EvmTxResult,
} from "../types";
import { ponsV2CurveAbi } from "./abi/curve";
import { ponsV2LaunchFactoryAbi } from "./abi/factory.generated";
import { ponsV2FeeEscrowAbi } from "./abi/fee-escrow.generated";
import { ponsV2LaunchAndBuyAbi } from "./abi/launch-and-buy.generated";
import { LifiClient } from "../lifi";
import { ponsV2MemeHookAbi } from "./abi/meme-hook.generated";
import { permit2Abi } from "./abi/permit2.generated";
import { ponsV2TokenAbi } from "./abi/token";
import { universalRouterAbi } from "./abi/universal-router.generated";
import {
  encodeV4ExactInSingle,
  poolIdOf,
  ponsPoolKey,
  quoteV4ExactIn,
  UNISWAP_V4_4663,
  V4_EVENTS_ABI,
  v4PoolExists,
  type PoolKey,
  type UniswapV4Deployment,
} from "./v4";
import { NATIVE_QUOTE, PONS_V2_MAINNET, type PonsDeployment } from "./addresses";
import {
  freshCurveState,
  minOutWithSlippage,
  quoteBuy,
  quoteSell,
  readyToGraduate,
  snipeTaxBps,
  spot,
  type CurveState,
} from "./math";

/** LI.FI Diamond completion event (same-chain swap). */
export const LIFI_EVENTS_ABI = parseAbi([
  "event LiFiGenericSwapCompleted(bytes32 indexed transactionId, string integrator, string referrer, address receiver, address fromAssetId, address toAssetId, uint256 fromAmount, uint256 toAmount)",
]);

/** All Pons ABIs merged: decodes any revert the adapter can hit. */
export const PONS_ERROR_ABI = [
  ...ponsV2CurveAbi,
  ...ponsV2TokenAbi,
  ...ponsV2LaunchFactoryAbi,
  ...ponsV2LaunchAndBuyAbi,
  ...ponsV2FeeEscrowAbi,
  ...ponsV2MemeHookAbi,
  ...universalRouterAbi,
  ...permit2Abi,
  ...V4_EVENTS_ABI,
].filter((x) => x.type === "error") as Abi;

function requireVault(opts: { vault?: LocalAccount } | undefined): LocalAccount {
  if (!opts?.vault) throw new AdapterError("bad_request", "vault is required (the mint's pinned vault)");
  return opts.vault;
}

function sendOpts(opts: { onSigned?: OnSigned }): { onSigned?: OnSigned } {
  return opts.onSigned ? { onSigned: opts.onSigned } : {};
}

/** GraduationPhase enum of ILaunchpadV2.sol. */
export const PHASE = { NotGraduated: 0, Swept: 1, PoolCreated: 2, Rescued: 3 } as const;

export interface LaunchInfo {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  creatorTaxBps: number;
  phase: number;
  poolFee: number;
  tickSpacing: number;
}

export interface FactoryTerms {
  launchFee: bigint;
  launchEnabled: boolean;
  snipeTaxStartBps: bigint;
  snipeTaxSeconds: bigint;
  maxCreatorTaxBps: bigint;
  economics: Hex;
  config: { supply: bigint; curveFeeBps: bigint; phantomQuote: bigint; graduationThreshold: bigint; enabled: boolean };
}

export interface PonsAdapterOptions {
  executor: EvmExecutor;
  /** Creator (branch 1) and funder (branch 4) keys. */
  keyring: EvmKeyring;
  /** Rotating funders of creator addresses (src/evm/funders.ts FunderPool). */
  funders: { pick(value: bigint): Promise<LocalAccount> };
  deployment?: PonsDeployment;
  /** Uniswap v4 contracts for graduated tokens. Default: Robinhood Chain mainnet. */
  uniswap?: UniswapV4Deployment;
  /**
   * Fallback for graduated tokens whose v4 pool cannot be used (not seeded /
   * not initialized): LI.FI, which only ever sees the vault address. Default off.
   */
  lifi?: LifiClient | null;
  /** Deadline of v4 swaps, seconds from now. Default 300. */
  swapDeadlineSec?: number;
  /** ETH left on a creator for gas (launch tx + later fee claims). Default 0.002 ETH (HOOD_CREATOR_GAS_RESERVE_WEI via runtime). */
  creatorGasReserveWei?: bigint;
  /** Funding granularity: funder -> creator transfers are multiples of this. Default 0.01 ETH (HOOD_CREATOR_FUND_STEP_WEI via runtime). */
  fundStepWei?: bigint;
  /** Max wait for a snipe-tax window (s). Default 65 (contract max 60). */
  maxSnipeWaitSec?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_TOTAL_FEE_BPS = 2_000n;

/**
 * Pons V2 (Robinhood Chain) launchpad adapter.
 *
 * - create: a FRESH creator address (HD branch 1, never reused, never a vault,
 *   never a user's wallet) is `msg.sender` (deployer) AND `creatorFeeRecipient`;
 *   it is funded by the funder key in round amounts (never by a vault), and runs
 *   `PonsV2LaunchAndBuy.launchAndBuy` = create + first buy in ONE transaction,
 *   tokens to the mint vault (the router exempts it from the snipe tax).
 *   User input never reaches `creatorFeeRecipient` / `snipeTaxExemptions`.
 * - buy / sell: directly on the token's curve, recipient = the vault itself.
 *   Inside the snipe-tax window (99% in the first second) a buy waits it out.
 * - quote: local, exact mirror of the curve math over one block's state.
 * - status: factory phase + curve sold-out flag ("graduated" -> Uniswap v4).
 */
export class PonsAdapter implements EvmLaunchpadAdapter {
  readonly id = "pons" as const;
  readonly deployment: PonsDeployment;
  readonly uniswap: UniswapV4Deployment;
  private readonly swapDeadlineSec: number;
  private readonly lifi: LifiClient | null;
  private readonly ex: EvmExecutor;
  private readonly keyring: EvmKeyring;
  private readonly funders: { pick(value: bigint): Promise<LocalAccount> };
  private readonly creatorGasReserveWei: bigint;
  private readonly fundStepWei: bigint;
  private readonly maxSnipeWaitSec: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly curves = new Map<string, Address>();
  private verified = false;

  constructor(o: PonsAdapterOptions) {
    this.ex = o.executor;
    this.keyring = o.keyring;
    this.funders = o.funders;
    this.deployment = o.deployment ?? PONS_V2_MAINNET;
    this.uniswap = o.uniswap ?? UNISWAP_V4_4663;
    this.swapDeadlineSec = o.swapDeadlineSec ?? 300;
    this.lifi = o.lifi ?? null;
    this.creatorGasReserveWei = o.creatorGasReserveWei ?? CREATOR_FUNDING_DEFAULTS.gasReserveWei;
    this.fundStepWei = o.fundStepWei ?? CREATOR_FUNDING_DEFAULTS.fundStepWei;
    this.maxSnipeWaitSec = o.maxSnipeWaitSec ?? 65;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (this.fundStepWei <= 0n) throw new RangeError("fundStepWei must be > 0");
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Code-hash pin of the factory / router / escrow + wiring; required before any send. */
  async verifyDeployment(): Promise<void> {
    if (this.verified) return;
    const d = this.deployment;
    const [fc, lc, ec] = await Promise.all([
      this.ex.read.getCode({ address: d.factory }),
      this.ex.read.getCode({ address: d.launchAndBuy }),
      this.ex.read.getCode({ address: d.feeEscrow }),
    ]);
    const check = (name: string, code: Hex | undefined, want: Hex) => {
      if (!code || code === "0x") throw new AdapterError("venue_unavailable", `pons ${name}: no code on this chain`);
      if (keccak256(code) !== want) throw new AdapterError("venue_unavailable", `pons ${name}: code hash changed, review before use`);
    };
    check("factory", fc, d.codeHash.factory);
    check("launchAndBuy", lc, d.codeHash.launchAndBuy);
    check("feeEscrow", ec, d.codeHash.feeEscrow);
    const fwd = await this.ex.read.readContract({ address: d.factory, abi: ponsV2LaunchFactoryAbi, functionName: "launchForwarder" });
    if (getAddress(fwd) !== getAddress(d.launchAndBuy)) {
      throw new AdapterError("venue_unavailable", "pons factory forwarder rotated, review before use");
    }
    this.verified = true;
  }

  async launchInfo(token: Address): Promise<LaunchInfo> {
    let t: Address;
    try {
      t = getAddress(token);
    } catch {
      throw new AdapterError("bad_request", "token is not an EVM address");
    }
    const r = (await this.ex.read.readContract({
      address: this.deployment.factory,
      abi: ponsV2LaunchFactoryAbi,
      functionName: "getLaunchedToken",
      args: [t],
    })) as {
      token: Address;
      curve: Address;
      deployer: Address;
      creatorFeeRecipient: Address;
      pairToken: Address;
      graduationThreshold: bigint;
      creatorTaxBps: number;
      phase: number;
      poolFee: number;
      tickSpacing: number;
      exists: boolean;
    };
    if (!r.exists) throw new AdapterError("not_found", "not a Pons V2 token");
    if (getAddress(r.pairToken) !== NATIVE_QUOTE) throw new AdapterError("bad_request", "only ETH-paired Pons tokens are supported");
    this.curves.set(t.toLowerCase(), r.curve);
    return {
      token: t,
      curve: getAddress(r.curve),
      deployer: getAddress(r.deployer),
      creatorFeeRecipient: getAddress(r.creatorFeeRecipient),
      pairToken: r.pairToken,
      graduationThreshold: r.graduationThreshold,
      creatorTaxBps: Number(r.creatorTaxBps),
      phase: Number(r.phase),
      poolFee: Number(r.poolFee),
      tickSpacing: Number(r.tickSpacing),
    };
  }

  /** Curve state + block (number, timestamp) read at ONE block. */
  async curveState(curve: Address, blockNumber?: bigint): Promise<{ state: CurveState; blockNumber: bigint; timestamp: bigint }> {
    const bn = blockNumber ?? (await this.ex.read.getBlockNumber({ cacheTime: 0 }));
    const fns = [
      "phantomQuote",
      "trackedQuote",
      "quoteFeeBalance",
      "creatorTaxBalance",
      "trackedTokens",
      "reservedTokens",
      "launchSupply",
      "feeBps",
      "creatorTaxBps",
      "graduated",
      "launchedAt",
      "snipeTaxStartBps",
      "snipeTaxSeconds",
    ] as const;
    const [res, block] = await Promise.all([
      this.ex.read.multicall({
        allowFailure: false,
        blockNumber: bn,
        contracts: fns.map((functionName) => ({ address: curve, abi: ponsV2CurveAbi, functionName })),
      }),
      this.ex.read.getBlock({ blockNumber: bn }),
    ]);
    const v = res as unknown[];
    const b = (i: number) => v[i] as bigint;
    return {
      state: {
        phantomQuote: b(0),
        trackedQuote: b(1),
        quoteFeeBalance: b(2),
        creatorTaxBalance: b(3),
        trackedTokens: b(4),
        reservedTokens: b(5),
        launchSupply: b(6),
        feeBps: b(7),
        creatorTaxBps: b(8),
        graduated: v[9] as boolean,
        launchedAt: b(10),
        snipeTaxStartBps: b(11),
        snipeTaxSeconds: b(12),
      },
      blockNumber: bn,
      timestamp: block.timestamp,
    };
  }

  async factoryTerms(): Promise<FactoryTerms> {
    const d = this.deployment;
    const c = (functionName: string, args?: readonly unknown[]) =>
      ({ address: d.factory, abi: ponsV2LaunchFactoryAbi, functionName, ...(args ? { args } : {}) }) as const;
    const r = (await this.ex.read.multicall({
      allowFailure: false,
      contracts: [
        c("launchFee"),
        c("launchEnabled"),
        c("snipeTaxStartBps"),
        c("snipeTaxSeconds"),
        c("maxCreatorTaxBps"),
        c("previewLaunchEconomics", [d.launchConfigId, NATIVE_QUOTE]),
        c("getLaunchConfig", [d.launchConfigId]),
      ] as never,
    })) as unknown[];
    const cfg = r[6] as FactoryTerms["config"];
    return {
      launchFee: r[0] as bigint,
      launchEnabled: r[1] as boolean,
      snipeTaxStartBps: r[2] as bigint,
      snipeTaxSeconds: r[3] as bigint,
      maxCreatorTaxBps: r[4] as bigint,
      economics: r[5] as Hex,
      config: {
        supply: cfg.supply,
        curveFeeBps: cfg.curveFeeBps,
        phantomQuote: cfg.phantomQuote,
        graduationThreshold: cfg.graduationThreshold,
        enabled: cfg.enabled,
      },
    };
  }

  async status(token: Address): Promise<CurveStatus> {
    const info = await this.launchInfo(token);
    if (info.phase !== PHASE.NotGraduated) return "graduated";
    const { state } = await this.curveState(info.curve);
    return state.graduated || readyToGraduate(state) ? "graduated" : "curve";
  }

  /**
   * Local quote over one block's curve state. A buy is priced for `recipient`
   * (pass the job's vault): it pays the snipe tax only if it is not exempt and
   * the window is open at that block; no recipient = a non-exempt buyer.
   */
  async quote(token: Address, side: "buy" | "sell", amount: bigint, opts: { recipient?: Address } = {}): Promise<EvmQuote> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    const info = await this.launchInfo(token);
    if (info.phase !== PHASE.NotGraduated) return this.quoteV4(info, side, amount);
    const { state, blockNumber, timestamp } = await this.curveState(info.curve);
    let sb = 0n;
    if (side === "buy" && snipeTaxBps(state, false, timestamp) > 0n) {
      const exempt = opts.recipient === undefined ? false : await this.ex.read.readContract({
        address: info.curve,
        abi: ponsV2CurveAbi,
        functionName: "snipeTaxExempt",
        args: [opts.recipient],
        blockNumber,
      });
      sb = snipeTaxBps(state, exempt, timestamp);
    }
    const s = spot(state);
    const status: CurveStatus = state.graduated || readyToGraduate(state) ? "graduated" : "curve";
    const base = { venue: this.id, token: info.token, side, amountIn: amount, snipeTaxBps: sb, priceEth: s.price, marketCapEth: s.marketCap, status, decimals: 18, blockNumber, route: "curve" as const };
    if (side === "buy") {
      const q = quoteBuy(state, amount, sb);
      return { ...base, amountOut: q.tokensOut, spent: q.spent, refund: q.refund };
    }
    return { ...base, amountOut: quoteSell(state, amount).quoteOut };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** Read-only network (mainnet without the lead's approval): fail before any RPC. */
  private requireSend(): void {
    if (!this.ex.allowSend) {
      throw new AdapterError("venue_unavailable", "EVM sends are disabled on this network (read-only)", { stage: "build" });
    }
  }

  async create(meta: EvmTokenMeta, initialBuyWei: bigint, opts: EvmCreateOptions): Promise<EvmTxResult> {
    const name = meta.name.trim();
    const symbol = meta.symbol.trim();
    if (!name || !symbol) throw new AdapterError("bad_request", "name and symbol are required");
    if (initialBuyWei < 0n) throw new AdapterError("bad_request", "initial buy must be >= 0");
    this.requireSend();
    requireVault(opts);
    const creatorTaxBps = BigInt(opts.creatorTaxBps ?? 0);
    await this.verifyDeployment();
    const terms = await this.factoryTerms();
    if (!terms.config.enabled) throw new AdapterError("venue_unavailable", "pons launch config disabled");
    if (creatorTaxBps < 0n || creatorTaxBps > terms.maxCreatorTaxBps || terms.config.curveFeeBps + creatorTaxBps > MAX_TOTAL_FEE_BPS) {
      throw new AdapterError("bad_request", "creator tax out of range");
    }

    const vault = requireVault(opts);
    const creatorIndex = opts.creatorIndex ?? (await this.keyring.allocateCreator());
    const creator = this.keyring.creator(creatorIndex);
    if (!terms.launchEnabled) {
      const ok = await this.ex.read.readContract({ address: this.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "canLaunch", args: [creator.address] });
      if (!ok) throw new AdapterError("venue_unavailable", "pons launches are closed (whitelist only)");
    }
    // A creator signs exactly one launch: a used one means a previous attempt landed.
    const used = await this.ex.read.getTransactionCount({ address: creator.address, blockTag: "latest" });
    if (used > 0) {
      throw new AdapterError("internal", "creator address already launched; reconcile the earlier attempt instead of retrying", { stage: "build" });
    }

    // Secret-but-deterministic CREATE2 salt (a retry with the same creator collides instead of launching twice).
    const salt = keccak256(await creator.signMessage({ message: "unzeen/pons/salt/v1" }));
    const params = {
      name,
      symbol,
      logo: meta.logo ?? "",
      description: meta.description ?? "",
      socials: {
        twitter: meta.socials?.twitter ?? "",
        telegram: meta.socials?.telegram ?? "",
        discord: meta.socials?.discord ?? "",
        website: meta.socials?.website ?? "",
        farcaster: meta.socials?.farcaster ?? "",
      },
      creatorFeeRecipient: creator.address,
      creatorTaxBps: Number(creatorTaxBps),
      buybackEnabled: false,
      expectedEconomics: terms.economics,
      salt,
    };

    let call: { to: Address; data: Hex; value: bigint };
    let expectedOut = 0n;
    if (initialBuyWei > 0n) {
      const fresh = freshCurveState({
        supply: terms.config.supply,
        curveFeeBps: terms.config.curveFeeBps,
        phantomQuote: terms.config.phantomQuote,
        graduationThreshold: terms.config.graduationThreshold,
        creatorTaxBps,
        snipeTaxStartBps: terms.snipeTaxStartBps,
        snipeTaxSeconds: terms.snipeTaxSeconds,
      });
      expectedOut = quoteBuy(fresh, initialBuyWei, 0n).tokensOut; // recipient is exempt
      if (opts.minOut !== undefined && expectedOut < opts.minOut) throw new AdapterError("slippage", "first buy below min_out");
      const own = minOutWithSlippage(expectedOut, BigInt(opts.slippageBps ?? 0));
      const minOut = opts.minOut !== undefined && opts.minOut > own ? opts.minOut : own;
      call = {
        to: this.deployment.launchAndBuy,
        data: encodeFunctionData({
          abi: ponsV2LaunchAndBuyAbi,
          functionName: "launchAndBuy",
          args: [params, this.deployment.launchConfigId, NATIVE_QUOTE, initialBuyWei, minOut, vault.address, []],
        }),
        value: terms.launchFee + initialBuyWei,
      };
    } else {
      call = {
        to: this.deployment.factory,
        data: encodeFunctionData({
          abi: ponsV2LaunchFactoryAbi,
          functionName: "launchToken",
          args: [params, this.deployment.launchConfigId, NATIVE_QUOTE],
        }),
        value: terms.launchFee,
      };
    }

    const sideTxs: EvmSideTx[] = [];
    const fund = await this.fundCreator(creator.address, call.value);
    if (fund) sideTxs.push(fund);

    let sent: SentEvmTx;
    try {
      sent = await this.ex.send(creator, call, sendOpts(opts));
    } catch (e) {
      throw e instanceof AdapterError ? e : new AdapterError("internal", String(e), { cause: e });
    }

    const logs = sent.receipt.logs;
    const launched = parseEventLogs({ abi: ponsV2LaunchFactoryAbi, logs, eventName: "TokenLaunched" }).find(
      (l) => getAddress(l.address) === getAddress(this.deployment.factory),
    );
    if (!launched) throw new AdapterError("internal", "launch landed but TokenLaunched not found", { signature: sent.hash, stage: "confirm" });
    const token = getAddress(launched.args.token);
    const curve = getAddress(launched.args.curve);
    this.curves.set(token.toLowerCase(), curve);
    const trade = initialBuyWei > 0n ? this.buyFromLogs(logs, curve) : null;
    if (initialBuyWei > 0n && !trade) throw new AdapterError("internal", "launch landed but CurveBuy not found", { signature: sent.hash, stage: "confirm" });

    if (trade && trade.tokensOut > 0n && opts.approveAfterBuy !== false) {
      const a = await this.ensureAllowance(vault, token, curve, maxUint256 >> 1n).catch(() => null);
      if (a) sideTxs.push(a);
    }

    return {
      ...(await this.baseResult("create", sent, token, curve, vault.address, sideTxs)),
      tokenAmount: trade?.tokensOut ?? 0n,
      quoteAmount: trade?.spent ?? 0n,
      venueFee: trade?.fee ?? 0n,
      creatorTax: trade?.tax ?? 0n,
      snipeTax: trade?.snipeTax ?? 0n,
      refund: trade?.refund ?? 0n,
      launchFee: terms.launchFee,
      creator: getAddress(creator.address),
      creatorIndex,
    };
  }

  async buy(token: Address, weiIn: bigint, minOut: bigint, opts: EvmTradeOptions): Promise<EvmTxResult> {
    if (weiIn <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (minOut < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    this.requireSend();
    requireVault(opts);
    await this.verifyDeployment();
    const info = await this.launchInfo(token);
    const vault = requireVault(opts);
    if (info.phase !== PHASE.NotGraduated) return this.tradeV4(info, "buy", weiIn, minOut, vault, opts);

    await this.waitSnipeTax(info.curve, vault.address, opts.snipeTax ?? "wait");
    const { state } = await this.curveState(info.curve);
    if (state.graduated || readyToGraduate(state)) throw new AdapterError("graduated", "curve sold out");

    const sent = await this.ex.send(vault, {
      to: info.curve,
      data: encodeFunctionData({ abi: ponsV2CurveAbi, functionName: "buy", args: [weiIn, minOut, vault.address] }),
      value: weiIn,
    }, sendOpts(opts));
    const trade = this.buyFromLogs(sent.receipt.logs, info.curve);
    if (!trade) throw new AdapterError("internal", "buy landed but CurveBuy not found", { signature: sent.hash, stage: "confirm" });

    const sideTxs: EvmSideTx[] = [];
    if (opts.approveAfterBuy !== false) {
      const a = await this.ensureAllowance(vault, info.token, info.curve, maxUint256 >> 1n).catch(() => null);
      if (a) sideTxs.push(a);
    }
    return {
      ...(await this.baseResult("buy", sent, info.token, info.curve, vault.address, sideTxs)),
      tokenAmount: trade.tokensOut,
      quoteAmount: trade.spent,
      venueFee: trade.fee,
      creatorTax: trade.tax,
      snipeTax: trade.snipeTax,
      refund: trade.refund,
    };
  }

  async sell(token: Address, amount: bigint, minWei: bigint, opts: EvmTradeOptions): Promise<EvmTxResult> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (minWei < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    this.requireSend();
    requireVault(opts);
    await this.verifyDeployment();
    const info = await this.launchInfo(token);
    const vault = requireVault(opts);
    if (info.phase !== PHASE.NotGraduated) return this.tradeV4(info, "sell", amount, minWei, vault, opts);
    const bal = await this.ex.read.readContract({ address: info.token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [vault.address] });
    if (bal < amount) throw new AdapterError("insufficient_tokens", "vault does not hold enough tokens");

    const sideTxs: EvmSideTx[] = [];
    const a = await this.ensureAllowance(vault, info.token, info.curve, amount);
    if (a) sideTxs.push(a);

    const sent = await this.ex.send(vault, {
      to: info.curve,
      data: encodeFunctionData({ abi: ponsV2CurveAbi, functionName: "sell", args: [amount, minWei, vault.address] }),
    }, sendOpts(opts));
    const ev = parseEventLogs({ abi: ponsV2CurveAbi, logs: sent.receipt.logs, eventName: "CurveSell" }).find(
      (l) => getAddress(l.address) === info.curve,
    );
    if (!ev) throw new AdapterError("internal", "sell landed but CurveSell not found", { signature: sent.hash, stage: "confirm" });
    return {
      ...(await this.baseResult("sell", sent, info.token, info.curve, vault.address, sideTxs)),
      tokenAmount: ev.args.tokensIn,
      quoteAmount: ev.args.quoteOut,
      venueFee: ev.args.fee,
      creatorTax: ev.args.tax,
      snipeTax: 0n,
      refund: 0n,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Funder -> creator top-up, ceil to `fundStepWei` (round amounts), skipped if the creator already has enough.
   * Gas part = max(reserve, PONS_CREATE_GAS_LIMIT x current pool fee cap): a cap that rose after start-up
   * tops the creator up (a retry on the same creator gets one more step) instead of a stuck create.
   */
  private async fundCreator(creator: Address, txValue: bigint): Promise<EvmSideTx | null> {
    const need = txValue + creatorReserveWei(this.creatorGasReserveWei, this.ex.fees.maxFeePerGas);
    const have = await this.ex.balance(creator);
    if (have >= need) return null;
    const value = ceilToStep(need - have, this.fundStepWei);
    const sent = await this.ex.transfer(await this.funders.pick(value), creator, value);
    return { kind: "fund", hash: sent.hash, networkFee: sent.networkFee, value };
  }

  /** approve(curve, max) when the allowance is below `atLeast`. Returns the approve tx, or null if not needed. */
  async ensureAllowance(vault: LocalAccount, token: Address, curve: Address, atLeast: bigint): Promise<EvmSideTx | null> {
    const cur = await this.ex.read.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "allowance", args: [vault.address, curve] });
    if (cur >= atLeast) return null;
    const sent = await this.ex.send(vault, {
      to: token,
      data: encodeFunctionData({ abi: ponsV2TokenAbi, functionName: "approve", args: [curve, maxUint256] }),
    });
    return { kind: "approve", hash: sent.hash, networkFee: sent.networkFee };
  }

  /**
   * Waits out the snipe-tax window for `recipient` (or fails, per policy).
   * Time = max(latest block timestamp, wall clock - 2 s): blocks come every
   * ~0.1 s on Robinhood Chain, but a quiet chain (or a local fork) may not
   * produce a block that would move `block.timestamp` in an eth_call.
   */
  private async waitSnipeTax(curve: Address, recipient: Address, policy: "wait" | "fail"): Promise<void> {
    const exempt = await this.ex.read.readContract({ address: curve, abi: ponsV2CurveAbi, functionName: "snipeTaxExempt", args: [recipient] });
    if (exempt) return;
    const deadline = Date.now() + this.maxSnipeWaitSec * 1000;
    for (;;) {
      const { state, timestamp } = await this.curveState(curve);
      const wall = BigInt(Math.floor(Date.now() / 1000)) - 2n;
      const now = timestamp > wall ? timestamp : wall;
      if (snipeTaxBps(state, false, now) === 0n) return;
      if (policy === "fail") throw new AdapterError("venue_unavailable", "token is inside its snipe-tax window; retry in a few seconds");
      if (Date.now() > deadline) throw new AdapterError("venue_unavailable", "snipe-tax window did not close in time");
      const left = Number(state.launchedAt + state.snipeTaxSeconds - now);
      await this.sleep(Math.max(1, left) * 1000);
    }
  }

  private buyFromLogs(logs: SentEvmTx["receipt"]["logs"], curve: Address) {
    const mine = logs.filter((l) => getAddress(l.address) === curve);
    const buy = parseEventLogs({ abi: ponsV2CurveAbi, logs: mine, eventName: "CurveBuy" })[0];
    if (!buy) return null;
    const refund = parseEventLogs({ abi: ponsV2CurveAbi, logs: mine, eventName: "CurveBuyRefunded" })[0]?.args.refund ?? 0n;
    const snipeTax = parseEventLogs({ abi: ponsV2CurveAbi, logs: mine, eventName: "SnipeTaxCharged" })[0]?.args.amount ?? 0n;
    return { tokensOut: buy.args.tokensOut, spent: buy.args.quoteIn, fee: buy.args.fee, tax: buy.args.tax, refund, snipeTax };
  }

  private async baseResult(
    kind: EvmTxResult["kind"],
    sent: SentEvmTx,
    token: Address,
    curve: Address,
    vault: Address,
    sideTxs: EvmSideTx[],
  ): Promise<Omit<EvmTxResult, "tokenAmount" | "quoteAmount" | "venueFee" | "creatorTax" | "snipeTax" | "refund">> {
    let blockTime: number | null = null;
    try {
      blockTime = Number((await this.ex.read.getBlock({ blockNumber: sent.receipt.blockNumber })).timestamp);
    } catch {
      blockTime = null;
    }
    return {
      venue: this.id,
      network: "hood",
      chainId: this.deployment.chainId,
      kind,
      hash: sent.hash,
      blockNumber: sent.receipt.blockNumber,
      blockTime,
      token,
      curve,
      vault: getAddress(vault),
      networkFee: sent.networkFee,
      sideTxs,
      decimals: 18,
      route: "curve",
      amountsKnown: true,
      fromEvent: true,
    };
  }

  // -------------------------------------------------------------------------
  // Graduated tokens: Uniswap v4 (the pool the Pons factory seeded)
  // -------------------------------------------------------------------------

  poolKey(info: LaunchInfo): PoolKey {
    return ponsPoolKey(info.token, info.poolFee, info.tickSpacing, this.deployment.memeHook);
  }

  /** Graduated -> its v4 pool key, after checking the pool is live. Swept = seeding pending. */
  private async liveV4Pool(info: LaunchInfo): Promise<PoolKey> {
    if (info.phase === PHASE.Rescued) throw new AdapterError("graduated", "graduation was rescued: no v4 pool for this token");
    if (info.phase === PHASE.Swept) throw new AdapterError("venue_unavailable", "graduation in progress: v4 pool not seeded yet");
    const key = this.poolKey(info);
    if (!(await v4PoolExists(this.ex.read, this.uniswap.stateView, poolIdOf(key)))) {
      throw new AdapterError("venue_unavailable", "v4 pool of the graduated token is not initialized");
    }
    return key;
  }

  private async quoteV4(info: LaunchInfo, side: "buy" | "sell", amount: bigint): Promise<EvmQuote> {
    const key = await this.liveV4Pool(info);
    const blockNumber = await this.ex.read.getBlockNumber({ cacheTime: 0 });
    const out = await quoteV4ExactIn(this.ex.read, this.uniswap.quoter, key, side === "buy", amount, blockNumber);
    // Spot from a tiny probe would cost another eth_call; price = executed average here.
    const priceWeiPerToken = side === "buy" ? (out > 0n ? (amount * 10n ** 18n) / out : 0n) : (out * 10n ** 18n) / amount;
    const supply = await this.ex.read.readContract({ address: info.token, abi: ponsV2TokenAbi, functionName: "totalSupply", blockNumber });
    return {
      venue: this.id,
      token: info.token,
      side,
      amountIn: amount,
      amountOut: out,
      snipeTaxBps: 0n,
      priceEth: formatUnits(priceWeiPerToken, 18),
      marketCapEth: formatUnits((priceWeiPerToken * supply) / 10n ** 18n, 18),
      status: "graduated",
      decimals: 18,
      blockNumber,
      route: "uniswap-v4",
    };
  }

  /** Permissionless phase 2 of graduation: seed the v4 pool (any account; we use the vault). */
  async seedGraduatedPool(token: Address, from: LocalAccount): Promise<SentEvmTx> {
    this.requireSend();
    return this.ex.send(from, {
      to: this.deployment.factory,
      data: encodeFunctionData({ abi: ponsV2LaunchFactoryAbi, functionName: "createGraduatedPool", args: [getAddress(token)] }),
    });
  }

  private async tradeV4(
    info0: LaunchInfo,
    side: "buy" | "sell",
    amountIn: bigint,
    minOut: bigint,
    vault: LocalAccount,
    opts: EvmTradeOptions,
  ): Promise<EvmTxResult> {
    let info = info0;
    const sideTxs: EvmSideTx[] = [];
    if (info.phase === PHASE.Swept && opts.seedPool) {
      await this.seedGraduatedPool(info.token, vault);
      info = await this.launchInfo(info.token);
    }
    let key: PoolKey;
    try {
      key = await this.liveV4Pool(info);
    } catch (e) {
      if (this.lifi && e instanceof AdapterError && e.code === "venue_unavailable") return this.tradeLifi(info, side, amountIn, minOut, vault, opts);
      throw e;
    }
    if (side === "sell") {
      const bal = await this.ex.read.readContract({ address: info.token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [vault.address] });
      if (bal < amountIn) throw new AdapterError("insufficient_tokens", "vault does not hold enough tokens");
      sideTxs.push(...(await this.ensurePermit2(vault, info.token, amountIn)));
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.swapDeadlineSec);
    const sent = await this.ex.send(vault, {
      to: this.uniswap.universalRouter,
      data: encodeV4ExactInSingle({ key, zeroForOne: side === "buy", amountIn, minOut, deadline }),
      value: side === "buy" ? amountIn : 0n,
    }, sendOpts(opts));
    const logs = sent.receipt.logs;
    const id = poolIdOf(key);
    const swap = parseEventLogs({ abi: V4_EVENTS_ABI, logs, eventName: "Swap" }).find(
      (l) => getAddress(l.address) === this.uniswap.poolManager && l.args.id === id,
    );
    if (!swap) throw new AdapterError("internal", "v4 swap landed but Swap not found", { signature: sent.hash, stage: "confirm" });
    const skim = parseEventLogs({ abi: V4_EVENTS_ABI, logs, eventName: "HookFeeCollected" }).find(
      (l) => getAddress(l.address) === this.deployment.memeHook && l.args.poolId === id,
    );
    const fee = skim?.args.feeAmount ?? 0n;
    const tax = skim?.args.taxAmount ?? 0n;
    let tokenAmount: bigint;
    let quoteAmount: bigint;
    if (side === "buy") {
      // Tokens that actually reached the vault (after the hook's skim).
      tokenAmount = parseEventLogs({ abi: ponsV2TokenAbi, logs, eventName: "Transfer" })
        .filter((l) => getAddress(l.address) === info.token && getAddress(l.args.to) === getAddress(vault.address))
        .reduce((a, l) => a + l.args.value, 0n);
      quoteAmount = amountIn;
    } else {
      tokenAmount = amountIn;
      quoteAmount = swap.args.amount0 - fee - tax; // ETH to the swapper minus the skim
    }
    if (side === "buy" && opts.approveAfterBuy !== false) {
      sideTxs.push(...(await this.ensurePermit2(vault, info.token, maxUint256 >> 1n).catch(() => [])));
    }
    return {
      ...(await this.baseResult(side, sent, info.token, info.curve, vault.address, sideTxs)),
      route: "uniswap-v4",
      tokenAmount,
      quoteAmount,
      venueFee: fee,
      creatorTax: tax,
      snipeTax: 0n,
      refund: 0n,
      ...(side === "buy" ? { feeInToken: true } : {}),
    };
  }

  /** LI.FI fallback: exact-amount approval to the pinned Diamond, then its validated calldata. */
  private async tradeLifi(info: LaunchInfo, side: "buy" | "sell", amountIn: bigint, minOut: bigint, vault: LocalAccount, opts: Partial<EvmTradeOptions> = {}): Promise<EvmTxResult> {
    const lifi = this.lifi!;
    const fromToken = side === "buy" ? NATIVE_QUOTE : info.token;
    const toToken = side === "buy" ? info.token : NATIVE_QUOTE;
    if (side === "sell") {
      const bal = await this.ex.read.readContract({ address: info.token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [vault.address] });
      if (bal < amountIn) throw new AdapterError("insufficient_tokens", "vault does not hold enough tokens");
    }
    const route = await lifi.quote({ fromToken, toToken, fromAmount: amountIn, vault: vault.address, minOut });
    const sideTxs: EvmSideTx[] = [];
    if (side === "sell") {
      const cur = await this.ex.read.readContract({ address: info.token, abi: ponsV2TokenAbi, functionName: "allowance", args: [vault.address, route.approvalAddress] });
      if (cur < amountIn) {
        const ap = await this.ex.send(vault, {
          to: info.token,
          data: encodeFunctionData({ abi: ponsV2TokenAbi, functionName: "approve", args: [route.approvalAddress, amountIn] }),
        });
        sideTxs.push({ kind: "approve", hash: ap.hash, networkFee: ap.networkFee });
      }
    }
    const sent = await this.ex.send(vault, { to: route.to, data: route.data, value: route.value }, sendOpts(opts));
    const done = parseEventLogs({ abi: LIFI_EVENTS_ABI, logs: sent.receipt.logs, eventName: "LiFiGenericSwapCompleted" }).find(
      (l) => getAddress(l.address) === route.to && getAddress(l.args.receiver) === getAddress(vault.address),
    );
    return {
      ...(await this.baseResult(side, sent, info.token, info.curve, vault.address, sideTxs)),
      route: "lifi",
      tokenAmount: side === "buy" ? (done?.args.toAmount ?? 0n) : amountIn,
      quoteAmount: side === "buy" ? amountIn : (done?.args.toAmount ?? 0n),
      venueFee: 0n,
      creatorTax: 0n,
      snipeTax: 0n,
      refund: 0n,
      amountsKnown: done !== undefined,
      fromEvent: done !== undefined,
    };
  }

  /** ERC-20 -> Permit2 (max) and Permit2 -> Universal Router (max amount, max expiry), only when missing. */
  async ensurePermit2(vault: LocalAccount, token: Address, atLeast: bigint): Promise<EvmSideTx[]> {
    const out: EvmSideTx[] = [];
    const a = await this.ensureAllowance(vault, token, this.uniswap.permit2, atLeast);
    if (a) out.push(a);
    const [amount, expiration] = await this.ex.read.readContract({
      address: this.uniswap.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [vault.address, token, this.uniswap.universalRouter],
    });
    const MAX160 = (1n << 160n) - 1n;
    const MAX48 = (1n << 48n) - 1n;
    const now = Math.floor(Date.now() / 1000);
    if (amount < (atLeast > MAX160 ? MAX160 : atLeast) || Number(expiration) < now + 86_400) {
      const sent = await this.ex.send(vault, {
        to: this.uniswap.permit2,
        data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, this.uniswap.universalRouter, MAX160, Number(MAX48)] }),
      });
      out.push({ kind: "approve", hash: sent.hash, networkFee: sent.networkFee });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Recovery: the result of a tx that landed while the relayer was down
  // -------------------------------------------------------------------------

  /**
   * Rebuilds the result of a LANDED main tx from its receipt (relayer restart:
   * the hash was recorded before broadcast). Route is detected from the logs
   * (curve / Uniswap v4 / LI.FI); `amountsKnown = false` when they cannot be read.
   */
  async resultFromReceipt(
    kind: "buy" | "sell" | "create",
    receipt: SentEvmTx["receipt"],
    ctx: { vault: Address; token?: Address; creatorIndex?: number },
  ): Promise<EvmTxResult> {
    const logs = receipt.logs;
    const sent: SentEvmTx = { hash: receipt.transactionHash, receipt, gasLimit: 0n, networkFee: receipt.gasUsed * receipt.effectiveGasPrice };
    const vault = getAddress(ctx.vault);
    const zero = { venueFee: 0n, creatorTax: 0n, snipeTax: 0n, refund: 0n };
    if (kind === "create") {
      const launched = parseEventLogs({ abi: ponsV2LaunchFactoryAbi, logs, eventName: "TokenLaunched" }).find(
        (l) => getAddress(l.address) === getAddress(this.deployment.factory),
      );
      if (!launched) throw new AdapterError("internal", "launch receipt without TokenLaunched", { signature: receipt.transactionHash, stage: "confirm" });
      const token = getAddress(launched.args.token);
      const curve = getAddress(launched.args.curve);
      const trade = this.buyFromLogs(logs, curve);
      const tx = await this.ex.read.getTransaction({ hash: receipt.transactionHash });
      const spentOnBuy = trade ? trade.spent + trade.refund : 0n;
      return {
        ...(await this.baseResult("create", sent, token, curve, vault, [])),
        tokenAmount: trade?.tokensOut ?? 0n,
        quoteAmount: trade?.spent ?? 0n,
        venueFee: trade?.fee ?? 0n,
        creatorTax: trade?.tax ?? 0n,
        snipeTax: trade?.snipeTax ?? 0n,
        refund: trade?.refund ?? 0n,
        launchFee: tx.value - spentOnBuy,
        creator: getAddress(tx.from),
        ...(ctx.creatorIndex !== undefined ? { creatorIndex: ctx.creatorIndex } : {}),
      };
    }
    if (!ctx.token) throw new AdapterError("internal", "token required");
    const info = await this.launchInfo(ctx.token);
    const base = await this.baseResult(kind, sent, info.token, info.curve, vault, []);
    const curveLogs = logs.filter((l) => getAddress(l.address) === info.curve);
    if (kind === "buy") {
      const t = this.buyFromLogs(curveLogs, info.curve);
      if (t) return { ...base, tokenAmount: t.tokensOut, quoteAmount: t.spent, venueFee: t.fee, creatorTax: t.tax, snipeTax: t.snipeTax, refund: t.refund };
    } else {
      const ev = parseEventLogs({ abi: ponsV2CurveAbi, logs: curveLogs, eventName: "CurveSell" })[0];
      if (ev) return { ...base, tokenAmount: ev.args.tokensIn, quoteAmount: ev.args.quoteOut, venueFee: ev.args.fee, creatorTax: ev.args.tax, snipeTax: 0n, refund: 0n };
    }
    const transfers = parseEventLogs({ abi: ponsV2TokenAbi, logs, eventName: "Transfer" }).filter((l) => getAddress(l.address) === info.token);
    const toVault = transfers.filter((l) => getAddress(l.args.to) === vault).reduce((a, l) => a + l.args.value, 0n);
    const fromVault = transfers.filter((l) => getAddress(l.args.from) === vault).reduce((a, l) => a + l.args.value, 0n);
    if (info.phase === PHASE.PoolCreated) {
      const id = poolIdOf(this.poolKey(info));
      const swap = parseEventLogs({ abi: V4_EVENTS_ABI, logs, eventName: "Swap" }).find(
        (l) => getAddress(l.address) === this.uniswap.poolManager && l.args.id === id,
      );
      if (swap) {
        const skim = parseEventLogs({ abi: V4_EVENTS_ABI, logs, eventName: "HookFeeCollected" }).find((l) => l.args.poolId === id);
        const fee = skim?.args.feeAmount ?? 0n;
        const tax = skim?.args.taxAmount ?? 0n;
        const tx = await this.ex.read.getTransaction({ hash: receipt.transactionHash });
        return kind === "buy"
          ? { ...base, ...zero, route: "uniswap-v4", tokenAmount: toVault, quoteAmount: tx.value, venueFee: fee, creatorTax: tax, feeInToken: true }
          : { ...base, ...zero, route: "uniswap-v4", tokenAmount: fromVault, quoteAmount: swap.args.amount0 - fee - tax, venueFee: fee, creatorTax: tax };
      }
    }
    const done = parseEventLogs({ abi: LIFI_EVENTS_ABI, logs, eventName: "LiFiGenericSwapCompleted" }).find((l) => getAddress(l.args.receiver) === vault);
    if (done) {
      return kind === "buy"
        ? { ...base, ...zero, route: "lifi", tokenAmount: done.args.toAmount, quoteAmount: done.args.fromAmount }
        : { ...base, ...zero, route: "lifi", tokenAmount: done.args.fromAmount, quoteAmount: done.args.toAmount };
    }
    return { ...base, ...zero, tokenAmount: 0n, quoteAmount: 0n, amountsKnown: false, fromEvent: false };
  }
}

import {
  encodeFunctionData,
  getAddress,
  keccak256,
  maxUint256,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { AdapterError } from "../../errors";
import type { CurveStatus } from "../../types";
import { ceilToStep } from "../fees";
import type { EvmExecutor, SentEvmTx } from "../executor";
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
import { ponsV2TokenAbi } from "./abi/token";
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

/** All Pons ABIs merged: decodes any revert the adapter can hit. */
export const PONS_ERROR_ABI = [
  ...ponsV2CurveAbi,
  ...ponsV2TokenAbi,
  ...ponsV2LaunchFactoryAbi,
  ...ponsV2LaunchAndBuyAbi,
  ...ponsV2FeeEscrowAbi,
].filter((x) => x.type === "error") as Abi;

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
  /** Default vault when a call does not pass one. */
  vault: LocalAccount;
  deployment?: PonsDeployment;
  /** ETH left on a creator for gas (launch tx + later fee claims). Default 0.002 ETH. */
  creatorGasReserveWei?: bigint;
  /** Funding granularity: funder -> creator transfers are multiples of this. Default 0.01 ETH. */
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
  private readonly ex: EvmExecutor;
  private readonly keyring: EvmKeyring;
  private readonly defaultVault: LocalAccount;
  private readonly creatorGasReserveWei: bigint;
  private readonly fundStepWei: bigint;
  private readonly maxSnipeWaitSec: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly curves = new Map<string, Address>();
  private verified = false;

  constructor(o: PonsAdapterOptions) {
    this.ex = o.executor;
    this.keyring = o.keyring;
    this.defaultVault = o.vault;
    this.deployment = o.deployment ?? PONS_V2_MAINNET;
    this.creatorGasReserveWei = o.creatorGasReserveWei ?? 2_000_000_000_000_000n;
    this.fundStepWei = o.fundStepWei ?? 10_000_000_000_000_000n;
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
   * (default: the default vault, the address our buys go to): it pays the snipe
   * tax only if it is not exempt and the window is open at that block.
   */
  async quote(token: Address, side: "buy" | "sell", amount: bigint, opts: { recipient?: Address } = {}): Promise<EvmQuote> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    const info = await this.launchInfo(token);
    if (info.phase !== PHASE.NotGraduated) throw new AdapterError("graduated", "token graduated to Uniswap v4");
    const { state, blockNumber, timestamp } = await this.curveState(info.curve);
    let sb = 0n;
    if (side === "buy" && snipeTaxBps(state, false, timestamp) > 0n) {
      const exempt = await this.ex.read.readContract({
        address: info.curve,
        abi: ponsV2CurveAbi,
        functionName: "snipeTaxExempt",
        args: [opts.recipient ?? this.defaultVault.address],
        blockNumber,
      });
      sb = snipeTaxBps(state, exempt, timestamp);
    }
    const s = spot(state);
    const status: CurveStatus = state.graduated || readyToGraduate(state) ? "graduated" : "curve";
    const base = { venue: this.id, token: info.token, side, amountIn: amount, snipeTaxBps: sb, priceEth: s.price, marketCapEth: s.marketCap, status, decimals: 18, blockNumber };
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

  async create(meta: EvmTokenMeta, initialBuyWei: bigint, opts: EvmCreateOptions = {}): Promise<EvmTxResult> {
    const name = meta.name.trim();
    const symbol = meta.symbol.trim();
    if (!name || !symbol) throw new AdapterError("bad_request", "name and symbol are required");
    if (initialBuyWei < 0n) throw new AdapterError("bad_request", "initial buy must be >= 0");
    this.requireSend();
    const creatorTaxBps = BigInt(opts.creatorTaxBps ?? 0);
    await this.verifyDeployment();
    const terms = await this.factoryTerms();
    if (!terms.config.enabled) throw new AdapterError("venue_unavailable", "pons launch config disabled");
    if (creatorTaxBps < 0n || creatorTaxBps > terms.maxCreatorTaxBps || terms.config.curveFeeBps + creatorTaxBps > MAX_TOTAL_FEE_BPS) {
      throw new AdapterError("bad_request", "creator tax out of range");
    }

    const vault = opts.vault ?? this.defaultVault;
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
      const minOut = minOutWithSlippage(expectedOut, BigInt(opts.slippageBps ?? 0));
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
      sent = await this.ex.send(creator, call);
    } catch (e) {
      throw e instanceof AdapterError ? e : new AdapterError("internal", String(e), { cause: e });
    }

    const logs = sent.receipt.logs;
    const launched = parseEventLogs({ abi: ponsV2LaunchFactoryAbi, logs, eventName: "TokenLaunched" }).find(
      (l) => getAddress(l.address) === getAddress(this.deployment.factory),
    );
    if (!launched) throw new AdapterError("internal", "launch landed but TokenLaunched not found", { signature: sent.hash });
    const token = getAddress(launched.args.token);
    const curve = getAddress(launched.args.curve);
    this.curves.set(token.toLowerCase(), curve);
    const trade = initialBuyWei > 0n ? this.buyFromLogs(logs, curve) : null;
    if (initialBuyWei > 0n && !trade) throw new AdapterError("internal", "launch landed but CurveBuy not found", { signature: sent.hash });

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

  async buy(token: Address, weiIn: bigint, minOut: bigint, opts: EvmTradeOptions = {}): Promise<EvmTxResult> {
    if (weiIn <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (minOut < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    this.requireSend();
    await this.verifyDeployment();
    const info = await this.launchInfo(token);
    if (info.phase !== PHASE.NotGraduated) throw new AdapterError("graduated", "token graduated to Uniswap v4");
    const vault = opts.vault ?? this.defaultVault;

    await this.waitSnipeTax(info.curve, vault.address, opts.snipeTax ?? "wait");
    const { state } = await this.curveState(info.curve);
    if (state.graduated || readyToGraduate(state)) throw new AdapterError("graduated", "curve sold out");

    const sent = await this.ex.send(vault, {
      to: info.curve,
      data: encodeFunctionData({ abi: ponsV2CurveAbi, functionName: "buy", args: [weiIn, minOut, vault.address] }),
      value: weiIn,
    });
    const trade = this.buyFromLogs(sent.receipt.logs, info.curve);
    if (!trade) throw new AdapterError("internal", "buy landed but CurveBuy not found", { signature: sent.hash });

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

  async sell(token: Address, amount: bigint, minWei: bigint, opts: EvmTradeOptions = {}): Promise<EvmTxResult> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (minWei < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    this.requireSend();
    await this.verifyDeployment();
    const info = await this.launchInfo(token);
    if (info.phase !== PHASE.NotGraduated) throw new AdapterError("graduated", "token graduated to Uniswap v4");
    const vault = opts.vault ?? this.defaultVault;
    const bal = await this.ex.read.readContract({ address: info.token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [vault.address] });
    if (bal < amount) throw new AdapterError("insufficient_tokens", "vault does not hold enough tokens");

    const sideTxs: EvmSideTx[] = [];
    const a = await this.ensureAllowance(vault, info.token, info.curve, amount);
    if (a) sideTxs.push(a);

    const sent = await this.ex.send(vault, {
      to: info.curve,
      data: encodeFunctionData({ abi: ponsV2CurveAbi, functionName: "sell", args: [amount, minWei, vault.address] }),
    });
    const ev = parseEventLogs({ abi: ponsV2CurveAbi, logs: sent.receipt.logs, eventName: "CurveSell" }).find(
      (l) => getAddress(l.address) === info.curve,
    );
    if (!ev) throw new AdapterError("internal", "sell landed but CurveSell not found", { signature: sent.hash });
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

  /** Funder -> creator top-up, ceil to `fundStepWei` (round amounts), skipped if the creator already has enough. */
  private async fundCreator(creator: Address, txValue: bigint): Promise<EvmSideTx | null> {
    const need = txValue + this.creatorGasReserveWei;
    const have = await this.ex.balance(creator);
    if (have >= need) return null;
    const value = ceilToStep(need - have, this.fundStepWei);
    const sent = await this.ex.transfer(this.keyring.funder(), creator, value);
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
      amountsKnown: true,
      fromEvent: true,
    };
  }
}

import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex, type LocalAccount } from "viem";
import { AdapterError } from "../errors";
import type { EvmExecutor } from "./executor";
import { ponsV2TokenAbi } from "./pons/abi/token";

/**
 * Withdrawals from the pool to a FRESH user address on Robinhood Chain
 * (parity with src/withdraw.ts + API.md `withdraw_token` A1):
 * - one part = one call here; core already cut 0.5-2 % and rounded each part
 *   down to 3 significant digits; `requireRounded` (default on) refuses an
 *   exact, unrounded amount as defence in depth;
 * - ERC-20 parts always come with an ETH gas drop to the recipient, paid by the
 *   FUNDER key (never by a vault), in its own tx before the token transfer and
 *   skipped when the recipient already holds the drop (a retried part never
 *   drops twice);
 * - the token goes from the vault that holds the mint (one vault per mint);
 * - recipients: valid EVM address (EIP-55 checked when mixed-case), not zero,
 *   not a contract (eth_getCode empty), not one of the pool's own addresses.
 * Nothing here logs addresses or amounts.
 */

/** ~10 ERC-20 transfers at 0.02 gwei with headroom (docs/analysis/robinhood-chain.md §4). */
export const MIN_EVM_GAS_DROP = 50_000_000_000_000n; // 0.00005 ETH

/** Rounds DOWN to `digits` significant decimal digits (same rule as core ledger E4/A1). */
export function roundDownSig(v: bigint, digits = 3): bigint {
  if (v < 0n) throw new RangeError("negative");
  const s = v.toString();
  if (s.length <= digits) return v;
  const scale = 10n ** BigInt(s.length - digits);
  return (v / scale) * scale;
}

export function parseEvmRecipient(to: string): Address {
  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new AdapterError("bad_request", "recipient is not an EVM address");
  let a: Address;
  try {
    // Mixed case must carry a valid EIP-55 checksum; all-lower / all-upper are accepted as typed.
    a = getAddress(to);
  } catch {
    throw new AdapterError("bad_request", "recipient fails the EIP-55 checksum");
  }
  const mixed = /[a-f]/.test(to.slice(2)) && /[A-F]/.test(to.slice(2));
  if (mixed && a !== to) throw new AdapterError("bad_request", "recipient fails the EIP-55 checksum");
  if (BigInt(a) === 0n) throw new AdapterError("bad_request", "recipient is the zero address");
  return a;
}

export interface EvmWithdrawPart {
  kind: "withdraw";
  asset: "native" | Address;
  vault: Address;
  to: Address;
  amount: bigint;
  /** Main transfer (ERC-20 transfer or ETH send). */
  hash: Hex;
  blockNumber: bigint;
  networkFee: bigint;
  /** Gas drop from the funder (ERC-20 parts), null when the recipient already had it. */
  drop: { hash: Hex; value: bigint; networkFee: bigint } | null;
  /** Tokens / wei the recipient actually received (from the Transfer event / the value). */
  received: bigint;
}

export interface EvmWithdrawerOptions {
  executor: EvmExecutor;
  funder: LocalAccount;
  gasDropWei?: bigint;
  /** Pool addresses (vaults, creators, funder, ...): never valid recipients. */
  isPoolAddress?: (a: Address) => boolean;
  requireRounded?: boolean;
}

export class EvmWithdrawer {
  private readonly ex: EvmExecutor;
  private readonly funder: LocalAccount;
  readonly gasDropWei: bigint;
  private readonly isPool: (a: Address) => boolean;
  private readonly requireRounded: boolean;

  constructor(o: EvmWithdrawerOptions) {
    this.ex = o.executor;
    this.funder = o.funder;
    this.gasDropWei = o.gasDropWei ?? MIN_EVM_GAS_DROP;
    if (this.gasDropWei < MIN_EVM_GAS_DROP) throw new RangeError(`gas drop must be >= ${MIN_EVM_GAS_DROP} wei`);
    this.isPool = o.isPoolAddress ?? (() => false);
    this.requireRounded = o.requireRounded ?? true;
  }

  private async checkRecipient(toRaw: string, vault: LocalAccount): Promise<Address> {
    const to = parseEvmRecipient(toRaw);
    if (to === getAddress(vault.address) || to === getAddress(this.funder.address) || this.isPool(to)) {
      throw new AdapterError("bad_request", "recipient is a pool address");
    }
    const code = await this.ex.read.getCode({ address: to });
    if (code && code !== "0x") throw new AdapterError("bad_request", "recipient is a contract; use a fresh wallet address");
    return to;
  }

  private checkAmount(amount: bigint): void {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (this.requireRounded && roundDownSig(amount, 3) !== amount) {
      throw new AdapterError("bad_request", "withdraw part must be rounded to 3 significant digits");
    }
  }

  /** One ERC-20 part: funder gas drop (if missing) then vault -> recipient transfer. */
  async withdrawToken(p: { vault: LocalAccount; token: Address; to: string; amount: bigint }): Promise<EvmWithdrawPart> {
    if (!this.ex.allowSend) throw new AdapterError("venue_unavailable", "EVM sends are disabled on this network (read-only)", { stage: "build" });
    this.checkAmount(p.amount);
    const token = getAddress(p.token);
    const to = await this.checkRecipient(p.to, p.vault);
    const held = await this.ex.read.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [p.vault.address] });
    if (held < p.amount) throw new AdapterError("insufficient_tokens", "vault does not hold enough tokens");

    let drop: EvmWithdrawPart["drop"] = null;
    const has = await this.ex.balance(to);
    if (has < this.gasDropWei) {
      const d = await this.ex.transfer(this.funder, to, this.gasDropWei);
      drop = { hash: d.hash, value: this.gasDropWei, networkFee: d.networkFee };
    }
    const sent = await this.ex.send(p.vault, {
      to: token,
      data: encodeFunctionData({ abi: ponsV2TokenAbi, functionName: "transfer", args: [to, p.amount] }),
    });
    const received = parseEventLogs({ abi: ponsV2TokenAbi, logs: sent.receipt.logs, eventName: "Transfer" })
      .filter((l) => getAddress(l.address) === token && getAddress(l.args.to) === to)
      .reduce((a, l) => a + l.args.value, 0n);
    return { kind: "withdraw", asset: token, vault: getAddress(p.vault.address), to, amount: p.amount, hash: sent.hash, blockNumber: sent.receipt.blockNumber, networkFee: sent.networkFee, drop, received };
  }

  /** One ETH part from a vault (the ETH itself pays the recipient's gas: no drop). */
  async withdrawEth(p: { vault: LocalAccount; to: string; amount: bigint }): Promise<EvmWithdrawPart> {
    if (!this.ex.allowSend) throw new AdapterError("venue_unavailable", "EVM sends are disabled on this network (read-only)", { stage: "build" });
    this.checkAmount(p.amount);
    const to = await this.checkRecipient(p.to, p.vault);
    const bal = await this.ex.balance(p.vault.address);
    if (bal < p.amount) throw new AdapterError("insufficient_sol", "vault does not have enough ETH");
    const sent = await this.ex.transfer(p.vault, to, p.amount);
    return { kind: "withdraw", asset: "native", vault: getAddress(p.vault.address), to, amount: p.amount, hash: sent.hash, blockNumber: sent.receipt.blockNumber, networkFee: sent.networkFee, drop: null, received: p.amount };
  }
}

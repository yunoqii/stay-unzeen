import {
  BaseError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { AdapterError } from "../errors";
import { classifyEvmError } from "./errors";
import { quantizeGasLimit, type EvmFeeCache } from "./fees";
import { isNonceError, NonceManager } from "./nonce";

export interface EvmCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface SentEvmTx {
  hash: Hex;
  receipt: TransactionReceipt;
  gasLimit: bigint;
  /** gasUsed x effectiveGasPrice (L1 component included on Arbitrum), wei. */
  networkFee: bigint;
}

/** A signed tx, BEFORE broadcast (relayer: record hash + nonce durably first). */
export interface SignedEvmTx {
  hash: Hex;
  nonce: number;
  from: Address;
}

/** Called after signing, before broadcast. Throwing aborts the send (nothing is broadcast). */
export type OnSigned = (tx: SignedEvmTx) => Promise<void>;

export interface EvmExecutorOptions {
  /** Reads: eth_call, estimateGas, nonce, receipts. */
  read: PublicClient;
  /** Sends: eth_sendRawTransaction (a different provider than reads when possible). Default `read`. */
  send?: PublicClient;
  chainId: number;
  fees: EvmFeeCache;
  /** Sends allowed (testnet, local fork, or mainnet with the lead's approval). */
  allowSend: boolean;
  nonces?: NonceManager;
  /** ABI used to decode raw revert data (Pons: all contracts merged). */
  errorAbi?: Abi;
  receiptTimeoutMs?: number;
  pollingIntervalMs?: number;
}

/**
 * Signs and sends pool transactions with THE fee profile (fees.ts) and a
 * per-address nonce mutex. The private key never leaves the process
 * (viem LocalAccount signs locally); nothing here logs addresses, amounts or
 * calldata.
 */
export class EvmExecutor {
  readonly read: PublicClient;
  private readonly sendClient: PublicClient;
  readonly nonces: NonceManager;
  private chainChecked = false;

  constructor(private readonly o: EvmExecutorOptions) {
    this.read = o.read;
    this.sendClient = o.send ?? o.read;
    this.nonces = o.nonces ?? new NonceManager((a) => this.read.getTransactionCount({ address: a, blockTag: "pending" }));
  }

  get allowSend(): boolean {
    return this.o.allowSend;
  }

  get fees(): EvmFeeCache {
    return this.o.fees;
  }

  /** eth_call from `from` (read-only simulation; works on mainnet). */
  async simulate(from: Address, call: EvmCall): Promise<Hex> {
    try {
      const r = await this.read.call({ account: from, to: call.to, data: call.data, value: call.value ?? 0n });
      return r.data ?? "0x";
    } catch (e) {
      throw classifyEvmError(e, "preflight", undefined, this.o.errorAbi);
    }
  }

  async estimate(from: Address, call: EvmCall): Promise<bigint> {
    try {
      return await this.read.estimateGas({ account: from, to: call.to, data: call.data, value: call.value ?? 0n });
    } catch (e) {
      throw classifyEvmError(e, "preflight", undefined, this.o.errorAbi);
    }
  }

  private async checkChain(): Promise<void> {
    if (this.chainChecked) return;
    const id = await this.read.getChainId();
    if (id !== this.o.chainId) throw new AdapterError("internal", `RPC chainId ${id} != expected ${this.o.chainId}`);
    if (this.sendClient !== this.read) {
      const sid = await this.sendClient.getChainId();
      if (sid !== this.o.chainId) throw new AdapterError("internal", `send RPC chainId ${sid} != expected ${this.o.chainId}`);
    }
    this.chainChecked = true;
  }

  /**
   * Estimate -> quantized gas limit -> sign (type-2, tip 0, constant maxFee) ->
   * send -> wait receipt. Throws AdapterError; a landed revert has
   * `landedErr: true` and the hash in `signature`.
   */
  async send(account: LocalAccount, call: EvmCall, opts: { gasLimit?: bigint; onSigned?: OnSigned } = {}): Promise<SentEvmTx> {
    if (!this.o.allowSend) {
      throw new AdapterError("venue_unavailable", "EVM sends are disabled on this network (read-only)", { stage: "build" });
    }
    if (!account.signTransaction) throw new AdapterError("internal", "account cannot sign transactions");
    await this.checkChain();
    const gas = opts.gasLimit ?? quantizeGasLimit(await this.estimate(account.address, call));

    const hash = await this.nonces.withNonce(account.address, async (nonce) => {
      for (let attempt = 0; ; attempt++) {
        const fee = this.o.fees.profile();
        const signed = await account.signTransaction!({
          chainId: this.o.chainId,
          type: "eip1559",
          nonce,
          to: call.to,
          data: call.data,
          value: call.value ?? 0n,
          gas,
          maxFeePerGas: fee.maxFeePerGas,
          maxPriorityFeePerGas: 0n,
        });
        const h = keccak256(signed);
        // Not recorded -> never broadcast (a throw here leaves the nonce free).
        if (opts.onSigned) await opts.onSigned({ hash: h, nonce, from: account.address });
        try {
          await this.sendClient.sendRawTransaction({ serializedTransaction: signed });
          return { value: h, broadcast: true };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/already known/i.test(msg)) return { value: h, broadcast: true };
          if (attempt === 0 && /max fee per gas less than block base fee|fee cap less than block base fee/i.test(msg)) {
            await this.o.fees.refresh();
            continue;
          }
          if (isNonceError(msg)) throw classifyEvmError(e, "preflight", undefined, this.o.errorAbi);
          // Unknown: maybe accepted by the sequencer. The caller checks `signature` before any retry.
          throw classifyEvmError(e, "confirm", h, this.o.errorAbi);
        }
      }
    });

    let receipt: TransactionReceipt;
    try {
      receipt = await this.read.waitForTransactionReceipt({
        hash,
        timeout: this.o.receiptTimeoutMs ?? 30_000,
        pollingInterval: this.o.pollingIntervalMs ?? 250,
      });
    } catch (e) {
      throw classifyEvmError(e, "confirm", hash, this.o.errorAbi);
    }
    const networkFee = receipt.gasUsed * receipt.effectiveGasPrice;
    if (receipt.status !== "success") {
      // Replay at the block to get the revert reason (eth_call, read-only).
      let reason: AdapterError | null = null;
      try {
        await this.read.call({ account: account.address, to: call.to, data: call.data, value: call.value ?? 0n, blockNumber: receipt.blockNumber - 1n });
      } catch (e) {
        reason = classifyEvmError(e, "confirm", hash, this.o.errorAbi);
      }
      throw new AdapterError(reason?.code ?? "internal", `tx reverted${reason ? `: ${reason.message}` : ""}`, {
        signature: hash,
        landedErr: true,
        stage: "confirm",
        ...(reason?.programError ? { programError: reason.programError } : {}),
      });
    }
    return { hash, receipt, gasLimit: gas, networkFee };
  }

  /** Plain ETH transfer (funder -> creator), same fee profile. */
  async transfer(from: LocalAccount, to: Address, value: bigint, opts: { onSigned?: OnSigned } = {}): Promise<SentEvmTx> {
    return this.send(from, { to, data: "0x", value }, opts);
  }

  /**
   * State of a recorded tx, asked of EVERY provider we have (read and send):
   * - "landed" as soon as one of them has the receipt;
   * - "pending" if one knows the tx but has no receipt;
   * - "unknown" ONLY when every provider answered "not found"
   *   (viem TransactionReceiptNotFoundError / TransactionNotFoundError).
   * Any other error (429, timeout, 5xx, Cloudflare) THROWS: the caller must
   * retry later and never treat it as "not sent" (review-hood-final #1).
   */
  async lookup(hash: Hex): Promise<{ state: "landed"; receipt: TransactionReceipt } | { state: "pending" } | { state: "unknown" }> {
    const clients = this.sendClient === this.read ? [this.read] : [this.read, this.sendClient];
    let pending = false;
    for (const c of clients) {
      try {
        const receipt = await c.getTransactionReceipt({ hash });
        return { state: "landed", receipt };
      } catch (e) {
        if (!isNotFound(e, "receipt")) throw new AdapterError("venue_unavailable", "RPC error while reading a recorded tx", { cause: e, signature: hash });
      }
      try {
        await c.getTransaction({ hash });
        pending = true;
      } catch (e) {
        if (!isNotFound(e, "tx")) throw new AdapterError("venue_unavailable", "RPC error while reading a recorded tx", { cause: e, signature: hash });
      }
    }
    return pending ? { state: "pending" } : { state: "unknown" };
  }

  /** Why a landed tx reverted: replays it (eth_call) one block earlier. */
  async explainRevert(receipt: TransactionReceipt): Promise<AdapterError> {
    try {
      const tx = await this.read.getTransaction({ hash: receipt.transactionHash });
      await this.read.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber: receipt.blockNumber - 1n });
      return new AdapterError("internal", "tx reverted", { signature: receipt.transactionHash, landedErr: true, stage: "confirm" });
    } catch (e) {
      const c = classifyEvmError(e, "confirm", receipt.transactionHash, this.o.errorAbi);
      return new AdapterError(c.code, `tx reverted: ${c.message}`, { signature: receipt.transactionHash, landedErr: true, stage: "confirm" });
    }
  }

  async balance(addr: Address): Promise<bigint> {
    return this.read.getBalance({ address: addr });
  }
}

/** True only for viem's "not found" errors of a receipt / a tx (never for transport errors). */
export function isNotFound(e: unknown, what: "receipt" | "tx"): boolean {
  if (!(e instanceof BaseError)) return false;
  const want = what === "receipt" ? TransactionReceiptNotFoundError : TransactionNotFoundError;
  return e.walk((x) => x instanceof want) !== null;
}

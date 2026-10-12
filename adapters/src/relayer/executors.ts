import type { Connection, Signer } from "@solana/web3.js";
import { AdapterError } from "../errors";
import type { PumpFunAdapter } from "../pumpfun";
import { fetchTx, signatureState, type Broadcaster, type SignatureState, type SignedTx } from "../tx";
import type { MetadataStore } from "../metadata";
import type { TokenWithdrawer } from "../withdraw";
import { DEFAULT_GAS_DROP, pickGasDrop, type GasDropRange, type Rng } from "./random";
import type { Execution, JobSpec, SentAttempt } from "./types";
import type { VaultRequest } from "./vaults";

/** Headroom on top of the traded lamports: ATA + accumulator rent + fees. */
const BUY_SOL_HEADROOM = 5_000_000n;
/** A sell / withdraw needs fees (and ATA rent + gas drop for withdraw). */
const FEE_SOL_HEADROOM = 200_000n;
const ATA_RENT_HEADROOM = 2_500_000n;

/** Per-kind executor: everything the engine needs from a venue / transfer module. */
export interface JobExecutor<S extends JobSpec = JobSpec> {
  vaultRequest(spec: S): VaultRequest;
  /** Pre-checks and signs. Never broadcasts. Throws AdapterError. */
  prepare(spec: S, vault: Signer): Promise<SignedTx>;
  /** Broadcasts and confirms. Throws AdapterError with `stage`. */
  submit(tx: SignedTx): Promise<void>;
  /** Executed amounts of a landed attempt; null when the tx cannot be read yet. */
  result(spec: S, attempt: SentAttempt): Promise<Execution | null>;
  classify(err: unknown, logs?: readonly string[] | null): AdapterError;
}

/** Chain access used to resolve recorded attempts. */
export interface ChainProbe {
  state(signature: string, lastValidBlockHeight: number): Promise<SignatureState>;
  /** Sends the same signed bytes again (no preflight). Best effort. */
  rebroadcast(raw: Uint8Array): Promise<void>;
  /** Logs of a landed transaction (to classify an on-chain failure). */
  logs(signature: string): Promise<string[] | null>;
}

export class RpcChainProbe implements ChainProbe {
  constructor(
    private readonly connection: Connection,
    /** Same broadcaster as first sends (Sender on mainnet), rate-gated. */
    private readonly broadcaster?: Broadcaster,
  ) {}
  state(signature: string, lastValidBlockHeight: number): Promise<SignatureState> {
    return signatureState(this.connection, signature, lastValidBlockHeight);
  }
  async rebroadcast(raw: Uint8Array): Promise<void> {
    if (this.broadcaster) {
      await this.broadcaster.trySend(raw).catch(() => undefined);
      return;
    }
    await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
  }
  async logs(signature: string): Promise<string[] | null> {
    const tx = await fetchTx(this.connection, signature, 3).catch(() => null);
    return tx?.meta?.logMessages ?? null;
  }
}

/** create_v2: mint + curve + vault ATA/accumulator + lookup table of a fresh vault. */
const CREATE_SOL_HEADROOM = 35_000_000n;

type PumpSpec = Extract<JobSpec, { kind: "buy" | "sell" | "create" }>;

/** buy / sell / create on pump.fun bonding curves. */
export class PumpFunTradeExecutor implements JobExecutor<PumpSpec> {
  constructor(
    private readonly adapter: PumpFunAdapter,
    /** Publishes create metadata (sanitized image + JSON). Without it, create jobs fail `venue_unavailable`. */
    private readonly metadata: MetadataStore | null = null,
  ) {}

  vaultRequest(spec: PumpSpec): VaultRequest {
    switch (spec.kind) {
      case "buy":
        return { minSol: spec.lamportsIn + BUY_SOL_HEADROOM };
      case "create":
        return { minSol: spec.lamportsIn + CREATE_SOL_HEADROOM };
      case "sell":
        return { minSol: FEE_SOL_HEADROOM, mint: spec.mint, minTokens: spec.amount };
    }
  }

  async prepare(spec: PumpSpec, vault: Signer): Promise<SignedTx> {
    switch (spec.kind) {
      case "buy":
        return this.adapter.prepareBuy(spec.mint, spec.lamportsIn, spec.minOut, { vault });
      case "sell":
        return this.adapter.prepareSell(spec.mint, spec.amount, spec.minLamports, { vault });
      case "create": {
        if (!this.metadata) throw new AdapterError("venue_unavailable", "no metadata store configured");
        // Content-addressed: a retried job publishes to the same URIs.
        const { uri } = await this.metadata.publish(spec.meta);
        return this.adapter.prepareCreate({ name: spec.meta.name, symbol: spec.meta.symbol, uri }, spec.lamportsIn, spec.minOut, { vault });
      }
    }
  }

  async submit(tx: SignedTx): Promise<void> {
    await this.adapter.submit(tx);
  }

  async result(spec: PumpSpec, a: SentAttempt): Promise<Execution | null> {
    if (spec.kind === "create") {
      const r = await this.adapter.createResult(a.signature, a.vault);
      if (!r) return null;
      // Same content-addressed URL the job published before signing (no new upload).
      const imageUrl = spec.meta.image ? ((await this.metadata?.publish(spec.meta).catch(() => null))?.imageUrl ?? null) : null;
      return {
        kind: "create",
        signature: r.signature,
        slot: r.slot,
        vault: r.vault,
        mint: r.mint,
        creator: r.creator,
        tokenAmount: r.tokenAmount,
        solAmount: r.solAmount,
        networkFee: r.networkFee,
        decimals: r.decimals,
        blockTime: r.blockTime ?? null,
        name: r.name,
        symbol: r.symbol,
        imageUrl,
        market: await this.adapter.market(r.mint).catch(() => null),
      };
    }
    const r = await this.adapter.tradeResult(spec.kind, a.signature, a.vault, spec.mint);
    if (!r || !r.amountsKnown) return null;
    return {
      kind: spec.kind,
      signature: r.signature,
      slot: r.slot,
      vault: r.vault,
      mint: r.mint,
      tokenAmount: r.tokenAmount,
      solAmount: r.solAmount,
      networkFee: r.networkFee,
      decimals: r.decimals,
      fromEvent: r.fromEvent === true,
      blockTime: r.blockTime ?? null,
      // Best effort: the feed must not block settlement.
      symbol: await this.adapter.tokenSymbol(spec.mint).catch(() => null),
      market: await this.adapter.market(spec.mint).catch(() => null),
    };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return this.adapter.classify(err, logs);
  }
}

/** Token withdrawal: gas drop + transfer, from the vault the mint is pinned to (D4). */
export class WithdrawExecutor implements JobExecutor<Extract<JobSpec, { kind: "withdraw" }>> {
  constructor(
    private readonly withdrawer: TokenWithdrawer,
    private readonly rng: Rng,
    private readonly gasDrop: GasDropRange = DEFAULT_GAS_DROP,
  ) {}

  vaultRequest(spec: Extract<JobSpec, { kind: "withdraw" }>): VaultRequest {
    return {
      minSol: (spec.gasLamports ?? this.gasDrop.max) + ATA_RENT_HEADROOM + FEE_SOL_HEADROOM,
      mint: spec.mint,
      minTokens: spec.amount,
    };
  }

  prepare(spec: Extract<JobSpec, { kind: "withdraw" }>, vault: Signer): Promise<SignedTx> {
    return this.withdrawer.prepare({
      vault,
      mint: spec.mint,
      to: spec.to,
      amount: spec.amount,
      gasDropLamports: spec.gasLamports ?? pickGasDrop(this.rng, this.gasDrop),
    });
  }

  async submit(tx: SignedTx): Promise<void> {
    await this.withdrawer.submit(tx);
  }

  async result(spec: Extract<JobSpec, { kind: "withdraw" }>, a: SentAttempt): Promise<Execution | null> {
    const r = await this.withdrawer.result(a.signature, { mint: spec.mint, vault: a.vault, to: spec.to });
    if (!r) return null;
    return { ...r };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return this.withdrawer.classify(err, logs);
  }
}

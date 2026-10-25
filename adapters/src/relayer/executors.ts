import { PublicKey, type Connection, type Signer } from "@solana/web3.js";
import type { Attester } from "../attest";
import { attestSigMessage, signDetached } from "../ed25519";
import { AdapterError } from "../errors";
import type { CreateResult, PreparedCreate, PreparedTrade } from "../pumpfun";
import type { CreateOptions, CurveStatus, TokenMeta, TradeOptions, TxResult } from "../types";
import { fetchTx, signatureState, type Broadcaster, type SignatureState, type SignedTx } from "../tx";
import type { MetadataStore } from "../metadata";
import type { TokenWithdrawer } from "../withdraw";
import { DEFAULT_GAS_DROP, pickGasDrop, type GasDropRange, type Rng } from "./random";
import type { Execution, JobSpec, SentAttempt } from "./types";
import type { VaultInventory, VaultRequest } from "./vaults";
import type { VaultFunder } from "../rebalance";
import { StockDistributor, type QuoteStocker } from "./quote-stock";

/** Headroom on top of the traded lamports: ATA + accumulator rent + fees. */
const BUY_SOL_HEADROOM = 5_000_000n;
/** A sell / withdraw needs fees (and ATA rent + gas drop for withdraw). */
const FEE_SOL_HEADROOM = 200_000n;
const ATA_RENT_HEADROOM = 2_500_000n;

/** Per-kind executor: everything the engine needs from a venue / transfer module. */
export interface JobExecutor<S extends JobSpec = JobSpec> {
  vaultRequest(spec: S): VaultRequest;
  /**
   * When it returns a request, the engine uses it instead of `vaultRequest` (it may
   * read chain: stock-only quote pairs choose the vault by quote STOCK, not SOL).
   */
  vaultRequestAsync?(spec: S): Promise<VaultRequest | null>;
  /** Pre-checks and signs. Never broadcasts. Throws AdapterError. */
  prepare(spec: S, vault: Signer): Promise<SignedTx>;
  /** Broadcasts and confirms. Throws AdapterError with `stage`. */
  submit(tx: SignedTx): Promise<void>;
  /** Executed amounts of a landed attempt; null when the tx cannot be read yet. */
  result(spec: S, attempt: SentAttempt): Promise<Execution | null>;
  classify(err: unknown, logs?: readonly string[] | null): AdapterError;
  /**
   * When set, the job is signed by this key instead of a pool vault (attest:
   * the attestation key of the job's purpose). The engine then takes no vault lease.
   */
  ownSigner?(spec: S): Signer | null;
  /** RELAYER v6 §4: `out_sig` known before sending (Verify attest); recorded with the attempt. */
  earlyOutSig?(spec: S): string | null;
  /**
   * Called with the leased vault before `prepare`: a result here means nothing
   * has to be sent (consolidate of an empty leg vault). null = go on.
   */
  noop?(spec: S, vault: Signer): Promise<Execution | null>;
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

/**
 * create: mint + curve / virtual pool + vault ATA (+ pump accumulator) +
 * lookup table of a fresh vault. pump.fun create_v2 ~0.02 SOL, Meteora DBC
 * ~0.01 SOL of rent (devnet 12.10): one headroom for both venues.
 */
const CREATE_SOL_HEADROOM = 35_000_000n;
/** Over a venue's own create requirement (`TradeVenue.createSolNeed`): balance drift between pick and sign. */
export const CREATE_SOL_MARGIN = 1_000_000n;

type PumpSpec = Extract<JobSpec, { kind: "buy" | "sell" | "create" | "fair_create" }>;

/**
 * What the relayer needs from a bonding-curve venue adapter (PumpFunAdapter,
 * MeteoraDbcAdapter): sign without sending, send, read executed amounts.
 */
export interface TradeVenue {
  prepareBuy(mint: string, lamportsIn: bigint, minOut: bigint, opts?: TradeOptions): Promise<PreparedTrade>;
  prepareSell(mint: string, amount: bigint, minLamports: bigint, opts?: TradeOptions): Promise<PreparedTrade>;
  prepareCreate(meta: TokenMeta, lamportsIn: bigint, minOut: bigint, opts?: CreateOptions): Promise<PreparedCreate>;
  submit(tx: SignedTx): Promise<unknown>;
  createResult(signature: string, vault: string): Promise<CreateResult | null>;
  tradeResult(kind: "buy" | "sell", signature: string, vault: string, mint: string): Promise<TxResult | null>;
  market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: CurveStatus; priceQuote?: string }>;
  tokenSymbol(mint: string): Promise<string | null>;
  classify(err: unknown, logs?: readonly string[] | null): AdapterError;
  /** Quote pair of a mint's curve (null = SOL); venues with stock-only quotes implement it. */
  quotePairOf?(mint: string): Promise<QuotePair | null>;
  /** Quote pair a create with `meta.quote = symbol` would use (null = SOL / not served). */
  quotePairFor?(symbol: string): QuotePair | null;
  /** SOL its own `prepareCreate` check needs besides the SOL first buy (absent: CREATE_SOL_HEADROOM). */
  readonly createSolNeed?: bigint;
}

export interface QuotePair {
  quoteMint: string;
  /** Stock-only quote (ZEC SPL): amounts are quote units, no swap leg. */
  stockOnly: boolean;
}

/**
 * buy / sell / create on a bonding-curve venue (pump.fun, Meteora DBC). Same
 * flow for every venue: one vault per mint (engine), sanitized image
 * published before signing, fresh creator per launch (adapter).
 */
export class VenueTradeExecutor implements JobExecutor<PumpSpec> {
  constructor(
    private readonly adapter: TradeVenue,
    /** Publishes create metadata (sanitized image + JSON). Without it, create jobs fail `venue_unavailable`. */
    private readonly metadata: MetadataStore | null = null,
  ) {}

  /**
   * Stock-only quote pairs (ZEC SPL, RELAYER v8 A3): `lamportsIn` is quote units and there is
   * no swap leg, so the vault is chosen by its quote STOCK (>= lamportsIn), SOL only for fees /
   * rent. A pinned mint keeps its vault (D4): short stock there -> pool_liquidity.
   */
  async vaultRequestAsync(spec: PumpSpec): Promise<VaultRequest | null> {
    if (spec.kind === "buy" && this.adapter.quotePairOf) {
      const pair = await this.adapter.quotePairOf(spec.mint).catch(() => null);
      if (pair?.stockOnly) return { minSol: BUY_SOL_HEADROOM, quote: { mint: pair.quoteMint, minUnits: spec.lamportsIn } };
    }
    if (spec.kind === "create" && spec.quote && this.adapter.quotePairFor) {
      const pair = this.adapter.quotePairFor(spec.quote);
      if (pair?.stockOnly) return { minSol: this.createHeadroom(), quote: { mint: pair.quoteMint, minUnits: spec.lamportsIn } };
    }
    return null;
  }

  /** Vault SOL for a create besides its SOL first buy: the adapter's own check + margin. */
  private createHeadroom(): bigint {
    const need = this.adapter.createSolNeed;
    return need !== undefined ? need + CREATE_SOL_MARGIN : CREATE_SOL_HEADROOM;
  }

  vaultRequest(spec: PumpSpec): VaultRequest {
    switch (spec.kind) {
      case "buy":
        return { minSol: spec.lamportsIn + BUY_SOL_HEADROOM };
      case "create":
        // A4: + the SOL of the later first buy pinned to this vault (Bags), with its own headroom.
        return { minSol: spec.lamportsIn + this.createHeadroom() + (spec.reserveLamports ? spec.reserveLamports + BUY_SOL_HEADROOM : 0n) };
      case "fair_create":
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
        return this.adapter.prepareCreate({ name: spec.meta.name, symbol: spec.meta.symbol, uri }, spec.lamportsIn, spec.minOut, {
          vault,
          ...(spec.quote ? { quote: spec.quote } : {}),
          ...(spec.platform ? { platform: spec.platform } : {}),
        });
      }
      case "fair_create": {
        if (!this.metadata) throw new AdapterError("venue_unavailable", "no metadata store configured");
        if (spec.minOut <= 0n) throw new AdapterError("bad_request", "fair_create needs min_out > 0");
        const { uri } = await this.metadata.publish(spec.meta);
        // Core's mint keypair, identical on every attempt: a retry cannot create a second mint.
        return this.adapter.prepareCreate({ name: spec.meta.name, symbol: spec.meta.symbol, uri }, spec.lamportsIn, spec.minOut, {
          vault,
          mintKeypair: spec.mintKeypair,
        });
      }
    }
  }

  async submit(tx: SignedTx): Promise<void> {
    await this.adapter.submit(tx);
  }

  async result(spec: PumpSpec, a: SentAttempt): Promise<Execution | null> {
    if (spec.kind === "create" || spec.kind === "fair_create") {
      const r = await this.adapter.createResult(a.signature, a.vault);
      if (!r) return null;
      if (spec.kind === "fair_create" && r.mint !== spec.mintKeypair.publicKey.toBase58()) {
        // Impossible (the mint key signs the tx); never report another mint as the launch.
        throw new AdapterError("internal", "fair_create landed with an unexpected mint");
      }
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
        creatorFee: r.creatorFee ?? null,
        ...(r.quoteMint && r.quoteAmount !== undefined ? { quoteMint: r.quoteMint, quoteAmount: r.quoteAmount } : {}),
        ...(r.lamportsByCore ? { lamportsByCore: true as const } : {}),
      };
    }
    const r = await this.adapter.tradeResult(spec.kind, a.signature, a.vault, spec.mint);
    if (!r || !r.amountsKnown) return null;
    // A quote-pair buy from stock is valued on pool A at read time: never book more than the job's lamports.
    const solAmount = spec.kind === "buy" && r.quoteMint && r.solAmount > spec.lamportsIn ? spec.lamportsIn : r.solAmount;
    return {
      kind: spec.kind,
      signature: r.signature,
      slot: r.slot,
      vault: r.vault,
      mint: r.mint,
      tokenAmount: r.tokenAmount,
      solAmount,
      ...(r.quoteMint && r.quoteAmount !== undefined ? { quoteMint: r.quoteMint, quoteAmount: r.quoteAmount } : {}),
      // Stock-only quote (ZEC): out_lamports NULL, core values quoteAmount (RELAYER v8 A3).
      ...(r.lamportsByCore ? { lamportsByCore: true as const } : {}),
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

/** pump.fun executor (historic name). */
export const PumpFunTradeExecutor = VenueTradeExecutor;
export type PumpFunTradeExecutor = VenueTradeExecutor;

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

/**
 * attest (RELAYER v3): SPL Memo with the commitment root, signed and paid by
 * the pool's attestation key (never a vault). `out_memo` is read back from the
 * confirmed transaction.
 */
export class AttestExecutor implements JobExecutor<Extract<JobSpec, { kind: "attest" }>> {
  /** F14: one attester per purpose (Verify operator key, fair-launch key). */
  private readonly by: Record<"verify" | "fair", Attester>;

  constructor(attesters: Attester | { verify: Attester; fair: Attester }) {
    this.by = "verify" in attesters && "fair" in attesters ? attesters : { verify: attesters, fair: attesters };
  }

  private of(spec: Extract<JobSpec, { kind: "attest" }>): Attester {
    return this.by[spec.purpose];
  }

  vaultRequest(): VaultRequest {
    return { minSol: 0n };
  }

  ownSigner(spec: Extract<JobSpec, { kind: "attest" }>): Signer {
    return this.of(spec).key;
  }

  prepare(spec: Extract<JobSpec, { kind: "attest" }>): Promise<SignedTx> {
    return this.of(spec).prepare(spec.memo);
  }

  /** v6 §4: Verify operator signature right away (fair-launch keeps it until confirmed). */
  earlyOutSig(spec: Extract<JobSpec, { kind: "attest" }>): string | null {
    if (spec.purpose !== "verify") return null;
    return signDetached(this.of(spec).key, attestSigMessage(spec.memo));
  }

  async submit(tx: SignedTx): Promise<void> {
    // Sending does not depend on the key (the tx is already signed).
    await this.by.verify.submit(tx);
  }

  async result(spec: Extract<JobSpec, { kind: "attest" }>, a: SentAttempt): Promise<Execution | null> {
    const attester = this.of(spec);
    const r = await attester.result(a.signature);
    // F2: core needs out_block_time (beforeRound / anchor.blockTime); a confirmed
    // tx without blockTime yet is re-read later instead of confirming without it.
    if (!r || r.blockTime === null) return null;
    // v4 out_sig: over the job's memo (= what core compares against), never over chain data.
    const outSig = signDetached(attester.key, attestSigMessage(spec.memo));
    return { kind: "attest", signature: r.signature, slot: r.slot, vault: r.signer, memo: r.memo, networkFee: r.networkFee, blockTime: r.blockTime, outSig };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return this.by.verify.classify(err, logs);
  }
}

/** RELAYER v7 `fund_vaults`: signed and paid by the rebalance address (no vault lease). */
export class FundVaultsExecutor implements JobExecutor<Extract<JobSpec, { kind: "fund_vaults" }>> {
  constructor(private readonly funder: Pick<VaultFunder, "prepare" | "submit" | "result" | "classify">, private readonly key: Signer) {}
  vaultRequest(): VaultRequest {
    return { minSol: 0n };
  }
  ownSigner(): Signer {
    return this.key;
  }
  prepare(spec: Extract<JobSpec, { kind: "fund_vaults" }>): Promise<SignedTx> {
    return this.funder.prepare(spec.lamports);
  }
  async submit(tx: SignedTx): Promise<void> {
    await this.funder.submit(tx);
  }
  async result(_spec: Extract<JobSpec, { kind: "fund_vaults" }>, a: SentAttempt): Promise<Execution | null> {
    const r = await this.funder.result(a.signature);
    if (!r) return null;
    return { kind: "fund_vaults", signature: r.signature, slot: r.slot, vault: a.vault, lamports: r.lamports, networkFee: r.networkFee, blockTime: r.blockTime };
  }
  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return this.funder.classify(err, logs);
  }
}

/**
 * RELAYER v7 `consolidate`: whole balance of `mint` from the leg vault to the
 * mint's vault (pool-internal transfer, no gas drop, recipient ATA created if
 * needed, paid by the leg vault). Empty leg -> executed with 0, nothing sent.
 */
export class ConsolidateExecutor implements JobExecutor<Extract<JobSpec, { kind: "consolidate" }>> {
  constructor(
    private readonly withdrawer: Pick<TokenWithdrawer, "prepare" | "submit" | "result" | "classify">,
    private readonly inventory: Pick<VaultInventory, "tokenBalance">,
  ) {}
  vaultRequest(spec: Extract<JobSpec, { kind: "consolidate" }>): VaultRequest {
    return { minSol: ATA_RENT_HEADROOM + FEE_SOL_HEADROOM, only: spec.from };
  }
  async noop(spec: Extract<JobSpec, { kind: "consolidate" }>, vault: Signer): Promise<Execution | null> {
    const held = await this.inventory.tokenBalance(vault.publicKey, spec.mint);
    if (held > 0n) return null;
    return { kind: "consolidate", signature: null, slot: null, vault: spec.from, mint: spec.mint, to: spec.to, tokenAmount: 0n, networkFee: 0n };
  }
  async prepare(spec: Extract<JobSpec, { kind: "consolidate" }>, vault: Signer): Promise<SignedTx> {
    const held = await this.inventory.tokenBalance(vault.publicKey, spec.mint);
    if (held <= 0n) throw new AdapterError("insufficient_tokens", "leg vault is empty");
    return this.withdrawer.prepare({ vault, mint: spec.mint, to: spec.to, amount: held, gasDropLamports: 0n, internal: true });
  }
  async submit(tx: SignedTx): Promise<void> {
    await this.withdrawer.submit(tx);
  }
  async result(spec: Extract<JobSpec, { kind: "consolidate" }>, a: SentAttempt): Promise<Execution | null> {
    const r = await this.withdrawer.result(a.signature, { mint: spec.mint, vault: a.vault, to: spec.to });
    if (!r) return null;
    return { kind: "consolidate", signature: r.signature, slot: r.slot, vault: a.vault, mint: spec.mint, to: spec.to, tokenAmount: r.tokenAmount, networkFee: r.networkFee };
  }
  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return this.withdrawer.classify(err, logs);
  }
}

/**
 * PROPOSED `fund_quote`: keep `vault`'s quote stock within policy.
 * - priced quotes (USDC, ...): ONE pool-A swap signed by the vault (vault lease on meta.vault);
 * - stock-only quotes (ZEC SPL): a transfer from the rebalance address, signed by that key
 *   (no vault lease: the vault only receives).
 */
export class FundQuoteExecutor implements JobExecutor<Extract<JobSpec, { kind: "fund_quote" }>> {
  /** By quote MINT: symbols are ambiguous (devnet USDC of pump.fun != DBC/LaunchLab's). */
  private readonly by: Map<string, QuoteStocker | StockDistributor>;
  constructor(stockers: readonly (QuoteStocker | StockDistributor)[]) {
    this.by = new Map(stockers.map((s) => [s.asset.mint.toBase58(), s]));
  }
  private of(spec: Extract<JobSpec, { kind: "fund_quote" }>): QuoteStocker | StockDistributor {
    const s = this.by.get(spec.quote) ?? (() => {
      const bySym = [...this.by.values()].filter((x) => x.asset.symbol === spec.quote);
      return bySym.length === 1 ? bySym[0] : undefined;
    })();
    if (!s) throw new AdapterError("venue_unavailable", `no (unique) quote stock route for ${spec.quote}`);
    return s;
  }
  vaultRequest(spec: Extract<JobSpec, { kind: "fund_quote" }>): VaultRequest {
    return { minSol: FEE_SOL_HEADROOM, only: spec.vault };
  }
  ownSigner(spec: Extract<JobSpec, { kind: "fund_quote" }>): Signer | null {
    const s = this.of(spec);
    return s instanceof StockDistributor ? s.source : null;
  }
  async noop(spec: Extract<JobSpec, { kind: "fund_quote" }>, signer: Signer): Promise<Execution | null> {
    const st = this.of(spec);
    const vault = new PublicKey(spec.vault);
    const todo = st instanceof StockDistributor ? (await st.need(vault)) > 0n : (await st.action(signer.publicKey)) !== null;
    if (todo) return null;
    return { kind: "fund_quote", signature: null, slot: null, vault: spec.vault, quoteMint: st.asset.mint.toBase58(), quoteDelta: 0n, lamports: 0n, networkFee: 0n };
  }
  async prepare(spec: Extract<JobSpec, { kind: "fund_quote" }>, signer: Signer): Promise<SignedTx> {
    const st = this.of(spec);
    const p = st instanceof StockDistributor ? await st.prepare(new PublicKey(spec.vault)) : await st.prepare(signer);
    if (!p) throw new AdapterError("bad_request", "stock within bounds");
    return p;
  }
  async submit(tx: SignedTx): Promise<void> {
    const st = [...this.by.values()][0];
    if (!st) throw new AdapterError("venue_unavailable", "no quote stock route");
    await st.submit(tx); // sending does not depend on the quote
  }
  async result(spec: Extract<JobSpec, { kind: "fund_quote" }>, a: SentAttempt): Promise<Execution | null> {
    const r = await this.of(spec).result(a.signature, spec.vault);
    if (!r) return null;
    return { kind: "fund_quote", signature: r.signature, slot: r.slot, vault: spec.vault, quoteMint: r.quoteMint, quoteDelta: r.quoteDelta, lamports: r.lamports, networkFee: r.networkFee };
  }
  classify(err: unknown): AdapterError {
    return err instanceof AdapterError ? err : new AdapterError("internal", err instanceof Error ? err.message.slice(0, 120) : "error");
  }
}

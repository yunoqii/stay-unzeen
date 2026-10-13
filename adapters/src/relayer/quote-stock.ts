import { PublicKey, type Connection, type Signer } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { AdapterError, classifyError } from "../errors";
import { fixedPrice, type PriorityPrice } from "../fees";
import { CP_AMM_PROGRAM_ID, PoolA, poolASwapLegs, type QuoteAsset } from "../pool-a";
import type { TxPipeline } from "../sender";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SignedTx } from "../tx";
import type { Rng } from "./random";
import type { VaultPool } from "./vaults";

/**
 * Quote STOCK on every vault (lead 13.10, launchpads-a.md): non-SOL trades
 * spend quote the vault already holds; this module keeps that stock between
 * `low` and `high` by ONE pool-A swap per vault, in batches on a random
 * schedule that has nothing to do with trades (never right before / after one):
 * - stock < low  -> buy (target - stock) quote, ExactOut, SOL in <= cost x 1.01;
 * - stock > high -> sell (stock - target) quote, ExactIn, SOL out >= value x 0.99.
 * Pool level only: no user, job or amount of a user is involved. The same
 * operation is exposed as the job `fund_quote` (proposed core op) so core can
 * schedule it instead of the relayer-local runner.
 */

export interface StockPolicy {
  /** Quote units. */
  target: bigint;
  low: bigint;
  high: bigint;
}

/** Fixed limit for every stock swap (one class, one limit). */
export const CU_STOCK = 150_000;
const SLIPPAGE_BPS = 100n;

export type StockAction = { kind: "buy"; units: bigint } | { kind: "sell"; units: bigint } | null;

export function stockAction(balance: bigint, p: StockPolicy): StockAction {
  if (!(p.low <= p.target && p.target <= p.high)) throw new RangeError("stock policy must have low <= target <= high");
  if (balance < p.low) return { kind: "buy", units: p.target - balance };
  if (balance > p.high) return { kind: "sell", units: balance - p.target };
  return null;
}

/**
 * Policy from env: QUOTE_STOCK_<SYM>_TARGET (whole tokens, default mainnet 50 /
 * devnet 2), low = target / 2, high = target x 3 (QUOTE_STOCK_<SYM>_LOW / _HIGH override).
 */
export function stockPolicy(asset: Pick<QuoteAsset, "symbol" | "decimals">, cluster: string, env: NodeJS.ProcessEnv = process.env): StockPolicy {
  const unit = 10n ** BigInt(asset.decimals);
  const whole = (k: string, d: number) => {
    const v = env[k]?.trim();
    const n = v ? Number(v) : d;
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be >= 0`);
    return BigInt(Math.round(n * 1e6)) * unit / 1_000_000n;
  };
  const t = whole(`QUOTE_STOCK_${asset.symbol}_TARGET`, cluster === "mainnet-beta" ? 50 : 2);
  const low = env[`QUOTE_STOCK_${asset.symbol}_LOW`]?.trim() ? whole(`QUOTE_STOCK_${asset.symbol}_LOW`, 0) : t / 2n;
  const high = env[`QUOTE_STOCK_${asset.symbol}_HIGH`]?.trim() ? whole(`QUOTE_STOCK_${asset.symbol}_HIGH`, 0) : t * 3n;
  return { target: t, low, high };
}

export interface PreparedStock extends SignedTx {
  kind: "fund_quote";
  vault: string;
  action: NonNullable<StockAction>;
}

export interface StockResult {
  signature: string;
  slot: number;
  vault: string;
  quoteMint: string;
  /** +units bought / -units sold. */
  quoteDelta: bigint;
  /** lamports paid (buy) / received (sell). */
  lamports: bigint;
  networkFee: bigint;
}

export class QuoteStocker {
  readonly poolA: PoolA;
  private readonly priority: PriorityPrice;
  constructor(
    private readonly o: {
      connection: Connection;
      asset: QuoteAsset;
      policy: StockPolicy;
      priorityMicroLamports?: number | PriorityPrice;
      pipeline?: TxPipeline | null;
    },
  ) {
    if (!o.asset.poolA) throw new Error(`no pool A for ${o.asset.symbol}`);
    this.poolA = new PoolA(o.connection, o.asset.poolA, o.asset);
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
  }

  get asset(): QuoteAsset {
    return this.o.asset;
  }

  async stock(vault: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(this.o.asset.mint, vault, true, this.o.asset.tokenProgram);
    const info = await this.o.connection.getAccountInfo(ata, "confirmed");
    return info ? unpackAccount(ata, info, this.o.asset.tokenProgram).amount : 0n;
  }

  /** The action this vault needs now (null = within [low, high]). */
  async action(vault: PublicKey): Promise<StockAction> {
    return stockAction(await this.stock(vault), this.o.policy);
  }

  /** Signs the one swap the vault needs; null when its stock is within bounds. Sends nothing. */
  async prepare(vault: Signer): Promise<PreparedStock | null> {
    const action = await this.action(vault.publicKey);
    if (!action) return null;
    const s = await this.poolA.load();
    let ixs;
    if (action.kind === "buy") {
      const cost = this.poolA.solForExactQuote(s, action.units);
      const max = (cost * (10_000n + SLIPPAGE_BPS)) / 10_000n;
      const bal = BigInt(await this.o.connection.getBalance(vault.publicKey, "confirmed"));
      if (bal < max + 5_000_000n) throw new AdapterError("insufficient_sol", "vault cannot afford its quote stock");
      ixs = await this.poolA.buyQuoteExactOut(vault.publicKey, s, action.units, max);
    } else {
      const value = this.poolA.solForQuote(s, action.units);
      ixs = await this.poolA.sellQuoteExactIn(vault.publicKey, s, action.units, (value * (10_000n - SLIPPAGE_BPS)) / 10_000n);
    }
    let signed: SignedTx;
    try {
      signed = await signTx(this.o.connection, ixs, vault, [], { computeUnits: CU_STOCK, priorityMicroLamports: this.priority.microLamports(), tip: this.o.pipeline?.tip ?? null });
    } catch (e) {
      throw this.sendError(e);
    }
    return { ...signed, kind: "fund_quote", vault: vault.publicKey.toBase58(), action };
  }

  async submit(tx: SignedTx): Promise<void> {
    try {
      await broadcastAndConfirm(this.o.connection, tx, this.o.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  async result(signature: string, vault: string): Promise<StockResult | null> {
    const tx = await fetchTx(this.o.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const leg = poolASwapLegs(tx, this.poolA.address)[0];
    if (!leg) return null;
    const s = await this.poolA.load().catch(() => null);
    // trade_direction is relative to the pool's A/B order: SOL in = buy quote.
    const solIsA = s?.solIsA ?? true;
    const buy = (leg.tradeDirection === 0) === solIsA;
    return {
      signature,
      slot: tx.slot,
      vault,
      quoteMint: this.o.asset.mint.toBase58(),
      quoteDelta: buy ? leg.outputAmount : -leg.inputAmount,
      lamports: buy ? leg.inputAmount : leg.outputAmount,
      networkFee: BigInt(tx.meta?.fee ?? 0),
    };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, [], CP_AMM_PROGRAM_ID.toBase58(), {}, "damm");
  }

  private sendError(e: unknown): AdapterError {
    if (!isSendFailure(e)) return e instanceof AdapterError ? e : this.classify(e);
    const f: SendFailure = e;
    const err = this.classify(f.error, f.logs);
    return new AdapterError(err.code, err.message, {
      ...(f.signature ? { signature: f.signature } : {}),
      ...(f.stage ? { stage: f.stage } : {}),
      ...(f.landedErr ? { landedErr: true } : {}),
      cause: f.error,
    });
  }
}

/**
 * Relayer-local schedule until core schedules `fund_quote` (RELAYER_QUOTE_STOCK=1):
 * a round every 45-90 min (random), vaults in random order, a random 20-120 s
 * pause between vaults, each vault locked like any job (never two txs in flight).
 * Logs: counts only.
 */
export class QuoteStockRunner {
  constructor(
    private readonly o: {
      stockers: readonly QuoteStocker[];
      pool: Pick<VaultPool, "keys" | "lockVault" | "release" | "markUsed">;
      rng: Rng;
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
      log?: (m: string) => void;
    },
  ) {}

  /** One round over every vault and quote. Returns counts. */
  async round(signal: AbortSignal): Promise<{ swaps: number; skipped: number; errors: number }> {
    const r = { swaps: 0, skipped: 0, errors: 0 };
    const keys = shuffle(this.o.pool.keys(), this.o.rng);
    for (const key of keys) {
      for (const st of this.o.stockers) {
        if (signal.aborted) return r;
        const signer = await this.o.pool.lockVault(key);
        if (!signer) {
          r.skipped++;
          continue;
        }
        try {
          const p = await st.prepare(signer);
          if (!p) {
            r.skipped++;
            continue;
          }
          await this.o.pool.markUsed(key, Date.now()).catch(() => undefined);
          await st.submit(p);
          r.swaps++;
        } catch {
          r.errors++;
        } finally {
          await this.o.pool.release(signer).catch(() => undefined);
        }
        await this.sleep(this.o.rng.int(20_000, 120_000), signal);
      }
    }
    return r;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sleep(this.o.rng.int(45 * 60_000, 90 * 60_000), signal);
      if (signal.aborted) break;
      const r = await this.round(signal);
      this.o.log?.(`quote stock round: swaps=${r.swaps} skipped=${r.skipped} errors=${r.errors}`);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (this.o.sleep) return this.o.sleep(ms, signal);
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
    });
  }
}

function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

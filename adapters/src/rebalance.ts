import { Keypair, PublicKey, SystemProgram, type Connection, type Signer } from "@solana/web3.js";
import type { Pool } from "pg";
import { AdapterError, classifyError } from "./errors";
import { lamportDelta } from "./events";
import { fixedPrice, type PriorityPrice } from "./fees";
import { slip10DerivePath } from "./keys";
import type { TxPipeline } from "./sender";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SignedTx } from "./tx";

/**
 * Pool auto-rebalance ZEC -> SOL (RELAYER.md v7 A, core 0015). Relayer side:
 * - the rebalance address key (its own HD branch of the creator master seed:
 *   not a vault, not a creator, not an attestation key);
 * - `fund_vaults`: ONE tx from the rebalance address spreading lamports over
 *   the vaults (water-fill: the poorest vaults up to a common level);
 * - `pool_sol_inventory`: SOL of all vaults + the rebalance address, every ~5 min.
 * Pool level only: no user, action or amount of a user is involved anywhere.
 */

/** m/44'/501'/2147483645'/4' (next to the attestation keys /2', /3'). */
export const REBALANCE_PATH = [44, 501, 0x7ffffffd, 4] as const;

export function deriveRebalanceKeypair(creatorMasterSeed: Uint8Array): Keypair {
  return Keypair.fromSeed(slip10DerivePath(creatorMasterSeed, REBALANCE_PATH));
}

/** A system account must stay rent-exempt (or be emptied): the address keeps this. */
export const RENT_EXEMPT_MIN = 890_880n;
const FEE_HEADROOM = 100_000n;
/** Smaller transfers are not worth a rebalance tx. */
export const MIN_FUND_LAMPORTS = 10_000_000n;
/** Recipients per tx (keeps a legacy tx well under 1232 bytes). */
export const MAX_FUND_RECIPIENTS = 20;
const CU_FUND = 60_000;

export interface FundTransfer {
  vault: string;
  lamports: bigint;
}

/**
 * Water-fill: raise the poorest vaults to one common level with `amount`
 * lamports (whatever is left once all are level is spread evenly, which is the
 * same thing). Integer, exact: Σ result = amount. At most `maxRecipients`
 * (the poorest). Depends only on balances, never on jobs or users.
 */
export function planFunding(amount: bigint, balances: readonly { vault: string; lamports: bigint }[], maxRecipients = MAX_FUND_RECIPIENTS): FundTransfer[] {
  if (amount <= 0n) return [];
  if (balances.length === 0) throw new RangeError("no vaults to fund");
  const sorted = [...balances].sort((a, b) => (a.lamports < b.lamports ? -1 : a.lamports > b.lamports ? 1 : a.vault < b.vault ? -1 : 1)).slice(0, Math.max(1, maxRecipients));
  // Smallest k such that the level of the k poorest does not exceed vault k+1.
  let k = sorted.length;
  let sum = 0n;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i]!.lamports;
    const level = (amount + sum) / BigInt(i + 1);
    const next = sorted[i + 1];
    if (!next || level <= next.lamports) {
      k = i + 1;
      break;
    }
  }
  const base = sorted.slice(0, k);
  const total = amount + base.reduce((s, b) => s + b.lamports, 0n);
  const level = total / BigInt(k);
  let rest = total - level * BigInt(k); // < k lamports: one each to the poorest
  const out: FundTransfer[] = [];
  for (const b of base) {
    let l = level - b.lamports;
    if (rest > 0n) {
      l += 1n;
      rest -= 1n;
    }
    if (l > 0n) out.push({ vault: b.vault, lamports: l });
  }
  return out;
}

export interface PreparedFund extends SignedTx {
  kind: "fund_vaults";
  from: string;
  transfers: FundTransfer[];
  /** Planned total (<= lamports_in when the address holds less). */
  lamports: bigint;
}

export interface FundResult {
  signature: string;
  slot: number;
  /** Lamports that reached the vaults (from balance deltas). */
  lamports: bigint;
  networkFee: bigint;
  blockTime: number | null;
}

export interface VaultFunderOptions {
  connection: Pick<Connection, "getBalance" | "getMultipleAccountsInfo" | "getLatestBlockhash" | "getTransaction" | "sendRawTransaction" | "confirmTransaction" | "simulateTransaction" | "getSignatureStatuses" | "getBlockHeight">;
  key: Signer;
  vaults: readonly PublicKey[];
  priorityMicroLamports?: number | PriorityPrice;
  /** Pool pipeline: same CU price and Sender tip as every pool tx. */
  pipeline?: TxPipeline | null;
}

/** `fund_vaults` builder (rebalance address -> vaults). */
export class VaultFunder {
  private readonly priority: PriorityPrice;
  constructor(private readonly o: VaultFunderOptions) {
    if (o.vaults.some((v) => v.equals(o.key.publicKey))) throw new Error("rebalance address is a vault");
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
  }

  get address(): string {
    return this.o.key.publicKey.toBase58();
  }

  /** Signs the spread of up to `lamportsIn`. Sends nothing. */
  async prepare(lamportsIn: bigint): Promise<PreparedFund> {
    if (lamportsIn <= 0n) throw new AdapterError("bad_request", "lamports_in must be > 0");
    const [bal, accs] = await this.rpc(() =>
      Promise.all([this.o.connection.getBalance(this.o.key.publicKey, "confirmed"), this.o.connection.getMultipleAccountsInfo([...this.o.vaults], "confirmed")]),
    );
    const tip = this.o.pipeline?.tip?.lamports ?? 0n;
    const spendable = BigInt(bal) - RENT_EXEMPT_MIN - FEE_HEADROOM - tip;
    const amount = spendable < lamportsIn ? spendable : lamportsIn;
    if (amount < MIN_FUND_LAMPORTS) throw new AdapterError("insufficient_sol", "rebalance address holds too little SOL");
    const transfers = planFunding(
      amount,
      this.o.vaults.map((v, i) => ({ vault: v.toBase58(), lamports: BigInt(accs[i]?.lamports ?? 0) })),
    );
    const ixs = transfers.map((t) => SystemProgram.transfer({ fromPubkey: this.o.key.publicKey, toPubkey: new PublicKey(t.vault), lamports: t.lamports }));
    let signed: SignedTx;
    try {
      signed = await signTx(this.o.connection, ixs, this.o.key, [], {
        computeUnits: CU_FUND,
        priorityMicroLamports: this.priority.microLamports(),
        tip: this.o.pipeline?.tip ?? null,
      });
    } catch (e) {
      throw this.sendError(e);
    }
    return { ...signed, kind: "fund_vaults", from: this.address, transfers, lamports: amount };
  }

  async submit(p: SignedTx): Promise<void> {
    try {
      await broadcastAndConfirm(this.o.connection as Connection, p, this.o.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  /** What actually reached the vaults; null when the tx is not readable yet. */
  async result(signature: string): Promise<FundResult | null> {
    const tx = await fetchTx(this.o.connection as Connection, signature, 10).catch(() => null);
    if (!tx) return null;
    let lamports = 0n;
    for (const v of this.o.vaults) {
      const d = lamportDelta(tx, v);
      if (d > 0n) lamports += d;
    }
    return { signature, slot: tx.slot, lamports, networkFee: BigInt(tx.meta?.fee ?? 0), blockTime: tx.blockTime ?? null };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, [], SystemProgram.programId.toBase58());
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

  private async rpc<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      throw new AdapterError("venue_unavailable", `RPC error: ${(e instanceof Error ? e.message : String(e)).split("\n", 1)[0]}`, { cause: e });
    }
  }
}

// ---------------------------------------------------------------------------
// pool_sol_inventory (core 0015)
// ---------------------------------------------------------------------------

export interface SolInventory {
  vaultLamports: bigint;
  vaultCount: number;
  rebalanceLamports: bigint;
  slot: number;
}

/**
 * SOL of every trading vault + the rebalance address, ONE consistent read
 * (getMultipleAccounts, confirmed, read provider). Written every ~5 min and at
 * start; core plans no rebalance without a row younger than 15 min.
 */
export class PoolSolInventoryWriter {
  constructor(
    private readonly db: Pool,
    private readonly network: "devnet" | "mainnet-beta",
    private readonly read: Pick<Connection, "getMultipleAccountsInfoAndContext">,
    private readonly vaults: readonly PublicKey[],
    private readonly rebalance: PublicKey,
  ) {
    if (vaults.length + 1 > 100) throw new RangeError("more than 99 vaults: split the read");
  }

  async snapshot(): Promise<SolInventory> {
    const r = await this.read.getMultipleAccountsInfoAndContext([...this.vaults, this.rebalance], { commitment: "confirmed" });
    let vaultLamports = 0n;
    for (let i = 0; i < this.vaults.length; i++) vaultLamports += BigInt(r.value[i]?.lamports ?? 0);
    return { vaultLamports, vaultCount: this.vaults.length, rebalanceLamports: BigInt(r.value[this.vaults.length]?.lamports ?? 0), slot: r.context.slot };
  }

  async writeOnce(): Promise<SolInventory> {
    const s = await this.snapshot();
    await this.db.query(
      `INSERT INTO pool_sol_inventory (network, vault_lamports, vault_count, rebalance_lamports, slot, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (network) DO UPDATE SET vault_lamports = EXCLUDED.vault_lamports, vault_count = EXCLUDED.vault_count,
         rebalance_lamports = EXCLUDED.rebalance_lamports, slot = EXCLUDED.slot, updated_at = now()`,
      [this.network, s.vaultLamports.toString(), s.vaultCount, s.rebalanceLamports.toString(), s.slot],
    );
    return s;
  }

  /** At start, then every 5 min ± 30 s until `signal` aborts. Errors go to `onError` (never thrown). */
  async run(signal: AbortSignal, onError: (e: unknown) => void = () => undefined, everyMs = 300_000, jitterMs = 30_000): Promise<void> {
    while (!signal.aborted) {
      await this.writeOnce().catch(onError);
      const wait = everyMs + Math.floor((Math.random() * 2 - 1) * jitterMs);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
}

/** Whether core 0015 is there and this role may write the inventory. */
export async function poolSolInventoryWritable(db: Pool): Promise<boolean> {
  const r = await db
    .query<{ ok: boolean }>(
      `SELECT to_regclass('pool_sol_inventory') IS NOT NULL
              AND has_table_privilege(current_user, 'pool_sol_inventory', 'INSERT,UPDATE,SELECT') AS ok`,
    )
    .catch(() => null);
  return r?.rows[0]?.ok === true;
}

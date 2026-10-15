import type { FeeConfig, Global } from "@pump-fun/pump-sdk";
import type { Pool } from "pg";
import { toBig } from "../math";
import type { SolanaNetwork } from "./postgres-queue";

/**
 * `launch_curves` (core 0008, RELAYER v3 §3): the network's launch curve from
 * the venue's on-chain config, so core never hardcodes reserves (devnet pump
 * Global has 1 virtual SOL, mainnet 30). Written at relayer start and every
 * 10 minutes. Public data only.
 */
export interface LaunchCurve {
  venue: "pumpfun" | "meteora-dbc" | "bags" | "pons";
  virtualSolLamports: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  /**
   * core 0034 / API v0.27: the venue's trade fee as read from chain with the reserves, market-cap
   * tiers ascending (pump.fun: protocol + creator bps of a SOL bonding curve). Absent: core uses
   * its configured fallback (UNZEEN_TRADE_FEE_BPS_PUMPFUN).
   */
  feeTiers?: FeeTierBps[];
}

export interface FeeTierBps {
  marketCapLamports: bigint;
  bps: number;
}

const I64_MAX = (1n << 63n) - 1n;

/**
 * Trade fee of a SOL pump.fun bonding curve, the way pump-fees charges it (SDK `computeFeesBps`
 * / `selectCurveFeeSchedule`): the FeeConfig market-cap tiers `feeTiers` (protocol + creator bps;
 * the lp share is AMM-only) when the FeeConfig exists, else Global `feeBasisPoints` +
 * `creatorFeeBasisPoints`. Verified on devnet 15.10: FeeConfig one tier 95 + 30 = 125 bps, and the
 * TradeEvent of tx 4s5DKdb8 charged exactly that (Global itself says 95 + 5).
 */
export function pumpFeeTiers(
  g: Pick<Global, "feeBasisPoints" | "creatorFeeBasisPoints">,
  fc: Pick<FeeConfig, "feeTiers"> | null,
): FeeTierBps[] {
  const num = (x: { toString(): string }) => Number(BigInt(x.toString()));
  const tiers = (fc?.feeTiers ?? []).map((t) => ({
    marketCapLamports: BigInt(t.marketCapLamportsThreshold.toString()),
    bps: num(t.fees.protocolFeeBps) + num(t.fees.creatorFeeBps),
  }));
  const out = tiers.length > 0 ? tiers : [{ marketCapLamports: 0n, bps: num(g.feeBasisPoints) + num(g.creatorFeeBasisPoints) }];
  out.sort((a, b) => (a.marketCapLamports < b.marketCapLamports ? -1 : a.marketCapLamports > b.marketCapLamports ? 1 : 0));
  for (const [i, t] of out.entries()) {
    if (!Number.isInteger(t.bps) || t.bps < 0 || t.bps > 5_000) throw new Error("pump fees: bps out of range");
    if (i > 0 && out[i - 1]!.marketCapLamports === t.marketCapLamports) throw new Error("pump fees: duplicate tier");
  }
  if (out.length > 32) throw new Error("pump fees: too many tiers");
  return out;
}

/** pump.fun `Global` -> launch curve (initial reserves of a new coin). Throws on values core would reject. */
export function pumpLaunchCurve(
  g: Pick<Global, "initialVirtualSolReserves" | "initialVirtualTokenReserves" | "initialRealTokenReserves" | "tokenTotalSupply"> &
    Partial<Pick<Global, "feeBasisPoints" | "creatorFeeBasisPoints">>,
  feeConfig?: Pick<FeeConfig, "feeTiers"> | null,
): LaunchCurve {
  const c: LaunchCurve = {
    venue: "pumpfun",
    virtualSolLamports: toBig(g.initialVirtualSolReserves),
    virtualTokenReserves: toBig(g.initialVirtualTokenReserves),
    realTokenReserves: toBig(g.initialRealTokenReserves),
    tokenTotalSupply: toBig(g.tokenTotalSupply),
  };
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === "bigint" && (v <= 0n || v > I64_MAX)) throw new Error(`pump Global: ${k} out of range`);
  }
  if (c.realTokenReserves > c.virtualTokenReserves || c.virtualTokenReserves > c.tokenTotalSupply * 2n) {
    throw new Error("pump Global: inconsistent token reserves");
  }
  if (feeConfig !== undefined && g.feeBasisPoints !== undefined && g.creatorFeeBasisPoints !== undefined) {
    c.feeTiers = pumpFeeTiers({ feeBasisPoints: g.feeBasisPoints, creatorFeeBasisPoints: g.creatorFeeBasisPoints }, feeConfig);
  }
  return c;
}

/** The parts of a Meteora DBC PoolConfig a launch curve needs (BN-like numbers). */
export interface DbcCurveConfig {
  sqrtStartPrice: { toString(): string };
  curve: { sqrtPrice: { toString(): string }; liquidity: { toString(): string } }[];
  swapBaseAmount: { toString(): string };
  preMigrationTokenSupply: { toString(): string };
  postMigrationTokenSupply: { toString(): string };
}

/** A curve segment worth modelling must hold at least this much quote (lamports). */
const MIN_SEGMENT_QUOTE = 10_000_000n;

/**
 * Meteora DBC config (SOL quote) -> the constant-product curve core models a first buy with.
 * DBC segment i spans sqrt prices [lower, curve[i].sqrtPrice) (Q64.64, lower = sqrtStartPrice for
 * i = 0) at liquidity L; inside it the pool IS x*y = k with virtual quote = L * lower >> 128 and
 * virtual base = L / lower (base units). Taken: the first segment holding >= 0.01 SOL (Bags'
 * shared config ArBv9x… has a degenerate first segment, then one segment of ~10 SOL = the whole
 * curve). real tokens = swapBaseAmount (sold on the curve), supply = pre-migration supply.
 */
export function dbcLaunchCurve(venue: "meteora-dbc" | "bags", c: DbcCurveConfig): LaunchCurve {
  let lower = BigInt(c.sqrtStartPrice.toString());
  for (const seg of c.curve) {
    const upper = BigInt(seg.sqrtPrice.toString());
    const L = BigInt(seg.liquidity.toString());
    if (L === 0n || upper <= lower) break;
    const quoteCap = (L * (upper - lower)) >> 128n;
    if (quoteCap >= MIN_SEGMENT_QUOTE) {
      const pre = BigInt(c.preMigrationTokenSupply.toString());
      const out: LaunchCurve = {
        venue,
        virtualSolLamports: (L * lower) >> 128n,
        virtualTokenReserves: L / lower,
        realTokenReserves: BigInt(c.swapBaseAmount.toString()),
        tokenTotalSupply: pre > 0n ? pre : BigInt(c.postMigrationTokenSupply.toString()),
      };
      for (const [k, v] of Object.entries(out)) {
        if (typeof v === "bigint" && (v <= 0n || v > I64_MAX)) throw new Error(`dbc config: ${k} out of range`);
      }
      if (out.realTokenReserves > out.virtualTokenReserves || out.virtualTokenReserves > out.tokenTotalSupply * 2n) throw new Error("dbc config: inconsistent token reserves");
      return out;
    }
    lower = upper;
  }
  throw new Error("dbc config: no curve segment with liquidity");
}

export const LAUNCH_CURVE_UPSERT = `
INSERT INTO launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves, real_token_reserves, token_total_supply, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (network, venue) DO UPDATE
   SET virtual_sol_lamports = EXCLUDED.virtual_sol_lamports,
       virtual_token_reserves = EXCLUDED.virtual_token_reserves,
       real_token_reserves = EXCLUDED.real_token_reserves,
       token_total_supply = EXCLUDED.token_total_supply,
       updated_at = now()`;

/** core 0034: fee tiers next to the reserves (JSON, thresholds as decimal strings). */
export const LAUNCH_CURVE_FEES_UPDATE = `UPDATE launch_curves SET fee_tiers = $3::jsonb WHERE network = $1 AND venue = $2`;

export function feeTiersJson(t: readonly FeeTierBps[]): string {
  return JSON.stringify(t.map((x) => ({ marketCapLamports: x.marketCapLamports.toString(), bps: x.bps })));
}

export class LaunchCurveWriter {
  /** false once the DB answered "no column fee_tiers" (core before 0034): reserves only. */
  private feesColumn = true;

  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
    /** Fresh curves from chain (pump: OnlinePumpSdk.fetchGlobal()). */
    private readonly source: () => Promise<LaunchCurve[]>,
  ) {}

  async writeOnce(): Promise<number> {
    const curves = await this.source();
    for (const c of curves) {
      await this.pool.query(LAUNCH_CURVE_UPSERT, [
        this.network,
        c.venue,
        c.virtualSolLamports.toString(),
        c.virtualTokenReserves.toString(),
        c.realTokenReserves.toString(),
        c.tokenTotalSupply.toString(),
      ]);
      if (c.feeTiers && this.feesColumn) {
        try {
          await this.pool.query(LAUNCH_CURVE_FEES_UPDATE, [this.network, c.venue, feeTiersJson(c.feeTiers)]);
        } catch (e) {
          if ((e as { code?: string }).code !== "42703") throw e;
          this.feesColumn = false; // undefined_column: core without 0034
        }
      }
    }
    return curves.length;
  }

  /** Writes now, then every `everyMs` until `signal` aborts. Errors go to `onError`, never throw. */
  async run(signal: AbortSignal, onError: (e: unknown) => void, everyMs = 10 * 60_000): Promise<void> {
    while (!signal.aborted) {
      await this.writeOnce().catch(onError);
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, everyMs);
        function done() {
          clearTimeout(t);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}

/** Whether core's `launch_curves` exists and this role may write it (0008 + relayer-role.sql). */
export async function launchCurvesWritable(pool: Pool): Promise<boolean> {
  const r = await pool
    .query<{ ok: boolean }>(
      `SELECT to_regclass('launch_curves') IS NOT NULL
              AND has_table_privilege(current_user, 'launch_curves', 'INSERT')
              AND has_table_privilege(current_user, 'launch_curves', 'UPDATE') AS ok`,
    )
    .catch(() => null);
  return r?.rows[0]?.ok === true;
}

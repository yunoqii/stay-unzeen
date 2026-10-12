import type { Global } from "@pump-fun/pump-sdk";
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
  venue: "pumpfun" | "meteora-dbc";
  virtualSolLamports: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
}

const I64_MAX = (1n << 63n) - 1n;

/** pump.fun `Global` -> launch curve (initial reserves of a new coin). Throws on values core would reject. */
export function pumpLaunchCurve(g: Pick<Global, "initialVirtualSolReserves" | "initialVirtualTokenReserves" | "initialRealTokenReserves" | "tokenTotalSupply">): LaunchCurve {
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
  return c;
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

export class LaunchCurveWriter {
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

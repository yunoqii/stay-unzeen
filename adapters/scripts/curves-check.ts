/**
 * Read-only check (API v0.28 TokenCurve): the one estimate formula against real pump.fun
 * TradeEvents of the given mints (reserves before the trade = event reserves minus the trade).
 * Usage: pnpm tsx scripts/curves-check.ts <mint>...  (public devnet RPC, or CURVES_CHECK_RPC_URL). Public data, amounts only.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { extractTradeEvents } from "../src/events";
import { getTransactionAnyVersion } from "../src/tx";
import { estimateBuy, estimateSell, dbcCurveState } from "../src/intel/curves";
import BN from "bn.js";
import type { PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DEFAULT_DBC_CONFIG, dbcCoder, dbcSwap2Events } from "../src/meteora";

// Public devnet RPC by default (the read provider does not serve getSignaturesForAddress).
const url = process.env.CURVES_CHECK_RPC_URL || "https://api.devnet.solana.com";
const conn = new Connection(url, "confirmed");
const mints = process.argv.slice(2);
const big = (x: { toString(): string } | undefined) => BigInt(x?.toString() ?? "0");
async function main() {
let n = 0, worst = 0;
const cfgAcc = await conn.getAccountInfo(new PublicKey(DEFAULT_DBC_CONFIG.devnet!));
const dbcCfg = cfgAcc ? (dbcCoder().accounts.decode("poolConfig", cfgAcc.data) as PoolConfig) : null;
for (const m of mints) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(m), { limit: 25 });
  for (const s of sigs.filter((x) => !x.err)) {
    const tx = await getTransactionAnyVersion(conn, s.signature).catch(() => null);
    if (!tx) continue;
    // Meteora DBC (Unzeen's devnet config): reserves before the swap from the event's next
    // sqrt price and the segment liquidity (S = L·√P/2^128, T = L/√P).
    for (const ev of dbcCfg ? dbcSwap2Events(tx as never) : []) {
      const r = ev.swapResult as unknown as Record<string, BN>;
      const next = big(r.nextSqrtPrice!);
      const seg = dbcCfg!.curve.find((c) => big(c.sqrtPrice) >= next && big(c.liquidity) > 0n)!;
      const L = big(seg.liquidity);
      const isBuy = ev.tradeDirection === 1;
      const pre = isBuy ? next - (big(r.excludedFeeInputAmount!) << 128n) / L : (L * next) / (L - big(r.includedFeeInputAmount!) * next);
      const st = dbcCurveState({ sqrtPrice: new BN(pre.toString()), quoteReserve: new BN(0), volatilityTracker: {} as never, activationPoint: new BN(0) }, dbcCfg!, new BN(10).pow(new BN(12)));
      if (!st) continue;
      const out = big(r.outputAmount!);
      const est = isBuy ? estimateBuy(st, big(r.includedFeeInputAmount!)) : estimateSell(st, big(r.includedFeeInputAmount!));
      const d = (Number(est > out ? est - out : out - est) / Number(out)) * 1e4;
      worst = Math.max(worst, d); n++;
      console.log(`dbc ${isBuy ? "buy " : "sell"} ${s.signature.slice(0, 8)} fee=${st.feeBps}bps in=${big(r.includedFeeInputAmount!)} chainOut=${out} formula=${est} diff=${d.toFixed(3)}bps`);
    }
    for (const ev of extractTradeEvents(tx as never, PUMP_PROGRAM_ID)) {
      const e = ev as unknown as Record<string, { toString(): string }> & { isBuy: boolean };
      const sol = big(e.solAmount), tok = big(e.tokenAmount);
      const vS = big(e.virtualSolReserves ?? e.virtualQuoteReserves), vT = big(e.virtualTokenReserves);
      const feeBps = Number(big(e.feeBasisPoints ?? 0) + big(e.creatorFeeBasisPoints ?? 0));
      const fees = big(e.fee ?? 0) + big(e.creatorFee ?? 0);
      if (e.isBuy) {
        const S = vS - sol, T = vT + tok; // reserves before the trade
        const spent = sol + fees;
        const est = estimateBuy({ virtualSol: S, virtualTokens: T, feeBps, buyFee: "added" }, spent);
        const d = Number(est > tok ? est - tok : tok - est) / Number(tok) * 1e4;
        worst = Math.max(worst, d); n++;
        console.log(`buy  ${s.signature.slice(0, 8)} fee=${feeBps}bps spent=${spent} chainTokens=${tok} formula=${est} diff=${d.toFixed(3)}bps`);
      } else {
        const S = vS + sol, T = vT - tok;
        const got = sol - fees;
        const est = estimateSell({ virtualSol: S, virtualTokens: T, feeBps }, tok);
        const d = Number(est > got ? est - got : got - est) / Number(got) * 1e4;
        worst = Math.max(worst, d); n++;
        console.log(`sell ${s.signature.slice(0, 8)} fee=${feeBps}bps tokens=${tok} chainLamportsNet=${got} formula=${est} diff=${d.toFixed(3)}bps`);
      }
    }
  }
}
console.log(`trades=${n} worst=${worst.toFixed(3)}bps`);
}
void main();

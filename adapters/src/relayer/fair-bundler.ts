import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, VersionedTransaction, type Connection, type Signer } from "@solana/web3.js";
import { AdapterError } from "../errors";
import { DEFAULT_PLAN, type FairPlanConfig } from "../fair-bundle";
import { JitoClient, JitoTipCache, jitoTip, type BundleSender, type JitoConfig } from "../jito";
import type { MetadataStore } from "../metadata";
import type { FairLegResult, PreparedFairBundle, PumpFunAdapter } from "../pumpfun";
import type { BundleLeg, FairCreateJobSpec } from "./types";

/**
 * Fair-launch v2 (mainnet only): what the engine needs to run a launch as a
 * Jito bundle over several vaults. The engine keeps the safety protocol
 * (record before send, resolve before resend, one mint keypair); this object
 * only signs, relays and reads. Leg tokens are moved to vault A by core's
 * `consolidate` jobs (RELAYER v7), not here.
 */
export interface FairBundler {
  /** Planner limits (reserves include the tip and the consolidation tx). */
  readonly plan: FairPlanConfig;
  /** Bundle sends per job before the capped single-tx fallback. */
  readonly bundleTries: number;
  /** Bundle path usable right now (fresh tip floor). Never touches the network. */
  available(): boolean;
  /** Publishes metadata (content-addressed) and signs every leg with one blockhash. */
  prepare(spec: FairCreateJobSpec, legs: readonly { vault: Signer; lamports: bigint }[]): Promise<PreparedFairBundle>;
  /** Sends the bundle. Throws (AdapterError venue_unavailable) on relay errors. */
  send(raws: readonly Uint8Array[]): Promise<void>;
  /** Best-effort resend of the same bundle while it is unresolved (rate-limited, never throws). */
  resend(raws: readonly Uint8Array[]): Promise<void>;
  /** Fresh-curve quote of a single create+buy (capped fallback scales min_out with it). */
  freshQuote(lamports: bigint): Promise<bigint>;
  /** Executed amounts of a landed leg; null = not readable yet. */
  legResult(signature: string, vault: string, mint: string): Promise<FairLegResult | null>;
  /** Whether a blockhash valid until `lastValidBlockHeight` has expired (finalized height). */
  expired(lastValidBlockHeight: number): Promise<boolean>;
  /**
   * Legs of a landed create whose record was lost (DB without `bundle_legs`):
   * the first successful tx on each other vault's ATA of the new mint.
   */
  discoverLegs(mint: string, createVault: string, vaults: readonly string[]): Promise<BundleLeg[]>;
  /** Public market snapshot after the last leg (tokens table); optional. */
  market?(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: "curve" | "graduated" }>;
}

/** Reserves the planner keeps on each vault (lamports), on top of the tip. */
export const CREATE_RESERVE = 35_000_000n + 100_000n; // = executors CREATE_SOL_HEADROOM + fee headroom
export const LEG_RESERVE = 5_000_000n + 200_000n; //     = BUY_SOL_HEADROOM + consolidation tx (fee + tip)

export interface JitoFairBundlerOptions {
  adapter: Pick<PumpFunAdapter, "prepareFairBundle" | "freshQuote" | "fairLegResult" | "classify" | "market">;
  metadata: MetadataStore | null;
  /** Send-side RPC (Helius): it sees every pool tx anyway; never the read provider. */
  connection: Pick<Connection, "getBlockHeight" | "getSignaturesForAddress" | "simulateTransaction">;
  sender: BundleSender;
  tips: Pick<JitoTipCache, "current">;
  cfg: Pick<JitoConfig, "maxLegs" | "maxPerVaultLamports" | "bundleTries" | "maxTipLamports">;
  now?: () => number;
}

export class JitoFairBundler implements FairBundler {
  readonly plan: FairPlanConfig;
  readonly bundleTries: number;
  private lastResend = 0;
  private readonly now: () => number;

  constructor(private readonly o: JitoFairBundlerOptions) {
    this.bundleTries = o.cfg.bundleTries;
    this.now = o.now ?? Date.now;
    this.plan = {
      ...DEFAULT_PLAN,
      maxLegs: o.cfg.maxLegs,
      maxPerVault: o.cfg.maxPerVaultLamports,
      // The worst-case tip is reserved, so a tip floor jump never breaks a planned leg.
      createReserve: CREATE_RESERVE + o.cfg.maxTipLamports,
      legReserve: LEG_RESERVE + o.cfg.maxTipLamports,
    };
  }

  available(): boolean {
    return this.o.tips.current() !== null;
  }

  async prepare(spec: FairCreateJobSpec, legs: readonly { vault: Signer; lamports: bigint }[]): Promise<PreparedFairBundle> {
    const tip = this.o.tips.current();
    if (tip === null) throw new AdapterError("venue_unavailable", "no fresh Jito tip floor");
    if (!this.o.metadata) throw new AdapterError("venue_unavailable", "no metadata store configured");
    const { uri } = await this.o.metadata.publish(spec.meta);
    return this.o.adapter.prepareFairBundle({ name: spec.meta.name, symbol: spec.meta.symbol, uri }, legs, spec.minOut, {
      mintKeypair: spec.mintKeypair,
      tip: jitoTip(tip),
    });
  }

  async send(raws: readonly Uint8Array[]): Promise<void> {
    // Preflight leg 0 alone (create + first buy; later legs need the mint and
    // cannot be simulated on a plain RPC). A rejection means nothing was relayed.
    const raw0 = raws[0];
    if (!raw0) throw new AdapterError("internal", "empty bundle");
    let sim;
    try {
      sim = await this.o.connection.simulateTransaction(VersionedTransaction.deserialize(raw0), { sigVerify: false, commitment: "confirmed" });
    } catch (e) {
      throw new AdapterError("venue_unavailable", "preflight RPC error", { stage: "preflight", cause: e });
    }
    if (sim.value.err) {
      const c = this.o.adapter.classify(new Error(`Transaction simulation failed: ${JSON.stringify(sim.value.err)}`), sim.value.logs ?? null);
      throw new AdapterError(c.code, c.message, { stage: "preflight", ...(c.programError ? { programError: c.programError } : {}) });
    }
    this.lastResend = this.now();
    try {
      await this.o.sender.sendBundle(raws);
    } catch (e) {
      // Message only (status / JSON-RPC error); never the bytes or the URL.
      throw new AdapterError("venue_unavailable", e instanceof Error ? e.message.slice(0, 120) : "bundle relay error", { stage: "confirm" });
    }
  }

  async resend(raws: readonly Uint8Array[]): Promise<void> {
    // Keyless Jito: 1 req/s/IP/region. One resend per ~3 s is plenty within a ~60 s blockhash life.
    if (this.now() - this.lastResend < 3_000) return;
    this.lastResend = this.now();
    await this.o.sender.sendBundle(raws).catch(() => undefined);
  }

  freshQuote(lamports: bigint): Promise<bigint> {
    return this.o.adapter.freshQuote(lamports);
  }

  legResult(signature: string, vault: string, mint: string): Promise<FairLegResult | null> {
    return this.o.adapter.fairLegResult(signature, vault, mint);
  }

  market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: "curve" | "graduated" }> {
    return this.o.adapter.market(mint);
  }

  async expired(lastValidBlockHeight: number): Promise<boolean> {
    return (await this.o.connection.getBlockHeight("finalized")) > lastValidBlockHeight;
  }

  async discoverLegs(mint: string, createVault: string, vaults: readonly string[]): Promise<BundleLeg[]> {
    const mintPk = new PublicKey(mint);
    const out: BundleLeg[] = [];
    for (const v of vaults) {
      if (v === createVault) continue;
      const ata = getAssociatedTokenAddressSync(mintPk, new PublicKey(v), true, TOKEN_2022_PROGRAM_ID);
      const sigs = await this.o.connection.getSignaturesForAddress(ata, { limit: 100 }, "confirmed");
      // Newest first: the oldest successful tx created the ATA = the leg's buy
      // (D4: no other pool tx touches this mint on this vault before consolidation).
      const first = [...sigs].reverse().find((s) => s.err === null);
      if (first) out.push({ signature: first.signature, vault: v });
    }
    return out;
  }


}

/** Mainnet runtime wiring: Jito client + background tip floor. Start/stop `tips` with the relayer. */
export function jitoFairBundler(o: Omit<JitoFairBundlerOptions, "sender" | "tips" | "cfg"> & { cfg: JitoConfig; fetchImpl?: typeof fetch }): {
  bundler: JitoFairBundler;
  tips: JitoTipCache;
} {
  const tips = new JitoTipCache({ percentile: o.cfg.percentile, maxLamports: o.cfg.maxTipLamports, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  const sender = new JitoClient({ url: o.cfg.url, uuid: o.cfg.uuid, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  return { bundler: new JitoFairBundler({ ...o, sender, tips }), tips };
}

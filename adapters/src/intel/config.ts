import { PUBLIC_RPC_URL } from "../env";

/**
 * Read-side providers of the intel indexer (decision 12.10, docs/STACK.md):
 * - reads + WebSocket: SOLANA_READ_RPC_URL_{DEVNET,MAINNET} (Shyft), WS from
 *   SOLANA_READ_WS_URL_* or derived https -> wss of the read URL;
 * - index calls (getTokenLargestAccounts): SOLANA_INDEX_RPC_URL_* — Shyft Free
 *   refuses them (403 IndexNotAllowedOnFreePlan, checked 12.10). Devnet falls
 *   back to SOLANA_RPC_URL_DEVNET; mainnet has NO fallback (the send provider
 *   must not see our reads, R1): holders are skipped until one is chosen.
 * Never falls back from the read URL to the Helius send URL.
 */
export interface IntelConfig {
  cluster: "devnet" | "mainnet-beta";
  readUrl: string;
  readSource: string;
  readWsUrl: string | null;
  indexUrl: string | null;
  indexSource: string | null;
  rps: number;
  ipfsGateway: string;
  full: boolean;
  /** Curve updates: poll (default; Shyft Free WS refused from our host 12.10) | ws | off. INTEL_CURVE_MODE. */
  curveMode: "poll" | "ws" | "off";
  /** UNZEEN_INTEL_FULL_TRADES=1: market_trades feed of hot warm mints (Helius Parsed Streams). */
  fullTrades: boolean;
  /** Parsed Streams URL (INTEL_TRADES_STREAM_URL, else mainnet wss://beta.helius-rpc.com/?api-key=<key of SOLANA_RPC_URL_MAINNET>). Never logged. */
  streamUrl: string | null;
  /** Budget guards, notifications per hour (1 credit each): trade feed / LaunchLab creates of the dev index. */
  tradesMaxPerHour: number;
  createsMaxPerHour: number;
  /**
   * Trade backfill (docs/INTEL.md "Бэкфилл сделок"): on with the full feed and an index provider,
   * INTEL_TRADE_BACKFILL=0 turns it off. Body credits per main tick (INTEL_TRADE_BACKFILL_MAX_TX),
   * discovery picks per tick (INTEL_TRADE_BACKFILL_DISCOVERY), index rps (INTEL_TRADE_BACKFILL_RPS).
   */
  backfill: { enabled: boolean; maxTxCredits: number; discoveryPerTick: number; rps: number };
  /** UNZEEN_WHALE_LAMPORTS (default 1 SOL, the threshold core uses for pool trades). */
  whaleLamports: bigint;
  /** INTEL_SNIPER_SLOTS: buys within create slot .. + N (default 4). */
  sniperSlots: number;
  warnings: string[];
}

export function loadIntelConfig(env: NodeJS.ProcessEnv = process.env): IntelConfig {
  const raw = env.SOLANA_CLUSTER?.trim() || env.UNZEEN_SOLANA_CLUSTER?.trim() || "devnet";
  if (raw !== "devnet" && raw !== "mainnet-beta") throw new Error(`intel runs on devnet or mainnet-beta, not ${raw}`);
  const cluster = raw;
  const sfx = cluster === "devnet" ? "DEVNET" : "MAINNET";
  const warnings: string[] = [];
  let readUrl = env[`SOLANA_READ_RPC_URL_${sfx}`]?.trim() || "";
  let readSource = `SOLANA_READ_RPC_URL_${sfx}`;
  if (!readUrl) {
    readUrl = PUBLIC_RPC_URL[cluster];
    readSource = "public";
    warnings.push(`SOLANA_READ_RPC_URL_${sfx} not set: reads go to the public RPC`);
  }
  const wsExplicit = env[`SOLANA_READ_WS_URL_${sfx}`]?.trim();
  const readWsUrl = wsExplicit || deriveWs(readUrl);
  let indexUrl = env[`SOLANA_INDEX_RPC_URL_${sfx}`]?.trim() || null;
  let indexSource: string | null = indexUrl ? `SOLANA_INDEX_RPC_URL_${sfx}` : null;
  if (!indexUrl && cluster === "devnet" && env.SOLANA_RPC_URL_DEVNET?.trim()) {
    indexUrl = env.SOLANA_RPC_URL_DEVNET.trim();
    indexSource = "SOLANA_RPC_URL_DEVNET";
    warnings.push("devnet: getTokenLargestAccounts via SOLANA_RPC_URL_DEVNET (send provider); not allowed on mainnet");
  }
  if (!indexUrl) warnings.push(`SOLANA_INDEX_RPC_URL_${sfx} not set: top-10 / dev share are not computed`);
  const rps = Number(env.INTEL_READ_RPS?.trim() || 5); // INTEL.md: no more than ~5 rps
  return {
    cluster,
    readUrl,
    readSource,
    readWsUrl,
    indexUrl,
    indexSource,
    rps: Number.isFinite(rps) && rps > 0 ? Math.min(rps, 10) : 5,
    // ipfs.io / dweb.link rate-limit our VPS (429, 24.10); Filebase answered every probe in < 60 ms.
    ipfsGateway: env.INTEL_IPFS_GATEWAY?.trim() || "https://ipfs.filebase.io/ipfs",
    full: env.INTEL_FULL?.trim() === "1",
    curveMode: curveMode(env.INTEL_CURVE_MODE),
    fullTrades: env.UNZEEN_INTEL_FULL_TRADES?.trim() === "1",
    streamUrl: streamUrl(cluster, env),
    tradesMaxPerHour: posInt(env.INTEL_TRADES_MAX_PER_H, 600),
    createsMaxPerHour: posInt(env.INTEL_CREATES_MAX_PER_H, 300),
    backfill: {
      enabled: env.UNZEEN_INTEL_FULL_TRADES?.trim() === "1" && indexUrl !== null && env.INTEL_TRADE_BACKFILL?.trim() !== "0",
      maxTxCredits: posInt(env.INTEL_TRADE_BACKFILL_MAX_TX, 24),
      discoveryPerTick: nonNegInt(env.INTEL_TRADE_BACKFILL_DISCOVERY, 8),
      rps: Math.min(posInt(env.INTEL_TRADE_BACKFILL_RPS, 5), 20),
    },
    whaleLamports: BigInt(posInt(env.UNZEEN_WHALE_LAMPORTS, 1_000_000_000)),
    sniperSlots: posInt(env.INTEL_SNIPER_SLOTS, 4),
    warnings,
  };
}

function deriveWs(httpUrl: string): string | null {
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    return u.toString();
  } catch {
    return null;
  }
}

function curveMode(v: string | undefined): IntelConfig["curveMode"] {
  const m = v?.trim() || "poll";
  if (m !== "poll" && m !== "ws" && m !== "off") throw new Error(`INTEL_CURVE_MODE must be poll|ws|off, got "${m}"`);
  return m;
}

function posInt(v: string | undefined, d: number): number {
  const n = Number(v?.trim() || d);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`expected a positive integer, got "${v}"`);
  return n;
}

function nonNegInt(v: string | undefined, d: number): number {
  const n = Number(v?.trim() || d);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got "${v}"`);
  return n;
}

/** Helius Parsed Streams (mainnet only; the devnet endpoint is not documented). */
function streamUrl(cluster: "devnet" | "mainnet-beta", env: NodeJS.ProcessEnv): string | null {
  const explicit = env.INTEL_TRADES_STREAM_URL?.trim();
  if (explicit) return explicit;
  if (cluster !== "mainnet-beta") return null;
  try {
    const key = new URL(env.SOLANA_RPC_URL_MAINNET?.trim() || "").searchParams.get("api-key");
    return key ? `wss://beta.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : null;
  } catch {
    return null;
  }
}

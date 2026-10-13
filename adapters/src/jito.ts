import { randomInt } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { SendGate, type SenderTip } from "./tx";

/**
 * Jito block engine: ONLY for fair-launch bundles (owner decision 13.10: Now
 * mode has no Jito; docs/analysis/now-mode.md N-11, fair-launch.md §3 v2).
 * Mainnet only: Jito has no devnet (testnet only), so on devnet the path is off.
 *
 * Docs checked 2026-10-13 (https://docs.jito.wtf/lowlatencytxnsend/):
 * - POST {base}/api/v1/bundles  `sendBundle` [[base64...], {encoding:"base64"}], <= 5 txs,
 *   sequential + atomic, all in one slot; result = bundle id.
 * - POST {base}/api/v1/getInflightBundleStatuses  (last 5 min): Invalid | Pending | Failed | Landed.
 * - POST {base}/api/v1/getTipAccounts: 8 accounts (unchanged since launch; live read 13.10 below).
 * - GET  https://bundles.jito.wtf/api/v1/bundles/tip_floor: landed tip percentiles in SOL.
 * - Without a key: 1 request / s / IP / region. Optional UUID -> `x-jito-auth` header.
 * - Minimum tip 1000 lamports; tip accounts must NOT come through a lookup table.
 * - Uncled blocks: legs of a bundle can be rebroadcast and land one by one,
 *   without atomicity. Every leg therefore carries its own tip and its own
 *   `min_tokens_out` (src/fair-bundle.ts), so an unbundled leg either fills
 *   at a fair price or fails.
 *
 * Privacy (now-mode.md N-11): the block engine sees our server IP, the optional
 * UUID and the full signed txs a few hundred ms before they are public. Never a
 * user IP, anon key or deposit. Fair-launch txs are public by design (the round
 * time is the public drand round), so this adds no user link.
 */

/** Mainnet tip accounts, `getTipAccounts` read live 2026-10-13 (same 8 as the docs). */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export const JITO_MAINNET_URL = "https://mainnet.block-engine.jito.wtf";
export const JITO_TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
export const JITO_MAX_BUNDLE_TXS = 5;
export const JITO_MIN_TIP_LAMPORTS = 1_000n;

/**
 * Tip ladder, lamports PER LEG. A tip is always one of these values (never a
 * raw percentile), so it cannot carry a per-launch fingerprint (N-5).
 */
export const JITO_TIP_LEVELS: readonly bigint[] = [
  1_000n, 2_000n, 5_000n, 10_000n, 20_000n, 50_000n, 100_000n, 200_000n, 500_000n, 1_000_000n,
];
/** Default clamp per leg: 0.0001 SOL (x5 legs = 0.0005 SOL per bundle). */
export const JITO_DEFAULT_MAX_TIP = 100_000n;

/** Smallest level >= raw (a floor to land), at least 1000, never above `max`. */
export function quantizeTip(raw: bigint | null, max: bigint = JITO_DEFAULT_MAX_TIP, levels: readonly bigint[] = JITO_TIP_LEVELS): bigint {
  const allowed = levels.filter((l) => l <= max && l >= JITO_MIN_TIP_LAMPORTS);
  if (allowed.length === 0) throw new RangeError("no Jito tip level <= max");
  if (raw === null || raw <= allowed[0]!) return allowed[0]!;
  return allowed.find((l) => l >= raw) ?? allowed[allowed.length - 1]!;
}

export type TipPercentile = "25" | "50" | "75" | "95" | "99" | "ema50";

/** tip_floor JSON -> lamports (ceil) of the chosen percentile; null when malformed. */
export function parseTipFloor(body: unknown, percentile: TipPercentile): bigint | null {
  const row = Array.isArray(body) ? body[0] : null;
  if (!row || typeof row !== "object") return null;
  const key = percentile === "ema50" ? "ema_landed_tips_50th_percentile" : `landed_tips_${percentile}th_percentile`;
  const sol = (row as Record<string, unknown>)[key];
  if (typeof sol !== "number" || !Number.isFinite(sol) || sol < 0 || sol > 10) return null;
  // SOL float -> lamports; round to 1e-3 lamport first so 1.0000000000000002e-6 is 1000, not 1001.
  const lamports = Math.ceil(Math.round(sol * 1e12) / 1e3);
  return BigInt(lamports);
}

export interface JitoTipCacheOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  /** Percentile of landed tips to follow (default 75th: a launch should land in its slot). */
  percentile?: TipPercentile;
  /** Clamp per leg (JITO_MAX_TIP_LAMPORTS). */
  maxLamports?: bigint;
  /** No fresh floor for this long -> `current()` is null (bundle path off, fallback). */
  staleMs?: number;
  refreshMinMs?: number;
  refreshMaxMs?: number;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Background cache of the tip floor (like the priority fee cache, src/fees.ts):
 * refreshed every 30–60 s independent of launches, so a fetch right before a
 * launch does not label it. Reading never touches the network.
 */
export class JitoTipCache {
  private raw: bigint | null = null;
  private at = 0;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private readonly o: Required<Omit<JitoTipCacheOptions, "fetchImpl">> & { fetchImpl: typeof fetch };

  constructor(opts: JitoTipCacheOptions = {}) {
    this.o = {
      fetchImpl: opts.fetchImpl ?? fetch,
      url: opts.url ?? JITO_TIP_FLOOR_URL,
      percentile: opts.percentile ?? "75",
      maxLamports: opts.maxLamports ?? JITO_DEFAULT_MAX_TIP,
      staleMs: opts.staleMs ?? 5 * 60_000,
      refreshMinMs: opts.refreshMinMs ?? 30_000,
      refreshMaxMs: opts.refreshMaxMs ?? 60_000,
      now: opts.now ?? Date.now,
      timeoutMs: opts.timeoutMs ?? 10_000,
    };
    quantizeTip(null, this.o.maxLamports); // validates the clamp
  }

  /** Quantized tip per leg, or null (never fetched / stale): then no bundle is sent. */
  current(): bigint | null {
    if (this.raw === null || this.o.now() - this.at > this.o.staleMs) return null;
    return quantizeTip(this.raw, this.o.maxLamports);
  }

  /** One refresh. Never throws. */
  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const res = await this.o.fetchImpl(this.o.url, { signal: AbortSignal.timeout(this.o.timeoutMs) });
        if (!res.ok) return;
        const v = parseTipFloor(await res.json(), this.o.percentile);
        if (v !== null) {
          this.raw = v;
          this.at = this.o.now();
        }
      } catch {
        /* keep the last value until it goes stale */
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  start(): void {
    if (this.timer) return;
    const loop = () => {
      const { refreshMinMs: a, refreshMaxMs: b } = this.o;
      this.timer = setTimeout(() => void this.refresh().finally(loop), a === b ? a : randomInt(a, b + 1));
      this.timer.unref?.();
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The tip policy of bundle legs: same shape as the pool's Sender tip (src/tx.ts poolPrefix). */
export function jitoTip(lamports: bigint, accounts: readonly string[] = JITO_TIP_ACCOUNTS, pick: (n: number) => number = (n) => randomInt(n)): SenderTip {
  if (lamports < JITO_MIN_TIP_LAMPORTS) throw new RangeError(`Jito tip must be >= ${JITO_MIN_TIP_LAMPORTS} lamports`);
  if (accounts.length === 0) throw new RangeError("no Jito tip accounts");
  return { lamports, accounts: accounts.map((a) => new PublicKey(a)), pick };
}

export type BundleState = "landed" | "pending" | "failed" | "invalid" | "unknown";

/** What the relayer needs from a bundle relay (JitoClient; fakes in tests). */
export interface BundleSender {
  readonly name: string;
  /** Sends up to 5 signed txs as one atomic bundle; returns the bundle id. Throws on HTTP / RPC error. */
  sendBundle(raws: readonly Uint8Array[]): Promise<string>;
  /** Best-effort status (in-flight view, last 5 min). Never authoritative for "can it still land". */
  status(bundleId: string): Promise<BundleState>;
}

export interface JitoClientOptions {
  /** Block engine base URL (JITO_BLOCK_ENGINE_URL), default mainnet global. */
  url?: string;
  /** Optional UUID (JITO_UUID) -> `x-jito-auth`. Never logged. */
  uuid?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Rate gate: keyless limit is 1 request / s / IP / region. */
  gate?: SendGate;
}

export class JitoClient implements BundleSender {
  readonly name = "jito";
  private readonly url: string;
  private readonly uuid: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly gate: SendGate;

  constructor(o: JitoClientOptions = {}) {
    this.url = (o.url?.trim() || JITO_MAINNET_URL).replace(/\/+$/, "");
    this.uuid = o.uuid?.trim() || null;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.gate = o.gate ?? new SendGate(1_100);
  }

  async sendBundle(raws: readonly Uint8Array[]): Promise<string> {
    if (raws.length === 0 || raws.length > JITO_MAX_BUNDLE_TXS) throw new RangeError(`bundle must have 1..${JITO_MAX_BUNDLE_TXS} txs`);
    const id = await this.rpc<string>("/api/v1/bundles", "sendBundle", [raws.map((r) => Buffer.from(r).toString("base64")), { encoding: "base64" }]);
    if (typeof id !== "string" || id.length === 0) throw new Error("jito sendBundle: no bundle id");
    return id;
  }

  async status(bundleId: string): Promise<BundleState> {
    const r = await this.rpc<{ value?: Array<{ bundle_id?: string; status?: string } | null> }>(
      "/api/v1/getInflightBundleStatuses",
      "getInflightBundleStatuses",
      [[bundleId]],
    );
    const s = r?.value?.find((v) => v?.bundle_id === bundleId)?.status;
    switch (s) {
      case "Landed":
        return "landed";
      case "Pending":
        return "pending";
      case "Failed":
        return "failed";
      case "Invalid":
        return "invalid";
      default:
        return "unknown";
    }
  }

  async tipAccounts(): Promise<string[]> {
    const r = await this.rpc<unknown>("/api/v1/getTipAccounts", "getTipAccounts", []);
    if (!Array.isArray(r) || r.length === 0 || !r.every((a) => typeof a === "string")) throw new Error("jito getTipAccounts: bad result");
    for (const a of r) new PublicKey(a); // throws on garbage
    return r as string[];
  }

  /** Exact JSON-RPC body (exported via `jitoRequest` for tests). */
  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.uuid) headers["x-jito-auth"] = this.uuid;
    return this.gate.run(async () => {
      const res = await this.fetchImpl(this.url + path, {
        method: "POST",
        headers,
        body: JSON.stringify(jitoRequest(method, params)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Status and JSON error only: never the URL / UUID / tx bytes.
      if (!res.ok) throw new Error(`jito HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
      if (j.error) throw new Error(`jito error ${j.error.code ?? ""}: ${(j.error.message ?? "").slice(0, 200)}`);
      return j.result as T;
    });
  }
}

export function jitoRequest(method: string, params: unknown[]): unknown {
  return { jsonrpc: "2.0", id: 1, method, params };
}

/** Jito config from env. Mainnet only: anything else -> null (path off). */
export interface JitoConfig {
  url: string;
  uuid: string | null;
  percentile: TipPercentile;
  maxTipLamports: bigint;
  /** Max legs per bundle (<= 5). */
  maxLegs: number;
  /** Optional cap of one leg (and of the create leg), lamports: forces a split above it. */
  maxPerVaultLamports: bigint | null;
  /** Bundle sends per job before the capped single-tx fallback. */
  bundleTries: number;
}

export function jitoConfigFromEnv(cluster: string, env: NodeJS.ProcessEnv = process.env): JitoConfig | null {
  if (cluster !== "mainnet-beta") return null;
  if (env.FAIR_JITO?.trim() === "0") return null;
  const pct = (env.JITO_TIP_PERCENTILE?.trim() || "75") as TipPercentile;
  if (!["25", "50", "75", "95", "99", "ema50"].includes(pct)) throw new Error("JITO_TIP_PERCENTILE must be 25|50|75|95|99|ema50");
  const maxTip = BigInt(env.JITO_MAX_TIP_LAMPORTS?.trim() || JITO_DEFAULT_MAX_TIP);
  if (maxTip < JITO_MIN_TIP_LAMPORTS) throw new Error(`JITO_MAX_TIP_LAMPORTS must be >= ${JITO_MIN_TIP_LAMPORTS}`);
  const maxLegs = Number(env.FAIR_BUNDLE_MAX_LEGS?.trim() || JITO_MAX_BUNDLE_TXS);
  if (!Number.isInteger(maxLegs) || maxLegs < 2 || maxLegs > JITO_MAX_BUNDLE_TXS) throw new Error("FAIR_BUNDLE_MAX_LEGS must be 2..5");
  const perVault = env.FAIR_MAX_PER_VAULT_LAMPORTS?.trim();
  const tries = Number(env.FAIR_BUNDLE_TRIES?.trim() || 2);
  if (!Number.isInteger(tries) || tries < 1 || tries > 5) throw new Error("FAIR_BUNDLE_TRIES must be 1..5");
  return {
    url: env.JITO_BLOCK_ENGINE_URL?.trim() || JITO_MAINNET_URL,
    uuid: env.JITO_UUID?.trim() || null,
    percentile: pct,
    maxTipLamports: maxTip,
    maxLegs,
    maxPerVaultLamports: perVault ? BigInt(perVault) : null,
    bundleTries: tries,
  };
}

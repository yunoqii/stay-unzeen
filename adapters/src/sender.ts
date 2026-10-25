import { randomInt } from "node:crypto";
import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { RpcBroadcaster, SendGate, type Broadcaster, type SenderTip } from "./tx";

/**
 * Helius Sender for mainnet pool transactions (docs/STACK.md, decision 12.10;
 * docs/analysis/rpc-providers.md R4/P4/P6).
 *
 * - SWQOS-only tier (`?swqos_only=true`): minimum tip 0.000005 SOL, 0 credits.
 * - The tip is part of the pool-wide tx prefix (src/tx.ts `poolPrefix`): the
 *   SAME amount on EVERY mainnet pool tx (buy, sell, create, withdraw, lookup
 *   tables), in every execution mode, so the tip never tells modes apart.
 * - Sender does not simulate. To keep the "preflight" stage (nothing is
 *   forwarded when the program would reject it) we simulate on the send-side
 *   RPC (Helius, `SOLANA_RPC_URL_MAINNET`): the same provider that is about to
 *   receive the tx anyway, never the read provider (Shyft must not see what
 *   we buy).
 * - One send per `SOLANA_SEND_MIN_INTERVAL_MS` (default 1000: Helius Free /
 *   keyless Sender 1 tx/s); rebroadcasts are dropped while the gate is busy.
 * - Devnet: Sender is mainnet-only (its docs list mainnet tip accounts and do
 *   not mention devnet), so devnet uses plain `sendTransaction` on
 *   `SOLANA_RPC_URL_DEVNET`, same gate, no tip.
 */

/** Sender tip accounts (mainnet-beta), docs checked 2026-10-12. */
export const SENDER_TIP_ACCOUNTS: readonly string[] = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

/** SWQOS-only minimum, 0.000005 SOL. */
export const SWQOS_MIN_TIP_LAMPORTS = 5_000n;

export const DEFAULT_SENDER_URL = "https://sender.helius-rpc.com/fast?swqos_only=true";

export function senderTip(lamports: bigint = SWQOS_MIN_TIP_LAMPORTS, pick: (n: number) => number = (n) => randomInt(n)): SenderTip {
  if (lamports < SWQOS_MIN_TIP_LAMPORTS) throw new RangeError(`sender tip must be >= ${SWQOS_MIN_TIP_LAMPORTS} lamports`);
  return { lamports, accounts: SENDER_TIP_ACCOUNTS.map((a) => new PublicKey(a)), pick };
}

/**
 * Sender URL with the Helius api key: SOLANA_SENDER_URL as is, else the
 * default SWQOS-only endpoint plus the `api-key` of `heliusRpcUrl` if any
 * (50 tx/s instead of 1 keyless; the gate still enforces our own interval).
 */
export function senderUrl(explicit: string | undefined, heliusRpcUrl: string | undefined): string {
  const v = explicit?.trim();
  if (v) return v;
  const u = new URL(DEFAULT_SENDER_URL);
  try {
    const key = heliusRpcUrl ? new URL(heliusRpcUrl).searchParams.get("api-key") : null;
    if (key) u.searchParams.set("api-key", key);
  } catch {
    /* no key */
  }
  return u.toString();
}

export class HeliusSenderBroadcaster implements Broadcaster {
  readonly name = "helius-sender";
  constructor(
    private readonly url: string,
    private readonly gate: SendGate,
    /** Send-side RPC for preflight simulation (never the read provider). */
    private readonly simulator: Pick<Connection, "simulateTransaction"> | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(raw: Uint8Array, o: { preflight: boolean }): Promise<void> {
    if (o.preflight && this.simulator) {
      const sim = await this.simulator.simulateTransaction(VersionedTransaction.deserialize(raw), {
        sigVerify: false,
        commitment: "confirmed",
      });
      if (sim.value.err) {
        const e = new Error(`Transaction simulation failed: ${JSON.stringify(sim.value.err)}`) as Error & { logs?: string[] };
        if (sim.value.logs) e.logs = sim.value.logs;
        throw e;
      }
    }
    await this.gate.run(() => this.post(raw));
  }

  async trySend(raw: Uint8Array): Promise<void> {
    await this.gate.tryRun(() => this.post(raw).catch(() => undefined));
  }

  /** Exact JSON-RPC body (exported via `senderRequest` for tests). */
  private async post(raw: Uint8Array): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(senderRequest(raw)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Status and JSON error only: the URL (api key) never goes into the message.
    // Sender answers a refused tx with HTTP 500 + a JSON-RPC error: read it either way.
    type RpcErr = { code?: number; message?: string };
    const j = (await res.json().catch(() => null)) as ({ error?: RpcErr } & RpcErr) | null;
    // JSON-RPC envelope, or (seen 25.10 with HTTP 500) a bare `{code, message}` object.
    const err: RpcErr | undefined = j?.error ?? (typeof j?.code === "number" ? j : undefined);
    if (err && isSenderRefusal(err.code)) {
      // Refused before forwarding (e.g. no static tip): these bytes can never land, so it is a
      // preflight-stage rejection (no waiting for the blockhash to expire).
      throw new Error(`sender preflight rejected ${err.code}: ${(err.message ?? "").slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(`sender HTTP ${res.status}`);
    if (!j) throw new Error("sender: malformed response");
    if (err) throw new Error(`sender error ${err.code ?? ""}: ${(err.message ?? "").slice(0, 200)}`);
  }
}

/** JSON-RPC "Invalid Request" / "Invalid params": the tx was refused, not forwarded. */
export function isSenderRefusal(code: number | undefined): boolean {
  return code === -32600 || code === -32602;
}

export function senderRequest(raw: Uint8Array): unknown {
  return {
    jsonrpc: "2.0",
    id: "unzeen",
    method: "sendTransaction",
    params: [Buffer.from(raw).toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
  };
}

/** How the pool sends: tip policy (or none) + broadcaster. Built once per process. */
export interface TxPipeline {
  tip: SenderTip | null;
  broadcaster: Broadcaster;
}

export function txPipeline(
  cfg: { cluster: string; senderUrl: string | null; senderTipLamports: bigint; sendMinIntervalMs: number },
  connection: Connection,
): TxPipeline {
  const gate = new SendGate(cfg.sendMinIntervalMs);
  if (cfg.cluster === "mainnet-beta" && cfg.senderUrl) {
    return {
      tip: senderTip(cfg.senderTipLamports),
      broadcaster: new HeliusSenderBroadcaster(cfg.senderUrl, gate, connection),
    };
  }
  return { tip: null, broadcaster: new RpcBroadcaster(connection, gate) };
}

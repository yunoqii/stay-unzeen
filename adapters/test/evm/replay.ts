import { createPublicClient, custom, http, type PublicClient, type Transport } from "viem";
import { hoodMainnet } from "../../src/evm/chain";

/** JSON-RPC request -> stable fixture key. */
export function rpcKey(method: string, params: unknown): string {
  return JSON.stringify([method, params ?? []], (_k, v) => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v));
}

export type RpcFixture = Record<string, unknown>;

/** Transport that answers only from a recorded fixture (no network). Unknown request = test failure. */
export function replayTransport(fx: RpcFixture): Transport {
  return custom({
    async request({ method, params }) {
      const k = rpcKey(method, params);
      if (!(k in fx)) throw new Error(`replay: no fixture for ${k.slice(0, 200)}`);
      const v = fx[k] as { error?: { code: number; message: string; data?: string } } | unknown;
      if (v && typeof v === "object" && "error" in (v as object) && (v as { error?: unknown }).error) {
        const e = (v as { error: { code: number; message: string; data?: string } }).error;
        throw Object.assign(new Error(e.message), { code: e.code, data: e.data });
      }
      return v;
    },
  });
}

/** Transport that forwards to `url` and records every answer into `fx` (read-only methods only). */
export function recordingTransport(url: string, fx: RpcFixture): Transport {
  const inner = http(url, { batch: false, retryCount: 3, retryDelay: 500 });
  return (params) => {
    const t = inner(params);
    return {
      ...t,
      request: (async (args: { method: string; params?: unknown }) => {
        if (/^eth_send/.test(args.method)) throw new Error("recordingTransport is read-only");
        // Pin the head: every later "latest block number" is the first one (replay stays consistent).
        const k = rpcKey(args.method, args.params);
        if (args.method === "eth_blockNumber" && k in fx) return fx[k];
        const res = await (t.request as (a: unknown) => Promise<unknown>)(args);
        fx[k] = res;
        return res;
      }) as typeof t.request,
    };
  };
}

export function replayClient(fx: RpcFixture): PublicClient {
  return createPublicClient({ chain: hoodMainnet, transport: replayTransport(fx) }) as PublicClient;
}

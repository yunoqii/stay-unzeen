import { describe, expect, it } from "vitest";
import {
  JITO_TIP_ACCOUNTS,
  JitoClient,
  JitoTipCache,
  jitoConfigFromEnv,
  jitoTip,
  parseTipFloor,
  quantizeTip,
} from "../src/jito";
import { poolPrefix, SendGate } from "../src/tx";
import { Keypair, SystemInstruction, SystemProgram } from "@solana/web3.js";

/** Live tip_floor body read 2026-10-13 (read-only GET). */
const FLOOR = [
  {
    time: "2026-10-13T07:37:28+00:00",
    landed_tips_25th_percentile: 1.0000000000000002e-6,
    landed_tips_50th_percentile: 1.0000000000000002e-6,
    landed_tips_75th_percentile: 3.0315e-6,
    landed_tips_95th_percentile: 0.00001111639999999999,
    landed_tips_99th_percentile: 0.000020049960000000017,
    ema_landed_tips_50th_percentile: 1.7879438400553249e-6,
  },
];

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe("tip floor and quantization", () => {
  it("parses SOL floats to lamports without float noise", () => {
    expect(parseTipFloor(FLOOR, "25")).toBe(1_000n);
    expect(parseTipFloor(FLOOR, "75")).toBe(3_032n);
    expect(parseTipFloor(FLOOR, "95")).toBe(11_117n);
    expect(parseTipFloor(FLOOR, "ema50")).toBe(1_788n);
    expect(parseTipFloor([], "75")).toBeNull();
    expect(parseTipFloor([{ landed_tips_75th_percentile: "x" }], "75")).toBeNull();
    expect(parseTipFloor([{ landed_tips_75th_percentile: 50 }], "75")).toBeNull(); // > 10 SOL: garbage
  });

  it("quantizes up to a fixed ladder, min 1000, clamped", () => {
    expect(quantizeTip(null)).toBe(1_000n);
    expect(quantizeTip(1n)).toBe(1_000n);
    expect(quantizeTip(3_032n)).toBe(5_000n);
    expect(quantizeTip(11_117n)).toBe(20_000n);
    expect(quantizeTip(10n ** 9n)).toBe(100_000n); // default clamp
    expect(quantizeTip(10n ** 9n, 1_000_000n)).toBe(1_000_000n);
    expect(() => quantizeTip(1n, 999n)).toThrow();
  });

  it("cache: null until fetched, quantized value, null again when stale; never throws", async () => {
    let now = 0;
    let fail = false;
    const { f, calls } = fakeFetch(() => (fail ? { status: 503, body: {} } : { body: FLOOR }));
    const c = new JitoTipCache({ fetchImpl: f, now: () => now, staleMs: 60_000 });
    expect(c.current()).toBeNull();
    await c.refresh();
    expect(calls[0]!.url).toBe("https://bundles.jito.wtf/api/v1/bundles/tip_floor");
    expect(c.current()).toBe(5_000n);
    fail = true;
    now = 30_000;
    await c.refresh(); // keeps the last value
    expect(c.current()).toBe(5_000n);
    now = 61_000;
    expect(c.current()).toBeNull();
  });
});

describe("JitoClient (mocked block engine)", () => {
  it("sendBundle: exact JSON-RPC body, base64, bundle id; UUID only as header", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { jsonrpc: "2.0", id: 1, result: "bundle-id-1" } }));
    const c = new JitoClient({ fetchImpl: f, uuid: "secret-uuid", gate: new SendGate(0) });
    const id = await c.sendBundle([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect(id).toBe("bundle-id-1");
    expect(calls[0]!.url).toBe("https://mainnet.block-engine.jito.wtf/api/v1/bundles");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [["AQI=", "Aw=="], { encoding: "base64" }],
    });
    expect((calls[0]!.init!.headers as Record<string, string>)["x-jito-auth"]).toBe("secret-uuid");
    expect(calls[0]!.url).not.toContain("secret-uuid");
  });

  it("rejects 0 or > 5 txs before any request", async () => {
    const { f, calls } = fakeFetch(() => ({ body: {} }));
    const c = new JitoClient({ fetchImpl: f, gate: new SendGate(0) });
    await expect(c.sendBundle([])).rejects.toThrow();
    await expect(c.sendBundle(Array.from({ length: 6 }, () => new Uint8Array([1])))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("errors carry status / RPC message only, never the URL or UUID", async () => {
    const { f } = fakeFetch((url) => (url.endsWith("/bundles") ? { status: 429, body: {} } : { body: { error: { code: -32602, message: "bad" } } }));
    const c = new JitoClient({ fetchImpl: f, url: "https://ny.mainnet.block-engine.jito.wtf/", uuid: "u-123", gate: new SendGate(0) });
    const e1 = await c.sendBundle([new Uint8Array([1])]).catch((e: Error) => e);
    expect(String(e1)).toContain("429");
    expect(String(e1)).not.toMatch(/jito\.wtf|u-123/);
    const e2 = await c.status("x").catch((e: Error) => e);
    expect(String(e2)).toContain("-32602");
  });

  it("in-flight status mapping and tip accounts", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith("getTipAccounts")
        ? { body: { result: [...JITO_TIP_ACCOUNTS] } }
        : { body: { result: { context: { slot: 1 }, value: [{ bundle_id: "b", status: "Landed", landed_slot: 5 }] } } },
    );
    const c = new JitoClient({ fetchImpl: f, gate: new SendGate(0) });
    expect(await c.status("b")).toBe("landed");
    expect(await c.status("other")).toBe("unknown");
    expect(await c.tipAccounts()).toEqual([...JITO_TIP_ACCOUNTS]);
    expect(calls[0]!.url).toMatch(/\/api\/v1\/getInflightBundleStatuses$/);
  });

  it("rate gate: one request per interval (keyless 1 rps)", async () => {
    let t = 0;
    const slept: number[] = [];
    const gate = new SendGate(1_100, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    const { f } = fakeFetch(() => ({ body: { result: "id" } }));
    const c = new JitoClient({ fetchImpl: f, gate });
    await c.sendBundle([new Uint8Array([1])]);
    await c.sendBundle([new Uint8Array([1])]);
    expect(slept).toEqual([1_100]);
  });
});

describe("tip in the pool prefix (same shape as every pool tx)", () => {
  it("one transfer to a Jito tip account right after the compute budget", () => {
    const payer = Keypair.generate().publicKey;
    const ixs = poolPrefix({ computeUnits: 300_000, priorityMicroLamports: 1_000, tip: jitoTip(5_000n, JITO_TIP_ACCOUNTS, () => 3) }, payer);
    expect(ixs).toHaveLength(3);
    expect(ixs[2]!.programId.equals(SystemProgram.programId)).toBe(true);
    const t = SystemInstruction.decodeTransfer(ixs[2]!);
    expect(t.toPubkey.toBase58()).toBe(JITO_TIP_ACCOUNTS[3]);
    expect(t.lamports).toBe(5_000n);
    expect(() => jitoTip(999n)).toThrow();
  });
});

describe("config", () => {
  it("devnet / testnet: Jito off; mainnet: on unless FAIR_JITO=0; validates ranges", () => {
    expect(jitoConfigFromEnv("devnet", {})).toBeNull();
    expect(jitoConfigFromEnv("mainnet-beta", { FAIR_JITO: "0" })).toBeNull();
    const c = jitoConfigFromEnv("mainnet-beta", {})!;
    expect(c).toMatchObject({ uuid: null, percentile: "75", maxLegs: 5, maxPerVaultLamports: null, bundleTries: 2 });
    expect(jitoConfigFromEnv("mainnet-beta", { FAIR_MAX_PER_VAULT_LAMPORTS: "3000000000" })!.maxPerVaultLamports).toBe(3_000_000_000n);
    expect(() => jitoConfigFromEnv("mainnet-beta", { FAIR_BUNDLE_MAX_LEGS: "6" })).toThrow();
    expect(() => jitoConfigFromEnv("mainnet-beta", { JITO_MAX_TIP_LAMPORTS: "10" })).toThrow();
    expect(() => jitoConfigFromEnv("mainnet-beta", { JITO_TIP_PERCENTILE: "80" })).toThrow();
  });
});

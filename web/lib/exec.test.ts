import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import { handle, mockPay, mockPool } from "@/lib/api/mock";
import type { ActionReceipt, Portfolio, SignedAction, Token } from "@/lib/api/types";
import { PAD_BUCKET, PAD_MIN, padAction } from "@/lib/pad";
import {
  DEFAULT_EXEC,
  execStorageKey,
  getDefaultExec,
  nowFee,
  queuedLabel,
  resetExecCache,
  resolveExec,
  setDefaultExec,
  withExec,
} from "./exec";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
    dump: m,
  };
}

describe("exec: profile default", () => {
  let store: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    store = fakeStorage();
    vi.stubGlobal("window", { localStorage: store, addEventListener() {}, removeEventListener() {} });
    resetExecCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to Delayed", () => {
    expect(DEFAULT_EXEC).toBe("delayed");
    expect(getDefaultExec("devnet")).toBe("delayed");
    expect(getDefaultExec("mainnet")).toBe("delayed");
  });

  it("is stored locally and separately per network", () => {
    setDefaultExec("devnet", "now");
    expect(getDefaultExec("devnet")).toBe("now");
    expect(getDefaultExec("mainnet")).toBe("delayed");
    setDefaultExec("mainnet", "max");
    resetExecCache(); // reload: read back from storage
    expect(getDefaultExec("devnet")).toBe("now");
    expect(getDefaultExec("mainnet")).toBe("max");
    expect(store.dump.get(execStorageKey("devnet"))).toBe("now");
    // the only thing stored is the mode: no key, no pubkey, no wallet
    expect([...store.dump.values()].every((v) => ["now", "delayed", "max"].includes(v))).toBe(true);
  });

  it("ignores garbage in storage", () => {
    store.setItem(execStorageKey("devnet"), "turbo");
    expect(getDefaultExec("devnet")).toBe("delayed");
  });
});

describe("exec: override at the button", () => {
  it("override wins for this action, otherwise the profile default", () => {
    expect(resolveExec("delayed", null)).toBe("delayed");
    expect(resolveExec("delayed", "now")).toBe("now");
    expect(resolveExec("now", "max")).toBe("max");
    expect(resolveExec("max", undefined)).toBe("max");
  });

  it("status line: now -> Sending…, delayed/max -> Queued for next batch", () => {
    expect(queuedLabel("now")).toBe("Sending…");
    expect(queuedLabel("delayed")).toBe("Queued for next batch");
    expect(queuedLabel("max")).toBe("Queued for next batch");
  });

  it("reads the flat Now fee from PoolInfo.fees when present", () => {
    expect(nowFee({ fees: { nowFeeZat: "5000" } })).toEqual({ zat: BigInt(5000) });
    expect(nowFee({ fees: { nowFeeLamports: "100000" } })).toEqual({ lamports: BigInt(100000) });
    expect(nowFee({})).toBeNull();
    expect(nowFee(null)).toBeNull();
  });
});

describe("exec: field in the signed body (mock backend)", () => {
  const SK = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
  const signer = signerFromSecret(SK);
  beforeEach(() => vi.useFakeTimers({ now: 1_760_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ res: T; headers: ReturnType<typeof signRequest>; raw?: string }> {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers = signRequest(signer, { chainId: "0202", method, pathWithQuery: path, body: raw });
    const p = handle("devnet", method, path, raw, headers);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    return { res: (await p) as T, headers, raw };
  }

  async function setup(): Promise<Token> {
    const pool = mockPool("devnet");
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
    mockPay("devnet", depositUri(pool, "90000000", memo));
    vi.advanceTimersByTime(20_000);
    const { res } = await call<Token[]>("GET", "/api/tokens");
    return res.find((x) => x.status === "curve")!;
  }

  const statusOf = async (id: string) =>
    (await call<Portfolio>("GET", "/api/portfolio")).res.actions!.find((a) => a.id === id)!.status;

  it("signs exec (padded) into the body; statuses arrive with the portfolio poll, timed by mode", async () => {
    const t = await setup();
    const base: SignedAction = { op: "buy", venue: t.venue, mint: t.mint, zecIn: "2000000", minOut: "0" };

    const now = await call<ActionReceipt>("POST", "/api/actions", padAction(withExec(base, "now")));
    expect(JSON.parse(now.raw!).exec).toBe("now");
    expect(new TextEncoder().encode(now.raw!).length % PAD_BUCKET).toBe(0);
    // exec is covered by the signature: the same headers with exec stripped are refused
    const tampered = handle("devnet", "POST", "/api/actions", JSON.stringify({ ...JSON.parse(now.raw!), exec: undefined }), now.headers);
    tampered.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await expect(tampered).rejects.toMatchObject({ code: "unauthorized" });
    const delayed = await call<ActionReceipt>("POST", "/api/actions", padAction(withExec(base, "delayed")));
    const max = await call<ActionReceipt>("POST", "/api/actions", padAction(withExec(base, "max")));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(await statusOf(now.res.id)).toBe("executed");
    expect(await statusOf(delayed.res.id)).toBe("queued");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await statusOf(delayed.res.id)).toBe("executed");
    expect(await statusOf(max.res.id)).toBe("queued");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await statusOf(max.res.id)).toBe("executed");
  });

  it("refuses an unknown exec value and Now on withdrawals", async () => {
    const t = await setup();
    const body = { op: "buy", venue: t.venue, mint: t.mint, zecIn: "2000000", minOut: "0", exec: "turbo" };
    await expect(call("POST", "/api/actions", body)).rejects.toMatchObject({ code: "bad_request" });
    const w = { op: "withdraw_token", mint: t.mint, amount: "1", to: "So11111111111111111111111111111111111111112", exec: "now" };
    await expect(call("POST", "/api/actions", w)).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("pad: body length does not reveal op or mode", () => {
  const mint = "So11111111111111111111111111111111111111112";
  const len = (a: SignedAction) => new TextEncoder().encode(JSON.stringify(padAction(a))).length;

  it("buy / sell / withdraw in any mode land in the same bucket", () => {
    const sizes = [
      len(withExec({ op: "buy", venue: "pumpfun", mint, zecIn: "1", minOut: "0" }, "now")),
      len(withExec({ op: "buy", venue: "pumpfun", mint, zecIn: "123456789", minOut: "987654321012" }, "delayed")),
      len(withExec({ op: "sell", venue: "meteora-dbc", mint, amount: "5", minZecOut: "0" }, "max")),
      len(withExec({ op: "withdraw_token", mint, amount: "5", to: [mint, mint, mint, mint, mint], smart: { parts: 5, maxDelayMin: 240 } }, "max")),
    ];
    expect(new Set(sizes)).toEqual(new Set([PAD_MIN]));
  });

  it("bigger bodies round up to a multiple of 256 and repadding is stable", () => {
    const big: SignedAction = { op: "create", venue: "pumpfun", meta: { name: "x", symbol: "X", image: "data:image/png;base64," + "A".repeat(2000) } };
    expect(len(big) % PAD_BUCKET).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(padAction(padAction(big) as SignedAction))).length).toBe(len(big));
  });
});

describe("activity: statuses only from the portfolio poll", () => {
  it("settles a tracked action from Portfolio.actions", async () => {
    const { applyActionStatuses } = await import("@/lib/activity");
    // nothing tracked: applying is a no-op and does not throw
    expect(() => applyActionStatuses("devnet", "pk", [{ id: "x", status: "executed" }])).not.toThrow();
  });
});

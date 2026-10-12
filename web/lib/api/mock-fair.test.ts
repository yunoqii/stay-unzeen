import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import { verifyInclusion } from "@/lib/fair/merkle";
import { encodeBid } from "@/lib/fair/plaintext";
import { sealBid } from "@/lib/fair/tlock";
import type { ActionReceipt, FairLaunch, PoolInfo, Portfolio, SignedAction } from "./types";
import type { ApiError } from "./errors";

const SK = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
const signer = signerFromSecret(SK);
type Mock = typeof import("./mock");

async function load(flag: boolean): Promise<Mock & { hint: typeof import("./mock-fair").mockFairHint }> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_MOCK_FAIR_LAUNCH", flag ? "1" : "");
  const m = await import("./mock");
  const f = await import("./mock-fair");
  return { ...m, hint: f.mockFairHint };
}

function caller(m: Mock) {
  return async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers = signRequest(signer, { chainId: "0202", method, pathWithQuery: path, body: raw });
    const p = m.handle("devnet", method, path, raw, headers);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    return (await p) as T;
  };
}

async function fund(m: Mock, call: ReturnType<typeof caller>) {
  await call("GET", "/api/pool"); // loads the fair module when the flag is on
  const pool = m.mockPool("devnet");
  const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
  m.mockPay("devnet", depositUri(pool, "90000000", memo));
  await vi.advanceTimersByTimeAsync(20_000);
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    // Modules are re-imported per test (env flag), so match the shape, not the class.
    return e && typeof e === "object" && "code" in e ? (e as ApiError).code : String(e);
  }
};

beforeEach(() => vi.useFakeTimers({ now: 1_791_000_000_000 }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("mock fair-launch: flag off", () => {
  it("looks exactly like a server without the feature", async () => {
    const m = await load(false);
    const call = caller(m);
    await fund(m, call);
    const pool = await call<PoolInfo>("GET", "/api/pool");
    expect(pool.features).not.toHaveProperty("fairLaunch"); // v0.7: absent = off
    expect(pool).not.toHaveProperty("fairLaunch");
    expect(await code(call("GET", "/api/launches"))).toBe("not_found");
    expect(await code(call("GET", "/api/launches/" + "00".repeat(16)))).toBe("not_found");
    const fl: SignedAction = { op: "fl_create", venue: "pumpfun", meta: { name: "X", symbol: "X" }, windowSecs: 120 };
    expect(await code(call("POST", "/api/actions", fl))).toBe("bad_request");
    const pf = await call<Portfolio>("GET", "/api/portfolio");
    expect(pf).not.toHaveProperty("fairBids");
    expect(pf).not.toHaveProperty("fairLaunches");
  });
});

describe("mock fair-launch: full cycle", () => {
  it("create -> publish -> sealed bid -> close + root -> verify inclusion -> reveal -> launched", async () => {
    const m = await load(true);
    const call = caller(m);
    await fund(m, call);
    const pool = await call<PoolInfo>("GET", "/api/pool");
    expect(pool.features?.fairLaunch).toBe(true);
    const params = pool.fairLaunch!;

    const r = await call<ActionReceipt>("POST", "/api/actions", { op: "fl_create", venue: "pumpfun", meta: { name: "Fair Moth", symbol: "FMOTH" }, windowSecs: 120 });
    expect(r.status).toBe("queued");
    const id = r.launchId!;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // Not public before the epoch boundary; the creator sees it as scheduled.
    expect(await code(call("GET", `/api/launches/${id}`))).toBe("not_found");
    expect((await call<Portfolio>("GET", "/api/portfolio")).fairLaunches?.find((x) => x.launchId === id)?.status).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(11_000);
    let l = await call<FairLaunch>("GET", `/api/launches/${id}`);
    expect(l.status).toBe("open");
    expect(l.drand.roundTime).toBeGreaterThan(l.closeAt);
    expect(l).not.toHaveProperty("commitment");

    const amount = BigInt(300_000); // 0.003 TAZ -> tier 0.005
    const ct = await sealBid(l.drand.round, encodeBid({ chainId: "0202", launchId: id, anonPubkey: signer.pubkey, amountZat: amount }), params.drand);
    m.hint(ct, amount);
    const bid = (hold: string, ciphertext = ct): SignedAction => ({ op: "fl_bid", launchId: id, holdZat: hold, ciphertext });
    expect(await code(call("POST", "/api/actions", bid("123")))).toBe("bad_request");
    const wrongRound = await sealBid(l.drand.round + 1, new Uint8Array(64), params.drand);
    expect(await code(call("POST", "/api/actions", bid("500000", wrongRound)))).toBe("bad_ciphertext");
    expect((await call<ActionReceipt>("POST", "/api/actions", bid("500000"))).status).toBe("queued");
    expect(await code(call("POST", "/api/actions", bid("500000")))).toBe("already_bid");

    let pf = await call<Portfolio>("GET", "/api/portfolio");
    let mine = pf.fairBids!.find((b) => b.launchId === id)!;
    expect(mine).toMatchObject({ status: "sealed", holdZat: "500000" });
    expect(mine).not.toHaveProperty("proof");
    expect(mine).not.toHaveProperty("amountZat");
    expect(pf.actions?.length ?? 0).toBe(0); // fl_* never in actions

    // Close: root published, proof for the owner, verified locally.
    await vi.advanceTimersByTimeAsync(l.closeAt - Date.now() + 100);
    l = await call<FairLaunch>("GET", `/api/launches/${id}`);
    expect(l.status).toBe("closed");
    expect(l.commitment?.root).toMatch(/^[0-9a-f]{64}$/);
    expect(await code(call("POST", "/api/actions", { op: "fl_cancel", launchId: id }))).toBe("launch_closed");
    pf = await call<Portfolio>("GET", "/api/portfolio");
    mine = pf.fairBids!.find((b) => b.launchId === id)!;
    expect(verifyInclusion(ct, mine.proof!, l.commitment!.root).ok).toBe(true);
    expect(verifyInclusion(wrongRound, mine.proof!, l.commitment!.root).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    l = await call<FairLaunch>("GET", `/api/launches/${id}`);
    expect(l.commitment?.attestation?.matches).toBe(true);

    // Round fires: reveal, one atomic create + buy, shares by amount.
    await vi.advanceTimersByTimeAsync(l.drand.roundTime - Date.now() + 7_000);
    l = await call<FairLaunch>("GET", `/api/launches/${id}`);
    expect(l.status).toBe("launched");
    expect(l.drand.signature).toMatch(/^[0-9a-f]{96}$/);
    expect(l.result!.bids === "<5" || (typeof l.result!.bids === "number" && l.result!.bids >= 5)).toBe(true);
    pf = await call<Portfolio>("GET", "/api/portfolio");
    mine = pf.fairBids!.find((b) => b.launchId === id)!;
    expect(mine.status).toBe("settled");
    expect(mine.amountZat).toBe("300000");
    expect(BigInt(mine.chargedZat!)).toBeLessThanOrEqual(amount);
    expect(BigInt(mine.chargedZat!) + BigInt(mine.releasedZat!)).toBe(BigInt(500_000));
    expect(pf.holdings.find((h) => h.mint === l.result!.mint)?.amount).toBe(mine.tokenAmount);
    expect(pf.zecHeld).toBe("0");
  });

  it("cancel before close returns the hold; creator can cancel the launch", async () => {
    const m = await load(true);
    const call = caller(m);
    await fund(m, call);
    const params = (await call<PoolInfo>("GET", "/api/pool")).fairLaunch!;
    const r = await call<ActionReceipt>("POST", "/api/actions", { op: "fl_create", venue: "pumpfun", meta: { name: "Gone", symbol: "GONE" }, windowSecs: 300 });
    await vi.advanceTimersByTimeAsync(11_000);
    const l = await call<FairLaunch>("GET", `/api/launches/${r.launchId}`);
    const ct = await sealBid(l.drand.round, encodeBid({ chainId: "0202", launchId: l.id, anonPubkey: signer.pubkey, amountZat: BigInt(200_000) }), params.drand);
    const before = (await call<Portfolio>("GET", "/api/portfolio")).zecBalance;
    await call("POST", "/api/actions", { op: "fl_bid", launchId: l.id, holdZat: "250000", ciphertext: ct });
    expect((await call<ActionReceipt>("POST", "/api/actions", { op: "fl_cancel", launchId: l.id })).status).toBe("executed");
    expect((await call<Portfolio>("GET", "/api/portfolio")).zecBalance).toBe(before);
    expect((await call<ActionReceipt>("POST", "/api/actions", { op: "fl_cancel_launch", launchId: l.id })).status).toBe("executed");
    expect((await call<FairLaunch>("GET", `/api/launches/${l.id}`)).status).toBe("cancelled");
    expect((await call<Portfolio>("GET", "/api/portfolio")).zecHeld).toBe("0");
  });
});

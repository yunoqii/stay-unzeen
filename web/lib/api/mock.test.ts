import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import type { Portfolio } from "./types";
import { handle, mockDepositPhase, mockPay, mockPool } from "./mock";

const SK = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
const signer = signerFromSecret(SK);

async function portfolio(): Promise<Portfolio> {
  const path = "/api/portfolio";
  const p = handle("devnet", "GET", path, undefined, signRequest(signer, { chainId: "0202", method: "GET", pathWithQuery: path }));
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as Portfolio;
}

describe("mock: Top up full cycle", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("GET /api/pool is public and per network", async () => {
    const p = handle("mainnet", "GET", "/api/pool", undefined, {});
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual(mockPool("mainnet"));
  });

  it("portfolio needs a signature", async () => {
    const p = handle("devnet", "GET", "/api/portfolio", undefined, {});
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("waiting -> mempool -> confirming -> credited, balance grows", async () => {
    const pool = mockPool("devnet");
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
    const before = await portfolio();
    expect(before.zecBalance).toBe("0");

    mockPay("devnet", depositUri(pool, "25000000", memo));
    expect(mockDepositPhase("devnet", memo).phase).toBe("none");
    vi.advanceTimersByTime(2_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("mempool");
    vi.advanceTimersByTime(4_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("confirming");
    vi.advanceTimersByTime(10_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("credited");

    const after = await portfolio();
    expect(after.zecBalance).toBe("25000000");
    expect(after.deposits[0]).toMatchObject({ amountZat: "25000000", status: "credited" });
  });

  it("below minimum stays with the pool as dust", async () => {
    const pool = mockPool("devnet");
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
    const start = (await portfolio()).zecBalance;
    mockPay("devnet", depositUri(pool, "999999", memo));
    vi.advanceTimersByTime(20_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("dust");
    expect((await portfolio()).zecBalance).toBe(start);
  });

  it("a devnet memo paid on mainnet is frozen, not credited", async () => {
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, [2, 2]);
    mockPay("mainnet", depositUri(mockPool("mainnet"), "50000000", memo));
    vi.advanceTimersByTime(20_000);
    expect(mockDepositPhase("mainnet", memo).phase).toBe("frozen");
  });
});

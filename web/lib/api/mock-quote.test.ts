// v0.28 GET /api/quote of the mock follows the grid contract: inAmount = the request, maxAmount, 404 above it.
import { describe, expect, it } from "vitest";
import type { JupiterQuote, TokenListItem } from "./types";
import { handle } from "./mock";

const get = <T,>(network: "mainnet" | "devnet", path: string) => handle(network, "GET", path, undefined, {}) as Promise<T>;

describe("mock /api/quote (grid)", () => {
  it("answers for the asked amount, with the grid top; 404 above it and on devnet", async () => {
    const list = await get<TokenListItem[]>("mainnet", "/api/tokens");
    const g = list.find((t) => t.status === "graduated");
    expect(g).toBeTruthy();
    const q = await get<JupiterQuote>("mainnet", `/api/quote?mint=${g!.mint}&side=buy&amount=123456789`);
    expect(q.inAmount).toBe("123456789");
    expect(q.maxAmount).toBe("25000000000");
    expect(BigInt(q.outAmount) > BigInt(0)).toBe(true);
    expect(Date.now() - q.asOf).toBeLessThan(11 * 60_000);
    await expect(get("mainnet", `/api/quote?mint=${g!.mint}&side=buy&amount=25000000001`)).rejects.toMatchObject({ code: "not_found" });
    await expect(get("devnet", `/api/quote?mint=${g!.mint}&side=buy&amount=1000`)).rejects.toMatchObject({ code: "not_found" });
  });
});

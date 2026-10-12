import { describe, expect, it } from "vitest";
import type { FairBid } from "@/lib/api/types";
import { bidsToPrune, type LocalBid } from "./bid-store";

const NOW = 1_800_000_000_000;
const local = (launchId: string, ageMs: number, pending = false): LocalBid => ({ launchId, amountZat: "1", holdZat: "1", ciphertext: "x", sealedAt: NOW - ageMs, ...(pending ? { pending } : {}) });
const server = (launchId: string, status: FairBid["status"]): FairBid => ({ launchId, holdZat: "1", status });

describe("local sealed bids are deleted once they are of no use (review F12)", () => {
  it("after reveal, settle, release, withdraw or an invalid bid; kept while sealed", () => {
    const l = ["a", "b", "c", "d", "e", "f"].map((id) => local(id, 1_000));
    const s = [server("a", "sealed"), server("b", "revealed"), server("c", "settled"), server("d", "released"), server("e", "cancelled"), server("f", "invalid")];
    expect(bidsToPrune(l, s, NOW)).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("a pending copy the server never listed goes after 10 min; an unlisted old one after 48 h", () => {
    expect(bidsToPrune([local("p", 5 * 60_000, true)], [], NOW)).toEqual([]);
    expect(bidsToPrune([local("p", 11 * 60_000, true)], [], NOW)).toEqual(["p"]);
    expect(bidsToPrune([local("o", 47 * 3_600_000)], [], NOW)).toEqual([]);
    expect(bidsToPrune([local("o", 49 * 3_600_000)], [], NOW)).toEqual(["o"]);
  });
});

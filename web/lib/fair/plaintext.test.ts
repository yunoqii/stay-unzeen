import { describe, expect, it } from "vitest";
import { base58, hex } from "@scure/base";
import vectors from "./testdata/fl-vectors.json";
import { parseTlockArmor } from "./armor";
import { assertQuicknet, QUICKNET, roundAt, roundTimeMs } from "./drand";
import { BID_LEN, encodeBid } from "./plaintext";
import { openWithBeacon, sealBid } from "./tlock";

const beacon = (r: number) => vectors.beacons.find((b) => b.round === r)!;

describe("bid plaintext (UZFL v1, 64 bytes)", () => {
  for (const v of vectors.tlockJs) {
    it(`matches core vector ${v.name}`, () => {
      const pt = encodeBid({ chainId: v.chainId, launchId: v.launchId, anonPubkey: base58.encode(hex.decode(v.anonPubkey)), amountZat: BigInt(v.amountZat) });
      expect(pt.length).toBe(BID_LEN);
      expect(hex.encode(pt)).toBe(v.plaintext);
    });
  }

  it("rejects bad fields", () => {
    const base = { chainId: "0202", launchId: "00".repeat(16), anonPubkey: new Uint8Array(32), amountZat: BigInt(1) };
    expect(() => encodeBid({ ...base, chainId: "0102" })).toThrow();
    expect(() => encodeBid({ ...base, launchId: "AB".repeat(16) })).toThrow();
    expect(() => encodeBid({ ...base, anonPubkey: new Uint8Array(31) })).toThrow();
    expect(() => encodeBid({ ...base, amountZat: BigInt(0) })).toThrow();
  });
});

describe("tlock sealing (static quicknet client, no network)", () => {
  it("core vectors open with the round-1000 signature (tlock-js interop)", async () => {
    for (const v of vectors.tlockJs) {
      const pt = await openWithBeacon(v.ciphertext, beacon(v.round));
      expect(hex.encode(pt)).toBe(v.plaintext);
    }
  });

  it("produces age armor with a tlock stanza for the launch round, and it opens at that round", async () => {
    const v = vectors.tlockJs[0];
    const pt = hex.decode(v.plaintext);
    const ct = await sealBid(1000, pt, QUICKNET);
    expect(ct.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    expect(ct.trim().endsWith("-----END AGE ENCRYPTED FILE-----")).toBe(true);
    expect(new TextEncoder().encode(ct).length).toBeLessThanOrEqual(1024);
    expect(parseTlockArmor(ct)).toEqual({ round: 1000, chainHash: QUICKNET.chainHash });
    expect(ct).not.toContain(v.plaintext); // nothing in the clear
    expect(hex.encode(await openWithBeacon(ct, beacon(1000)))).toBe(v.plaintext);
    // Wrong round signature does not open it.
    await expect(openWithBeacon(ct, { ...beacon(1001), round: 1000 })).rejects.toThrow();
  });

  it("refuses a pool that announces anything but quicknet, and never fetches", async () => {
    const pt = new Uint8Array(64);
    await expect(sealBid(1000, pt, { ...QUICKNET, chainHash: "00".repeat(32) })).rejects.toThrow();
    await expect(sealBid(1000, pt, undefined)).rejects.toThrow();
    expect(() => assertQuicknet({ ...QUICKNET, period: 30 })).toThrow();
  });

  it("parseTlockArmor rejects non-tlock input", () => {
    expect(parseTlockArmor("hello")).toBeNull();
    expect(parseTlockArmor("-----BEGIN AGE ENCRYPTED FILE-----\nYWJj\n-----END AGE ENCRYPTED FILE-----")).toBeNull();
    expect(parseTlockArmor("x".repeat(2000))).toBeNull();
  });
});

describe("drand round time", () => {
  it("matches the quicknet formula", () => {
    expect(roundTimeMs(1)).toBe(QUICKNET.genesis * 1000);
    // latest = 33010614 -> 2026-10-12 20:00:06 UTC (analysis §1)
    expect(new Date(roundTimeMs(33010614)).toISOString()).toBe("2026-10-12T20:00:06.000Z");
    expect(roundAt(roundTimeMs(33010614))).toBe(33010614);
    expect(roundAt(roundTimeMs(33010614) + 2999)).toBe(33010614);
  });
});

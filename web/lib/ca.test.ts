import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import { mintError, parseMint } from "./ca";

const MINT = "2pYxXseqGTcBSKL5MtoXW7u86p2KAUs6b8r523Rwbp4T"; // devnet mint from token-intel.md
const PUMP = "Hs7ZSyr7Ra7rDzvhHnCHbXwzDtKh5gKDaRcHSE4pump";

describe("CA search validation", () => {
  it("accepts a base58 address of 32 bytes", () => {
    expect(parseMint(MINT)).toBe(MINT);
    expect(parseMint(`  ${MINT}\n`)).toBe(MINT);
    expect(base58.decode(parseMint(MINT)!).length).toBe(32);
  });

  it("accepts pump.fun vanity mints if they decode to 32 bytes", () => {
    const ok = (() => {
      try {
        return base58.decode(PUMP).length === 32;
      } catch {
        return false;
      }
    })();
    expect(parseMint(PUMP) !== null).toBe(ok);
  });

  it("rejects wrong lengths and the excluded base58 letters", () => {
    expect(parseMint(MINT.slice(0, -1))).toBeNull(); // 31 bytes
    expect(parseMint(MINT + "1")).toBeNull();
    expect(parseMint(MINT.replace("p", "0"))).toBeNull();
    expect(parseMint(MINT.replace("p", "O"))).toBeNull();
    expect(parseMint(MINT.replace("p", "l"))).toBeNull();
    expect(parseMint("0x" + "a".repeat(40))).toBeNull(); // EVM address
    expect(parseMint("")).toBeNull();
    expect(parseMint("PEPE")).toBeNull();
  });

  it("rejects non-canonical encodings (leading zero bytes mismatch)", () => {
    const bytes = new Uint8Array(32);
    bytes[31] = 7;
    const canonical = base58.encode(bytes);
    expect(parseMint(canonical)).toBe(canonical);
    expect(parseMint("1" + canonical)).toBeNull(); // 33 bytes
  });

  it("extracts a mint from a pasted link without opening it", () => {
    expect(parseMint(`https://pump.fun/coin/${MINT}`)).toBe(MINT);
    expect(parseMint(`https://solscan.io/token/${MINT}?cluster=devnet`)).toBe(MINT);
    expect(parseMint("https://example.com/nothing/here")).toBeNull();
    expect(parseMint(`javascript:${MINT}`)).toBeNull();
  });

  it("explains why an input is not a mint", () => {
    expect(mintError(MINT)).toBeNull();
    expect(mintError("")).toBeNull();
    expect(mintError("0OIl")).toMatch(/base58/);
    expect(mintError(MINT.slice(0, 20))).toMatch(/32 bytes/);
  });
});

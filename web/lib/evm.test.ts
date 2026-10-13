import { describe, expect, it } from "vitest";
import { checkEvmAddress, toChecksumAddress } from "./evm";

// EIP-55 test vectors.
const EIP55 = ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"];

describe("EVM addresses (EIP-55)", () => {
  it.each(EIP55)("checksums %s", (a) => {
    expect(toChecksumAddress(a.toLowerCase())).toBe(a);
    expect(checkEvmAddress(a)).toEqual({ ok: true, address: a });
  });

  it("accepts single-case input and returns the checksummed form", () => {
    expect(checkEvmAddress(EIP55[0].toLowerCase())).toEqual({ ok: true, address: EIP55[0] });
    expect(checkEvmAddress("0x" + EIP55[0].slice(2).toUpperCase())).toEqual({ ok: true, address: EIP55[0] });
  });

  it("catches a typo through the checksum, refuses junk and the zero address", () => {
    const typo = EIP55[0].replace("aAeb", "aaeb");
    expect(checkEvmAddress(typo)).toMatchObject({ ok: false, reason: "checksum" });
    expect(checkEvmAddress("0x123")).toMatchObject({ ok: false, reason: "format" });
    expect(checkEvmAddress("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toMatchObject({ ok: false, reason: "format" });
    expect(checkEvmAddress("0x" + "0".repeat(40))).toMatchObject({ ok: false, reason: "zero" });
    expect(checkEvmAddress("")).toMatchObject({ ok: false, reason: "empty" });
  });
});

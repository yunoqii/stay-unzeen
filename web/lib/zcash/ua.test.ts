import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32m } from "@scure/base";
import vectors from "@/lib/crypto/testdata/ua-vectors.json";
import { checkWithdrawUa, decodeUnifiedAddress, f4jumble, f4jumbleInv, TYPECODE } from "./ua";

/** Test-only encoder: receivers (ascending typecode) -> UA string. */
function encodeUa(hrp: string, receivers: { typecode: number; data: Uint8Array }[]): string {
  const parts: number[] = [];
  for (const r of receivers) parts.push(r.typecode, r.data.length, ...r.data);
  const pad = new Uint8Array(16);
  pad.set(Array.from(hrp, (c) => c.charCodeAt(0)));
  const raw = new Uint8Array([...parts, ...pad]);
  return bech32m.encode(hrp, bech32m.toWords(f4jumble(raw)), false);
}

const orchard = new Uint8Array(43).fill(7);
const sapling = new Uint8Array(43).fill(9);
const p2pkh = new Uint8Array(20).fill(1);

describe("F4Jumble (zcash-test-vectors)", () => {
  it.each(vectors.f4jumble.map((v, i) => [i, v] as const))("vector %i", (_, v) => {
    expect(bytesToHex(f4jumble(hexToBytes(v.normal)))).toBe(v.jumbled);
    expect(bytesToHex(f4jumbleInv(hexToBytes(v.jumbled)))).toBe(v.normal);
  });
});

describe("Unified Address decoding (zcash-test-vectors)", () => {
  it.each(vectors.unified.map((v, i) => [i, v] as const))("vector %i", (_, v) => {
    const ua = decodeUnifiedAddress(v.ua);
    expect(ua.net).toBe("main");
    const get = (t: number) => ua.receivers.find((r) => r.typecode === t);
    expect(get(TYPECODE.orchard) ? bytesToHex(get(TYPECODE.orchard)!.data) : null).toBe(v.orchard);
    expect(get(TYPECODE.sapling) ? bytesToHex(get(TYPECODE.sapling)!.data) : null).toBe(v.sapling);
    expect(get(TYPECODE.p2pkh) ? bytesToHex(get(TYPECODE.p2pkh)!.data) : null).toBe(v.p2pkh);
  });
});

describe("checkWithdrawUa", () => {
  const withOrchard = vectors.unified.find((v) => v.orchard && !v.unknownTypecode)!.ua;
  const withoutOrchard = vectors.unified.find((v) => !v.orchard)!.ua;

  it("accepts a mainnet UA with an Orchard receiver on mainnet", () => {
    expect(checkWithdrawUa(withOrchard, "mainnet").ok).toBe(true);
  });

  it("accepts a testnet UA on devnet, rejects it on mainnet and vice versa", () => {
    const test = encodeUa("utest", [
      { typecode: 2, data: sapling },
      { typecode: 3, data: orchard },
    ]);
    expect(checkWithdrawUa(test, "devnet").ok).toBe(true);
    expect(checkWithdrawUa(test, "mainnet")).toMatchObject({ ok: false, reason: "wrong_network" });
    expect(checkWithdrawUa(withOrchard, "devnet")).toMatchObject({ ok: false, reason: "wrong_network" });
  });

  it("rejects a UA without an Orchard receiver", () => {
    expect(checkWithdrawUa(withoutOrchard, "mainnet")).toMatchObject({ ok: false, reason: "no_orchard" });
  });

  it("rejects t-addresses and Sapling with an explanation", () => {
    expect(checkWithdrawUa("t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU", "mainnet")).toMatchObject({ ok: false, reason: "transparent" });
    expect(checkWithdrawUa("tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU", "devnet")).toMatchObject({ ok: false, reason: "transparent" });
    expect(
      checkWithdrawUa("zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly", "mainnet"),
    ).toMatchObject({ ok: false, reason: "sapling" });
  });

  it("catches a typo through the checksum", () => {
    const i = 20;
    const c = withOrchard[i] === "q" ? "p" : "q";
    const typo = withOrchard.slice(0, i) + c + withOrchard.slice(i + 1);
    expect(checkWithdrawUa(typo, "mainnet")).toMatchObject({ ok: false, reason: "typo" });
  });

  it("rejects a transparent-only UA and out-of-order receivers", () => {
    expect(checkWithdrawUa(encodeUa("u", [{ typecode: 0, data: p2pkh }]), "mainnet").ok).toBe(false);
    expect(
      checkWithdrawUa(
        encodeUa("u", [
          { typecode: 3, data: orchard },
          { typecode: 2, data: sapling },
        ]),
        "mainnet",
      ).ok,
    ).toBe(false);
  });

  it("rejects empty input and accepts surrounding whitespace", () => {
    expect(checkWithdrawUa("  ", "mainnet")).toMatchObject({ ok: false, reason: "empty" });
    expect(checkWithdrawUa(`  ${withOrchard}\n`, "mainnet").ok).toBe(true);
  });
});

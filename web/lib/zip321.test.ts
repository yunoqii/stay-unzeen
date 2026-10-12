import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { keypairFromSecret } from "@/lib/crypto/keys";
import { checkUnz1, decodeUnz1, unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId, PoolMismatchError, DEPOSIT_TTL_SEC } from "@/lib/deposit";
import { mockPool } from "@/lib/api/mock";
import type { PoolInfo } from "@/lib/api/types";
import { buildZip321, memoText, parseZip321, zatToZip321Amount, Zip321Error } from "./zip321";

const UA_TEST = mockPool("devnet").address;
const UA_MAIN = mockPool("mainnet").address;
const SK = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");

describe("zip321: amounts", () => {
  it("formats zatoshis as decimal ZEC without trailing zeros", () => {
    expect(zatToZip321Amount("100000000")).toBe("1");
    expect(zatToZip321Amount("10000000")).toBe("0.1");
    expect(zatToZip321Amount("1")).toBe("0.00000001");
    expect(zatToZip321Amount("123456789")).toBe("1.23456789");
    expect(zatToZip321Amount("2100000000000000")).toBe("21000000");
    expect(() => zatToZip321Amount("2100000000000001")).toThrow(Zip321Error);
    expect(() => zatToZip321Amount("1.5")).toThrow(Zip321Error);
  });
});

describe("zip321: parser follows the spec", () => {
  it("reads the ZIP-321 single-payment example", () => {
    const uri =
      "zcash:ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase";
    const [p] = parseZip321(uri);
    expect(p.address).toBe("ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez");
    expect(p.amountZat).toBe("100000000");
    expect(memoText(p)).toBe("This is a simple memo.");
    expect(p.message).toBe("Thank you for your purchase");
  });

  it("reads multi-payment URIs with paramindex", () => {
    const ps = parseZip321(`zcash:?address=${UA_TEST}&amount=0.5&address.1=${UA_MAIN}&amount.1=2`);
    expect(ps.map((p) => p.amountZat)).toEqual(["50000000", "200000000"]);
  });

  it("rejects what a wallet must reject", () => {
    const bad = [
      `bitcoin:${UA_TEST}?amount=1`,
      `zcash:${UA_TEST}?amount=0.123456789`, // > 8 decimals
      `zcash:${UA_TEST}?amount=1.`,
      `zcash:${UA_TEST}?amount=-1`,
      `zcash:${UA_TEST}?amount=1&amount=2`, // duplicate
      `zcash:${UA_TEST}?amount=1&memo=VGhpcw==`, // padding
      `zcash:${UA_TEST}?amount=1&memo=VGh+cw`, // not base64url
      `zcash:${UA_TEST}?amount=1&req-foo=1`, // unknown required param
      `zcash:${UA_TEST}?amount.01=1`, // leading zero paramindex
      `zcash:tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU?amount=1&memo=VGhpcw`, // memo on t-addr
      `zcash:?address=${UA_TEST}&amount=1&address.1=${UA_MAIN}`, // missing amount in multi-payment
      `zcash:notanaddress?amount=1`,
      `zcash:${UA_TEST}?`,
    ];
    for (const u of bad) expect(() => parseZip321(u), u).toThrow(Zip321Error);
  });

  it("ignores unknown optional params", () => {
    expect(parseZip321(`zcash:${UA_TEST}?amount=1&foo=bar`)[0].amountZat).toBe("100000000");
  });
});

describe("zip321: our Top up URI parses back to the same payment", () => {
  const pool = mockPool("devnet");
  const chain = poolChainId(pool, "devnet");
  const now = 1_760_000_000;
  const memo = unz1MemoString(depositFields(now, BigInt("12345678901234567890")), SK, chain);

  it("round-trips address, amount and memo", () => {
    const uri = depositUri(pool, "12500000", memo);
    expect(uri.startsWith(`zcash:${pool.address}?amount=0.125&memo=`)).toBe(true);
    expect(uri).not.toMatch(/[=]$|%3D/); // no base64 padding
    const [p] = parseZip321(uri);
    expect(p.address).toBe(pool.address);
    expect(p.amountZat).toBe("12500000");
    expect(memoText(p)).toBe(memo);
  });

  it("memo is a valid unz1 deposit for this pool, 153 bytes, expiry now + 24 h, no refund", () => {
    const [p] = parseZip321(depositUri(pool, "1000000", memo));
    const text = memoText(p)!;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(267);
    expect(text.charCodeAt(0)).toBeLessThan(0xf5); // ZIP-302 text memo
    const d = decodeUnz1(text, chain);
    expect(d.valid).toBe(true);
    expect(d.op).toBe("deposit");
    expect(d.venue).toBe("none");
    expect(d.target).toEqual({ kind: "none" });
    expect(d.expiry).toBe(now + DEPOSIT_TTL_SEC);
    expect(d.anonPubkey).toBe(keypairFromSecret(SK).pubkey);
    expect(checkUnz1(text, chain, now + 60)).toBe("valid");
    // Signed for testnet/devnet only.
    expect(checkUnz1(text, [1, 1], now + 60)).toBe("bad_signature");
  });

  it("builder refuses bad input", () => {
    expect(() => buildZip321({ address: pool.address, amountZat: "0", memo })).toThrow(Zip321Error);
    expect(() => buildZip321({ address: pool.address, amountZat: "1", memo: "x".repeat(513) })).toThrow(Zip321Error);
    expect(() => buildZip321({ address: "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU", amountZat: "1", memo })).toThrow(Zip321Error);
  });
});

describe("deposit: pool checks", () => {
  const ok = mockPool("devnet");
  it("accepts the matching pool", () => {
    expect(poolChainId(ok, "devnet")).toEqual([2, 2]);
    expect(poolChainId(mockPool("mainnet"), "mainnet")).toEqual([1, 1]);
  });
  it("accepts Zcash mainnet behind Solana devnet", () => {
    const p: PoolInfo = { ...ok, network: "main", chainId: "0102", address: mockPool("mainnet").address };
    expect(poolChainId(p, "devnet")).toEqual([1, 2]);
  });
  it("refuses a pool for another network", () => {
    expect(() => poolChainId(ok, "mainnet")).toThrow(PoolMismatchError);
    expect(() => poolChainId({ ...ok, chainId: "0102" }, "devnet")).toThrow(PoolMismatchError); // says test, signs main
    expect(() => poolChainId({ ...ok, chainId: "zz" }, "devnet")).toThrow(PoolMismatchError);
    expect(() => poolChainId({ ...ok, address: UA_MAIN }, "devnet")).toThrow(PoolMismatchError);
  });
});

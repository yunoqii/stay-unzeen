import { describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { decryptHistory, deriveHistoryKey, encryptHistory, HistoryDecryptError, historySlot, type HistoryEntry } from "./crypto";
import { addPending, applyStatuses, EXPIRE_MS, expiredCount, fillsOf } from "./reduce";

const SECRET = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const PUB = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "2pYxXseqGTcBSKL5MtoXW7u86p2KAUs6b8r523Rwbp4T";

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "a".repeat(32),
  kind: "buy",
  mint: MINT,
  symbol: "PEPE",
  decimals: 6,
  submittedAt: 1_000,
  status: "executed",
  fill: { kind: "buy", ts: 2_000, tokenAmount: "1000000", solAmount: "1800000", zecSpent: "1000000" },
  ...over,
});

describe("history encryption (T4)", () => {
  it("round-trips with the key of the same secret and network", async () => {
    const key = await deriveHistoryKey(SECRET, "devnet");
    const blob = await encryptHistory(key, "devnet", PUB, [entry()]);
    const again = await deriveHistoryKey(SECRET, "devnet");
    expect(await decryptHistory(again, "devnet", PUB, blob)).toEqual([entry()]);
  });

  it("ciphertext shows neither the mint nor the amounts", async () => {
    const key = await deriveHistoryKey(SECRET, "devnet");
    const blob = await encryptHistory(key, "devnet", PUB, [entry()]);
    const raw = JSON.stringify(blob) + new TextDecoder("latin1").decode(base64.decode(blob.ct));
    expect(raw).not.toContain(MINT);
    expect(raw).not.toContain("PEPE");
    expect(raw).not.toContain("1800000");
  });

  it("fresh IV per write", async () => {
    const key = await deriveHistoryKey(SECRET, "devnet");
    const a = await encryptHistory(key, "devnet", PUB, [entry()]);
    const b = await encryptHistory(key, "devnet", PUB, [entry()]);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("another key, another network or another pubkey cannot read it", async () => {
    const key = await deriveHistoryKey(SECRET, "devnet");
    const blob = await encryptHistory(key, "devnet", PUB, [entry()]);
    await expect(decryptHistory(await deriveHistoryKey(OTHER, "devnet"), "devnet", PUB, blob)).rejects.toBeInstanceOf(HistoryDecryptError);
    // networks get different keys from the same secret
    await expect(decryptHistory(await deriveHistoryKey(SECRET, "mainnet"), "devnet", PUB, blob)).rejects.toBeInstanceOf(HistoryDecryptError);
    // AAD binds the network and the pubkey
    await expect(decryptHistory(key, "mainnet", PUB, blob)).rejects.toBeInstanceOf(HistoryDecryptError);
    await expect(decryptHistory(key, "devnet", PUB.replace("9", "8"), blob)).rejects.toBeInstanceOf(HistoryDecryptError);
  });

  it("tampering is detected", async () => {
    const key = await deriveHistoryKey(SECRET, "devnet");
    const blob = await encryptHistory(key, "devnet", PUB, [entry()]);
    const ct = base64.decode(blob.ct);
    ct[0] ^= 1;
    await expect(decryptHistory(key, "devnet", PUB, { ...blob, ct: base64.encode(ct) })).rejects.toBeInstanceOf(HistoryDecryptError);
  });

  it("the key is not extractable", async () => {
    const key = await deriveHistoryKey(SECRET, "devnet");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();
  });

  it("slot ids are per network and do not spell out the pubkey", () => {
    expect(historySlot("devnet", PUB)).not.toContain(PUB);
    expect(historySlot("devnet", PUB)).not.toBe(historySlot("mainnet", PUB));
    expect(historySlot("devnet", PUB)).toMatch(/^devnet:[0-9a-f]{32}$/);
  });
});

describe("history updates from the portfolio poll", () => {
  const pending = (over: Partial<HistoryEntry> = {}) => {
    const { status: _s, fill: _f, ...rest } = entry(over);
    void _s;
    void _f;
    return addPending([], rest)[0];
  };

  it("executed + fill -> executed, without the Solana tx", () => {
    const out = applyStatuses([pending()], [{ id: "a".repeat(32), status: "executed", solanaTx: "SIG", fill: { tokenAmount: "5", solAmount: "6", zecSpent: "7" } }], 9_000);
    expect(out[0].status).toBe("executed");
    expect(out[0].fill).toEqual({ kind: "buy", ts: 9_000, tokenAmount: "5", solAmount: "6", zecSpent: "7" });
    expect(JSON.stringify(out)).not.toContain("SIG");
  });

  it("uses executedAt for the marker time when the server sends it", () => {
    const out = applyStatuses([pending()], [{ id: "a".repeat(32), status: "executed", executedAt: 1_759_999_980_000, fill: { tokenAmount: "5", zecSpent: "7" } }], 1_760_000_050_000);
    expect(out[0].fill?.ts).toBe(1_759_999_980_000);
  });

  it("create learns its mint from the fill", () => {
    const out = applyStatuses([pending({ kind: "create", mint: undefined })], [{ id: "a".repeat(32), status: "executed", fill: { tokenAmount: "5", zecSpent: "7", mint: MINT } }], 9_000);
    expect(out[0].mint).toBe(MINT);
    expect(fillsOf(out, MINT)).toHaveLength(1);
  });

  it("failed actions are dropped; queued and sent stay pending", () => {
    expect(applyStatuses([pending()], [{ id: "a".repeat(32), status: "failed", error: "slippage" }], 9_000)).toEqual([]);
    const p = [pending()];
    expect(applyStatuses(p, [{ id: "a".repeat(32), status: "sent" }], 9_000)).toBe(p);
  });

  it("expires after the server's retention when it never settled for us", () => {
    const p = [pending({ submittedAt: 0 })];
    expect(applyStatuses(p, [], EXPIRE_MS - 1)).toBe(p);
    const out = applyStatuses(p, [], EXPIRE_MS + 1);
    expect(out[0].status).toBe("expired");
    expect(expiredCount(out, MINT)).toBe(1);
  });

  it("addPending is idempotent by id", () => {
    const p = [pending()];
    const { status: _s, fill: _f, ...rest } = entry();
    void _s;
    void _f;
    expect(addPending(p, rest)).toBe(p);
  });
});

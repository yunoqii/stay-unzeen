import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { signatureState } from "../../src/tx";
import { parseRecipient } from "../../src/withdraw";

function conn(height: number, status: unknown): Connection {
  return {
    getBlockHeight: async () => height,
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [status] }),
  } as unknown as Connection;
}

describe("signatureState", () => {
  it("landed only when confirmed or finalized", async () => {
    expect(await signatureState(conn(10, { slot: 5, err: null, confirmationStatus: "confirmed" }), "s", 100)).toEqual({
      state: "landed",
      slot: 5,
      err: null,
    });
    expect((await signatureState(conn(10, { slot: 5, err: null, confirmationStatus: "finalized" }), "s", 100)).state).toBe(
      "landed",
    );
    // processed may be on a dropped fork
    expect((await signatureState(conn(10, { slot: 5, err: null, confirmationStatus: "processed" }), "s", 100)).state).toBe(
      "pending",
    );
    expect((await signatureState(conn(500, { slot: 5, err: null, confirmationStatus: "processed" }), "s", 100)).state).toBe(
      "pending",
    );
  });

  it("expired only when finalized height is past lastValidBlockHeight and the sig is unknown", async () => {
    expect((await signatureState(conn(100, null), "s", 100)).state).toBe("pending");
    expect((await signatureState(conn(101, null), "s", 100)).state).toBe("expired");
  });

  it("landed with error keeps the error", async () => {
    const st = await signatureState(conn(10, { slot: 5, err: { Custom: 1 }, confirmationStatus: "confirmed" }), "s", 100);
    expect(st).toEqual({ state: "landed", slot: 5, err: { Custom: 1 } });
  });
});

describe("withdraw recipient", () => {
  it("accepts wallets, rejects PDAs and garbage", () => {
    const w = Keypair.generate().publicKey.toBase58();
    expect(parseRecipient(w).toBase58()).toBe(w);
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey("11111111111111111111111111111111"));
    expect(() => parseRecipient(pda.toBase58())).toThrow(/not a wallet/);
    expect(() => parseRecipient("nope")).toThrow(/invalid/);
  });
});

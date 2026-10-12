import { describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { keypairFromMnemonic, newMnemonic } from "./keys";
import { decryptVault, encryptMnemonic, isEncryptedVault, WrongPasswordError } from "./vault";

const FAST = { iterations: 1_000 }; // production uses PBKDF2_ITERATIONS; tests stay fast

describe("vault (PBKDF2 -> AES-GCM)", () => {
  it("round-trips the phrase and yields the same key", async () => {
    const m = newMnemonic();
    const vault = await encryptMnemonic(m, "correct horse battery", "devnet", FAST);
    expect(isEncryptedVault(JSON.parse(JSON.stringify(vault)))).toBe(true);
    const out = await decryptVault(vault, "correct horse battery");
    expect(out.mnemonic).toBe(m);
    expect(out.keypair.pubkey).toBe((await keypairFromMnemonic(m)).pubkey);
    expect(vault.pubkey).toBe(out.keypair.pubkey);
  });

  it("never stores the phrase in clear", async () => {
    const m = newMnemonic();
    const json = JSON.stringify(await encryptMnemonic(m, "correct horse battery", "devnet", FAST));
    for (const w of m.split(" ")) expect(json).not.toContain(` ${w} `);
    expect(json).not.toContain(m);
  });

  it("uses a fresh salt and IV every time", async () => {
    const m = newMnemonic();
    const a = await encryptMnemonic(m, "correct horse battery", "devnet", FAST);
    const b = await encryptMnemonic(m, "correct horse battery", "devnet", FAST);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects a wrong password", async () => {
    const vault = await encryptMnemonic(newMnemonic(), "correct horse battery", "devnet", FAST);
    await expect(decryptVault(vault, "wrong horse battery")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("rejects a tampered ciphertext or a swapped pubkey", async () => {
    const vault = await encryptMnemonic(newMnemonic(), "correct horse battery", "devnet", FAST);
    const ct = base64.decode(vault.ct);
    ct[0] ^= 1;
    await expect(decryptVault({ ...vault, ct: base64.encode(ct) }, "correct horse battery")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    const other = await keypairFromMnemonic(newMnemonic());
    await expect(decryptVault({ ...vault, pubkey: other.pubkey }, "correct horse battery")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("is bound to its network", async () => {
    const vault = await encryptMnemonic(newMnemonic(), "correct horse battery", "devnet", FAST);
    expect(vault.network).toBe("devnet");
    await expect(decryptVault({ ...vault, network: "mainnet" }, "correct horse battery")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("refuses short passwords", async () => {
    await expect(encryptMnemonic(newMnemonic(), "short", "devnet", FAST)).rejects.toThrow();
  });
});

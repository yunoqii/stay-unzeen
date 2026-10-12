import { describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { keypairAtPath, keypairFromMnemonic, LEGACY_ANON_KEY_PATH, newMnemonic } from "./keys";
import { decryptVault, encryptMnemonic, isEncryptedVault, WrongPasswordError, type EncryptedVault } from "./vault";

const FAST = { iterations: 1_000 }; // production uses PBKDF2_ITERATIONS; tests stay fast

describe("vault (PBKDF2 -> AES-GCM)", () => {
  it("round-trips the phrase and yields the same key", async () => {
    const m = newMnemonic();
    const vault = await encryptMnemonic(m, "correct horse battery", "devnet", FAST);
    expect(isEncryptedVault(JSON.parse(JSON.stringify(vault)))).toBe(true);
    const out = await decryptVault(vault, "correct horse battery");
    expect(out.mnemonic).toBe(m);
    expect(out.keypair.pubkey).toBe((await keypairFromMnemonic(m, "devnet")).pubkey);
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
    const other = await keypairFromMnemonic(newMnemonic(), "devnet");
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

  it("upgrades a v1 vault (shared path) to v2 (per-network path) with the same password", async () => {
    const m = newMnemonic();
    const pw = "correct horse battery";
    const v1 = await legacyV1Vault(m, pw, "devnet");
    const out = await decryptVault(v1, pw);
    expect(out.mnemonic).toBe(m);
    expect(out.keypair.pubkey).toBe((await keypairFromMnemonic(m, "devnet")).pubkey);
    expect(out.keypair.pubkey).not.toBe(v1.pubkey);
    expect(out.upgraded).toMatchObject({ v: 2, network: "devnet", pubkey: out.keypair.pubkey });
    const again = await decryptVault(out.upgraded!, pw);
    expect(again.upgraded).toBeUndefined();
    expect(again.keypair.pubkey).toBe(out.keypair.pubkey);
    await expect(decryptVault(v1, "wrong horse battery")).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

/** A vault exactly as web v0.2 wrote it: v1, pubkey on m/44'/133'/0'/0', AAD "unzeen/vault/v1". */
async function legacyV1Vault(mnemonic: string, password: string, network: "devnet" | "mainnet"): Promise<EncryptedVault> {
  const enc = new TextEncoder();
  const { pubkey } = await keypairAtPath(mnemonic, LEGACY_ANON_KEY_PATH);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: FAST.iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(`unzeen/vault/v1\n${network}\n${pubkey}`) },
      key,
      enc.encode(mnemonic),
    ),
  );
  return {
    v: 1,
    network,
    pubkey,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: FAST.iterations, salt: base64.encode(salt) },
    cipher: { name: "AES-GCM", iv: base64.encode(iv) },
    ct: base64.encode(ct),
    createdAt: 0,
  };
}

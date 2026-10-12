import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mnemonicToSeed } from "@scure/bip39";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  anonKeyPath,
  isValidMnemonic,
  keypairAtPath,
  LEGACY_ANON_KEY_PATH,
  keypairFromMnemonic,
  newMnemonic,
  normalizeMnemonic,
  slip10Ed25519,
} from "./keys";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("BIP-39", () => {
  it("matches the reference seed vector (passphrase TREZOR)", async () => {
    const seed = await mnemonicToSeed(ABANDON, "TREZOR");
    expect(bytesToHex(seed)).toBe(
      "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04",
    );
  });

  it("generates valid 12-word phrases", () => {
    for (let i = 0; i < 20; i++) {
      const m = newMnemonic();
      expect(m.split(" ")).toHaveLength(12);
      expect(isValidMnemonic(m)).toBe(true);
    }
  });

  it("rejects bad checksums, wrong length and unknown words", () => {
    expect(isValidMnemonic(ABANDON.replace(/about$/, "abandon"))).toBe(false);
    expect(isValidMnemonic("abandon abandon abandon")).toBe(false);
    expect(isValidMnemonic(ABANDON.replace(/about$/, "unzeen"))).toBe(false);
    // 24 valid words are not accepted: the product uses 12.
    expect(isValidMnemonic(`${ABANDON} ${ABANDON}`)).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    expect(normalizeMnemonic(`  ${ABANDON.toUpperCase().replace(/ /g, "\n  ")} `)).toBe(ABANDON);
  });
});

describe("SLIP-0010 ed25519", () => {
  // SLIP-0010 test vector 1 for ed25519.
  const seed = hexToBytes("000102030405060708090a0b0c0d0e0f");

  it("derives the master key", () => {
    const { key, chainCode } = slip10Ed25519(seed, "m");
    expect(bytesToHex(chainCode)).toBe("90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb");
    expect(bytesToHex(key)).toBe("2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
    expect(bytesToHex(ed25519.getPublicKey(key))).toBe("a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed");
  });

  it("derives m/0' (pubkey cross-checked with node:crypto)", () => {
    const { key, chainCode } = slip10Ed25519(seed, "m/0'");
    expect(bytesToHex(chainCode)).toBe("8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69");
    expect(bytesToHex(key)).toBe("68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
    expect(bytesToHex(ed25519.getPublicKey(key))).toBe("8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c");
  });

  it("rejects non-hardened paths", () => {
    expect(() => slip10Ed25519(seed, "m/0")).toThrow();
  });
});

describe("anon key from mnemonic", () => {
  it("is deterministic and independent of formatting", async () => {
    const a = await keypairFromMnemonic(ABANDON, "devnet");
    const b = await keypairFromMnemonic(`  ${ABANDON.toUpperCase()}  `, "devnet");
    expect(a.pubkey).toBe(b.pubkey);
    expect(a.secretKey).toHaveLength(32);
    expect(a.publicKey).toHaveLength(32);
  });

  it("uses m/44'/133'/<net>'/0': one phrase, a different key per network", async () => {
    expect(anonKeyPath("mainnet")).toBe("m/44'/133'/0'/0'");
    expect(anonKeyPath("devnet")).toBe("m/44'/133'/1'/0'");
    const main = await keypairFromMnemonic(ABANDON, "mainnet");
    const dev = await keypairFromMnemonic(ABANDON, "devnet");
    expect(main.pubkey).not.toBe(dev.pubkey);
    // Golden values: fail if the derivation (path, curve, normalization) ever changes.
    expect(main.pubkey).toBe("3aY2SvoAGX6pYdFfUwqaj8LVn499hDrrQ1w8bJVWbN1E");
    expect(dev.pubkey).toBe("BvSbw1qy4VG3xgvss1kERnc6tY2cAEmouMiBUDhhU8j7");
    // The v0.2 shared path equals today's mainnet path.
    expect((await keypairAtPath(ABANDON, LEGACY_ANON_KEY_PATH)).pubkey).toBe(main.pubkey);
  });

  it("throws on an invalid phrase", async () => {
    await expect(keypairFromMnemonic("not a real phrase", "devnet")).rejects.toThrow();
  });
});

// Backend vectors: core/testdata/unz1-vectors.json, section "anonKey".
const BACKEND = path.resolve(import.meta.dirname, "../../../core/testdata/unz1-vectors.json");

interface AnonKeyCase {
  chainIdHex: string;
  mnemonic: string;
  path: string;
  pubkey: string;
  secretKeyHex: string;
  seedHex: string;
}

const anonCases: AnonKeyCase[] = existsSync(BACKEND)
  ? (JSON.parse(readFileSync(BACKEND, "utf8")) as { anonKey?: { cases?: AnonKeyCase[] } }).anonKey?.cases ?? []
  : [];

describe.skipIf(anonCases.length === 0)("anon key: backend vectors (core/testdata/unz1-vectors.json)", () => {
  for (const c of anonCases) {
    it(`${c.chainIdHex} ${c.path} ${c.mnemonic.split(" ").slice(0, 2).join(" ")}…`, async () => {
      const network = c.chainIdHex === "0101" ? "mainnet" : "devnet";
      expect(anonKeyPath(network)).toBe(c.path);
      expect(bytesToHex(await mnemonicToSeed(c.mnemonic, ""))).toBe(c.seedHex);
      const kp = await keypairFromMnemonic(c.mnemonic, network);
      expect(bytesToHex(kp.secretKey)).toBe(c.secretKeyHex);
      expect(kp.pubkey).toBe(c.pubkey);
    });
  }
});

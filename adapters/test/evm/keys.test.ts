import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { EvmKeyring, EvmKeyStore, evmPath, openEvmKeys, parseMnemonic, resolveEvmCipher } from "../../src/evm/keys";
import { CreatorPubkeyFile, MemoryCreatorIndexCounter } from "../../src/keys";
import { ageCipher, createAgeIdentityFile, generateAgeIdentity } from "../../src/keystore";
import { TEST_MNEMONIC } from "./cases";

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-evm-keys-"));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("EVM HD keys", () => {
  it("BIP-44 coin 60 paths, one hardened account per role", () => {
    expect(evmPath("vault", 3)).toBe("m/44'/60'/0'/0/3");
    expect(evmPath("creator", 7)).toBe("m/44'/60'/1'/0/7");
    expect(evmPath("attest", 1)).toBe("m/44'/60'/2'/0/1");
    expect(evmPath("rebalance", 0)).toBe("m/44'/60'/3'/0/0");
    expect(evmPath("funder", 0)).toBe("m/44'/60'/4'/0/0");
    expect(() => evmPath("vault", -1)).toThrow(RangeError);
  });

  it("derivation matches standard wallets (test mnemonic vectors)", () => {
    const kr = new EvmKeyring(TEST_MNEMONIC);
    expect(kr.vault(0).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"); // anvil/hardhat #0
    expect(kr.vault(1).address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    for (const [role, acct] of [["creator", 1], ["attest", 2], ["rebalance", 3], ["funder", 4]] as const) {
      expect(kr.account(role, 0).address).toBe(mnemonicToAccount(TEST_MNEMONIC, { accountIndex: acct }).address);
    }
  });

  it("roles never share an address", () => {
    const kr = new EvmKeyring(TEST_MNEMONIC);
    const all = [kr.vault(0), kr.vault(1), kr.creator(0), kr.creator(1), kr.funder(), kr.rebalance(), kr.attest("verify"), kr.attest("fair")].map((a) => a.address);
    expect(new Set(all).size).toBe(all.length);
  });

  it("creators come from the counter and are recorded publicly before use", async () => {
    const dir = tmpDir();
    const reg = new CreatorPubkeyFile(path.join(dir, "creator-addresses.json"));
    const kr = new EvmKeyring(TEST_MNEMONIC, new MemoryCreatorIndexCounter(5), reg);
    const i = await kr.allocateCreator();
    expect(i).toBe(5);
    const c = kr.creator(i);
    expect(reg.read().has(c.address)).toBe(true);
    expect(await kr.allocateCreator()).toBe(6);
  });

  it("rejects bad mnemonics", () => {
    expect(() => parseMnemonic("test ".repeat(12))).toThrow(/checksum/);
    expect(() => parseMnemonic("foo ".repeat(12))).toThrow(/word/);
    expect(() => parseMnemonic("test test")).toThrow(/12 or 24/);
    expect(parseMnemonic(`  ${TEST_MNEMONIC}\n`)).toBe(TEST_MNEMONIC);
  });
});

describe("EVM key store (age)", () => {
  it("creates an encrypted 24-word seed once, 0600, stable across opens", async () => {
    const dir = path.join(tmpDir(), "evm");
    const cipher = await ageCipher(await generateAgeIdentity());
    const s1 = EvmKeyStore.open(dir, { cipher, requireEncryption: true });
    const m1 = await s1.mnemonic();
    expect(m1.split(" ")).toHaveLength(24);
    const f = path.join(dir, "evm-seed.txt.age");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f).includes(Buffer.from(m1.split(" ")[0]!))).toBe(false);
    expect(fs.existsSync(path.join(dir, "evm-seed.txt"))).toBe(false);
    const m2 = await EvmKeyStore.open(dir, { cipher }).mnemonic();
    expect(m2).toBe(m1);
    const kr = await s1.keyring({ registry: null, counter: new MemoryCreatorIndexCounter() });
    expect(kr.vault(0).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("mainnet requires encryption; mixed plaintext/encrypted states are refused", async () => {
    const dir = path.join(tmpDir(), "evm");
    expect(() => EvmKeyStore.open(dir, { cipher: null, requireEncryption: true })).toThrow(/encrypted/);
    const cipher = await ageCipher(await generateAgeIdentity());
    await EvmKeyStore.open(dir, { cipher }).mnemonic();
    expect(() => EvmKeyStore.open(dir, { cipher: null })).toThrow(/age-encrypted/);
    const plainDir = path.join(tmpDir(), "evm");
    await EvmKeyStore.open(plainDir, { cipher: null }).mnemonic();
    expect(() => EvmKeyStore.open(plainDir, { cipher })).toThrow(/plaintext/);
  });

  it("age identity: HOOD_* first, Solana fallback, never inside the keys dir", async () => {
    const root = tmpDir();
    const keysDir = path.join(root, "evm");
    const idFile = path.join(root, "id.key");
    await createAgeIdentityFile(idFile, keysDir);
    expect((await resolveEvmCipher(keysDir, { HOOD_KEYS_AGE_KEY_FILE: idFile }))?.source).toBe("HOOD_KEYS_AGE_KEY_FILE");
    expect((await resolveEvmCipher(keysDir, { SOLANA_KEYS_AGE_KEY_FILE: idFile }))?.source).toBe("SOLANA_KEYS_AGE_KEY_FILE");
    expect(await resolveEvmCipher(keysDir, {})).toBeNull();
    const inside = path.join(keysDir, "id.key");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.copyFileSync(idFile, inside);
    await expect(resolveEvmCipher(keysDir, { HOOD_KEYS_AGE_KEY_FILE: inside })).rejects.toThrow(/outside/);
    await expect(openEvmKeys(path.join(root, "m"), "mainnet", {})).rejects.toThrow(/encrypted/);
  });
});

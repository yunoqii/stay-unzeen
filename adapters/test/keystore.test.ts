import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { CreatorKeyring, FileCreatorIndexCounter, MemoryCreatorIndexCounter, ensureVaults, loadVaults } from "../src/keys";
import { KeyStore, ageCipher, createAgeIdentityFile, generateAgeIdentity, resolveAgeIdentity } from "../src/keystore";
import { FileMintVaults } from "../src/relayer/mint-vaults";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-ks-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("age key store", () => {
  it("migrates existing plaintext devnet keys without loss, leaves no plaintext", async () => {
    const root = tmp();
    const keysDir = path.join(root, "devnet", "solana");
    const before = ensureVaults(keysDir, 3).map((k) => Buffer.from(k.secretKey).toString("hex"));
    const seedBefore = fs.readFileSync(path.join(keysDir, (new CreatorKeyring(keysDir), "creator-master.hex")), "utf8");
    fs.writeFileSync(path.join(keysDir, "alt-X.json"), "{}"); // public state stays as is

    const idFile = path.join(root, "solana.agekey");
    await createAgeIdentityFile(idFile, keysDir);
    expect(fs.statSync(idFile).mode & 0o777).toBe(0o600);
    const id = resolveAgeIdentity(keysDir, { SOLANA_KEYS_AGE_KEY_FILE: idFile })!;
    const cipher = await ageCipher(id.identity);

    expect(() => KeyStore.open(keysDir, { cipher })).toThrow(/plaintext/); // refuses before migration
    const plainStore = KeyStore.open(keysDir, { cipher: null });
    expect(plainStore.plaintextSecrets().sort()).toEqual(["creator-master.hex", "vault-0.json", "vault-1.json", "vault-2.json"]);

    const migrator = KeyStore.forMigration(keysDir, cipher);
    const { encrypted } = await migrator.migrate();
    expect(encrypted.length).toBe(4);
    expect(fs.readdirSync(keysDir).sort()).toEqual([
      "alt-X.json", "creator-master.hex.age", "vault-0.json.age", "vault-1.json.age", "vault-2.json.age",
    ]);
    for (const f of fs.readdirSync(keysDir).filter((f) => f.endsWith(".age"))) {
      const raw = fs.readFileSync(path.join(keysDir, f));
      expect(raw.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
      expect(raw.includes(Buffer.from(seedBefore.slice(0, 16)))).toBe(false);
    }

    const ks = KeyStore.open(keysDir, { cipher });
    const after = (await ks.vaults()).map((k) => Buffer.from(k.secretKey).toString("hex"));
    expect(after).toEqual(before);
    expect((await ks.creatorSeed()).toString("hex")).toBe(seedBefore.trim());
    // same creator addresses as before the migration (fees stay collectable)
    const ring = new CreatorKeyring(await ks.creatorSeed(), new MemoryCreatorIndexCounter());
    expect(ring.publicKey(3).equals(new CreatorKeyring(Buffer.from(seedBefore.trim(), "hex"), new MemoryCreatorIndexCounter()).publicKey(3))).toBe(true);
    // re-running is a no-op; a wrong key cannot read
    expect((await migrator.migrate()).encrypted).toEqual([]);
    const other = await ageCipher(await generateAgeIdentity());
    await expect(KeyStore.open(keysDir, { cipher: other }).vaults()).rejects.toThrow();
  });

  it("resumes a crashed migration (both files present) and refuses a conflicting one", async () => {
    const keysDir = tmp();
    ensureVaults(keysDir, 1);
    const cipher = await ageCipher(await generateAgeIdentity());
    const plain = fs.readFileSync(path.join(keysDir, "vault-0.json"));
    fs.writeFileSync(path.join(keysDir, "vault-0.json.age"), await cipher.encrypt(plain));
    const m = KeyStore.forMigration(keysDir, cipher);
    expect((await m.migrate()).encrypted).toEqual(["vault-0.json"]);
    expect(fs.existsSync(path.join(keysDir, "vault-0.json"))).toBe(false);

    // a different plaintext vault-0 next to the .age
    fs.writeFileSync(path.join(keysDir, "vault-0.json"), JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
    await expect(m.migrate()).rejects.toThrow(/different/);
  });

  it("new keys are written encrypted; encryption can be required (mainnet)", async () => {
    const keysDir = tmp();
    const cipher = await ageCipher(await generateAgeIdentity());
    const ks = KeyStore.open(keysDir, { cipher });
    const v = await ks.ensureVaults(2);
    await ks.creatorSeed();
    expect(fs.readdirSync(keysDir).sort()).toEqual(["creator-master.hex.age", "vault-0.json.age", "vault-1.json.age"]);
    expect((await ks.vaults()).map((k) => k.publicKey.toBase58())).toEqual(v.map((k) => k.publicKey.toBase58()));
    // legacy plaintext helpers refuse an encrypted dir (they would mint new plaintext keys)
    expect(() => loadVaults(keysDir)).toThrow(/KeyStore/);
    expect(() => ensureVaults(keysDir, 3)).toThrow(/KeyStore/);
    expect(() => new CreatorKeyring(keysDir)).toThrow(/KeyStore/);
    expect(() => KeyStore.open(keysDir, { cipher: null })).toThrow(/SOLANA_KEYS_AGE_KEY_FILE/);
    expect(() => KeyStore.open(tmp(), { cipher: null, requireEncryption: true })).toThrow(/encrypted/);
  });

  it("identity must live outside the keys dir and not be group/world readable", async () => {
    const keysDir = tmp();
    await expect(createAgeIdentityFile(path.join(keysDir, "k.agekey"), keysDir)).rejects.toThrow(/outside/);
    expect(() => resolveAgeIdentity(keysDir, { SOLANA_KEYS_AGE_KEY_FILE: path.join(keysDir, "x") })).toThrow(/outside/);
    const f = path.join(tmp(), "k.agekey");
    await createAgeIdentityFile(f, keysDir);
    fs.chmodSync(f, 0o644);
    expect(() => resolveAgeIdentity(keysDir, { SOLANA_KEYS_AGE_KEY_FILE: f })).toThrow(/chmod/);
    expect(resolveAgeIdentity(keysDir, {})).toBeNull();
    const inline = await generateAgeIdentity();
    expect(resolveAgeIdentity(keysDir, { SOLANA_KEYS_AGE_KEY: inline })?.source).toBe("SOLANA_KEYS_AGE_KEY");
  });
});

describe("file counters / pins are atomic between processes", () => {
  it("creator counter: parallel next() never repeats an index", async () => {
    const f = path.join(tmp(), "creator-counter.json");
    const a = new FileCreatorIndexCounter(f);
    const b = new FileCreatorIndexCounter(f);
    const got = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).next()));
    expect([...got].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(a.peek()).toBe(20);
  });

  it("mint pins: first writer wins, load counts pins", async () => {
    const f = path.join(tmp(), "mint-vaults.json");
    const a = new FileMintVaults(f);
    const winners = await Promise.all(["v1", "v2", "v3"].map((v, i) => (i % 2 ? a : new FileMintVaults(f)).assign("M", v)));
    expect(new Set(winners).size).toBe(1);
    await a.assign("N", "v9");
    expect(await new FileMintVaults(f).get("M")).toBe(winners[0]);
    expect(await a.load()).toEqual(new Map([[winners[0]!, 1], ["v9", 1]]));
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});

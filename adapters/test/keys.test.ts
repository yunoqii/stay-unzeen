import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CreatorKeyring,
  MemoryCreatorIndexCounter,
  ensureVaults,
  loadVaults,
  slip10Child,
  slip10Master,
} from "../src/keys";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-keys-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("SLIP-0010 ed25519 (official test vector 1)", () => {
  const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  it("master", () => {
    const m = slip10Master(seed);
    expect(m.key.toString("hex")).toBe("2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
    expect(m.chainCode.toString("hex")).toBe("90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb");
  });
  it("m/0'", () => {
    const c = slip10Child(slip10Master(seed), 0);
    expect(c.key.toString("hex")).toBe("68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
    expect(c.chainCode.toString("hex")).toBe("8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69");
  });
});

describe("vaults", () => {
  it("generates once, 0600, stable on reload, ordered", () => {
    const dir = tmp();
    const a = ensureVaults(dir, 3);
    const b = ensureVaults(dir, 3);
    expect(a.map((k) => k.publicKey.toBase58())).toEqual(b.map((k) => k.publicKey.toBase58()));
    expect(new Set(a.map((k) => k.publicKey.toBase58())).size).toBe(3);
    expect(fs.statSync(path.join(dir, "vault-0.json")).mode & 0o777).toBe(0o600);
    fs.renameSync(path.join(dir, "vault-2.json"), path.join(dir, "vault-10.json"));
    expect(loadVaults(dir)[2]?.publicKey.equals(a[2]!.publicKey)).toBe(true);
  });
});

describe("creator keyring", () => {
  it("allocates a fresh, never-reused address per launch", async () => {
    const dir = tmp();
    const ring = new CreatorKeyring(dir);
    const idx = [await ring.allocate(), await ring.allocate(), await ring.allocate()];
    expect(idx).toEqual([0, 1, 2]);
    const addrs = idx.map((i) => ring.publicKey(i).toBase58());
    expect(new Set(addrs).size).toBe(3);
    // persisted counter: a new process continues, does not restart at 0
    expect(await new CreatorKeyring(dir).allocate()).toBe(3);
  });
  it("takes the index source from an injected counter (future Postgres sequence)", async () => {
    const ring = new CreatorKeyring(tmp(), new MemoryCreatorIndexCounter(41));
    expect([await ring.allocate(), await ring.allocate()]).toEqual([41, 42]);
  });
  it("is re-derivable (fees can be collected later) and differs from vaults", () => {
    const dir = tmp();
    const vaults = ensureVaults(dir, 2).map((k) => k.publicKey.toBase58());
    const a = new CreatorKeyring(dir).publicKey(7).toBase58();
    const b = new CreatorKeyring(dir).publicKey(7).toBase58();
    expect(a).toBe(b);
    expect(vaults).not.toContain(a);
    expect(fs.statSync(path.join(dir, "creator-master.hex")).mode & 0o777).toBe(0o600);
  });
  it("different master seeds give different creators", () => {
    expect(new CreatorKeyring(tmp()).publicKey(0).equals(new CreatorKeyring(tmp()).publicKey(0))).toBe(false);
  });
});

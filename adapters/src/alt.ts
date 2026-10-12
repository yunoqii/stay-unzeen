import fs from "node:fs";
import path from "node:path";
import {
  AddressLookupTableProgram,
  PublicKey,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { sendAndConfirm } from "./tx";

/**
 * Address lookup tables for transactions that do not fit 1232 bytes as legacy
 * (pump.fun create_v2 + first buy is ~1476 bytes).
 *
 * One table PER VAULT, owned by that vault: a single shared table would be an
 * on-chain fingerprint linking every vault of the pool together, defeating the
 * sharding. Tables only hold public program/config addresses.
 */
export class LookupTables {
  private readonly cache = new Map<string, AddressLookupTableAccount>();

  constructor(
    private readonly connection: Connection,
    private readonly stateDir: string,
    private readonly priorityMicroLamports = 0,
  ) {}

  /** Returns an active table of `vault` holding at least `addresses`. */
  async ensure(vault: Signer, addresses: readonly PublicKey[]): Promise<AddressLookupTableAccount> {
    const key = vault.publicKey.toBase58();
    const file = path.join(this.stateDir, `alt-${key}.json`);
    let table = this.cache.get(key) ?? (await this.load(file));
    if (!table) {
      table = await this.create(vault, file);
    }
    const have = new Set(table.state.addresses.map((a) => a.toBase58()));
    const missing = uniq(addresses).filter((a) => !have.has(a.toBase58()));
    if (missing.length > 0) {
      table = await this.extend(vault, table.key, missing);
    }
    this.cache.set(key, table);
    return table;
  }

  private async load(file: string): Promise<AddressLookupTableAccount | null> {
    if (!fs.existsSync(file)) return null;
    const { address } = JSON.parse(fs.readFileSync(file, "utf8")) as { address: string };
    // A table from another cluster (or a reset localnet) simply is not found.
    const res = await this.connection.getAddressLookupTable(new PublicKey(address));
    return res.value;
  }

  private async create(vault: Signer, file: string): Promise<AddressLookupTableAccount> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const recentSlot = await this.pickRecentSlot();
      const [ix, address] = AddressLookupTableProgram.createLookupTable({
        authority: vault.publicKey,
        payer: vault.publicKey,
        recentSlot,
      });
      try {
        await sendAndConfirm(this.connection, [ix], vault, [], this.opts());
      } catch (e) {
        lastErr = e;
        if (!isNotRecentSlotError(e)) throw e;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ address: address.toBase58() }) + "\n", { mode: 0o600 });
      return this.waitActive(address, 0);
    }
    throw lastErr;
  }

  /**
   * A slot that is surely in every node's SlotHashes: a real (non-skipped)
   * finalized block a few blocks back. Public RPCs are load-balanced, and the
   * node simulating the tx can lag the one that answered getSlot.
   */
  private async pickRecentSlot(): Promise<number> {
    const finalized = await this.connection.getSlot("finalized");
    const blocks = await this.connection.getBlocks(Math.max(0, finalized - 40), finalized, "finalized").catch(() => []);
    return chooseRecentSlot(blocks, finalized);
  }

  private async extend(vault: Signer, table: PublicKey, addrs: PublicKey[]): Promise<AddressLookupTableAccount> {
    const before = (await this.connection.getAddressLookupTable(table)).value?.state.addresses.length ?? 0;
    for (let i = 0; i < addrs.length; i += 25) {
      const ix: TransactionInstruction = AddressLookupTableProgram.extendLookupTable({
        lookupTable: table,
        authority: vault.publicKey,
        payer: vault.publicKey,
        addresses: addrs.slice(i, i + 25),
      });
      await sendAndConfirm(this.connection, [ix], vault, [], this.opts());
    }
    return this.waitActive(table, before + addrs.length);
  }

  /** New entries are usable only from the slot after the extension. */
  private async waitActive(table: PublicKey, minLen: number): Promise<AddressLookupTableAccount> {
    for (let i = 0; i < 60; i++) {
      const res = await this.connection.getAddressLookupTable(table, { commitment: "confirmed" });
      const t = res.value;
      if (t && t.state.addresses.length >= minLen) {
        const slot = await this.connection.getSlot("confirmed");
        // +2: leaders can lag the confirmed slot we observe.
        if (slot > Number(t.state.lastExtendedSlot) + 2) return t;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`lookup table ${table.toBase58()} did not activate`);
  }

  private opts() {
    return { computeUnits: 50_000, priorityMicroLamports: this.priorityMicroLamports };
  }
}

function uniq(xs: readonly PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Accounts common to two instruction sets built for different random
 * mint/user/creator: the static (non-per-trade) accounts worth putting in a
 * lookup table. Signers are excluded (they cannot come from a table).
 */
export function staticAccounts(a: readonly TransactionInstruction[], b: readonly TransactionInstruction[]): PublicKey[] {
  const keysOf = (ixs: readonly TransactionInstruction[]) => {
    const m = new Map<string, PublicKey>();
    for (const ix of ixs) {
      for (const k of ix.keys) if (!k.isSigner) m.set(k.pubkey.toBase58(), k.pubkey);
    }
    return m;
  };
  const ka = keysOf(a);
  const kb = keysOf(b);
  return [...ka.entries()].filter(([k]) => kb.has(k)).map(([, v]) => v);
}

/** Picks the block `back` blocks before the newest finalized one (falls back to `finalized`). */
export function chooseRecentSlot(finalizedBlocks: readonly number[], finalized: number, back = 8): number {
  if (finalizedBlocks.length === 0) return finalized;
  const sorted = [...finalizedBlocks].sort((a, b) => a - b);
  return sorted[Math.max(0, sorted.length - 1 - back)] ?? finalized;
}

/** ALT program: "<slot> is not a recent slot" (InvalidInstructionData). */
export function isNotRecentSlotError(e: unknown): boolean {
  const parts: string[] = [];
  const collect = (x: unknown) => {
    if (x instanceof Error) parts.push(x.message);
    else if (typeof x === "string") parts.push(x);
  };
  if (e && typeof e === "object" && "error" in e) {
    collect((e as { error: unknown }).error);
    const logs = (e as { logs?: unknown }).logs;
    if (Array.isArray(logs)) logs.forEach(collect);
  } else collect(e);
  return parts.some((p) => /is not a recent slot/i.test(p));
}

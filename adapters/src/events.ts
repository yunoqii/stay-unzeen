import bs58 from "bs58";
import { PUMP_SDK, pumpIdl, type TradeEventBc } from "@pump-fun/pump-sdk";
import type { PublicKey, TokenBalance, VersionedTransactionResponse } from "@solana/web3.js";

/** Anchor `emit_cpi!` tag: sha256("anchor:event")[..8], little-endian. */
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

function eventDiscriminator(name: string): Buffer {
  const ev = (pumpIdl.events as ReadonlyArray<{ name: string; discriminator: number[] }>).find((e) => e.name === name);
  if (!ev) throw new Error(`pump IDL has no event ${name}`);
  return Buffer.from(ev.discriminator);
}

const TRADE_EVENT = eventDiscriminator("TradeEvent");

/**
 * Decodes pump `TradeEvent`s from a confirmed transaction: from self-CPI
 * event instructions (emit_cpi) and, as a fallback, from "Program data:" logs.
 */
export function extractTradeEvents(tx: VersionedTransactionResponse, pumpProgramId: PublicKey): TradeEventBc[] {
  const payloads: Buffer[] = [];
  const meta = tx.meta;
  if (meta?.innerInstructions) {
    const keys = tx.transaction.message.getAccountKeys(
      meta.loadedAddresses ? { accountKeysFromLookups: meta.loadedAddresses } : undefined,
    );
    for (const group of meta.innerInstructions) {
      for (const ix of group.instructions) {
        const program = keys.get(ix.programIdIndex);
        if (!program?.equals(pumpProgramId)) continue;
        const data = Buffer.from(bs58.decode(ix.data));
        if (data.length > 16 && data.subarray(0, 8).equals(EVENT_IX_TAG) && data.subarray(8, 16).equals(TRADE_EVENT)) {
          payloads.push(data.subarray(16));
        }
      }
    }
  }
  if (payloads.length === 0) {
    for (const line of meta?.logMessages ?? []) {
      const m = /^Program data: (.+)$/.exec(line);
      if (!m?.[1]) continue;
      const data = Buffer.from(m[1], "base64");
      if (data.length > 8 && data.subarray(0, 8).equals(TRADE_EVENT)) payloads.push(data.subarray(8));
    }
  }
  const out: TradeEventBc[] = [];
  for (const p of payloads) {
    try {
      out.push(PUMP_SDK.decodeTradeEventBc(p));
    } catch {
      // Layout drift: ignore, caller falls back to balance deltas.
    }
  }
  return out;
}

/** Token balance change of `owner` for `mint` in base units (post - pre). */
export function tokenDelta(tx: VersionedTransactionResponse, owner: PublicKey, mint: PublicKey): bigint {
  const o = owner.toBase58();
  const m = mint.toBase58();
  const sum = (arr: TokenBalance[] | null | undefined): bigint =>
    (arr ?? [])
      .filter((b) => b.owner === o && b.mint === m)
      .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

/** Lamport balance change of `account` (post - pre). */
export function lamportDelta(tx: VersionedTransactionResponse, account: PublicKey): bigint {
  const keys = tx.transaction.message.getAccountKeys(
    tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined,
  );
  for (let i = 0; i < keys.length; i++) {
    if (keys.get(i)?.equals(account)) {
      const pre = tx.meta?.preBalances[i] ?? 0;
      const post = tx.meta?.postBalances[i] ?? 0;
      return BigInt(post) - BigInt(pre);
    }
  }
  return 0n;
}

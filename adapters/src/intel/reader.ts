import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { Connection, PublicKey, type AccountInfo, type Commitment } from "@solana/web3.js";
import type { LargestAccount } from "./metrics";
import { getTransactionAnyVersion } from "../tx";

/**
 * Read side of the intel indexer. Reads go to the READ provider (Shyft,
 * SOLANA_READ_RPC_URL_*), never to the send provider (Helius): no single
 * provider sees both "what we look at" and "what we buy" (rpc-providers R1).
 *
 * `getTokenLargestAccounts` is an "index" call: Shyft Free answers
 * 403 IndexNotAllowedOnFreePlan (checked live 12.10 on devnet and mainnet),
 * the public RPC 429. It therefore goes to a separate INDEX provider
 * (SOLANA_INDEX_RPC_URL_*); without one, holders are simply not computed.
 */
export interface ChainReader {
  getMultipleAccounts(keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
  /** null = no index provider configured (holders skipped). */
  getTokenLargestAccounts(mint: PublicKey): Promise<LargestAccount[] | null>;
  /**
   * Mints of recent pump.fun transactions (decoy pool). `before`: page further
   * back in history (low-activity clusters); returns the oldest signature seen.
   */
  recentPumpMints(sample: number, before?: string): Promise<string[] | { mints: string[]; oldest: string | null }>;
  readonly hasIndex: boolean;
  /** Current slot (DBC fee schedulers on slot-activated configs, API v0.28). Optional. */
  getSlot?(): Promise<number>;
}

/** Token bucket in front of fetch: at most `rps` requests per second (Shyft Free 10 rps). */
export function rateLimitedFetch(rps: number, inner: typeof fetch = fetch): typeof fetch {
  const gap = 1000 / rps;
  let next = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    return inner(input, init);
  }) as typeof fetch;
}

export interface RpcChainReaderOptions {
  readUrl: string;
  readWsUrl?: string | null;
  indexUrl?: string | null;
  rps?: number;
  indexRps?: number;
  commitment?: Commitment;
}

export class RpcChainReader implements ChainReader {
  readonly read: Connection;
  private readonly index: Connection | null;
  readonly hasIndex: boolean;

  constructor(o: RpcChainReaderOptions) {
    const commitment = o.commitment ?? "confirmed";
    this.read = new Connection(o.readUrl, {
      commitment,
      fetch: rateLimitedFetch(o.rps ?? 8),
      ...(o.readWsUrl ? { wsEndpoint: o.readWsUrl } : {}),
    });
    this.index = o.indexUrl ? new Connection(o.indexUrl, { commitment, fetch: rateLimitedFetch(o.indexRps ?? 2) }) : null;
    this.hasIndex = this.index !== null;
  }

  async getMultipleAccounts(keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    const out: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      out.push(...(await this.read.getMultipleAccountsInfo(keys.slice(i, i + 100) as PublicKey[])));
    }
    return out;
  }

  async getSlot(): Promise<number> {
    return this.read.getSlot();
  }

  async getTokenLargestAccounts(mint: PublicKey): Promise<LargestAccount[] | null> {
    if (!this.index) return null;
    const r = await this.index.getTokenLargestAccounts(mint);
    return r.value.map((a) => ({ address: a.address.toBase58(), amount: BigInt(a.amount) }));
  }

  async recentPumpMints(sample: number, before?: string): Promise<{ mints: string[]; oldest: string | null }> {
    const sigs = await this.read.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 100, ...(before ? { before } : {}) });
    const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
    const picked = shuffle(ok).slice(0, sample);
    const mints = new Set<string>();
    for (const sig of picked) {
      // v1 transactions (mainnet 13.10) are read too, not dropped.
      const tx = await getTransactionAnyVersion(this.read, sig).catch(() => null);
      for (const b of tx?.meta?.postTokenBalances ?? []) {
        if (b.mint !== "So11111111111111111111111111111111111111112") mints.add(b.mint);
      }
    }
    return { mints: [...mints], oldest: sigs.at(-1)?.signature ?? null };
  }
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Well-formed base58 32-byte address (CA search input). */
export function isMintAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

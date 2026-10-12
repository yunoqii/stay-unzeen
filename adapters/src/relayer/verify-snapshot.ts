import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection, type Keypair } from "@solana/web3.js";
import type { Pool } from "pg";
import type { MintSource } from "../creator-fees";
import { signDetached, verifyDetached, verifyVaultMessage } from "../ed25519";
import type { SolanaNetwork } from "./postgres-queue";

/**
 * Verify: vault asset snapshot (RELAYER.md v4 §2, docs/analysis/verify.md §4.1).
 *
 * While core holds a snapshot in `collecting` (relayer frozen, nothing in
 * flight), the relayer:
 * 1. reads ALL pool addresses (+ their ATA for every pool mint) on ONE
 *    `finalized` slot with getMultipleAccounts via the read provider;
 * 2. signs `unzeen/verify/v1/vault\n<chainId>\n<id>\n<address>` with each
 *    address's own key (proof the operator controls it, no tx needed);
 * 3. writes `verify_vaults` + `solana_slot` / `assets_done_at` in ONE DB
 *    transaction, only while `freeze_until` has not passed.
 *
 * Addresses: every vault, the attestation key, the Meteora DBC partner key
 * (always, also at 0 SOL: the published set must not shrink and grow with
 * activity), and creator addresses that hold anything at the snapshot slot.
 *
 * Privacy: addresses and balances are public by design (the Verify page lists
 * them). Keys and signatures are never logged; logs carry counts only.
 */

/** One address of the pool and the key that proves it. */
export interface SnapshotSigner {
  key: Keypair;
  /** false: listed only if it holds SOL or tokens at the snapshot slot (creators). */
  always: boolean;
}

export interface VaultBalance {
  address: string;
  lamports: bigint;
  /** Non-zero only, base units as decimal strings, sorted by mint. */
  tokens: { mint: string; amount: string }[];
}

export interface SignedVaultBalance extends VaultBalance {
  sig: string;
}

export interface SnapshotRequest {
  id: number;
  chainId: string;
  /** unix ms; nothing is written after it. */
  freezeUntil: number;
}

// ---------------------------------------------------------------------------
// chain read on one slot
// ---------------------------------------------------------------------------

export interface SlotAccounts {
  slot: number;
  accounts: (AccountInfo<Buffer> | null)[];
}

/** getMultipleAccounts at `finalized` (≤ 100 keys per call). */
export interface FinalizedReader {
  read(keys: readonly PublicKey[], minContextSlot?: number): Promise<SlotAccounts>;
  /** Owners of mint accounts (program of a mint never changes: any slot is fine). */
  owners(keys: readonly PublicKey[]): Promise<(PublicKey | null)[]>;
}

export class RpcFinalizedReader implements FinalizedReader {
  constructor(private readonly connection: Connection) {}
  async read(keys: readonly PublicKey[], minContextSlot?: number): Promise<SlotAccounts> {
    const r = await this.connection.getMultipleAccountsInfoAndContext(keys as PublicKey[], {
      commitment: "finalized",
      ...(minContextSlot !== undefined ? { minContextSlot } : {}),
    });
    return { slot: r.context.slot, accounts: r.value };
  }
  async owners(keys: readonly PublicKey[]): Promise<(PublicKey | null)[]> {
    const out: (PublicKey | null)[] = [];
    for (let i = 0; i < keys.length; i += GMA_LIMIT) {
      const r = await this.connection.getMultipleAccountsInfo(keys.slice(i, i + GMA_LIMIT) as PublicKey[], "finalized");
      out.push(...r.map((a) => a?.owner ?? null));
    }
    return out;
  }
}

export const GMA_LIMIT = 100;

export class SlotMismatchError extends Error {
  constructor() {
    super("finalized slots of the account chunks differ after retries");
    this.name = "SlotMismatchError";
  }
}

/**
 * All `keys` on ONE finalized slot. One chunk: trivially consistent. More:
 * chunks are fetched together, pinned with `minContextSlot` = the highest slot
 * seen; if any chunk answers from another slot, the whole read is repeated.
 */
export async function readOnOneSlot(reader: FinalizedReader, keys: readonly PublicKey[], tries = 6): Promise<SlotAccounts> {
  const chunks: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += GMA_LIMIT) chunks.push(keys.slice(i, i + GMA_LIMIT) as PublicKey[]);
  if (chunks.length === 0) chunks.push([]);
  let pin: number | undefined;
  for (let t = 0; t < tries; t++) {
    const parts = await Promise.all(chunks.map((c) => reader.read(c, pin)));
    const slots = new Set(parts.map((p) => p.slot));
    if (slots.size === 1) return { slot: parts[0]!.slot, accounts: parts.flatMap((p) => p.accounts) };
    pin = Math.max(...slots);
  }
  throw new SlotMismatchError();
}

// ---------------------------------------------------------------------------
// balances
// ---------------------------------------------------------------------------

const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/** SPL Token / Token-2022 account base layout: mint(32) owner(32) amount(u64 LE) … state at 108. */
export function tokenAmountOf(acc: AccountInfo<Buffer> | null, program: PublicKey, mint: PublicKey, owner: PublicKey): bigint {
  if (!acc || !acc.owner.equals(program) || acc.data.length < 165) return 0n;
  const d = acc.data;
  if (!mint.toBuffer().equals(d.subarray(0, 32)) || !owner.toBuffer().equals(d.subarray(32, 64))) return 0n;
  if (d[108] === 0) return 0n; // uninitialized
  return d.readBigUInt64LE(64);
}

export interface BalancePlan {
  addresses: PublicKey[];
  /** mint (base58) -> token program, only for mints whose account exists. */
  mints: { mint: PublicKey; program: PublicKey }[];
  /** keys to read: addresses first, then the ATA of (address i, mint j) at addresses.length + i * mints.length + j. */
  keys: PublicKey[];
  /** Mints skipped (no account / not a token program). */
  unknownMints: number;
}

export async function planBalances(reader: FinalizedReader, addresses: readonly string[], mints: readonly string[]): Promise<BalancePlan> {
  const addrs = [...new Set(addresses)].map((a) => new PublicKey(a));
  const mintKeys = [...new Set(mints)].sort().map((m) => new PublicKey(m));
  const owners = mintKeys.length > 0 ? await reader.owners(mintKeys) : [];
  const known: { mint: PublicKey; program: PublicKey }[] = [];
  mintKeys.forEach((m, i) => {
    const p = owners[i];
    if (p && TOKEN_PROGRAMS.some((t) => t.equals(p))) known.push({ mint: m, program: p });
  });
  const keys = [...addrs];
  for (const a of addrs) {
    for (const m of known) keys.push(getAssociatedTokenAddressSync(m.mint, a, true, m.program));
  }
  return { addresses: addrs, mints: known, keys, unknownMints: mintKeys.length - known.length };
}

export function balancesFromAccounts(plan: BalancePlan, accounts: readonly (AccountInfo<Buffer> | null)[]): VaultBalance[] {
  if (accounts.length !== plan.keys.length) throw new Error("account count mismatch");
  const n = plan.addresses.length;
  const k = plan.mints.length;
  return plan.addresses.map((a, i) => {
    const tokens: { mint: string; amount: string }[] = [];
    plan.mints.forEach((m, j) => {
      const amt = tokenAmountOf(accounts[n + i * k + j] ?? null, m.program, m.mint, a);
      if (amt > 0n) tokens.push({ mint: m.mint.toBase58(), amount: amt.toString() });
    });
    tokens.sort((x, y) => (x.mint < y.mint ? -1 : x.mint > y.mint ? 1 : 0));
    return { address: a.toBase58(), lamports: BigInt(accounts[i]?.lamports ?? 0), tokens };
  });
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

export interface CollectedSnapshot {
  slot: number;
  vaults: SignedVaultBalance[];
  unknownMints: number;
}

/** Reads, filters and signs. Pure w.r.t. the DB (testable with a fake reader). */
export async function collectVaultSnapshot(
  reader: FinalizedReader,
  req: Pick<SnapshotRequest, "id" | "chainId">,
  signers: readonly SnapshotSigner[],
  mints: readonly string[],
): Promise<CollectedSnapshot> {
  if (!/^[0-9a-f]{4}$/.test(req.chainId)) throw new Error("bad chain id");
  const byAddr = new Map<string, SnapshotSigner>();
  for (const s of signers) {
    const a = s.key.publicKey.toBase58();
    const prev = byAddr.get(a);
    byAddr.set(a, prev ? { key: s.key, always: prev.always || s.always } : s);
  }
  const plan = await planBalances(reader, [...byAddr.keys()], mints);
  const { slot, accounts } = await readOnOneSlot(reader, plan.keys);
  const vaults: SignedVaultBalance[] = [];
  for (const b of balancesFromAccounts(plan, accounts)) {
    const s = byAddr.get(b.address)!;
    if (!s.always && b.lamports === 0n && b.tokens.length === 0) continue;
    const msg = verifyVaultMessage(req.chainId, req.id, b.address);
    const sig = signDetached(s.key, msg);
    if (!verifyDetached(b.address, msg, sig)) throw new Error("vault signature self-check failed");
    vaults.push({ ...b, sig });
  }
  vaults.sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
  return { slot, vaults, unknownMints: plan.unknownMints };
}

// ---------------------------------------------------------------------------
// store (role unzeen_relayer: SELECT id/network/chain_id/status/freeze_until/assets_done_at,
// UPDATE solana_slot/assets_done_at on verify_snapshots; SELECT/INSERT on verify_vaults)
// ---------------------------------------------------------------------------

export interface VerifySnapshotStore {
  /** Oldest snapshot of the network waiting for vault assets, still inside its freeze. */
  pending(): Promise<SnapshotRequest | null>;
  /** One transaction; false when the snapshot moved on (other relayer, timeout, skipped). */
  write(id: number, slot: number, vaults: readonly SignedVaultBalance[]): Promise<boolean>;
}

export class PgVerifySnapshotStore implements VerifySnapshotStore {
  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
  ) {}

  async pending(): Promise<SnapshotRequest | null> {
    const r = await this.pool.query<{ id: number; chain_id: string; until_ms: string }>(
      `SELECT id, chain_id, (extract(epoch FROM freeze_until) * 1000)::bigint AS until_ms
         FROM verify_snapshots
        WHERE network = $1 AND status = 'collecting' AND assets_done_at IS NULL AND freeze_until > now()
        ORDER BY id LIMIT 1`,
      [this.network],
    );
    const row = r.rows[0];
    return row ? { id: row.id, chainId: row.chain_id, freezeUntil: Number(row.until_ms) } : null;
  }

  async write(id: number, slot: number, vaults: readonly SignedVaultBalance[]): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      for (const v of vaults) {
        await c.query(
          `INSERT INTO verify_vaults (snapshot_id, address, lamports, tokens, sig)
           VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT DO NOTHING`,
          [id, v.address, v.lamports.toString(), JSON.stringify(v.tokens), v.sig],
        );
      }
      const u = await c.query(
        `UPDATE verify_snapshots SET solana_slot = $2, assets_done_at = now()
          WHERE id = $1 AND network = $3 AND status = 'collecting' AND assets_done_at IS NULL AND freeze_until > now()`,
        [id, slot, this.network],
      );
      if (u.rowCount !== 1) {
        await c.query("ROLLBACK");
        return false;
      }
      await c.query("COMMIT");
      return true;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}

/** True while a Verify snapshot of `network` freezes the relayer (RELAYER v4 §1); false before 0009. */
export async function verifyFrozen(pool: Pool, network: SolanaNetwork): Promise<boolean> {
  const r = await pool.query<{ frozen: boolean }>(
    `SELECT to_regclass('verify_snapshots') IS NOT NULL AS frozen`,
  );
  if (r.rows[0]?.frozen !== true) return false;
  const f = await pool.query<{ frozen: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM verify_snapshots WHERE network = $1 AND status IN ('freezing', 'collecting')
                       AND freeze_until > now()) AS frozen`,
    [network],
  );
  return f.rows[0]?.frozen === true;
}

/** Whether core 0009 is there and this role may write vault snapshots. */
export async function verifySnapshotsWritable(pool: Pool): Promise<boolean> {
  const r = await pool
    .query<{ ok: boolean }>(
      `SELECT to_regclass('verify_vaults') IS NOT NULL
              AND has_table_privilege(current_user, 'verify_vaults', 'INSERT')
              AND has_column_privilege(current_user, 'verify_snapshots', 'assets_done_at', 'UPDATE') AS ok`,
    )
    .catch(() => null);
  return r?.rows[0]?.ok === true;
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

export interface VaultSnapshotterOptions {
  store: VerifySnapshotStore;
  reader: FinalizedReader;
  /** Current signer set (vaults, attestation key, partner, creators). Re-read per snapshot. */
  signers: () => Promise<SnapshotSigner[]>;
  mints: MintSource;
  /** Counts only. */
  log?: (m: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Poll interval range, ms (RELAYER v4: 1–2 s). */
  pollMinMs?: number;
  pollMaxMs?: number;
}

export type SnapshotOutcome = "idle" | "written" | "lost" | "late";

export class VaultSnapshotter {
  constructor(private readonly o: VaultSnapshotterOptions) {}

  /** One poll: nothing pending -> idle; else collect + write. Throws on RPC / DB errors. */
  async tick(): Promise<SnapshotOutcome> {
    const req = await this.o.store.pending();
    if (!req) return "idle";
    const started = (this.o.now ?? Date.now)();
    const [signers, mints] = await Promise.all([this.o.signers(), this.o.mints.mints()]);
    const snap = await collectVaultSnapshot(this.o.reader, req, signers, mints);
    if ((this.o.now ?? Date.now)() >= req.freezeUntil) {
      this.o.log?.("verify snapshot: freeze ended before the assets were read; core skips this snapshot");
      return "late";
    }
    const ok = await this.o.store.write(req.id, snap.slot, snap.vaults);
    const ms = (this.o.now ?? Date.now)() - started;
    this.o.log?.(
      ok
        ? `verify snapshot: ${snap.vaults.length} address(es) written in ${ms} ms${snap.unknownMints ? ` (${snap.unknownMints} mint(s) without account)` : ""}`
        : "verify snapshot: already written or no longer collecting",
    );
    return ok ? "written" : "lost";
  }

  async run(signal: AbortSignal, onError: (e: unknown) => void = () => undefined): Promise<void> {
    const sleep = this.o.sleep ?? abortableSleep;
    const lo = this.o.pollMinMs ?? 1_000;
    const hi = this.o.pollMaxMs ?? 2_000;
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (e) {
        onError(e);
      }
      await sleep(lo + Math.floor(Math.random() * (hi - lo + 1)), signal);
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

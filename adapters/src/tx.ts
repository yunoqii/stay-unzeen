import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  MessageV0,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";

export interface SendOptions {
  computeUnits: number;
  priorityMicroLamports: number;
  /** When set, a v0 transaction is built with these lookup tables. */
  lookupTables?: AddressLookupTableAccount[];
  /**
   * Pool-wide Sender tip (mainnet). When set, EVERY pool transaction carries
   * the same transfer right after the compute budget (R4 / P4): same amount,
   * tip account picked uniformly at random. null/undefined = no tip (devnet).
   */
  tip?: SenderTip | null;
}

/** One tip policy for the whole pool (src/sender.ts builds it from config). */
export interface SenderTip {
  lamports: bigint;
  accounts: readonly PublicKey[];
  /** Uniform index in [0, n); CSPRNG in production. */
  pick: (n: number) => number;
}

/**
 * Sends signed bytes. `preflight: true` = first send (simulate, reject
 * without forwarding on simulation failure); false = rebroadcast of the
 * same bytes. `trySend` is a best-effort rebroadcast that is dropped when the
 * send rate limit is busy (never delays a first send).
 */
export interface Broadcaster {
  readonly name: string;
  send(raw: Uint8Array, o: { preflight: boolean }): Promise<void>;
  trySend(raw: Uint8Array): Promise<void>;
}

export interface SendFailure {
  error: unknown;
  logs: string[] | null;
  signature?: string;
  /**
   * Where it failed:
   * - "build": nothing was signed/sent (e.g. too large);
   * - "preflight": the RPC simulated and rejected it, it was NOT forwarded;
   * - "confirm": it was (or may have been) broadcast; outcome unknown or failed
   *   on chain (`landedErr` true when the chain recorded an error).
   */
  stage?: "build" | "preflight" | "confirm";
  landedErr?: boolean;
}

/** A signed transaction whose signature is known before it is broadcast. */
export interface SignedTx {
  signature: string;
  raw: Uint8Array;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Compute budget prefix of EVERY pool transaction: limit, then price, always
 * both and always in this order (R-relayer-2: no tx shape that tells one
 * execution mode from another). The price is the pool-wide quantized value.
 */
export function computeBudget(opts: Pick<SendOptions, "computeUnits" | "priorityMicroLamports">): TransactionInstruction[] {
  if (!Number.isSafeInteger(opts.priorityMicroLamports) || opts.priorityMicroLamports < 0) {
    throw new RangeError("bad compute unit price");
  }
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }),
  ];
}

/**
 * Prefix of EVERY pool transaction: compute limit, compute price and, when a
 * pool tip is configured, the tip transfer from the fee payer. Same order and
 * amount for buy, sell, create, withdraw and lookup-table transactions.
 */
export function poolPrefix(
  opts: Pick<SendOptions, "computeUnits" | "priorityMicroLamports" | "tip">,
  feePayer: PublicKey,
): TransactionInstruction[] {
  const ixs = computeBudget(opts);
  const tip = opts.tip;
  if (tip) {
    if (tip.lamports <= 0n || tip.accounts.length === 0) throw new RangeError("bad sender tip");
    const i = tip.pick(tip.accounts.length);
    const to = tip.accounts[i];
    if (!to) throw new RangeError("tip account index out of range");
    ixs.push(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: to, lamports: tip.lamports }));
  }
  return ixs;
}

/**
 * Signs a transaction with a fresh blockhash (or `recent`: the legs of one
 * Jito bundle share one blockhash, so they all expire together). Nothing is sent.
 */
export async function signTx(
  connection: Pick<Connection, "getLatestBlockhash">,
  instructions: TransactionInstruction[],
  feePayer: Signer,
  extraSigners: Signer[],
  opts: SendOptions,
  recent?: { blockhash: string; lastValidBlockHeight: number },
): Promise<SignedTx> {
  const budget = poolPrefix(opts, feePayer.publicKey);
  const { blockhash, lastValidBlockHeight } = recent ?? (await connection.getLatestBlockhash("confirmed"));
  const raw = buildSigned([...budget, ...instructions], feePayer, extraSigners, blockhash, lastValidBlockHeight, opts);
  return { signature: signatureOf(raw), raw, blockhash, lastValidBlockHeight };
}

/**
 * Broadcasts a signed transaction (with preflight) and waits for
 * confirmation, rebroadcasting the same bytes until confirmed or expired.
 * Throws `SendFailure` (see `stage`).
 */
export async function broadcastAndConfirm(
  connection: Connection,
  tx: SignedTx,
  broadcaster: Broadcaster = new RpcBroadcaster(connection),
): Promise<{ signature: string; slot: number }> {
  const { raw, signature, blockhash, lastValidBlockHeight } = tx;
  try {
    await broadcaster.send(raw, { preflight: true });
  } catch (error) {
    let logs: string[] | null = null;
    if (error instanceof SendTransactionError) {
      logs = error.logs ?? (await error.getLogs(connection).catch(() => null));
    } else if (Array.isArray((error as { logs?: unknown })?.logs)) {
      logs = (error as { logs: string[] }).logs; // Sender preflight (src/sender.ts)
    }
    // A simulation failure is final for these bytes: the RPC did not forward
    // them. A transport error (timeout, 5xx) may still have forwarded them.
    const stage = isPreflightRejection(error) ? "preflight" : "confirm";
    throw { error, logs, signature, stage } satisfies SendFailure;
  }

  // Public RPCs/leaders drop transactions silently; rebroadcast the same signed
  // bytes until confirmed or the blockhash expires (same signature: no double spend).
  let done = false;
  const rebroadcast = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 2000));
      if (done) break;
      await broadcaster.trySend(raw).catch(() => undefined);
    }
  })();
  let res: Awaited<ReturnType<Connection["confirmTransaction"]>>;
  try {
    res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (error) {
    throw { error, logs: null, signature, stage: "confirm" } satisfies SendFailure;
  } finally {
    done = true;
    await rebroadcast;
  }
  if (res.value.err) {
    const info = await fetchTx(connection, signature);
    throw {
      error: new Error(`transaction failed: ${JSON.stringify(res.value.err)}`),
      logs: info?.meta?.logMessages ?? null,
      signature,
      stage: "confirm",
      landedErr: true,
    } satisfies SendFailure;
  }
  return { signature, slot: res.context.slot };
}

/**
 * Builds, signs, simulates (preflight), sends and confirms one transaction
 * (legacy, or v0 when lookup tables are given). Throws `SendFailure` with the
 * program logs on failure.
 */
export async function sendAndConfirm(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Signer,
  extraSigners: Signer[],
  opts: SendOptions,
  broadcaster?: Broadcaster,
): Promise<{ signature: string; slot: number }> {
  const signed = await signTx(connection, instructions, feePayer, extraSigners, opts);
  return broadcastAndConfirm(connection, signed, broadcaster);
}

/**
 * Serial send gate: at most one send per `minIntervalMs` (Helius Free
 * sendTransaction 1/s, Sender keyless 1/s). FIFO for first sends; `tryRun`
 * runs only when the gate is idle and the interval has passed (rebroadcasts
 * never push a first send back).
 */
export class SendGate {
  private tail: Promise<void> = Promise.resolve();
  private last = -Infinity;
  private waiting = 0;
  constructor(
    readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(minIntervalMs >= 0)) throw new RangeError("minIntervalMs must be >= 0");
  }

  run<T>(f: () => Promise<T>): Promise<T> {
    this.waiting++;
    const p = this.tail.then(async () => {
      const wait = this.last + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      this.waiting--;
      return f();
    });
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async tryRun(f: () => Promise<void>): Promise<boolean> {
    if (this.waiting > 0 || this.now() - this.last < this.minIntervalMs) return false;
    await this.run(f);
    return true;
  }
}

/** Standard `sendTransaction` on the given RPC (devnet; mainnet fallback), rate-gated. */
export class RpcBroadcaster implements Broadcaster {
  readonly name = "rpc";
  constructor(
    private readonly connection: Pick<Connection, "sendRawTransaction">,
    private readonly gate: SendGate = new SendGate(0),
  ) {}

  async send(raw: Uint8Array, o: { preflight: boolean }): Promise<void> {
    await this.gate.run(() =>
      this.connection.sendRawTransaction(
        raw,
        o.preflight ? { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 } : { skipPreflight: true, maxRetries: 0 },
      ),
    );
  }

  async trySend(raw: Uint8Array): Promise<void> {
    await this.gate.tryRun(async () => {
      await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    });
  }
}

/** On-chain state of a signature relative to its blockhash validity. */
export type SignatureState =
  | { state: "landed"; slot: number; err: unknown | null }
  | { state: "pending" } //  not seen, blockhash still valid: may still land
  | { state: "expired" }; // not seen and can never land

/**
 * Whether a previously signed transaction landed ("landed" = confirmed or
 * finalized; "processed" is still "pending"). "expired" is only returned
 * when the FINALIZED block height is past `lastValidBlockHeight` and the
 * signature is still unknown (history searched) — then it can never land and
 * rebuilding is safe.
 */
export async function signatureState(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<SignatureState> {
  // Height first, status second: if the tx lands between the two reads we see it.
  const height = await connection.getBlockHeight("finalized");
  const st = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const s = st.value[0];
  if (s) {
    // Only confirmed/finalized count: a "processed" tx may sit on a fork that
    // gets dropped, settling it would credit a trade that never happened.
    if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") {
      return { state: "landed", slot: s.slot, err: s.err ?? null };
    }
    return { state: "pending" };
  }
  return height > lastValidBlockHeight ? { state: "expired" } : { state: "pending" };
}

function isPreflightRejection(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /Transaction simulation failed|Simulation failed|preflight/i.test(msg);
}

function signatureOf(raw: Uint8Array): string {
  // Wire format: compact-u16 signature count, then 64-byte signatures; the
  // first signature (fee payer) is the transaction id. Count < 128 -> 1 byte.
  const count = raw[0] ?? 0;
  if (count === 0 || count >= 0x80) throw new Error("unexpected transaction encoding");
  return bs58.encode(raw.subarray(1, 65));
}

function buildSigned(
  ixs: TransactionInstruction[],
  feePayer: Signer,
  extraSigners: Signer[],
  blockhash: string,
  lastValidBlockHeight: number,
  opts: SendOptions,
): Uint8Array {
  try {
    if (opts.lookupTables && opts.lookupTables.length > 0) {
      const msg = MessageV0.compile({
        payerKey: feePayer.publicKey,
        instructions: ixs,
        recentBlockhash: blockhash,
        addressLookupTableAccounts: opts.lookupTables,
      });
      const vtx = new VersionedTransaction(msg);
      vtx.sign([feePayer, ...extraSigners]);
      return vtx.serialize();
    }
    const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight });
    tx.add(...ixs);
    tx.sign(feePayer, ...extraSigners);
    return tx.serialize();
  } catch (error) {
    // e.g. "Transaction too large": nothing was sent.
    throw { error, logs: null, stage: "build" } satisfies SendFailure;
  }
}

export async function fetchTx(
  connection: Connection,
  signature: string,
  attempts = 10,
): Promise<VersionedTransactionResponse | null> {
  for (let i = 0; i < attempts; i++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 500 + i * 300));
  }
  return null;
}

export function isSendFailure(x: unknown): x is SendFailure {
  return typeof x === "object" && x !== null && "error" in x && "logs" in x;
}

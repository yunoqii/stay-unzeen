import bs58 from "bs58";
import { Keypair, PublicKey, TransactionInstruction, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { AdapterError, classifyError } from "./errors";
import { fixedPrice, type PriorityPrice } from "./fees";
import { slip10DerivePath } from "./keys";
import type { TxPipeline } from "./sender";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SignedTx } from "./tx";

/**
 * Fair-launch commitment attestation (RELAYER.md v3 `attest`, docs/ARCHITECTURE.md
 * "Commitment root"): one SPL Memo transaction whose data is exactly the 64-hex
 * commitment root, signed (and paid) by the pool's attestation key.
 *
 * The attestation key is its own hardened HD branch of the creator master seed
 * (stored age-encrypted like the vaults): not a vault, not a creator, not the
 * DBC partner. One per network (the seed is per network). Until 28.10 the memo
 * carries no prefix that would name the feature.
 */

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** m/44'/501'/2147483645'/2' — next to the partner key (2147483646'/1'), never a creator index (< 2^31-2). */
export const ATTEST_PATH = [44, 501, 0x7ffffffd, 2] as const;

export function deriveAttestKeypair(creatorMasterSeed: Uint8Array): Keypair {
  return Keypair.fromSeed(slip10DerivePath(creatorMasterSeed, ATTEST_PATH));
}

const ROOT_RE = /^[0-9a-f]{64}$/;

/** Memo data the pool will ever sign: 64 lowercase hex, nothing else. */
export function isCommitmentMemo(memo: string): boolean {
  return ROOT_RE.test(memo);
}

/** The memo instruction: no account keys (the fee payer's signature is the attestation). */
export function memoInstruction(memo: string): TransactionInstruction {
  if (!isCommitmentMemo(memo)) throw new AdapterError("bad_request", "memo must be exactly 64 lowercase hex characters");
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo, "utf8") });
}

/** Data of the (single) top-level memo instruction of a confirmed tx; null when absent / ambiguous. */
export function memoOfTx(tx: VersionedTransactionResponse): string | null {
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys(tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined);
  const memos = msg.compiledInstructions
    .filter((ix) => keys.get(ix.programIdIndex)?.equals(MEMO_PROGRAM_ID))
    .map((ix) => Buffer.from(ix.data).toString("utf8"));
  return memos.length === 1 ? memos[0]! : null;
}

/** Memo CU: SPL Memo costs ~ 100 CU per byte; 64 bytes + headroom. */
export const ATTEST_CU = 30_000;

export interface AttestResult {
  signature: string;
  slot: number;
  signer: string;
  memo: string;
  networkFee: bigint;
  blockTime: number | null;
}

export class Attester {
  private readonly priority: PriorityPrice;

  constructor(
    private readonly connection: Connection,
    readonly key: Keypair,
    priority: number | PriorityPrice = 0,
    /** Same pool pipeline as every other tx: one CU price, the same Sender tip on mainnet. */
    private readonly pipeline: TxPipeline | null = null,
  ) {
    this.priority = typeof priority === "number" ? fixedPrice(priority) : priority;
  }

  get publicKey(): PublicKey {
    return this.key.publicKey;
  }

  async prepare(memo: string): Promise<SignedTx> {
    const ix = memoInstruction(memo);
    try {
      return await signTx(this.connection, [ix], this.key, [], {
        computeUnits: ATTEST_CU,
        priorityMicroLamports: this.priority.microLamports(),
        tip: this.pipeline?.tip ?? null,
      });
    } catch (e) {
      throw this.sendError(e);
    }
  }

  async submit(tx: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.connection, tx, this.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  /** Memo as recorded on chain (never the job's input). Null when unreadable yet. */
  async result(signature: string): Promise<AttestResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx || tx.meta?.err) return null;
    const memo = memoOfTx(tx);
    if (memo === null) return null;
    const payer = tx.transaction.message.staticAccountKeys[0];
    if (!payer?.equals(this.key.publicKey)) return null;
    return {
      signature,
      slot: tx.slot,
      signer: payer.toBase58(),
      memo,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
    };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, [], MEMO_PROGRAM_ID.toBase58(), {}, "memo");
  }

  private sendError(e: unknown): AdapterError {
    if (!isSendFailure(e)) return e instanceof AdapterError ? e : this.classify(e);
    const f: SendFailure = e;
    const err = this.classify(f.error, f.logs);
    return new AdapterError(err.code, err.message, {
      ...(f.signature ? { signature: f.signature } : {}),
      ...(f.stage ? { stage: f.stage } : {}),
      ...(f.landedErr ? { landedErr: true } : {}),
      cause: f.error,
    });
  }
}

/** base58 of the memo data, for tests comparing raw instruction bytes. */
export function memoDataBase58(memo: string): string {
  return bs58.encode(Buffer.from(memo, "utf8"));
}

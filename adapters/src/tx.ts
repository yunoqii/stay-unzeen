import {
  ComputeBudgetProgram,
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
}

export interface SendFailure {
  error: unknown;
  logs: string[] | null;
  signature?: string;
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
): Promise<{ signature: string; slot: number }> {
  const budget: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits })];
  if (opts.priorityMicroLamports > 0) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }));
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const raw = buildSigned([...budget, ...instructions], feePayer, extraSigners, blockhash, lastValidBlockHeight, opts);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5,
    });
  } catch (error) {
    let logs: string[] | null = null;
    if (error instanceof SendTransactionError) {
      logs = error.logs ?? (await error.getLogs(connection).catch(() => null));
    }
    throw { error, logs } satisfies SendFailure;
  }

  // Public RPCs/leaders drop transactions silently; rebroadcast the same signed
  // bytes until confirmed or the blockhash expires (same signature: no double spend).
  let done = false;
  const rebroadcast = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 2000));
      if (done) break;
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  })();
  let res: Awaited<ReturnType<Connection["confirmTransaction"]>>;
  try {
    res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (error) {
    throw { error, logs: null, signature } satisfies SendFailure;
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
    } satisfies SendFailure;
  }
  return { signature, slot: res.context.slot };
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
    throw { error, logs: null } satisfies SendFailure;
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

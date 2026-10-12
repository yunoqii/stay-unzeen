import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type Signer } from "@solana/web3.js";
import { AdapterError, classifyError } from "./errors";
import { lamportDelta, tokenDelta } from "./events";
import { fixedPrice, type PriorityPrice } from "./fees";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SignedTx } from "./tx";

/** One withdraw part = one transaction: SOL gas drop + recipient ATA + token transfer. */
export interface PreparedWithdraw extends SignedTx {
  kind: "withdraw";
  mint: string;
  vault: string;
  to: string;
  amount: bigint;
  gasDropLamports: bigint;
}

export interface WithdrawResult {
  kind: "withdraw";
  signature: string;
  slot: number;
  mint: string;
  vault: string;
  to: string;
  /** Tokens the recipient actually received (base units, from balances). */
  tokenAmount: bigint;
  /** SOL the recipient actually received for gas, lamports. */
  gasDropLamports: bigint;
  networkFee: bigint;
  decimals: number;
  blockTime: number | null;
}

/**
 * Smallest drop: a new system account must end up rent-exempt (~890 880
 * lamports), plus room for a few transactions of the recipient.
 */
export const MIN_GAS_DROP = 1_000_000n;
const CU_WITHDRAW = 60_000;
const FEE_HEADROOM = 100_000n;

export interface WithdrawerOptions {
  connection: Connection;
  /** Pool-wide compute unit price (src/fees.ts cache); a number = fixed. */
  priorityMicroLamports?: number | PriorityPrice;
}

/**
 * Token withdrawals from a vault to a fresh user address. Always sends a SOL
 * gas drop in the same transaction (the user must never fund the new address
 * from their main wallet: that would link it to the vault transfer).
 */
export class TokenWithdrawer {
  private readonly connection: Connection;
  private readonly priority: PriorityPrice;

  constructor(o: WithdrawerOptions) {
    this.connection = o.connection;
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
  }

  /** Pre-checks (address, holdings, SOL) and signs one withdraw part. Sends nothing. */
  async prepare(p: {
    vault: Signer;
    mint: string;
    to: string;
    amount: bigint;
    gasDropLamports: bigint;
    /**
     * Pool-internal move between vaults (consolidation tooling): no gas drop,
     * recipient is a vault. Never used for user withdrawals.
     */
    internal?: boolean;
  }): Promise<PreparedWithdraw> {
    if (p.amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (p.internal ? p.gasDropLamports !== 0n : p.gasDropLamports < MIN_GAS_DROP) {
      throw new AdapterError("bad_request", `gas drop must be >= ${MIN_GAS_DROP} lamports`);
    }
    const to = parseRecipient(p.to);
    if (to.equals(p.vault.publicKey)) throw new AdapterError("bad_request", "recipient is the vault itself");
    const mint = parseKey(p.mint, "mint");
    const mi = await this.rpc(() => this.connection.getAccountInfo(mint));
    if (!mi) throw new AdapterError("not_found", `mint ${p.mint} does not exist`);
    const tokenProgram = mi.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new AdapterError("not_found", `${p.mint} is not an SPL mint`);
    }
    const decimals = unpackMint(mint, mi, tokenProgram).decimals;

    const fromAta = getAssociatedTokenAddressSync(mint, p.vault.publicKey, true, tokenProgram);
    const toAta = getAssociatedTokenAddressSync(mint, to, false, tokenProgram);
    const [fromInfo, toAtaInfo, vaultLamports] = await this.rpc(() =>
      Promise.all([
        this.connection.getAccountInfo(fromAta),
        this.connection.getAccountInfo(toAta),
        this.connection.getBalance(p.vault.publicKey, "confirmed"),
      ]),
    );
    const held = fromInfo ? unpackAccount(fromAta, fromInfo, tokenProgram).amount : 0n;
    if (held < p.amount) throw new AdapterError("insufficient_tokens", `vault holds ${held} < ${p.amount}`);
    // Token-2022 ATA with extensions is up to ~182 bytes.
    const ataRent = toAtaInfo ? 0n : BigInt(await this.rpc(() => this.connection.getMinimumBalanceForRentExemption(182)));
    const need = p.gasDropLamports + ataRent + FEE_HEADROOM;
    if (BigInt(vaultLamports) < need) {
      throw new AdapterError("insufficient_sol", `vault has ${vaultLamports} lamports, needs ~${need}`);
    }

    const ixs = [
      ...(p.gasDropLamports > 0n
        ? [SystemProgram.transfer({ fromPubkey: p.vault.publicKey, toPubkey: to, lamports: p.gasDropLamports })]
        : []),
      createAssociatedTokenAccountIdempotentInstruction(p.vault.publicKey, toAta, to, mint, tokenProgram),
      createTransferCheckedInstruction(fromAta, mint, toAta, p.vault.publicKey, p.amount, decimals, [], tokenProgram),
    ];
    let signed: SignedTx;
    try {
      signed = await signTx(this.connection, ixs, p.vault, [], {
        computeUnits: CU_WITHDRAW,
        priorityMicroLamports: this.priority.microLamports(),
      });
    } catch (e) {
      throw toAdapterError(e);
    }
    return {
      ...signed,
      kind: "withdraw",
      mint: p.mint,
      vault: p.vault.publicKey.toBase58(),
      to: to.toBase58(),
      amount: p.amount,
      gasDropLamports: p.gasDropLamports,
    };
  }

  async submit(p: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.connection, p);
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  /** What actually moved, read from the landed transaction. Null if unreadable yet. */
  async result(signature: string, p: { mint: string; vault: string; to: string }): Promise<WithdrawResult | null> {
    const tx = await fetchTx(this.connection, signature).catch(() => null);
    if (!tx) return null;
    const mint = new PublicKey(p.mint);
    const to = new PublicKey(p.to);
    const decimals =
      [...(tx.meta?.postTokenBalances ?? [])].find((b) => b.mint === p.mint)?.uiTokenAmount.decimals ?? 0;
    return {
      kind: "withdraw",
      signature,
      slot: tx.slot,
      mint: p.mint,
      vault: p.vault,
      to: p.to,
      tokenAmount: tokenDelta(tx, to, mint),
      gasDropLamports: lamportDelta(tx, to),
      networkFee: BigInt(tx.meta?.fee ?? 0),
      decimals,
      blockTime: tx.blockTime ?? null,
    };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, [], "");
  }

  private async rpc<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new AdapterError("venue_unavailable", `RPC error: ${msg.split("\n", 1)[0] ?? msg}`, { cause: e });
    }
  }
}

function toAdapterError(e: unknown): AdapterError {
  if (!isSendFailure(e)) return classifyError(e, null, [], "");
  const err = classifyError(e.error, e.logs, [], "");
  return new AdapterError(err.code, err.message, {
    ...(e.signature ? { signature: e.signature } : {}),
    ...(e.stage ? { stage: e.stage } : {}),
    ...(e.landedErr ? { landedErr: true } : {}),
    cause: e.error,
  });
}

function parseKey(s: string, what: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new AdapterError("bad_request", `invalid ${what} address`);
  }
}

/**
 * Recipient must be a normal wallet address (on the ed25519 curve): tokens
 * sent to a PDA / program account could be unrecoverable for the user.
 */
export function parseRecipient(s: string): PublicKey {
  const pk = parseKey(s, "recipient");
  if (!PublicKey.isOnCurve(pk.toBytes())) throw new AdapterError("bad_request", "recipient is not a wallet address");
  return pk;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { NATIVE_MINT, MINT_SIZE, MintLayout, ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import {
  AddressLookupTableAccount,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { staticAccounts } from "../../src/alt";
import { PriorityFeeCache, type PriorityFeeSource } from "../../src/fees";
import { CreatorKeyring, MemoryCreatorIndexCounter } from "../../src/keys";
import { PumpFunAdapter, type PreparedTrade } from "../../src/pumpfun";
import { Relayer } from "../../src/relayer/engine";
import { PumpFunTradeExecutor } from "../../src/relayer/executors";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { seededRng } from "../../src/relayer/random";
import type { JobSpec } from "../../src/relayer/types";
import { VaultPool } from "../../src/relayer/vaults";
import type { SignedTx } from "../../src/tx";
import { TokenWithdrawer } from "../../src/withdraw";
import { loadParams } from "../helpers";
import { FakeChain, FakeClock, FakeInventory } from "./fakes";

const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

class CountingSource implements PriorityFeeSource {
  readonly name = "counting";
  calls = 0;
  async estimate(): Promise<number> {
    this.calls++;
    return 33_000; // -> level 50 000
  }
}

/** Minimal offline Connection: fixed blockhash, one SPL mint, a vault holding tokens. */
function stubConnection(mint: PublicKey, vault: PublicKey) {
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 10n ** 15n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    mintData,
  );
  const fromAta = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_PROGRAM_ID);
  const accData = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint, owner: vault, amount: 10n ** 12n, delegateOption: 0, delegate: PublicKey.default, state: 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    },
    accData,
  );
  const info = (data: Buffer) => ({ data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1_000_000 });
  return {
    rpcEndpoint: "http://stub.invalid",
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
    getAccountInfo: async (k: PublicKey) => (k.equals(mint) ? info(mintData) : k.equals(fromAta) ? info(accData) : null),
    getBalance: async () => 10 ** 10,
    getMinimumBalanceForRentExemption: async () => 2_039_280,
  };
}

interface Budget {
  units: number | null;
  price: number | null;
  /** Positions of the compute budget instructions in the tx. */
  order: string[];
}

function decode(raw: Uint8Array): { budget: Budget; ixs: { program: string; keys: string[]; data: string }[]; feePayer: string } {
  let ixs: TransactionInstruction[];
  let feePayer: string;
  try {
    const tx = Transaction.from(raw);
    ixs = tx.instructions;
    feePayer = tx.feePayer!.toBase58();
  } catch {
    const v = VersionedTransaction.deserialize(raw);
    const keys = v.message.staticAccountKeys;
    feePayer = keys[0]!.toBase58();
    ixs = v.message.compiledInstructions.map(
      (c) =>
        ({
          programId: keys[c.programIdIndex]!,
          keys: c.accountKeyIndexes.map((i) => ({ pubkey: keys[i] ?? PublicKey.default, isSigner: false, isWritable: false })),
          data: Buffer.from(c.data),
        }) as TransactionInstruction,
    );
  }
  const budget: Budget = { units: null, price: null, order: [] };
  for (const ix of ixs) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    const t = ComputeBudgetInstruction.decodeInstructionType(ix);
    budget.order.push(t);
    if (t === "SetComputeUnitLimit") budget.units = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
    if (t === "SetComputeUnitPrice") budget.price = Number(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
  }
  return {
    budget,
    feePayer,
    ixs: ixs.map((ix) => ({
      program: ix.programId.toBase58(),
      keys: ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "s" : ""}${k.isWritable ? "w" : ""}`),
      data: Buffer.from(ix.data).toString("hex"),
    })),
  };
}

type SignFn = (ixs: TransactionInstruction[], payer: Signer, cu: number, extra?: Signer[], lookupTables?: AddressLookupTableAccount[]) => Promise<SignedTx>;

describe("R-relayer-2: one compute unit price for every pool transaction", () => {
  it("buy / sell / create / withdraw / lookup-table tx all carry the cached, quantized price; no estimate while signing", async () => {
    const src = new CountingSource();
    const fees = new PriorityFeeCache(src);
    await fees.refresh();
    expect(src.calls).toBe(1);

    const vault = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const conn = stubConnection(mint, vault.publicKey);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-fee-"));
    const adapter = new PumpFunAdapter({
      connection: conn as never,
      defaultVault: vault,
      vaults: [vault],
      creators: new CreatorKeyring(Buffer.alloc(64, 7), new MemoryCreatorIndexCounter()),
      stateDir,
      priorityMicroLamports: fees,
    });
    // The single signing path every pump.fun prepare* uses (CU: trade 300k, create 500k).
    const sign = (adapter as unknown as { sign: SignFn }).sign.bind(adapter);
    const transfer = SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });

    const { global, feeConfig } = loadParams();
    const quoteAmount = new BN(10_000_000);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount, quoteMint: NATIVE_MINT });
    const mintKp = Keypair.generate();
    const createIxs = await PUMP_SDK.createV2AndBuyV2Instructions({
      global, mint: mintKp.publicKey, name: "Unzeen", symbol: "UNZ", uri: "https://example.invalid/m.json",
      creator: Keypair.generate().publicKey, user: vault.publicKey, amount, quoteAmount, mayhemMode: false, slippage: 0,
    });

    const buy = await sign([transfer], vault, 300_000);
    const sell = await sign([transfer], vault, 300_000);
    // create is v0 with the vault's own lookup table (as in production).
    const otherIxs = await PUMP_SDK.createV2AndBuyV2Instructions({
      global, mint: Keypair.generate().publicKey, name: "Unzeen", symbol: "UNZ", uri: "https://example.invalid/m.json",
      creator: Keypair.generate().publicKey, user: Keypair.generate().publicKey, amount, quoteAmount, mayhemMode: false, slippage: 0,
    });
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: vault.publicKey,
        addresses: [...staticAccounts(createIxs, otherIxs), global.feeRecipient, ...global.feeRecipients, ...global.buybackFeeRecipients],
      },
    });
    const create = await sign(createIxs, vault, 500_000, [mintKp], [table]);
    const withdraw = await new TokenWithdrawer({ connection: conn as never, priorityMicroLamports: fees }).prepare({
      vault,
      mint: mint.toBase58(),
      to: Keypair.generate().publicKey.toBase58(),
      amount: 1_000n,
      gasDropLamports: 2_000_000n,
    });
    const altOpts = (adapter as unknown as { alts: { opts(): { priorityMicroLamports: number } } }).alts.opts();

    const all = [buy, sell, create, withdraw].map((t) => decode(t.raw));
    for (const d of all) {
      expect(d.budget.price).toBe(50_000);
      expect(d.budget.order).toEqual(["SetComputeUnitLimit", "SetComputeUnitPrice"]);
      // R-relayer-3: the vault pays the fee in the same tx, no fee / tip wallet.
      expect(d.feePayer).toBe(vault.publicKey.toBase58());
      expect(d.ixs.slice(2).every((ix) => ix.program !== ComputeBudgetProgram.programId.toBase58())).toBe(true);
    }
    expect(altOpts.priorityMicroLamports).toBe(50_000);
    expect(src.calls).toBe(1); // signing read the cache only
  });
});

/** pump.fun adapter with offline trades: real signing path, deterministic instructions. */
class OfflinePump extends PumpFunAdapter {
  readonly built: Uint8Array[] = [];
  constructor(
    conn: unknown,
    vault: Keypair,
    fees: PriorityFeeCache,
    private readonly chain: FakeChain,
  ) {
    super({
      connection: conn as never,
      defaultVault: vault,
      vaults: [vault],
      creators: new CreatorKeyring(Buffer.alloc(64, 9), new MemoryCreatorIndexCounter()),
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-tx-")),
      priorityMicroLamports: fees,
    });
  }
  override async prepareBuy(mint: string, lamportsIn: bigint, minOut: bigint, opts: { vault?: Signer } = {}): Promise<PreparedTrade> {
    const v = opts.vault!;
    const data = Buffer.alloc(24);
    data.writeBigUInt64LE(lamportsIn, 8);
    data.writeBigUInt64LE(minOut, 16);
    const ix: TransactionInstruction = {
      programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
      keys: [
        { pubkey: v.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      ],
      data,
    } as TransactionInstruction;
    const signed = await (this as unknown as { sign: SignFn }).sign([ix], v, 300_000);
    this.built.push(signed.raw);
    return { ...signed, kind: "buy", mint, vault: v.publicKey.toBase58(), expectedOut: minOut };
  }
  override async submit(p: SignedTx): Promise<{ signature: string; slot: number }> {
    this.chain.land(p.signature);
    return { signature: p.signature, slot: 1 };
  }
  override async tradeResult(kind: "buy" | "sell", signature: string, vault: string, mint: string) {
    return {
      kind, signature, slot: 1, vault, mint, tokenAmount: 10n, solAmount: 10n, networkFee: 5_000n, decimals: 6,
      fromEvent: true, amountsKnown: true, blockTime: 1,
    } as never;
  }
  override async tokenSymbol(): Promise<string | null> {
    return null;
  }
  override async market(): Promise<never> {
    throw new Error("offline");
  }
}

describe("R-relayer-3: Now and Delayed transactions are identical", () => {
  it("same spec through the now lane and the batch lane -> byte-identical instructions (and messages)", async () => {
    const chain = new FakeChain();
    const clock = new FakeClock(1_700_000_000_000, chain);
    const inv = new FakeInventory();
    const vault = Keypair.generate();
    inv.sol.set(vault.publicKey.toBase58(), 10n ** 10n);
    const src = new CountingSource();
    const fees = new PriorityFeeCache(src);
    await fees.refresh();
    const mint = Keypair.generate().publicKey;
    const adapter = new OfflinePump(stubConnection(mint, vault.publicKey), vault, fees, chain);
    const queue = new InMemoryJobQueue(seededRng(3));
    const relayer = new Relayer({
      queue,
      pool: new VaultPool([vault], inv, seededRng(3)),
      executors: { trade: { pumpfun: new PumpFunTradeExecutor(adapter) }, withdraw: new PumpFunTradeExecutor(adapter) as never },
      probe: chain,
      clock,
      rng: seededRng(3),
    });
    const spec: JobSpec = { kind: "buy", venue: "pumpfun", mint: mint.toBase58(), lamportsIn: 5_000_000n, minOut: 77n };
    const now = queue.enqueue(spec, { notBefore: clock.now(), execMode: "now" });
    const delayed = queue.enqueue(spec, { notBefore: clock.now(), execMode: "delayed" });

    expect(await relayer.tick("now")).toBe(true);
    expect(await relayer.tick("batch")).toBe(true);
    expect(queue.get(now.id)!.state).toBe("executed");
    expect(queue.get(delayed.id)!.state).toBe("executed");
    expect(adapter.built).toHaveLength(2);

    const [a, b] = adapter.built.map(decode);
    expect(a!.ixs).toEqual(b!.ixs);
    expect(a!.budget).toEqual({ units: 300_000, price: 50_000, order: ["SetComputeUnitLimit", "SetComputeUnitPrice"] });
    expect(Buffer.from(adapter.built[0]!).equals(Buffer.from(adapter.built[1]!))).toBe(true);
    expect(src.calls).toBe(1);
  });
});

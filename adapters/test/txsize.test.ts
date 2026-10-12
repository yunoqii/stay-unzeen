import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { staticAccounts } from "../src/alt";
import { loadParams } from "./helpers";

const { global, feeConfig } = loadParams();
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

async function createIxs(mint: PublicKey, user: PublicKey, creator: PublicKey) {
  const quoteAmount = new BN(50_000_000);
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: quoteAmount,
    quoteMint: NATIVE_MINT,
  });
  return PUMP_SDK.createV2AndBuyV2Instructions({
    global,
    mint,
    name: "Unzeen Devnet Test Token Name 32",
    symbol: "UNZEEN1234",
    uri: "https://example.invalid/" + "m".repeat(150),
    creator,
    user,
    amount,
    quoteAmount,
    mayhemMode: false,
    slippage: 0,
  });
}

describe("create_v2 + first buy transaction size", () => {
  it("does not fit a legacy tx, fits v0 with a per-vault lookup table (max-length meta)", async () => {
    const vault = Keypair.generate();
    const mint = Keypair.generate();
    const r = () => Keypair.generate().publicKey;
    const ixs = await createIxs(mint.publicKey, vault.publicKey, r());
    const budget = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];

    const legacy = new Transaction({ feePayer: vault.publicKey, recentBlockhash: BLOCKHASH }).add(...budget, ...ixs);
    expect(() => legacy.serialize({ requireAllSignatures: false, verifySignatures: false })).toThrow(/too large/);

    const other = await createIxs(r(), r(), r());
    const statics = staticAccounts(ixs, other);
    // per-trade accounts (mint, vault, creator) must never be in the table
    for (const k of [mint.publicKey, vault.publicKey]) expect(statics.some((s) => s.equals(k))).toBe(false);
    const fee = [global.feeRecipient, ...global.feeRecipients, ...global.buybackFeeRecipients];
    const table = new AddressLookupTableAccount({
      key: r(),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: vault.publicKey,
        addresses: [...statics, ...fee],
      },
    });
    const msg = MessageV0.compile({
      payerKey: vault.publicKey,
      instructions: [...budget, ...ixs],
      recentBlockhash: BLOCKHASH,
      addressLookupTableAccounts: [table],
    });
    const vtx = new VersionedTransaction(msg);
    vtx.sign([vault, mint]);
    const size = vtx.serialize().length;
    expect(size).toBeLessThanOrEqual(1232);
  });
});

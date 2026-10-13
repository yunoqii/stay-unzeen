import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { Keypair } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PUMP_SDK, newBondingCurve } from "@pump-fun/pump-sdk";
import { loadParams } from "./helpers";
import { creatorFeeOf } from "../src/pumpfun";
import { dbcCreatorFee } from "../src/meteora";

/** E4: core's (quantized) min_out goes into the pump instruction byte for byte, never re-derived. */
describe("E4: min_out is passed through unchanged", () => {
  const u64 = (x: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(x);
    return b;
  };
  const { global } = loadParams();
  const curve = { ...newBondingCurve(global), creator: Keypair.generate().publicKey, quoteMint: NATIVE_MINT };
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;

  it("buy_exact_quote_in_v3: min_tokens_out = minOut, spendable = lamportsIn", async () => {
    const minOut = 123_000_000_000n; // 3 significant digits, as core quantizes
    const ixs = await PUMP_SDK.buyExactQuoteInV3Instructions({
      bondingCurve: curve, associatedUserAccountInfo: null, mint, user,
      amount: new BN(minOut.toString()), quoteAmount: new BN("10000000"), slippage: 0,
      tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID,
    } as never);
    const data = Buffer.concat(ixs.map((i) => i.data));
    expect(data.includes(u64(minOut))).toBe(true);
    expect(data.includes(u64(10_000_000n))).toBe(true);
  });

  it("sell_v3: min_sol_output = minLamports", async () => {
    const minLamports = 45_600_000n;
    const ixs = await PUMP_SDK.sellV3Instructions({
      bondingCurve: curve, mint, user,
      amount: new BN("1000000"), quoteAmount: new BN(minLamports.toString()), slippage: 0,
      tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID,
    } as never);
    const data = Buffer.concat(ixs.map((i) => i.data));
    expect(data.includes(u64(minLamports))).toBe(true);
  });
});

describe("v6 out_creator_fee helpers", () => {
  it("pump TradeEvent.creatorFee; DBC creator share of the trading fee (floor)", () => {
    expect(creatorFeeOf({ creatorFee: new BN(30_000) })).toBe(30_000n);
    expect(creatorFeeOf({})).toBeNull();
    expect(dbcCreatorFee(1_001n, 50)).toBe(500n);
    expect(dbcCreatorFee(1_000n, 0)).toBe(0n);
    expect(() => dbcCreatorFee(1n, 101)).toThrow();
  });
});

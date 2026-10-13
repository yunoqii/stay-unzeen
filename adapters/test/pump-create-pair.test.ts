import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda } from "@pump-fun/pump-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { extractCreateEvents } from "../src/events";
import { CreatorKeyring, MemoryCreatorIndexCounter } from "../src/keys";
import { PUMP_QUOTE_DEFAULTS, quoteAssets } from "../src/pool-a";
import { PumpFunAdapter } from "../src/pumpfun";
import { FakeRpc } from "./rpc-fake";

/*
 * pump.fun create WITHOUT a first buy has no TradeEvent: the pair comes from the create
 * parameters stored on the curve (bondingCurve.quoteMint), so tokens.quote_mint is right.
 * Fixture: devnet create 13.10 (logs + curve, pump-create-devnet.json); the tx around the
 * real logs is minimal (no token balances = no buy); the curve's quote is set per case.
 */
const PUMP = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pump-create-devnet.json"), "utf8")) as {
  signature: string; slot: number; blockTime: number; mint: string; logs: string[]; curve: { owner: string; data: string };
};

function txJson(user: PublicKey) {
  return {
    slot: PUMP.slot,
    blockTime: PUMP.blockTime,
    version: "legacy",
    meta: {
      err: null, fee: 5_000, preBalances: [1, 1], postBalances: [1, 1], preTokenBalances: [], postTokenBalances: [], logMessages: PUMP.logs,
      innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, rewards: [], status: { Ok: null }, computeUnitsConsumed: 1,
    },
    transaction: {
      signatures: [PUMP.signature],
      message: {
        accountKeys: [user.toBase58(), PUMP_PROGRAM_ID.toBase58()],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        instructions: [],
        recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
      },
    },
  };
}

async function run(quote: PublicKey | null) {
  const rpc = new FakeRpc();
  const conn = rpc.connection();
  // the create event's user = the vault that created it
  rpc.txs.set(PUMP.signature, txJson(Keypair.generate().publicKey));
  const t0 = (await conn.getTransaction(PUMP.signature, { maxSupportedTransactionVersion: 0 }))!;
  const ce = extractCreateEvents(t0, PUMP_PROGRAM_ID)[0]!;
  rpc.txs.set(PUMP.signature, txJson(ce.user));
  const data = Buffer.from(PUMP.curve.data, "base64");
  // BondingCurve (IDL 4.0.0): disc 8 | 5 x u64 | complete | creator 32 | mayhem | cashback | quote_mint @ 83
  if (quote) quote.toBuffer().copy(data, 83);
  expect(new PublicKey(PUMP_SDK.decodeBondingCurve({ data, owner: PUMP_PROGRAM_ID, executable: false, lamports: 1 }).quoteMint).equals(quote ?? PublicKey.default)).toBe(true);
  rpc.set(bondingCurvePda(new PublicKey(PUMP.mint)), { owner: PUMP.curve.owner, lamports: 1, data: data.toString("base64") });
  const vault = Keypair.generate();
  const a = new PumpFunAdapter({
    connection: conn,
    defaultVault: vault,
    creators: new CreatorKeyring(Buffer.alloc(64, 7), new MemoryCreatorIndexCounter()),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-pcp-")),
    quotes: quoteAssets("devnet", {}, "pumpfun"),
  });
  return a.createResult(PUMP.signature, ce.user.toBase58());
}

describe("pump.fun create without a first buy: pair from the curve", () => {
  it("SOL curve: no pair", async () => {
    const r = (await run(null))!;
    expect(r).toMatchObject({ kind: "create", tokenAmount: 0n, solAmount: 0n });
    expect(r.quoteMint).toBeUndefined();
  });
  it("USDC curve: quote_mint set, 0 units moved", async () => {
    const usdc = new PublicKey(PUMP_QUOTE_DEFAULTS.devnet.USDC!.mint);
    const r = (await run(usdc))!;
    expect(r).toMatchObject({ kind: "create", tokenAmount: 0n, solAmount: 0n, quoteMint: usdc.toBase58(), quoteAmount: 0n });
  });
});

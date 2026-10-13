import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { CreatorDirectory, MemeFunFeeVenue, StaticMintSource, TOKEN_ACCOUNT_RENT } from "../src/creator-fees";
import { anchorEventPayloads } from "../src/events";
import { CreatorKeyring, MemoryCreatorIndexCounter, deriveCreatorKeypair } from "../src/keys";
import {
  CU_MEME_CREATE,
  MEMEFUN_EVENTS,
  MEMEFUN_PROGRAM_ID,
  MemeFunAdapter,
  buyIxs,
  claimCreatorFeesIx,
  createTokenIx,
  curvePda,
  decodeCreateEvent,
  decodeCurve,
  decodeTradeEvent,
  globalPda,
  isContentAddressed,
  metadataPda,
  sellIxs,
} from "../src/memefun";
import { FakeRpc } from "./rpc-fake";

/*
 * meme.fun (venue "memefun"). IDL: on-chain `anchor:idl` of MEME4gf… (mainnet, 13.10).
 * Devnet e2e 13.10 (pnpm memefun:devnet + fees:sweep): create (+ first buy 0.01 SOL), buy
 * 0.02 SOL, sell half, creator-fee claim.
 */
const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "memefun-idl.json"), "utf8")) as {
  instructions: { name: string; discriminator: number[]; accounts: { name: string; signer?: boolean; writable?: boolean; address?: string }[] }[];
  events: { name: string; discriminator: number[] }[];
};
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "memefun-devnet.json"), "utf8")) as {
  mint: string; creator: string; vault: string; curve: { owner: string; data: string };
  txs: Record<"create" | "buy" | "sell" | "claim", { signature: string; result: unknown }>;
};

async function tx(k: keyof typeof FX.txs): Promise<VersionedTransactionResponse> {
  const rpc = new FakeRpc();
  rpc.txs.set(FX.txs[k].signature, FX.txs[k].result);
  return (await rpc.connection().getTransaction(FX.txs[k].signature, { maxSupportedTransactionVersion: 0 }))!;
}
const ixOf = (name: string) => IDL.instructions.find((i) => i.name === name)!;

describe("meme.fun instructions match the on-chain IDL", () => {
  const mint = Keypair.generate().publicKey;
  const accs = { mint, reserve: Keypair.generate().publicKey, solVault: Keypair.generate().publicKey };
  const user = Keypair.generate().publicKey;
  const check = (name: string, ix: { data: Buffer; keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) => {
    const idl = ixOf(name);
    expect([...ix.data.subarray(0, 8)]).toEqual(idl.discriminator);
    expect(ix.keys).toHaveLength(idl.accounts.length);
    idl.accounts.forEach((a, i) => {
      expect([ix.keys[i]!.isSigner, ix.keys[i]!.isWritable], `${name}.${a.name}`).toEqual([!!a.signer, !!a.writable]);
      if (a.address) expect(ix.keys[i]!.pubkey.toBase58(), `${name}.${a.name}`).toBe(a.address);
    });
  };
  it("create_token (14 accounts, 4 signers incl. the creator), buy, sell, claim_creator_fees", () => {
    const creator = Keypair.generate().publicKey;
    const c = createTokenIx({ ...accs, creator, name: "N", symbol: "S", uri: "ipfs://x" });
    check("create_token", c);
    expect(c.keys[1]!.pubkey.equals(curvePda(mint))).toBe(true);
    expect(c.keys[8]!.pubkey.equals(metadataPda(mint))).toBe(true);
    expect(c.keys[13]!.pubkey.equals(globalPda())).toBe(true);
    check("buy", buyIxs(accs, user, 1n, 1n).find((i) => i.programId.equals(MEMEFUN_PROGRAM_ID))!);
    check("sell", sellIxs(accs, user, 1n, 0n).find((i) => i.programId.equals(MEMEFUN_PROGRAM_ID))!);
    check("claim_creator_fees", claimCreatorFeesIx(mint, accs.solVault, creator, Keypair.generate().publicKey));
  });
  it("event discriminators", () => {
    for (const [name, d] of Object.entries(MEMEFUN_EVENTS)) expect([...d]).toEqual(IDL.events.find((e) => e.name === name)!.discriminator);
  });
  it("content-addressed metadata only (program error 6017 otherwise)", () => {
    expect(isContentAddressed("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy")).toBe(true);
    expect(isContentAddressed("https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy")).toBe(true);
    expect(isContentAddressed("https://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")).toBe(true);
    expect(isContentAddressed("https://media.unzeen.example/media/abc.json")).toBe(false);
  });
});

describe("meme.fun events and curve (devnet e2e 13.10)", () => {
  it("curve account decodes: creator = the fresh creator, fees owed claimed to 0", () => {
    const c = decodeCurve(Buffer.from(FX.curve.data, "base64"));
    expect(c.mint.toBase58()).toBe(FX.mint);
    expect(c.creator.toBase58()).toBe(FX.creator);
    expect(c.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(c.creatorFeesOwed).toBe(0n); // after the claim
    expect(c.realSolReserves).toBeGreaterThan(0n);
  });
  it("create: CreateEvent + the vault's first buy (TradeEvent sol = gross lamports in)", async () => {
    const t = await tx("create");
    const ce = anchorEventPayloads(t, MEMEFUN_PROGRAM_ID, MEMEFUN_EVENTS.CreateEvent).map(decodeCreateEvent)[0]!;
    expect(ce).toMatchObject({ name: "Unzeen meme test", symbol: "UNZM" });
    expect(ce.creator.toBase58()).toBe(FX.creator);
    const ev = anchorEventPayloads(t, MEMEFUN_PROGRAM_ID, MEMEFUN_EVENTS.TradeEvent).map(decodeTradeEvent)[0]!;
    expect(ev).toMatchObject({ isBuy: true, solAmount: 10_000_000n, tokenAmount: 177_765_101_483n });
    expect(ev.user.toBase58()).toBe(FX.vault);
    // the creator signed, the vault paid the fee
    const keys = t.transaction.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys[0]).toBe(FX.vault);
    expect(keys.slice(0, t.transaction.message.header.numRequiredSignatures)).toContain(FX.creator);
  });
  it("adapter results read the events", async () => {
    const rpc = new FakeRpc();
    for (const k of ["create", "buy", "sell"] as const) rpc.txs.set(FX.txs[k].signature, FX.txs[k].result);
    const a = new MemeFunAdapter({ connection: rpc.connection(), defaultVault: Keypair.generate(), creators: new CreatorKeyring(Buffer.alloc(64, 1), new MemoryCreatorIndexCounter()), stateDir: os.tmpdir() });
    expect(await a.createResult(FX.txs.create.signature, FX.vault)).toMatchObject({ venue: "memefun", mint: FX.mint, creator: FX.creator, tokenAmount: 177_765_101_483n, solAmount: 10_000_000n, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() });
    expect(await a.tradeResult("buy", FX.txs.buy.signature, FX.vault, FX.mint)).toMatchObject({ tokenAmount: 355_361_725_476n, solAmount: 20_000_000n });
    expect(await a.tradeResult("sell", FX.txs.sell.signature, FX.vault, FX.mint)).toMatchObject({ tokenAmount: 266_563_413_479n, solAmount: 14_826_511n });
    expect(await a.tradeResult("sell", FX.txs.buy.signature, FX.vault, FX.mint)).toBeNull(); // a buy is not a sell
  });
  it("creator-fee claim: amount from ClaimEvent", async () => {
    const v = new MemeFunFeeVenue(new FakeRpc().connection(), new CreatorDirectory(Buffer.alloc(64), 0), new StaticMintSource([]));
    expect(v.collected(await tx("claim"), { venue: "memefun", kind: "creator", mint: FX.mint, authority: FX.creator, lamports: 0n, lockedRent: 0n, frontLamports: 0n })).toBe(439_299n);
  });
});

describe("MemeFunAdapter.prepareCreate (offline, simulation faked)", () => {
  function setup(o: { creatorLeft?: number; err?: unknown } = {}) {
    const rpc = new FakeRpc();
    const vault = Keypair.generate();
    rpc.balances.set(vault.publicKey.toBase58(), 1_000_000_000);
    const createLogs = (FX.txs.create.result as { meta: { logMessages: string[] } }).meta.logMessages;
    rpc.simulate = () => ({ err: o.err ?? null, logs: createLogs, accounts: [{ lamports: o.creatorLeft ?? 100_000_000 - 23_456_789 }] });
    const tables: PublicKey[][] = [];
    const a = new MemeFunAdapter({
      connection: rpc.connection(),
      defaultVault: vault,
      creators: new CreatorKeyring(Buffer.alloc(64, 4), new MemoryCreatorIndexCounter()),
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-meme-")),
      lookupTables: {
        ensure: async (_v: unknown, addrs: readonly PublicKey[]) => {
          tables.push([...addrs]);
          return new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [...addrs] } });
        },
      } as never,
    });
    return { rpc, vault, a, tables };
  }
  const META = { name: "N".repeat(32), symbol: "S".repeat(10), uri: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy" };

  it("the vault funds the fresh creator with exactly what the simulated create took; 5 signers; first buy by the vault", async () => {
    const { a, vault, tables } = setup();
    const p = await a.prepareCreate(META, 10_000_000n, 0n);
    expect(p.expectedOut).toBe(177_765_101_483n); // from the simulated TradeEvent
    const t = VersionedTransaction.deserialize(p.raw);
    const m = t.message;
    const alt = new AddressLookupTableAccount({ key: m.addressTableLookups[0]!.accountKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: tables.at(-1)! } });
    const keys = m.getAccountKeys({ addressLookupTableAccounts: [alt] });
    const signers = m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58());
    expect(signers).toHaveLength(5); // vault, creator, mint, reserve, sol vault
    expect(signers[0]).toBe(vault.publicKey.toBase58());
    expect(signers).toContain(p.creator);
    expect(signers).toContain(p.mint);
    const ixs = m.compiledInstructions.map((ix) => ({ program: keys.get(ix.programIdIndex)!, data: Buffer.from(ix.data), keys: ix.accountKeyIndexes.map((i) => keys.get(i)!) }));
    const fund = ixs.find((i) => i.program.equals(SystemProgram.programId) && i.keys[1]!.toBase58() === p.creator)!;
    expect(fund.keys[0]!.equals(vault.publicKey)).toBe(true);
    expect(fund.data.readBigUInt64LE(4)).toBe(23_456_789n);
    const lim = ixs.find((i) => i.program.equals(ComputeBudgetProgram.programId) && i.data[0] === 2)!;
    expect(lim.data.readUInt32LE(1)).toBe(CU_MEME_CREATE);
    const buy = ixs.find((i) => i.program.equals(MEMEFUN_PROGRAM_ID) && i.data.subarray(0, 8).equals(Buffer.from(ixOf("buy").discriminator)))!;
    expect(buy.keys[7]!.equals(vault.publicKey)).toBe(true); // user = vault
    expect(buy.keys[3]!.equals(getAssociatedTokenAddressSync(new PublicKey(p.mint), vault.publicKey, true, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(buy.keys[4]!.equals(getAssociatedTokenAddressSync(NATIVE_MINT, vault.publicKey, true))).toBe(true);
    expect(p.raw.length).toBeLessThanOrEqual(1232);
    expect(tables.at(-1)!.map((k) => k.toBase58())).not.toContain(p.creator); // per-launch keys stay out of the ALT
  });

  it("refusals before signing: non-IPFS uri, quote pair, fair launch, unmeasurable create, slippage", async () => {
    const { a, rpc } = setup();
    await expect(a.prepareCreate({ ...META, uri: "https://media.example/m.json" }, 1n, 0n)).rejects.toMatchObject({ code: "venue_unavailable" });
    await expect(a.prepareCreate(META, 1n, 0n, { quote: "USDC" })).rejects.toMatchObject({ code: "venue_unavailable" });
    await expect(a.prepareCreate(META, 1n, 0n, { mintKeypair: Keypair.generate() })).rejects.toMatchObject({ code: "bad_request" });
    await expect(setup({ creatorLeft: 100_000_000 }).a.prepareCreate(META, 0n, 0n)).rejects.toMatchObject({ code: "venue_unavailable" });
    await expect(a.prepareCreate(META, 10_000_000n, 10n ** 15n)).rejects.toMatchObject({ code: "slippage" });
    expect(rpc.simulated.length).toBeGreaterThan(0);
  });

  it("simulation errors map to adapter codes (SlippageExceeded -> slippage)", async () => {
    const { a } = setup({ err: { InstructionError: [3, { Custom: 6009 }] } });
    const logs = ["Program MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F invoke [1]", "Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6009. Error Message: x.", "Program MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F failed: custom program error: 0x1779"];
    (a as unknown as { connection: { simulateTransaction: unknown } }).connection.simulateTransaction = async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [3, { Custom: 6009 }] }, logs, accounts: null } });
    await expect(a.prepareCreate(META, 10_000_000n, 0n)).rejects.toMatchObject({ code: "slippage" });
  });
});

describe("meme.fun creator-fee venue", () => {
  it("one target per launch of ours; claim to the creator's WSOL ATA, closed to the vault (only the creator signs besides the vault)", async () => {
    const dir = new CreatorDirectory(Buffer.alloc(64, 2), 1);
    const creator = deriveCreatorKeypair(Buffer.alloc(64, 2), 0);
    const data = Buffer.from(FX.curve.data, "base64");
    creator.publicKey.toBuffer().copy(data, 40); // curve creator := ours
    data.writeBigUInt64LE(500_000n, 8 + 128 + 58); // creator_fees_owed
    const rpc = new FakeRpc();
    rpc.set(curvePda(new PublicKey(FX.mint)), { owner: MEMEFUN_PROGRAM_ID.toBase58(), lamports: 1, data: data.toString("base64") });
    const v = new MemeFunFeeVenue(rpc.connection(), dir, new StaticMintSource([FX.mint, Keypair.generate().publicKey.toBase58()]));
    const [t] = await v.discover();
    expect(t).toMatchObject({ venue: "memefun", kind: "creator", lamports: 500_000n, frontLamports: TOKEN_ACCOUNT_RENT, authority: creator.publicKey.toBase58() });
    const vault = Keypair.generate().publicKey;
    const plan = (await v.build(t!, vault))!;
    const signers = [...new Set(plan.instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())))].sort();
    expect(signers).toEqual([creator.publicKey.toBase58(), vault.toBase58()].sort());
    expect(plan.instructions.at(-1)!.keys[1]!.pubkey.equals(vault)).toBe(true); // close -> vault
    expect(await new MemeFunFeeVenue(rpc.connection(), new CreatorDirectory(Buffer.alloc(64, 9), 2), new StaticMintSource([FX.mint])).discover()).toEqual([]);
  });
});

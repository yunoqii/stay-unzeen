import fs from "node:fs";
import path from "node:path";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID, AccountLayout, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildRelayer } from "../src/relayer/runtime";
import {
  DEFAULT_SENDER_URL,
  HeliusSenderBroadcaster,
  SENDER_TIP_ACCOUNTS,
  SWQOS_MIN_TIP_LAMPORTS,
  senderRequest,
  senderTip,
  senderUrl,
  txPipeline,
} from "../src/sender";
import { SendGate, broadcastAndConfirm, maskTipAccounts, poolPrefix, signTx } from "../src/tx";
import { AddressLookupTableAccount } from "@solana/web3.js";
import { TokenWithdrawer } from "../src/withdraw";

const TIP_SET = new Set(SENDER_TIP_ACCOUNTS);
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

/** Lamports and recipient of the tip transfer at index 2 (after limit + price), or null. */
function tipOf(raw: Uint8Array): { lamports: bigint; to: string } | null {
  const tx = Transaction.from(raw);
  const ix = tx.instructions[2];
  if (!ix || !ix.programId.equals(SystemProgram.programId)) return null;
  try {
    const d = SystemInstruction.decodeTransfer(ix);
    return TIP_SET.has(d.toPubkey.toBase58()) ? { lamports: d.lamports, to: d.toPubkey.toBase58() } : null;
  } catch {
    return null;
  }
}

describe("pool tip prefix", () => {
  it("limit, price, then the same tip transfer; uniform tip account choice", () => {
    const payer = Keypair.generate().publicKey;
    const tip = senderTip();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const ixs = poolPrefix({ computeUnits: 100_000, priorityMicroLamports: 5_000, tip }, payer);
      expect(ixs).toHaveLength(3);
      expect(ixs[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(ixs[1]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      const t = SystemInstruction.decodeTransfer(ixs[2]!);
      expect(t.lamports).toBe(SWQOS_MIN_TIP_LAMPORTS);
      expect(t.fromPubkey.equals(payer)).toBe(true);
      seen.add(t.toPubkey.toBase58());
    }
    expect(seen.size).toBe(SENDER_TIP_ACCOUNTS.length);
  });

  it("no tip -> exactly the compute budget pair (devnet)", () => {
    expect(poolPrefix({ computeUnits: 1, priorityMicroLamports: 0, tip: null }, Keypair.generate().publicKey)).toHaveLength(2);
  });

  it("tip below the SWQOS minimum is refused", () => {
    expect(() => senderTip(4_999n)).toThrow();
    expect(() => loadConfig({ SOLANA_CLUSTER: "devnet", SOLANA_SENDER_TIP_LAMPORTS: "100" })).toThrow();
  });
});

/** Minimal connection for TokenWithdrawer.prepare (no network). */
function fakeConnection(mint: PublicKey, vault: PublicKey): Connection {
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 10n ** 15n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    mintData,
  );
  const ata = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_PROGRAM_ID);
  const ataData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    { mint, owner: vault, amount: 10n ** 9n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default },
    ataData,
  );
  const acc = (data: Buffer): AccountInfo<Buffer> => ({ data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 });
  return {
    getAccountInfo: async (k: PublicKey) => (k.equals(mint) ? acc(mintData) : k.equals(ata) ? acc(ataData) : null),
    getBalance: async () => 1_000_000_000,
    getMinimumBalanceForRentExemption: async () => 2_000_000,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
  } as unknown as Connection;
}

describe("same Sender tip on every pool tx", () => {
  it("buy-like, lookup-table-like and withdraw transactions carry the identical tip", async () => {
    const cfg = loadConfig({ SOLANA_CLUSTER: "mainnet-beta", UNZEEN_ALLOW_MAINNET: "yes", SOLANA_RPC_URL_MAINNET: "https://mainnet.helius-rpc.com/?api-key=k" });
    const vault = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const conn = fakeConnection(mint, vault.publicKey);
    const pipeline = txPipeline(cfg, conn);
    expect(pipeline.tip?.lamports).toBe(SWQOS_MIN_TIP_LAMPORTS);
    expect(pipeline.broadcaster.name).toBe("helius-sender");

    const memo = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    const generic = await signTx(conn, [{ programId: memo, keys: [], data: Buffer.from("x") }], vault, [], { computeUnits: 50_000, priorityMicroLamports: 1_000, tip: pipeline.tip });
    const w = new TokenWithdrawer({ connection: conn, priorityMicroLamports: 1_000, pipeline });
    const wd = await w.prepare({ vault, mint: mint.toBase58(), to: Keypair.generate().publicKey.toBase58(), amount: 1_000n, gasDropLamports: 3_000_000n });
    const tips = [tipOf(generic.raw), tipOf(wd.raw)];
    for (const t of tips) expect(t?.lamports).toBe(SWQOS_MIN_TIP_LAMPORTS);
  });

  it("every signTx / sendAndConfirm call site in src passes the pool tip", () => {
    const src = path.resolve(__dirname, "../src");
    const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    let sites = 0;
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      if (f === "tx.ts") continue;
      for (const m of text.matchAll(/\b(signTx|sendAndConfirm)\(/g)) {
        sites++;
        const window = text.slice(m.index!, m.index! + 400);
        const viaOpts = /this\.opts\(\)/.test(window);
        expect(/tip:/.test(window) || viaOpts, `${f}: ${m[1]} without tip`).toBe(true);
      }
    }
    expect(sites).toBeGreaterThanOrEqual(4); // pumpfun sign, withdraw, alt create + extend
    expect(fs.readFileSync(path.join(src, "alt.ts"), "utf8")).toMatch(/tip: this\.pipeline\?\.tip/);
  });

  it("the relayer builds ONE pipeline shared by trade, lookup-table and withdraw builders", () => {
    const cfg = loadConfig({ SOLANA_CLUSTER: "mainnet-beta", UNZEEN_ALLOW_MAINNET: "yes", SOLANA_RPC_URL_MAINNET: "https://mainnet.helius-rpc.com/?api-key=k" });
    const db = new pg.Pool();
    const rt = buildRelayer({
      cfg,
      connection: new Connection("http://127.0.0.1:1"),
      network: "mainnet-beta",
      keys: { store: {} as never, vaults: [Keypair.generate()], creatorSeed: Buffer.alloc(64, 1) },
      db,
      lockDb: db,
      warn: () => undefined,
      metadata: null,
      mintVaults: {} as never,
      creatorCounter: { next: async () => 0 } as never,
    });
    const adapter = rt.adapter as unknown as { pipeline: unknown; alts: { pipeline: unknown } };
    expect(adapter.pipeline).toBe(rt.pipeline);
    expect(adapter.alts.pipeline).toBe(rt.pipeline);
    expect(rt.pipeline.tip?.lamports).toBe(SWQOS_MIN_TIP_LAMPORTS);
    void db.end();
  });

  it("devnet: plain sendTransaction, no tip", () => {
    const cfg = loadConfig({ SOLANA_CLUSTER: "devnet" });
    const p = txPipeline(cfg, new Connection("http://127.0.0.1:1"));
    expect(p.tip).toBeNull();
    expect(p.broadcaster.name).toBe("rpc");
    expect(cfg.senderUrl).toBeNull();
  });
});

describe("Sender broadcaster", () => {
  it("request: base64, skipPreflight, maxRetries 0", () => {
    const body = senderRequest(new Uint8Array([1, 2, 3])) as { method: string; params: [string, Record<string, unknown>] };
    expect(body.method).toBe("sendTransaction");
    expect(body.params[0]).toBe("AQID");
    expect(body.params[1]).toEqual({ encoding: "base64", skipPreflight: true, maxRetries: 0 });
  });

  it("url: SWQOS-only + api key of the Helius RPC; explicit wins", () => {
    const u = new URL(senderUrl(undefined, "https://mainnet.helius-rpc.com/?api-key=abc"));
    expect(u.searchParams.get("swqos_only")).toBe("true");
    expect(u.searchParams.get("api-key")).toBe("abc");
    expect(senderUrl(" https://x.example/fast ", "https://h/?api-key=abc")).toBe("https://x.example/fast");
    expect(senderUrl(undefined, undefined)).toBe(new URL(DEFAULT_SENDER_URL).toString());
  });

  it("preflight simulation failure: nothing is posted", async () => {
    const posted: unknown[] = [];
    const sim = { simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [2, { Custom: 6001 }] }, logs: ["Program log: x"] } }) };
    const b = new HeliusSenderBroadcaster("https://sender.example/fast", new SendGate(0), sim as never, (async (_u: unknown, init: { body: string }) => {
      posted.push(init.body);
      return new Response("{}");
    }) as never);
    const tx = new Transaction({ feePayer: Keypair.generate().publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 });
    tx.add(SystemProgram.transfer({ fromPubkey: tx.feePayer!, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    const raw = tx.serialize({ requireAllSignatures: false });
    await expect(b.send(raw, { preflight: true })).rejects.toThrow(/simulation failed/);
    expect(posted).toHaveLength(0);
    expect(VersionedTransaction.deserialize(raw)).toBeDefined();
  });

  it("Sender refusal (HTTP 500 + JSON-RPC -32602, e.g. no static tip) is a preflight-stage rejection", async () => {
    const b = new HeliusSenderBroadcaster("https://sender.example/fast", new SendGate(0), null, (async () =>
      new Response(JSON.stringify({ code: -32602, message: "Invalid Request: transaction must send a tip of at least 5000 lamports" }), { status: 500 })) as never);
    // Sender's body here is a bare error object; also the JSON-RPC envelope form.
    const b2 = new HeliusSenderBroadcaster("https://sender.example/fast", new SendGate(0), null, (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "unzeen", error: { code: -32602, message: "Invalid Request: tip" } }), { status: 500 })) as never);
    const payer = Keypair.generate();
    const signed = await signTx({ getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }) } as never,
      [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })], payer, [], { computeUnits: 1, priorityMicroLamports: 0 });
    for (const x of [b, b2]) {
      const e = await broadcastAndConfirm({} as never, signed, x).catch((err: unknown) => err as { stage?: string });
      expect(e).toMatchObject({ stage: "preflight" });
    }
    await expect(b2.send(signed.raw, { preflight: false })).rejects.toThrow(/preflight rejected -32602/);
    // other HTTP failures stay transport errors (may have been forwarded)
    const b3 = new HeliusSenderBroadcaster("https://sender.example/fast", new SendGate(0), null, (async () => new Response("bad gateway", { status: 502 })) as never);
    await expect(b3.send(signed.raw, { preflight: false })).rejects.toThrow(/sender HTTP 502/);
  });

  it("tip account stays STATIC in a v0 tx even when the lookup table holds it (Sender only sees static tips)", async () => {
    const payer = Keypair.generate();
    const tip = senderTip(SWQOS_MIN_TIP_LAMPORTS, () => 0);
    const other = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [other, ...tip.accounts] },
    });
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other, lamports: 1 });
    const signed = await signTx({ getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }) } as never,
      [ix], payer, [], { computeUnits: 1, priorityMicroLamports: 0, tip, lookupTables: [table] });
    const msg = VersionedTransaction.deserialize(signed.raw).message;
    const stat = msg.staticAccountKeys.map((k) => k.toBase58());
    expect(stat).toContain(tip.accounts[0]!.toBase58());
    // the non-tip entry still comes through the table, at its on-chain index 0
    expect(stat).not.toContain(other.toBase58());
    expect(msg.addressTableLookups[0]!.writableIndexes).toEqual([0]);
    // masking keeps indices and leaves tables without tips untouched
    const masked = maskTipAccounts([table], tip.accounts)[0]!;
    expect(masked.state.addresses).toHaveLength(table.state.addresses.length);
    expect(masked.state.addresses[0]!.equals(other)).toBe(true);
    expect(masked.state.addresses.some((a) => TIP_SET.has(a.toBase58()))).toBe(false);
    const plain = new AddressLookupTableAccount({ key: table.key, state: { ...table.state, addresses: [other] } });
    expect(maskTipAccounts([plain], tip.accounts)[0]).toBe(plain);
  });

  it("send gate: one send per interval, FIFO; rebroadcast dropped while busy", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const gate = new SendGate(1_000, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => gate.run(async () => void order.push(i))));
    expect(order).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(await gate.tryRun(async () => undefined)).toBe(false); // interval not passed
    t += 1_000;
    expect(await gate.tryRun(async () => undefined)).toBe(true);
  });
});

describe("priority fee URL is independent of the main RPC (P5)", () => {
  it("mainnet: helius source from SOLANA_PRIORITY_FEE_URL, whatever the main RPC host", () => {
    const c = loadConfig({
      SOLANA_CLUSTER: "mainnet-beta",
      UNZEEN_ALLOW_MAINNET: "yes",
      SOLANA_RPC_URL_MAINNET: "https://rpc.shyft.to/?api_key=k",
      SOLANA_PRIORITY_FEE_URL: "https://mainnet.helius-rpc.com/?api-key=k",
    });
    expect(c.priorityFeeSource).toBe("helius");
    expect(c.priorityFeeUrl).toBe("https://mainnet.helius-rpc.com/?api-key=k");
  });

  it("mainnet default: SOLANA_RPC_URL_MAINNET", () => {
    const c = loadConfig({ SOLANA_CLUSTER: "mainnet-beta", UNZEEN_ALLOW_MAINNET: "yes", SOLANA_RPC_URL_MAINNET: "https://mainnet.helius-rpc.com/?api-key=k" });
    expect(c.priorityFeeUrl).toBe("https://mainnet.helius-rpc.com/?api-key=k");
  });

  it("explicit helius without any URL is an error, not a silent switch", () => {
    expect(() => loadConfig({ SOLANA_CLUSTER: "devnet", SOLANA_PRIORITY_FEE_SOURCE: "helius" })).toThrow(/SOLANA_PRIORITY_FEE_URL/);
  });
});

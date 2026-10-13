import fs from "node:fs";
import path from "node:path";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { extractTradeEvents } from "../src/events";
import { RpcChainReader } from "../src/intel/reader";
import { fetchTx, getTransactionAnyVersion } from "../src/tx";

/* A real mainnet v1 pump.fun trade (13.10, public): web3.js 1.99 parses it once asked with version 1. */
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pump-v1-tx.json"), "utf8")) as { signature: string; result: { version: number } };

function rpcConn(): { conn: Connection; bodies: { method: string; params: unknown[] }[] } {
  const bodies: { method: string; params: unknown[] }[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    bodies.push(body);
    const p = body.params[1] as { maxSupportedTransactionVersion?: number } | undefined;
    // What a real RPC does: refuse v1 when the client only supports v0.
    const result =
      body.method === "getTransaction"
        ? (p?.maxSupportedTransactionVersion ?? -1) >= 1
          ? FX.result
          : undefined
        : body.method === "getSignaturesForAddress"
          ? [{ signature: FX.signature, slot: 1, err: null, memo: null, blockTime: 1, confirmationStatus: "confirmed" }]
          : null;
    const payload =
      result === undefined
        ? { jsonrpc: "2.0", id: body.id, error: { code: -32015, message: "Transaction version (1) is not supported by the requesting client." } }
        : { jsonrpc: "2.0", id: body.id, result };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { conn: new Connection("http://rpc.invalid", { commitment: "confirmed", fetch: f }), bodies };
}

describe("version 1 transactions (mainnet since 2026)", () => {
  it("fixture is a real v1 tx", () => {
    expect(FX.result.version).toBe(1);
  });

  it("getTransactionAnyVersion / fetchTx ask for version 1 and parse it (events, account keys)", async () => {
    const { conn, bodies } = rpcConn();
    const tx = await getTransactionAnyVersion(conn, FX.signature);
    expect(tx?.version).toBe(1);
    expect(extractTradeEvents(tx!, PUMP_PROGRAM_ID)).toHaveLength(1);
    expect(tx!.transaction.message.getAccountKeys().length).toBeGreaterThan(10);
    expect((bodies[0]!.params[1] as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion).toBe(1);
    expect((await fetchTx(conn, FX.signature, 1))?.version).toBe(1);
  });

  it("the old request (version 0) is refused by the RPC, so v1 would have been lost", async () => {
    const { conn } = rpcConn();
    await expect(conn.getTransaction(FX.signature, { maxSupportedTransactionVersion: 0 })).rejects.toThrow(/version \(1\)/);
  });

  it("intel decoy pool (recentPumpMints) reads v1 trades", async () => {
    const { conn } = rpcConn();
    const reader = new RpcChainReader({ readUrl: "http://rpc.invalid" });
    (reader as unknown as { read: Connection }).read = conn;
    const r = await reader.recentPumpMints(1);
    expect(r.mints.length).toBeGreaterThan(0);
  });
});

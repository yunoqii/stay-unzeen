import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

/** Account as served by the fake RPC. */
export interface FakeAccount {
  owner: string;
  lamports: number;
  data: string; // base64
}

/** Mainnet snapshot of scripts/snapshot-launchlab.ts (LaunchLab configs / platforms / rules, USD1 pool A). */
export function launchLabAccounts(): Record<string, FakeAccount> {
  const raw = fs.readFileSync(path.join(__dirname, "fixtures", "launchlab-mainnet-accounts.json.gz"));
  return (JSON.parse(zlib.gunzipSync(raw).toString("utf8")) as { accounts: Record<string, FakeAccount> }).accounts;
}

export function launchLabTxs(): { poolASwap: { signature: string; result: unknown }; devnet: Record<"solCreate" | "quoteCreateStock" | "quoteBuyLeg" | "quoteSell", { signature: string; result: unknown }> } {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "launchlab-txs.json"), "utf8"));
}

/** SPL token account (initialized) holding `amount` of `mint` for `owner`. */
export function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, program: PublicKey = TOKEN_PROGRAM_ID): FakeAccount {
  const b = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    { mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default },
    b,
  );
  return { owner: program.toBase58(), lamports: 2_039_280, data: b.toString("base64") };
}

/**
 * Offline JSON-RPC: accounts from a map, balances per address, fixed slot / blockhash,
 * transactions by signature. Records every method called (`calls`).
 */
export class FakeRpc {
  readonly calls: string[] = [];
  readonly accounts: Map<string, FakeAccount>;
  readonly balances = new Map<string, number>();
  readonly txs = new Map<string, unknown>();
  slot = 370_000_000;
  /** simulateTransaction answer (base64 tx in); default: an error. */
  simulate: (txBase64: string, cfg: { accounts?: { addresses: string[] } }) => { err: unknown; logs: string[]; accounts?: ({ lamports: number } | null)[] } = () => ({ err: "no simulation", logs: [] });
  readonly simulated: string[] = [];

  constructor(accounts: Record<string, FakeAccount> = {}) {
    this.accounts = new Map(Object.entries(accounts));
  }

  set(pk: PublicKey, a: FakeAccount): void {
    this.accounts.set(pk.toBase58(), a);
  }

  connection(): Connection {
    const f = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Req | Req[];
      const out = Array.isArray(body) ? body.map((b) => this.answer(b)) : this.answer(body);
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return new Connection("http://rpc.invalid", { fetch: f, commitment: "confirmed" });
  }

  private acc(k: string): unknown {
    const a = this.accounts.get(k);
    if (!a) return null;
    const len = Buffer.from(a.data, "base64").length;
    return { data: [a.data, "base64"], executable: false, lamports: a.lamports, owner: a.owner, rentEpoch: 0, space: len };
  }

  private answer(r: Req): unknown {
    this.calls.push(r.method);
    const ctx = { context: { slot: this.slot } };
    const p = r.params ?? [];
    let result: unknown;
    switch (r.method) {
      case "getAccountInfo":
        result = { ...ctx, value: this.acc(String(p[0])) };
        break;
      case "getMultipleAccounts":
        result = { ...ctx, value: (p[0] as string[]).map((k) => this.acc(k)) };
        break;
      case "getBalance":
        result = { ...ctx, value: this.balances.get(String(p[0])) ?? 0 };
        break;
      case "getSlot":
        result = this.slot;
        break;
      case "getLatestBlockhash":
        result = { ...ctx, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1_000 } };
        break;
      case "getBlockHeight":
        result = 300_000_000;
        break;
      case "getProgramAccounts": {
        // memcmp filters over the stored accounts of program p[0]
        const cfg = (p[1] ?? {}) as { filters?: { dataSize?: number; memcmp?: { offset: number; bytes: string } }[] };
        const out: unknown[] = [];
        for (const [k, a] of this.accounts) {
          if (a.owner !== String(p[0])) continue;
          const d = Buffer.from(a.data, "base64");
          const ok = (cfg.filters ?? []).every((f) =>
            f.memcmp ? d.subarray(f.memcmp.offset, f.memcmp.offset + 32).equals(new PublicKey(f.memcmp.bytes).toBuffer()) : d.length === f.dataSize,
          );
          if (ok) out.push({ pubkey: k, account: this.acc(k) });
        }
        result = out;
        break;
      }
      case "getMinimumBalanceForRentExemption":
        result = Number(p[0]) === 165 ? 2_039_280 : 890_880 + Number(p[0]) * 6_960;
        break;
      case "simulateTransaction": {
        const tx = String(p[0]);
        this.simulated.push(tx);
        const r = this.simulate(tx, (p[1] ?? {}) as { accounts?: { addresses: string[] } });
        result = {
          ...ctx,
          value: {
            err: r.err, logs: r.logs, unitsConsumed: 1,
            accounts: r.accounts?.map((a) => (a ? { lamports: a.lamports, data: ["", "base64"], owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0 } : null)) ?? null,
          },
        };
        break;
      }
      case "getTransaction":
        result = this.txs.get(String(p[0])) ?? null;
        break;
      default:
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `fake rpc: ${r.method}` } };
    }
    return { jsonrpc: "2.0", id: r.id, result };
  }
}

interface Req {
  id: string | number;
  method: string;
  params?: unknown[];
}

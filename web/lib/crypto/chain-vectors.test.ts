// API v0.18 chain ids (core/testdata/chain-vectors.json): one phrase -> a different anon key per origin
// (m/44'/133'/<net>'/0'), and a request signed for one chainId is invalid on every other.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NETWORK_CONFIG, type Network } from "@/lib/network";
import { anonKeyPath, keypairAtPath, keypairFromMnemonic } from "./keys";
import { signerFromSecret, signRequest, verifyRequest } from "./sign";

interface Case {
  anonKeyPath: string;
  chain: "solana" | "hood";
  chainIdHex: string;
  evmChainId: number | null;
  network: string;
  pubkey: string;
  request: { body: string; method: "POST"; nonce: string; pathQuery: string; sig: string; ts: string };
}

const file = path.resolve(import.meta.dirname, "../../../core/testdata/chain-vectors.json");
const vectors = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { cases: [], invalid: [], mnemonic: "" }) as { cases: Case[]; invalid: string[]; mnemonic: string };
/** Origins the UI has (Robinhood Chain testnet 0212 has none). */
const UI: Record<string, Network> = { "mainnet-beta": "mainnet", devnet: "devnet", hood: "hood" };

describe.skipIf(!existsSync(file))("chain-vectors.json (API v0.18)", () => {
  it.each(vectors.cases.map((c) => [`${c.chain} ${c.network} ${c.chainIdHex}`, c] as const))("%s", async (_, c) => {
    const kp = await keypairAtPath(vectors.mnemonic, c.anonKeyPath);
    expect(kp.pubkey).toBe(c.pubkey);
    const req = { chainId: c.chainIdHex, method: c.request.method, pathWithQuery: c.request.pathQuery, body: c.request.body };
    const headers = signRequest(signerFromSecret(kp.secretKey), req, { nonce: c.request.nonce, ts: Number(c.request.ts) });
    expect(headers["x-unzeen-sig"]).toBe(c.request.sig);
    // Bound to its chainId: every other one (valid or not) rejects it.
    for (const other of ["0101", "0202", "0111", "0212", ...vectors.invalid].filter((x) => x !== c.chainIdHex))
      expect(verifyRequest(headers, { ...req, chainId: other }, Number(c.request.ts) + 1000)).toEqual({ ok: false, reason: "bad_sig" });

    const n = UI[c.network];
    if (!n) return;
    // The UI's own origin config: path, chainId, chain.
    expect(anonKeyPath(n)).toBe(c.anonKeyPath);
    expect((await keypairFromMnemonic(vectors.mnemonic, n)).pubkey).toBe(c.pubkey);
    if (n !== "hood" || NETWORK_CONFIG.hood.chain === "hood") {
      expect(NETWORK_CONFIG[n].chainIdHex).toBe(c.chainIdHex);
      expect(NETWORK_CONFIG[n].chain).toBe(c.chain);
      expect(NETWORK_CONFIG[n].evmChainId ?? null).toBe(c.evmChainId);
    }
  });
});

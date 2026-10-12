import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { keypairFromMnemonic } from "./keys";
import {
  HEADER_NONCE,
  HEADER_SIG,
  HEADER_TS,
  newNonce,
  signerFromSecret,
  signingString,
  signRequest,
  verifyRequest,
  type SignedHeaders,
} from "./sign";
import own from "./testdata/sign-vectors.json";

const signer = signerFromSecret(hexToBytes(own.secretKeyHex));

describe("request signing: web vectors (generated independently with node:crypto)", () => {
  it("derives the same pubkey", () => {
    expect(signer.pubkey).toBe(own.pubkey);
  });

  for (const v of own.vectors) {
    it(v.name, () => {
      const req = { chainId: v.chainId, method: v.method, pathWithQuery: v.pathWithQuery, body: v.body || undefined };
      expect(signingString(req, v.nonce, v.ts)).toBe(v.message);
      const headers = signRequest(signer, req, { nonce: v.nonce, ts: v.ts });
      expect(headers).toEqual(v.headers);
      expect(verifyRequest(v.headers, req, v.ts + 1_000)).toEqual({ ok: true, pubkey: own.pubkey });
      // Bound to the network: the same headers fail for the other chain.
      const other = v.chainId === "0202" ? "0101" : "0202";
      expect(verifyRequest(v.headers, { ...req, chainId: other }, v.ts + 1_000)).toEqual({ ok: false, reason: "bad_sig" });
    });
  }
});

describe("request signing: rules from docs/API.md", () => {
  const req = { chainId: "0202", method: "post", pathWithQuery: "/api/actions", body: '{"op":"claim"}' };

  it("upper-cases the method, puts the domain then the chain id first", () => {
    const s = signingString(req, "00".repeat(16), 1);
    expect(s.split("\n")).toHaveLength(7);
    expect(s.startsWith("unzeen/api/v1\n0202\nPOST\n/api/actions\n")).toBe(true);
    expect(() => signingString({ ...req, chainId: "0A0A" }, "00".repeat(16), 1)).toThrow();
  });

  it("hashes an empty body as sha256 of the empty string", () => {
    expect(signingString({ chainId: "0101", method: "GET", pathWithQuery: "/x" }, "00".repeat(16), 1).split("\n")[4]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("uses a fresh 16-byte hex nonce", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newNonce());
  });

  it("fails verification on any change and outside the 60 s window", () => {
    const now = 1_760_000_000_000;
    const h = signRequest(signer, req, { ts: now });
    expect(verifyRequest(h, req, now).ok).toBe(true);
    expect(verifyRequest(h, { ...req, body: '{"op":"claim" }' }, now)).toEqual({ ok: false, reason: "bad_sig" });
    expect(verifyRequest(h, { ...req, pathWithQuery: "/api/actions?x=1" }, now)).toEqual({ ok: false, reason: "bad_sig" });
    expect(verifyRequest(h, { ...req, method: "GET" }, now)).toEqual({ ok: false, reason: "bad_sig" });
    const otherNonce: SignedHeaders = { ...h, [HEADER_NONCE]: newNonce() };
    expect(verifyRequest(otherNonce, req, now)).toEqual({ ok: false, reason: "bad_sig" });
    expect(verifyRequest(h, req, now + 60_001)).toEqual({ ok: false, reason: "stale" });
    expect(verifyRequest({ ...h, [HEADER_SIG]: "1" }, req, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRequest({}, req, now)).toEqual({ ok: false, reason: "missing" });
  });

  it("signs with the key derived from the phrase", async () => {
    const kp = await keypairFromMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "devnet",
    );
    const h = signRequest(signerFromSecret(kp.secretKey), req);
    expect(verifyRequest(h, req)).toEqual({ ok: true, pubkey: kp.pubkey });
  });
});

// Backend vectors: core/testdata/unz1-vectors.json, section "api".
const BACKEND = path.resolve(import.meta.dirname, "../../../core/testdata/unz1-vectors.json");

interface BackendApiCase {
  name: string;
  expect: "ok" | "stale" | "bad_signature";
  secretKeyHex: string;
  method: string;
  pathQuery: string;
  signedBody: string;
  sentBody: string;
  bodySha256Hex: string;
  message: string;
  now: number;
  headers: SignedHeaders;
  chainIdHex: string;
  verifyChainIdHex: string;
}

const backendApi: BackendApiCase[] = existsSync(BACKEND)
  ? (JSON.parse(readFileSync(BACKEND, "utf8")) as { api?: { cases?: BackendApiCase[] } }).api?.cases ?? []
  : [];

const VERDICT = { ok: "ok", stale: "stale", bad_signature: "bad_sig" } as const;

describe.skipIf(backendApi.length === 0)("request signing: backend vectors (core/testdata/unz1-vectors.json)", () => {
  for (const c of backendApi) {
    it(`${c.name} -> ${c.expect}`, () => {
      const signed = { chainId: c.chainIdHex, method: c.method, pathWithQuery: c.pathQuery, body: c.signedBody || undefined };
      const sent = { chainId: c.verifyChainIdHex, method: c.method, pathWithQuery: c.pathQuery, body: c.sentBody || undefined };
      const ts = Number(c.headers[HEADER_TS]);

      // Same signing string and the same headers from our signer.
      expect(signingString(signed, c.headers[HEADER_NONCE], ts)).toBe(c.message);
      expect(signRequest(signerFromSecret(hexToBytes(c.secretKeyHex)), signed, { nonce: c.headers[HEADER_NONCE], ts })).toEqual(
        c.headers,
      );

      // Same verdict as the backend for what was actually sent.
      const res = verifyRequest(c.headers, sent, c.now);
      expect(res.ok ? "ok" : res.reason).toBe(VERDICT[c.expect]);
    });
  }
});

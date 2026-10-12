// HTTP request signing with the anon key, exactly as in docs/API.md "Подпись запросов anon-ключом":
//
//   unzeen/api/v1\n<METHOD>\n<path?query>\n<hex(sha256(body))>\n<nonce>\n<ts>
//
// Headers: x-unzeen-pubkey (base58), x-unzeen-nonce (16 bytes hex), x-unzeen-ts (unix ms), x-unzeen-sig (base58, 64 bytes).

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

export const SIGN_DOMAIN = "unzeen/api/v1";
export const SIG_WINDOW_MS = 60_000;

export const HEADER_PUBKEY = "x-unzeen-pubkey";
export const HEADER_NONCE = "x-unzeen-nonce";
export const HEADER_TS = "x-unzeen-ts";
export const HEADER_SIG = "x-unzeen-sig";

export type SignedHeaders = {
  [HEADER_PUBKEY]: string;
  [HEADER_NONCE]: string;
  [HEADER_TS]: string;
  [HEADER_SIG]: string;
};

export interface Signer {
  pubkey: string;
  sign(message: Uint8Array): Uint8Array;
}

export interface RequestToSign {
  method: string;
  /** Path plus query exactly as sent, e.g. "/api/orders?status=open". No origin. */
  pathWithQuery: string;
  /** Exact body bytes sent on the wire. Empty / undefined = empty body. */
  body?: string | Uint8Array;
}

const enc = new TextEncoder();

function bodyBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  return typeof body === "string" ? enc.encode(body) : body;
}

export function bodyHash(body?: string | Uint8Array): string {
  return bytesToHex(sha256(bodyBytes(body)));
}

/** The canonical string that gets signed. */
export function signingString(req: RequestToSign, nonce: string, ts: number | string): string {
  if (!req.pathWithQuery.startsWith("/")) throw new Error("pathWithQuery must start with '/'");
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("nonce must be 16 bytes lower-case hex");
  return [SIGN_DOMAIN, req.method.toUpperCase(), req.pathWithQuery, bodyHash(req.body), nonce, String(ts)].join("\n");
}

export function newNonce(): string {
  return bytesToHex(randomBytes(16));
}

export function signerFromSecret(secretKey: Uint8Array): Signer {
  const pubkey = base58.encode(ed25519.getPublicKey(secretKey));
  return { pubkey, sign: (m) => ed25519.sign(m, secretKey) };
}

export function signRequest(
  signer: Signer,
  req: RequestToSign,
  opts: { nonce?: string; ts?: number } = {},
): SignedHeaders {
  const nonce = opts.nonce ?? newNonce();
  const ts = opts.ts ?? Date.now();
  const sig = signer.sign(enc.encode(signingString(req, nonce, ts)));
  return {
    [HEADER_PUBKEY]: signer.pubkey,
    [HEADER_NONCE]: nonce,
    [HEADER_TS]: String(ts),
    [HEADER_SIG]: base58.encode(sig),
  };
}

export type VerifyResult = { ok: true; pubkey: string } | { ok: false; reason: "missing" | "malformed" | "stale" | "bad_sig" };

/**
 * Server-side check, mirrored here for the in-browser mock and for tests.
 * Replay protection (pubkey, nonce) is the caller's job.
 */
export function verifyRequest(
  headers: Record<string, string | undefined>,
  req: RequestToSign,
  now: number = Date.now(),
): VerifyResult {
  const pubkey = headers[HEADER_PUBKEY];
  const nonce = headers[HEADER_NONCE];
  const tsRaw = headers[HEADER_TS];
  const sigRaw = headers[HEADER_SIG];
  if (!pubkey || !nonce || !tsRaw || !sigRaw) return { ok: false, reason: "missing" };
  let pk: Uint8Array, sig: Uint8Array;
  try {
    pk = base58.decode(pubkey);
    sig = base58.decode(sigRaw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (pk.length !== 32 || sig.length !== 64 || !/^[0-9a-f]{32}$/.test(nonce) || !/^\d+$/.test(tsRaw))
    return { ok: false, reason: "malformed" };
  if (Math.abs(now - Number(tsRaw)) > SIG_WINDOW_MS) return { ok: false, reason: "stale" };
  const msg = enc.encode(signingString(req, nonce, tsRaw));
  let valid = false;
  try {
    valid = ed25519.verify(sig, msg, pk);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, pubkey } : { ok: false, reason: "bad_sig" };
}

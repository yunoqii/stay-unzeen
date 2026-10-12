// ZIP-321 payment request URIs (https://zips.z.cash/zip-0321), built in the browser.
//
//   zcash:<address>?amount=<decimal ZEC>&memo=<base64url(memo bytes), no padding>
//
// We only build single-payment URIs, but the parser understands the full grammar (paramindex,
// label/message, req-*) so tests can check our own output the way a wallet would read it.

import { base64urlnopad } from "@scure/base";
import { formatUnits, parseUnits, ZEC_DECIMALS } from "@/lib/format";

export const MEMO_MAX_BYTES = 512; // ZIP-302
const MAX_ZAT = BigInt(21_000_000) * BigInt(100_000_000);

export interface Zip321Payment {
  address: string;
  /** Integer zatoshis. */
  amountZat?: string;
  /** Raw memo bytes. */
  memo?: Uint8Array;
  label?: string;
  message?: string;
}

export class Zip321Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Zip321Error";
  }
}

/** Transparent addresses can't carry a memo (ZIP-321: memo with a t-addr is invalid). */
export function isTransparentAddress(a: string): boolean {
  return /^(t1|t3|tm|t2)[1-9A-HJ-NP-Za-km-z]+$/.test(a);
}

const SHIELDED_RE = /^(u|utest|zs|ztestsapling)1[02-9ac-hj-np-z]+$/;

function checkAddress(a: string) {
  if (!a) throw new Zip321Error("missing address");
  if (!SHIELDED_RE.test(a) && !isTransparentAddress(a)) throw new Zip321Error("not a Zcash address");
}

/** zatoshis -> ZIP-321 amount: decimal ZEC, at most 8 fraction digits, no trailing zeros. */
export function zatToZip321Amount(zat: string): string {
  if (!/^\d+$/.test(zat)) throw new Zip321Error("amount must be an integer number of zatoshis");
  const v = BigInt(zat);
  if (v > MAX_ZAT) throw new Zip321Error("amount exceeds 21M ZEC");
  return formatUnits(v.toString(), ZEC_DECIMALS);
}

/** Percent-encode label/message (qchar: unreserved + a few sub-delims, everything else %XX). */
function qchars(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Single-payment ZIP-321 URI. `memo` is the memo text (UTF-8); it is base64url-encoded here. */
export function buildZip321(p: { address: string; amountZat: string; memo?: string | Uint8Array; label?: string; message?: string }): string {
  checkAddress(p.address);
  if (BigInt(p.amountZat || "0") <= BigInt(0)) throw new Zip321Error("amount must be positive");
  const params = [`amount=${zatToZip321Amount(p.amountZat)}`];
  if (p.memo !== undefined) {
    if (isTransparentAddress(p.address)) throw new Zip321Error("memo is not allowed for a transparent address");
    const bytes = typeof p.memo === "string" ? new TextEncoder().encode(p.memo) : p.memo;
    if (bytes.length > MEMO_MAX_BYTES) throw new Zip321Error("memo longer than 512 bytes");
    params.push(`memo=${base64urlnopad.encode(bytes)}`);
  }
  if (p.label) params.push(`label=${qchars(p.label)}`);
  if (p.message) params.push(`message=${qchars(p.message)}`);
  return `zcash:${p.address}?${params.join("&")}`;
}

const PARAM_RE = /^([a-zA-Z][a-zA-Z0-9+-]*)(?:\.([1-9][0-9]{0,3}))?$/;
const AMOUNT_RE = /^[0-9]+(?:\.[0-9]{1,8})?$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Strict ZIP-321 parser. Returns payments ordered by paramindex (0 = no index). */
export function parseZip321(uri: string): Zip321Payment[] {
  const m = /^zcash:([^?]*)(?:\?(.*))?$/i.exec(uri);
  if (!m) throw new Zip321Error("not a zcash: URI");
  const [, pathAddr, query] = m;
  const byIndex = new Map<number, Partial<Zip321Payment> & { seen: Set<string> }>();
  const slot = (i: number) => {
    let s = byIndex.get(i);
    if (!s) byIndex.set(i, (s = { seen: new Set() }));
    return s;
  };
  if (pathAddr) slot(0).address = pathAddr;

  if (query !== undefined) {
    if (query === "") throw new Zip321Error("empty query");
    for (const part of query.split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Zip321Error(`malformed parameter "${part}"`);
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      const km = PARAM_RE.exec(key);
      if (!km) throw new Zip321Error(`bad parameter name "${key}"`);
      const name = km[1].toLowerCase();
      const idx = km[2] ? Number(km[2]) : 0;
      const s = slot(idx);
      if (s.seen.has(name)) throw new Zip321Error(`duplicate parameter "${key}"`);
      s.seen.add(name);
      switch (name) {
        case "address":
          if (idx === 0 && pathAddr) throw new Zip321Error("address given twice");
          s.address = value;
          break;
        case "amount": {
          if (!AMOUNT_RE.test(value)) throw new Zip321Error(`bad amount "${value}"`);
          const zat = parseUnits(value, ZEC_DECIMALS);
          if (BigInt(zat) > MAX_ZAT) throw new Zip321Error("amount exceeds 21M ZEC");
          s.amountZat = zat;
          break;
        }
        case "memo": {
          if (!B64URL_RE.test(value)) throw new Zip321Error("memo must be base64url without padding");
          let bytes: Uint8Array;
          try {
            bytes = base64urlnopad.decode(value);
          } catch {
            throw new Zip321Error("memo is not valid base64url");
          }
          if (bytes.length > MEMO_MAX_BYTES) throw new Zip321Error("memo longer than 512 bytes");
          s.memo = bytes;
          break;
        }
        case "label":
        case "message":
          try {
            s[name] = decodeURIComponent(value);
          } catch {
            throw new Zip321Error(`bad percent-encoding in ${name}`);
          }
          break;
        default:
          // Unknown required parameters make the whole URI invalid; other unknown ones are ignored.
          if (name.startsWith("req-")) throw new Zip321Error(`unsupported required parameter "${key}"`);
      }
    }
  }

  if (byIndex.size === 0) throw new Zip321Error("no payment");
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, s]) => {
      checkAddress(s.address ?? "");
      if (s.memo && isTransparentAddress(s.address!)) throw new Zip321Error("memo is not allowed for a transparent address");
      if (byIndex.size > 1 && s.amountZat === undefined) throw new Zip321Error("amount is required in multi-payment URIs");
      const { seen: _seen, ...p } = s;
      void _seen;
      return p as Zip321Payment;
    });
}

/** Memo bytes from a parsed payment as text (unz1 memos are UTF-8). */
export function memoText(p: Zip321Payment): string | null {
  return p.memo ? new TextDecoder("utf-8", { fatal: true }).decode(p.memo) : null;
}

/** UI decimal ZEC -> zatoshis, or null if not a valid amount. */
export function zecToZat(v: string): string | null {
  try {
    return parseUnits(v, ZEC_DECIMALS);
  } catch {
    return null;
  }
}

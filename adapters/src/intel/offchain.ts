import { contentName, sanitizeImage, MAX_IMAGE_BYTES } from "../metadata";
import { safeFetch, type SafeFetchOptions } from "./ssrf";
import type { OffchainInfo, TokenSafety } from "./types";

/**
 * Off-chain part of a token (uri JSON -> socials, image -> our /media).
 * Called by the indexer for every mint of a tick batch / warm refresh that has
 * no cached result; the frontend never touches `uri` or `image` (T2).
 */

export const MAX_JSON_BYTES = 64 * 1024;
export const JSON_TIMEOUT_MS = 3_000;
export const IMAGE_TIMEOUT_MS = 5_000;

/** Where re-encoded images go (LocalMetadataStore.putMedia: same dir and URL scheme as the relayer's media). */
export interface MediaSink {
  putMedia(name: string, bytes: Buffer, mime: string): Promise<string>;
}

export interface OffchainDeps {
  media: MediaSink | null;
  ipfsGateway: string;
  now?: () => number;
  /** Test injection, same contract as safeFetch. */
  fetcher?: (url: string, o: SafeFetchOptions) => Promise<{ body: Buffer; contentType: string | null }>;
  lookup?: SafeFetchOptions["lookup"];
}

export async function fetchOffchain(uri: string, d: OffchainDeps): Promise<OffchainInfo> {
  const now = d.now ?? Date.now;
  const fetcher = d.fetcher ?? safeFetch;
  const base = { ipfsGateway: d.ipfsGateway, ...(d.lookup ? { lookup: d.lookup } : {}) };
  let doc: Record<string, unknown>;
  try {
    const r = await fetcher(uri, { ...base, maxBytes: MAX_JSON_BYTES, timeoutMs: JSON_TIMEOUT_MS, accept: "application/json" });
    const parsed = JSON.parse(r.body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    doc = parsed as Record<string, unknown>;
  } catch {
    return { fetchedAt: now(), ok: false };
  }
  const info: OffchainInfo = { fetchedAt: now(), ok: true };
  const socials = normalizeSocials(doc);
  if (socials) info.socials = socials;
  const image = typeof doc.image === "string" ? doc.image : null;
  if (image && d.media) {
    try {
      const r = await fetcher(image, { ...base, maxBytes: MAX_IMAGE_BYTES, timeoutMs: IMAGE_TIMEOUT_MS, accept: "image/png,image/jpeg,image/webp" });
      const img = await sanitizeImage(r.body); // re-encoded from pixels: no EXIF/XMP/ICC, no polyglot tail
      info.image = await d.media.putMedia(contentName(img.bytes, img.ext), img.bytes, img.mime);
    } catch {
      /* no image: socials still count */
    }
  }
  return info;
}

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const TG_HOSTS = new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]);

/**
 * Only normalized https links: twitter -> https://x.com/<path>, telegram ->
 * https://t.me/<path>, website -> https://host/path (no query, fragment or
 * credentials: tracking parameters are the author's, not ours).
 */
export function normalizeSocials(doc: Record<string, unknown>): TokenSafety["socials"] | undefined {
  const ext = doc.extensions && typeof doc.extensions === "object" ? (doc.extensions as Record<string, unknown>) : {};
  const pickStr = (k: string) => (typeof doc[k] === "string" ? (doc[k] as string) : typeof ext[k] === "string" ? (ext[k] as string) : undefined);
  const out: NonNullable<TokenSafety["socials"]> = {};
  const tw = link(pickStr("twitter"), X_HOSTS, "https://x.com");
  if (tw) out.twitter = tw;
  const tg = link(pickStr("telegram"), TG_HOSTS, "https://t.me");
  if (tg) out.telegram = tg;
  const web = link(pickStr("website"), null, null);
  if (web) out.website = web;
  return Object.keys(out).length > 0 ? out : undefined;
}

function link(raw: string | undefined, hosts: Set<string> | null, canonical: string | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (s.length === 0 || s.length > 200) return undefined;
  const handle = /^@?([A-Za-z0-9_]{2,64})$/.exec(s);
  if (hosts && handle) return `${canonical}/${handle[1]}`;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && hosts)) return undefined;
  if (u.username || u.password || (u.port && u.port !== "443")) return undefined;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return undefined;
  const path = u.pathname.replace(/\/+$/, "");
  if (hosts) {
    if (!hosts.has(host)) return undefined;
    if (!/^\/[A-Za-z0-9_+\-/]{1,100}$/.test(path)) return undefined;
    return `${canonical}${path}`;
  }
  if (!/^[A-Za-z0-9._~\-/%]*$/.test(path)) return undefined;
  return `https://${host}${path}`;
}

import dns from "node:dns";
import https from "node:https";
import net from "node:net";

/**
 * Server-side fetch of token `uri` JSON and images (T2, T6). The URL is
 * chosen by the token's author, so:
 * - only `https:` (and `ipfs://`, rewritten to ONE gateway we choose);
 * - no credentials in the URL, port 443 only;
 * - the host is resolved once, EVERY address must be public (no loopback,
 *   RFC1918, CGNAT, link-local / 169.254.169.254, ULA, multicast, NAT64 /
 *   6to4 / mapped forms of those), and the connection is pinned to the
 *   checked address (no DNS rebinding between check and connect);
 * - no redirects by default (docs/INTEL.md rule 8); with `maxRedirects` > 0
 *   every hop is re-checked like the first URL;
 * - hard size limit while streaming, overall timeout;
 * - no cookies, no Referer, fixed User-Agent.
 * Fetches happen only on the indexer tick (warm set or tick batch), never on
 * a user's click, so the author's host cannot learn that someone looked.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(a, p, "ipv4");
}
for (const [a, p] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
  ["2001::", 23],
] as const) {
  blocked.addSubnet(a, p, "ipv6");
}

/** True only for globally routable unicast addresses. */
export function isPublicIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return !blocked.check(ip, "ipv4");
  if (fam !== 6) return false;
  const low = ip.toLowerCase();
  // Embedded IPv4 forms: mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16, compat ::a.b.c.d.
  const v4 = embeddedV4(low);
  if (v4 !== undefined) return v4 !== null && isPublicIp(v4);
  return !blocked.check(low, "ipv6");
}

/** undefined = no embedded IPv4; null = embedded but unparsable (treated as blocked). */
function embeddedV4(ip: string): string | null | undefined {
  const words = expandV6(ip);
  if (!words) return null;
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => words.slice(from, to).every((w) => w === 0);
  if (zero(0, 5) && words[5] === 0xffff) return toV4(words[6]!, words[7]!); // ::ffff:v4
  if (words[0] === 0x64 && words[1] === 0xff9b && zero(2, 6)) return toV4(words[6]!, words[7]!); // NAT64
  if (words[0] === 0x2002) return toV4(words[1]!, words[2]!); // 6to4
  if (zero(0, 6) && (words[6] !== 0 || words[7]! > 1)) return toV4(words[6]!, words[7]!); // ::v4 (deprecated)
  return undefined;
}

function expandV6(ip: string): number[] | null {
  let s = ip.split("%")[0]!;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const p = m[1]!.split(".").map(Number);
    if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null;
    s = s.slice(0, -m[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (all.length !== 8) return null;
  const words = all.map((w) => parseInt(w, 16));
  return words.some((w) => !(w >= 0 && w <= 0xffff)) ? null : words;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Base URL of the one IPFS gateway we use, e.g. https://ipfs.io/ipfs */
  ipfsGateway: string;
  maxRedirects?: number;
  accept?: string;
  /** Injected for tests. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Injected for tests: performs the pinned request. */
  request?: PinnedRequest;
}

export type PinnedRequest = (
  url: URL,
  address: { address: string; family: number },
  o: { timeoutMs: number; maxBytes: number; accept: string },
) => Promise<{ status: number; location: string | null; contentType: string | null; body: Buffer }>;

/**
 * Public IPFS gateways token authors link to (pump.fun writes https://ipfs.io/ipfs/<cid>). Their
 * paths are rewritten to OUR one gateway: ipfs.io / dweb.link answer 429 to our host (24.10), and
 * one gateway means one more party sees the CIDs, not several.
 */
const PUBLIC_IPFS_GATEWAYS = new Set([
  "ipfs.io", "gateway.ipfs.io", "dweb.link", "cloudflare-ipfs.com", "cf-ipfs.com", "gateway.pinata.cloud",
  "nftstorage.link", "w3s.link", "4everland.io", "ipfs.filebase.io", "ipfs.4everland.io",
]);

function ipfsPath(s: string): { cid: string; rest: string } | null {
  const scheme = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]{20,100})(\/[^\s?#]*)?$/.exec(s);
  if (scheme) return { cid: scheme[1]!, rest: scheme[2] ?? "" };
  // https://<public gateway>/ipfs/<cid>[/path], or https://<anything>.mypinata.cloud/ipfs/<cid>.
  const path = /^https:\/\/([a-z0-9.-]+)\/ipfs\/([A-Za-z0-9]{20,100})(\/[^\s?#]*)?(?:[?#].*)?$/i.exec(s);
  if (path) {
    const host = path[1]!.toLowerCase();
    if (PUBLIC_IPFS_GATEWAYS.has(host) || host.endsWith(".mypinata.cloud")) return { cid: path[2]!, rest: path[3] ?? "" };
  }
  // Subdomain gateways: https://<cid>.ipfs.<gateway>/[path].
  const sub = /^https:\/\/([a-z0-9]{50,100})\.ipfs\.([a-z0-9.-]+)(\/[^\s?#]*)?(?:[?#].*)?$/i.exec(s);
  if (sub && PUBLIC_IPFS_GATEWAYS.has(sub[2]!.toLowerCase())) return { cid: sub[1]!, rest: sub[3] && sub[3] !== "/" ? sub[3] : "" };
  return null;
}

/** Validates and normalizes a token-author URL. Throws SsrfError. */
export function checkUrl(raw: string, ipfsGateway: string): URL {
  const s = raw.trim();
  if (s.length === 0 || s.length > 512) throw new SsrfError("bad url length");
  let u: URL;
  const p = ipfsPath(s);
  const ipfs = p ? [s, p.cid, p.rest] : null;
  try {
    u = ipfs ? new URL(`${ipfsGateway.replace(/\/+$/, "")}/${ipfs[1]}${ipfs[2] ?? ""}`) : new URL(s);
  } catch {
    throw new SsrfError("unparsable url");
  }
  if (u.protocol !== "https:") throw new SsrfError("only https");
  if (u.username || u.password) throw new SsrfError("credentials in url");
  if (u.port && u.port !== "443") throw new SsrfError("port not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new SsrfError("host not allowed");
  }
  if (net.isIP(host) && !isPublicIp(host)) throw new SsrfError("private address");
  u.hash = "";
  return u;
}

const defaultLookup = async (host: string) => dns.promises.lookup(host, { all: true, verbatim: true });

export async function safeFetch(raw: string, o: SafeFetchOptions): Promise<{ body: Buffer; contentType: string | null }> {
  const lookup = o.lookup ?? defaultLookup;
  const request = o.request ?? pinnedHttpsRequest;
  const deadline = Date.now() + o.timeoutMs;
  let url = checkUrl(raw, o.ipfsGateway);
  for (let hop = 0; hop <= (o.maxRedirects ?? 0); hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await withTimeout(lookup(host), deadline);
    if (addrs.length === 0) throw new SsrfError("no address");
    // Every resolved address (hence every candidate below) must be public, as before.
    if (!addrs.every((a) => isPublicIp(a.address))) throw new SsrfError("private address");
    const res = await requestFirstReachable(request, url, orderAddresses(addrs), deadline, {
      maxBytes: o.maxBytes,
      accept: o.accept ?? "*/*",
    });
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new SsrfError("redirect without location");
      url = checkUrl(new URL(res.location, url).toString(), o.ipfsGateway);
      continue;
    }
    if (res.status !== 200) throw new SsrfError(`http ${res.status}`);
    return { body: res.body, contentType: res.contentType };
  }
  throw new SsrfError("too many redirects");
}

/** Most candidates tried per hop (all already checked public); bounds work on a long answer. */
const MAX_CANDIDATES = 4;

/**
 * IPv4 first, then IPv6, each in resolver order (M2): with `verbatim` the AAAA often comes first,
 * and a host without an IPv6 route fails it with ENETUNREACH. Deduplicated.
 */
export function orderAddresses(addrs: { address: string; family: number }[]): { address: string; family: number }[] {
  const seen = new Set<string>();
  const uniq = addrs.filter((a) => (seen.has(a.address) ? false : (seen.add(a.address), true)));
  const fam = (a: { address: string; family: number }) => net.isIP(a.address) || a.family;
  return [...uniq.filter((a) => fam(a) === 4), ...uniq.filter((a) => fam(a) !== 4)];
}

/** Errors raised before any HTTP response: the next address may still work. */
const CONNECT_ERRORS = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "ECONNRESET",
  "EPROTO",
]);

function isConnectError(e: unknown): boolean {
  if (e instanceof SsrfError) return false; // size limit, timeout: final
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECT_ERRORS.has(code);
}

async function requestFirstReachable(
  request: PinnedRequest,
  url: URL,
  candidates: { address: string; family: number }[],
  deadline: number,
  o: { maxBytes: number; accept: string },
): Promise<Awaited<ReturnType<PinnedRequest>>> {
  let last: unknown = new SsrfError("no address");
  for (const addr of candidates.slice(0, MAX_CANDIDATES)) {
    // Defence in depth: never connect to an address that is not public, whatever the caller did.
    if (!isPublicIp(addr.address)) throw new SsrfError("private address");
    const left = deadline - Date.now();
    if (left <= 0) throw new SsrfError("timeout");
    try {
      return await request(url, addr, { timeoutMs: left, maxBytes: o.maxBytes, accept: o.accept });
    } catch (e) {
      if (!isConnectError(e)) throw e;
      last = e;
    }
  }
  throw last;
}

/** TLS SNI for the request: none for an IP literal (brackets stripped for IPv6), else the host. */
export function tlsServername(url: URL): string | undefined {
  const h = url.hostname.replace(/^\[|\]$/g, "");
  return net.isIP(h) ? undefined : h;
}

async function withTimeout<T>(p: Promise<T>, deadline: number): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) throw new SsrfError("timeout");
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new SsrfError("timeout")), left)))]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** HTTPS GET connected to the pre-checked address (SNI and cert check against the hostname). */
export const pinnedHttpsRequest: PinnedRequest = (url, address, o) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: o.accept, "user-agent": "unzeen-intel/1", "accept-encoding": "identity" },
        servername: tlsServername(url),
        lookup: (_h, _opts, cb) => {
          // Node may ask with {all:true}: answer in the matching shape.
          if ((_opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [address]);
          else cb(null, address.address, address.family);
        },
        agent: false,
        timeout: o.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
        if (status !== 200) {
          res.resume();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }
        const declared = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > o.maxBytes) {
          req.destroy();
          reject(new SsrfError("too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => {
          n += c.length;
          if (n > o.maxBytes) {
            req.destroy();
            reject(new SsrfError("too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new SsrfError("timeout")), o.timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new SsrfError("timeout")));
    req.on("error", reject);
    req.end();
  });

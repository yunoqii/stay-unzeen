import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fetchOffchain, normalizeSocials, type MediaSink } from "../src/intel/offchain";
import { SsrfError, checkUrl, isPublicIp, safeFetch, type PinnedRequest } from "../src/intel/ssrf";

const GW = "https://ipfs.io/ipfs";

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "ff02::1",
    "not-an-ip",
  ])("blocks %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["1.1.1.1", "8.8.8.8", "104.16.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) =>
    expect(isPublicIp(ip)).toBe(true),
  );
});

describe("checkUrl", () => {
  it.each([
    "http://example.com/a.json",
    "ftp://example.com/a",
    "file:///etc/passwd",
    "https://user:pw@example.com/",
    "https://example.com:8443/",
    "https://localhost/a",
    "https://foo.localhost/a",
    "https://printer.local/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/",
    "data:application/json,{}",
    "javascript:alert(1)",
    "",
  ])("rejects %s", (u) => expect(() => checkUrl(u, GW)).toThrow(SsrfError));

  it("rewrites public gateway links (path and subdomain style) to our one gateway", () => {
    const cid = "bafkreia5srcytkvbkn2hedwejljmwjxb5gcpmfxtlgcwo3six2mu62wbwu";
    expect(checkUrl(`https://ipfs.io/ipfs/${cid}`, GW).toString()).toBe(`${GW}/${cid}`);
    expect(checkUrl(`https://pump.mypinata.cloud/ipfs/${cid}/a.png?img-width=64`, GW).toString()).toBe(`${GW}/${cid}/a.png`);
    expect(checkUrl(`https://${cid}.ipfs.dweb.link/`, GW).toString()).toBe(`${GW}/${cid}`);
    expect(checkUrl(`https://${cid}.ipfs.w3s.link/meta.json`, GW).toString()).toBe(`${GW}/${cid}/meta.json`);
    // Not a known gateway: left alone (and still SSRF-checked).
    expect(checkUrl(`https://example.com/ipfs/${cid}`, GW).toString()).toBe(`https://example.com/ipfs/${cid}`);
  });

  it("rewrites ipfs:// to our one gateway", () => {
    const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    expect(checkUrl(`ipfs://${cid}`, GW).toString()).toBe(`${GW}/${cid}`);
    expect(checkUrl(`ipfs://ipfs/${cid}/meta.json`, GW).toString()).toBe(`${GW}/${cid}/meta.json`);
  });

  it("accepts plain https and drops the fragment", () => {
    expect(checkUrl("https://arweave.net/abc#x", GW).toString()).toBe("https://arweave.net/abc");
  });
});

const ok = (body: string | Buffer, contentType = "application/json"): Awaited<ReturnType<PinnedRequest>> => ({
  status: 200,
  location: null,
  contentType,
  body: Buffer.isBuffer(body) ? body : Buffer.from(body),
});

describe("safeFetch", () => {
  it("refuses a host that resolves to a private address (DNS check before connect)", async () => {
    let connected = false;
    await expect(
      safeFetch("https://evil.example/meta.json", {
        maxBytes: 1000,
        timeoutMs: 1000,
        ipfsGateway: GW,
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        request: async () => ((connected = true), ok("{}")),
      }),
    ).rejects.toThrow(SsrfError);
    expect(connected).toBe(false);
  });

  it("refuses when ANY resolved address is private", async () => {
    await expect(
      safeFetch("https://mixed.example/", {
        maxBytes: 1000,
        timeoutMs: 1000,
        ipfsGateway: GW,
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
        request: async () => ok("{}"),
      }),
    ).rejects.toThrow("private address");
  });

  it("connects to the checked address (pinned) and re-checks every redirect hop", async () => {
    const pinned: string[] = [];
    const res = await safeFetch("https://a.example/1", {
      maxBytes: 1000,
      timeoutMs: 1000,
      ipfsGateway: GW,
      maxRedirects: 2,
      lookup: async (h) => [{ address: h === "a.example" ? "93.184.216.34" : "1.1.1.1", family: 4 }],
      request: async (url, addr) => {
        pinned.push(`${url.hostname}@${addr.address}`);
        return url.hostname === "a.example" ? { status: 302, location: "https://b.example/2", contentType: null, body: Buffer.alloc(0) } : ok('{"a":1}');
      },
    });
    expect(res.body.toString()).toBe('{"a":1}');
    expect(pinned).toEqual(["a.example@93.184.216.34", "b.example@1.1.1.1"]);
  });

  it("default (INTEL.md): no redirects at all", async () => {
    await expect(
      safeFetch("https://a.example/1", {
        maxBytes: 1000,
        timeoutMs: 1000,
        ipfsGateway: GW,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async () => ({ status: 302, location: "https://b.example/2", contentType: null, body: Buffer.alloc(0) }),
      }),
    ).rejects.toThrow("too many redirects");
  });

  it("refuses a redirect to a private or non-https target (when redirects are enabled)", async () => {
    for (const location of ["https://127.0.0.1/x", "http://b.example/x", "https://localhost/"]) {
      await expect(
        safeFetch("https://a.example/1", {
          maxBytes: 1000,
          timeoutMs: 1000,
          ipfsGateway: GW,
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          maxRedirects: 2,
          request: async () => ({ status: 301, location, contentType: null, body: Buffer.alloc(0) }),
        }),
      ).rejects.toThrow(SsrfError);
    }
  });

  it("stops after maxRedirects", async () => {
    await expect(
      safeFetch("https://a.example/1", {
        maxBytes: 1000,
        timeoutMs: 1000,
        ipfsGateway: GW,
        maxRedirects: 2,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async () => ({ status: 302, location: "https://a.example/again", contentType: null, body: Buffer.alloc(0) }),
      }),
    ).rejects.toThrow("too many redirects");
  });

  it("passes the size limit and remaining time to the request", async () => {
    let seen: { timeoutMs: number; maxBytes: number } | null = null;
    await safeFetch("https://a.example/1", {
      maxBytes: 64 * 1024,
      timeoutMs: 3000,
      ipfsGateway: GW,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (_u, _a, o) => ((seen = o), ok("{}")),
    });
    expect(seen!.maxBytes).toBe(64 * 1024);
    expect(seen!.timeoutMs).toBeLessThanOrEqual(3000);
  });

  it("times out a slow DNS answer", async () => {
    await expect(
      safeFetch("https://slow.example/", {
        maxBytes: 10,
        timeoutMs: 50,
        ipfsGateway: GW,
        lookup: () => new Promise((r) => setTimeout(() => r([{ address: "1.1.1.1", family: 4 }]), 500)),
        request: async () => ok("{}"),
      }),
    ).rejects.toThrow("timeout");
  });
});

describe("off-chain metadata", () => {
  it("socials are normalized https links only", () => {
    expect(
      normalizeSocials({
        twitter: "https://twitter.com/unzeen?ref=abc",
        telegram: "@unzeen_chat",
        website: "https://user:pw@evil.example/",
      }),
    ).toEqual({ twitter: "https://x.com/unzeen", telegram: "https://t.me/unzeen_chat" });
    expect(normalizeSocials({ website: "https://example.org/path/?utm=1#x" })).toEqual({ website: "https://example.org/path" });
    expect(normalizeSocials({ twitter: "https://evil.example/unzeen", website: "javascript:alert(1)" })).toBeUndefined();
    expect(normalizeSocials({ extensions: { telegram: "https://t.me/abc" } })).toEqual({ telegram: "https://t.me/abc" });
  });

  it("image is re-encoded (no EXIF) and stored in our media, never returned as an external URL", async () => {
    const MARK = "UNZEEN-EXIF-MARK";
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#f00" } })
      .jpeg()
      .withExif({ IFD0: { Artist: MARK } })
      .toBuffer();
    expect(jpeg.includes(Buffer.from(MARK))).toBe(true);
    const stored: Buffer[] = [];
    const media: MediaSink = {
      putMedia: async (name, bytes) => (stored.push(bytes), `https://unzeen.example/media/${name}`),
    };
    const info = await fetchOffchain("https://meta.example/m.json", {
      media,
      ipfsGateway: GW,
      fetcher: async (url) =>
        url.endsWith(".json") ? { body: Buffer.from(JSON.stringify({ image: "https://img.example/x.jpg", twitter: "x.com/abc" })), contentType: null } : { body: jpeg, contentType: "image/jpeg" },
    });
    expect(info.ok).toBe(true);
    expect(info.image).toMatch(/^https:\/\/unzeen\.example\/media\/[0-9a-f]{40}\.jpg$/);
    expect(stored[0]!.includes(Buffer.from(MARK))).toBe(false);
    expect(info.socials).toEqual({ twitter: "https://x.com/abc" });
  });

  it("an image the gateway refuses (429) is flagged for a retry; socials still count", async () => {
    const info = await fetchOffchain("https://meta.example/m.json", {
      media: { putMedia: async (name) => `https://unzeen.example/media/${name}` },
      ipfsGateway: GW,
      fetcher: async (url) => {
        if (url.endsWith(".json")) return { body: Buffer.from(JSON.stringify({ image: "ipfs://bafkreia5srcytkvbkn2hedwejljmwjxb5gcpmfxtlgcwo3six2mu62wbwu", twitter: "x.com/abc" })), contentType: null };
        throw new SsrfError("http 429");
      },
    });
    expect(info.ok).toBe(true);
    expect(info.imageFailed).toBe(true);
    expect(info.image).toBeUndefined();
    expect(info.socials).toEqual({ twitter: "https://x.com/abc" });
  });

  it("a failed or oversized JSON is a cached failure, not an exception", async () => {
    const info = await fetchOffchain("https://meta.example/m.json", {
      media: null,
      ipfsGateway: GW,
      fetcher: async () => {
        throw new SsrfError("too large");
      },
    });
    expect(info.ok).toBe(false);
  });
});

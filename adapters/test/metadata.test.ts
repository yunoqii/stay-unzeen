import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterError } from "../src/errors";
import { LocalMetadataStore, PinataMetadataStore, metadataStoreFromEnv, parseImageDataUrl, publicMetadataUrlProblem, rebaseMediaUrl, sanitizeImage } from "../src/metadata";

const MARK = "UNZEEN-SECRET-EXIF-MARK";

/** A JPEG with EXIF (GPS, camera, a marker string), XMP and a comment, 2000x1000, rotated tag. */
async function dirtyJpeg(): Promise<Buffer> {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>${MARK}</rdf:Description></rdf:RDF></x:xmpmeta>`;
  return sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: "PhoneMaker", Model: "Phone 15", Artist: MARK },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "55/1 45/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "37/1 37/1 0/1" },
    })
    .withXmp(xmp)
    .toBuffer();
}

const toDataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString("base64")}`;

describe("image sanitizing (EXIF removal)", () => {
  it("source really carries EXIF/GPS/XMP (test precondition)", async () => {
    const src = await dirtyJpeg();
    const m = await sharp(src).metadata();
    expect(m.exif).toBeDefined();
    expect(m.xmp).toBeDefined();
    expect(m.orientation).toBe(6);
    expect(src.includes(MARK)).toBe(true);
  });

  it("re-encodes without any metadata, applies orientation, caps size", async () => {
    const out = await sanitizeImage(await dirtyJpeg(), "image/jpeg");
    const m = await sharp(out.bytes).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.xmp).toBeUndefined();
    expect(m.iptc).toBeUndefined();
    expect(m.icc).toBeUndefined();
    expect(m.comments ?? []).toEqual([]);
    expect(out.bytes.includes(MARK)).toBe(false);
    expect(out.bytes.includes("PhoneMaker")).toBe(false);
    expect(out.bytes.includes("Exif")).toBe(false);
    // orientation 6 (90° CW) baked in: 2000x1000 -> portrait, longest side 1024
    expect(m.format).toBe("jpeg");
    expect([out.width, out.height]).toEqual([512, 1024]);
    expect(m.orientation ?? 1).toBe(1);
  });

  it("keeps transparency as PNG and drops PNG text chunks", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } })
      .png()
      .withMetadata({ exif: { IFD0: { Artist: MARK } } })
      .toBuffer();
    expect(png.includes(MARK)).toBe(true);
    const out = await sanitizeImage(png, "image/png");
    expect(out.mime).toBe("image/png");
    expect(out.bytes.includes(MARK)).toBe(false);
    expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
  });

  it("drops bytes appended after the image (polyglot / hidden payload)", async () => {
    const src = Buffer.concat([await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer(), Buffer.from(MARK)]);
    const out = await sanitizeImage(src, "image/png");
    expect(out.bytes.includes(MARK)).toBe(false);
  });

  it("rejects a mismatching declared type, garbage, wrong data URLs and oversize", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(sanitizeImage(png, "image/jpeg")).rejects.toBeInstanceOf(AdapterError);
    await expect(sanitizeImage(Buffer.from("not an image"))).rejects.toMatchObject({ code: "bad_request" });
    expect(() => parseImageDataUrl(toDataUrl("image/gif", png))).toThrow(AdapterError);
    expect(() => parseImageDataUrl("data:image/png;base64,")).toThrow(AdapterError);
    expect(() => parseImageDataUrl(toDataUrl("image/png", Buffer.alloc(512 * 1024 + 1)))).toThrow(/bytes/);
    expect(parseImageDataUrl(toDataUrl("image/png", png)).bytes.equals(png)).toBe(true);
  });
});

describe("metadata stores", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("local store: content-addressed image + JSON, idempotent, sanitized file on disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-meta-"));
    dirs.push(dir);
    const store = new LocalMetadataStore(path.join(dir, "pub"), "https://media.example/meta/");
    const image = toDataUrl("image/jpeg", await dirtyJpeg());
    const a = await store.publish({ name: "Unzeen Test", symbol: "UNZT", image });
    const b = await store.publish({ name: "Unzeen Test", symbol: "UNZT", image });
    expect(a).toEqual(b);
    expect(a.uri).toMatch(/^https:\/\/media\.example\/meta\/[0-9a-f]{40}\.json$/);
    expect(a.imageUrl).toMatch(/^https:\/\/media\.example\/meta\/[0-9a-f]{40}\.jpg$/);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "pub", path.basename(a.uri)), "utf8"));
    expect(json).toEqual({ name: "Unzeen Test", symbol: "UNZT", description: "", showName: true, image: a.imageUrl });
    const img = fs.readFileSync(path.join(dir, "pub", path.basename(a.imageUrl!)));
    expect(img.includes(MARK)).toBe(false);
    expect((await sharp(img).metadata()).exif).toBeUndefined();
    const noImg = await store.publish({ name: "N", symbol: "N" });
    expect(noImg.imageUrl).toBeNull();
  });

  it("pinata store: uploads sanitized bytes with the JWT, maps failures to venue_unavailable", async () => {
    const uploads: { auth: string | null; size: number; type: string }[] = [];
    let n = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const f = (init.body as FormData).get("file") as Blob;
      uploads.push({ auth: new Headers(init.headers).get("authorization"), size: f.size, type: f.type });
      const buf = Buffer.from(await f.arrayBuffer());
      if (buf.includes(MARK)) throw new Error("unsanitized upload");
      return new Response(JSON.stringify({ data: { cid: `bafy${++n}` } }), { status: 200 });
    }) as unknown as typeof fetch;
    const store = new PinataMetadataStore("jwt-x", "https://gw.example/ipfs", fakeFetch);
    const r = await store.publish({ name: "A", symbol: "A", image: toDataUrl("image/jpeg", await dirtyJpeg()) });
    expect(r).toEqual({ uri: "https://gw.example/ipfs/bafy2", imageUrl: "https://gw.example/ipfs/bafy1" });
    expect(uploads.map((u) => [u.auth, u.type])).toEqual([["Bearer jwt-x", "image/jpeg"], ["Bearer jwt-x", "application/json"]]);

    // Site copy: with a /media mirror tokens.image is ours (web CSP), the chain JSON keeps IPFS.
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "unz-mirror-"));
    const mirrored = new PinataMetadataStore("jwt-x", "https://gw.example/ipfs", fakeFetch, new LocalMetadataStore(mdir, "https://api.example/media"));
    const m = await mirrored.publish({ name: "A", symbol: "A", image: toDataUrl("image/jpeg", await dirtyJpeg()) });
    expect(m.uri).toMatch(/^https:\/\/gw\.example\/ipfs\/bafy\d+$/);
    expect(m.imageUrl).toMatch(/^https:\/\/api\.example\/media\/[0-9a-f]{40}\.jpg$/);
    expect(fs.existsSync(path.join(mdir, path.basename(m.imageUrl!)))).toBe(true);
    const env = { PINATA_JWT: "x", UNZEEN_METADATA_BASE_URL: "https://api.example/media", UNZEEN_METADATA_DIR: mdir };
    expect((metadataStoreFromEnv(os.tmpdir(), env) as unknown as { displayMirror: unknown }).displayMirror).toBeInstanceOf(LocalMetadataStore);

    const failing = new PinataMetadataStore("j", undefined, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);
    await expect(failing.publish({ name: "A", symbol: "A" })).rejects.toMatchObject({ code: "venue_unavailable" });
  });
});

describe("GAP-5: mainnet never writes a local metadata URL on chain", () => {
  it("publicMetadataUrlProblem: only public https hosts pass", () => {
    for (const ok of ["https://api.unzeen.xyz/media", "https://media.example/meta/", "https://8.8.8.8/m"]) expect(publicMetadataUrlProblem(ok)).toBeNull();
    const bad: Record<string, RegExp> = {
      "http://api.unzeen.xyz/media": /not https/,
      "http://127.0.0.1:8090/media": /not https/,
      "https://127.0.0.1/media": /loopback/,
      "https://localhost/media": /public host|local/,
      "https://box.local/media": /local host/,
      "https://10.0.0.5/m": /private/,
      "https://192.168.1.2/m": /private/,
      "https://172.20.0.1/m": /private/,
      "https://[::1]/m": /loopback/,
      "https://media/m": /public host/,
      "not a url": /not a URL/,
    };
    for (const [u, re] of Object.entries(bad)) expect(publicMetadataUrlProblem(u), u).toMatch(re);
  });

  it("metadataStoreFromEnv: mainnet + local http base -> refused (null + reason); devnet keeps it", () => {
    const env = { UNZEEN_METADATA_BASE_URL: "http://127.0.0.1:8090/media" };
    const reasons: string[] = [];
    expect(metadataStoreFromEnv(os.tmpdir(), env, { cluster: "mainnet-beta", onRefuse: (r) => reasons.push(r) })).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/refused on mainnet \(not https\).*PINATA_JWT/);
    expect(metadataStoreFromEnv(os.tmpdir(), env, { cluster: "devnet" })).toBeInstanceOf(LocalMetadataStore);
    expect(metadataStoreFromEnv(os.tmpdir(), env)).toBeInstanceOf(LocalMetadataStore);
  });

  it("metadataStoreFromEnv: mainnet with PINATA_JWT or a public https base -> a store", () => {
    expect(metadataStoreFromEnv(os.tmpdir(), { PINATA_JWT: "x", UNZEEN_METADATA_BASE_URL: "http://127.0.0.1/m" }, { cluster: "mainnet-beta" })).toBeInstanceOf(PinataMetadataStore);
    expect(metadataStoreFromEnv(os.tmpdir(), { UNZEEN_METADATA_BASE_URL: "https://api.unzeen.xyz/media" }, { cluster: "mainnet-beta" })).toBeInstanceOf(LocalMetadataStore);
  });

  it("LocalMetadataStore itself refuses a local URL when built for mainnet", () => {
    expect(() => new LocalMetadataStore(os.tmpdir(), "https://localhost/m", { requirePublicHttps: true })).toThrow(/refused on mainnet/);
    expect(() => new LocalMetadataStore(os.tmpdir(), "http://127.0.0.1/m")).not.toThrow();
  });
});

describe("rebaseMediaUrl: cached /media URLs follow a domain change", () => {
  it("moves /media/<sha40> of any host to the current base, leaves the rest", () => {
    const sha = "a".repeat(40);
    const base = "https://api-mainnet.stayunzeen.live/media/";
    expect(rebaseMediaUrl(`https://api-mainnet.169-58-209-71.sslip.io/media/${sha}.png`, base)).toBe(`https://api-mainnet.stayunzeen.live/media/${sha}.png`);
    expect(rebaseMediaUrl(`http://127.0.0.1:8080/media/${sha}.jpg`, base)).toBe(`https://api-mainnet.stayunzeen.live/media/${sha}.jpg`);
    expect(rebaseMediaUrl(`https://ipfs.io/ipfs/bafy1`, base)).toBe("https://ipfs.io/ipfs/bafy1");
    expect(rebaseMediaUrl(`https://x.example/media/${sha}.png?x=1`, base)).toBe(`https://x.example/media/${sha}.png?x=1`);
    expect(rebaseMediaUrl(`https://x.example/media/${sha}.png`, undefined)).toBe(`https://x.example/media/${sha}.png`);
  });
});

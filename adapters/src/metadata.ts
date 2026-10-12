import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { AdapterError } from "./errors";

/**
 * Token metadata for a launch (pump.fun `uri` -> Metaplex-style JSON with
 * `image`). The user's image never leaves our server as-is:
 *
 * 1. `parseImageDataUrl`: only `data:image/(png|jpeg|webp);base64,…` up to
 *    512 KiB (API.md), and the bytes must really be that format;
 * 2. `sanitizeImage`: decoded and RE-ENCODED from pixels with sharp. The output
 *    is a new file: no EXIF/GPS/XMP/IPTC/ICC/comments, no trailing bytes or
 *    polyglot payloads of the original; orientation applied first; size
 *    capped at 1024 px; PNG if it has transparency, else JPEG;
 * 3. a `MetadataStore` publishes image + JSON from the server (the user's IP
 *    is never tied to the mint), content-addressed, so a retried job reuses
 *    the same URIs.
 *
 * Where it is published (decision, day 4): pump.fun's own upload endpoint
 * (`pump.fun/api/ipfs`) is no longer supported (pumpportal / pumpdev docs,
 * 10.2026), and the program does not care what `uri` is. So:
 * - `LocalMetadataStore` (default): files in a public dir served by our
 *   static host under UNZEEN_METADATA_BASE_URL; `tokens.image` (core schema:
 *   "URL served by us (re-encoded)") points to the same file;
 * - `PinataMetadataStore` (when PINATA_JWT is set): IPFS via Pinata, what
 *   pump.fun's own UI and indexers resolve best on mainnet. Pinata sees our
 *   server's IP and the (public anyway) image, never the user.
 */

export const MAX_IMAGE_BYTES = 512 * 1024;
/** Longest side of the published image. */
export const MAX_IMAGE_SIDE = 1024;
/** Decompression-bomb guard: refuse inputs above this many pixels. */
const MAX_INPUT_PIXELS = 4096 * 4096;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";
const FORMAT_OF: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };

export function parseImageDataUrl(dataUrl: string): { mime: ImageMime; bytes: Buffer } {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl.trim());
  if (!m) throw new AdapterError("bad_request", "image must be a data:image/(png|jpeg|webp);base64 URL");
  const bytes = Buffer.from(m[2]!, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new AdapterError("bad_request", `image must be 1..${MAX_IMAGE_BYTES} bytes`);
  }
  return { mime: m[1] as ImageMime, bytes };
}

export interface SanitizedImage {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg";
  ext: "png" | "jpg";
  width: number;
  height: number;
}

/** Re-encodes an untrusted image from pixels; see the module comment. */
export async function sanitizeImage(input: Buffer, declared?: ImageMime): Promise<SanitizedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new AdapterError("bad_request", "image cannot be decoded");
  }
  if (!meta.format || !["png", "jpeg", "webp"].includes(meta.format)) {
    throw new AdapterError("bad_request", "image must be png, jpeg or webp");
  }
  if (declared && FORMAT_OF[declared] !== meta.format) {
    throw new AdapterError("bad_request", "image content does not match its declared type");
  }
  if ((meta.pages ?? 1) > 1) throw new AdapterError("bad_request", "animated images are not supported");
  const alpha = meta.hasAlpha === true;
  // No .keepMetadata()/.withMetadata(): sharp writes none of the input's metadata.
  let pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
    .rotate() // bake EXIF orientation into pixels before the tag is dropped
    .resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb");
  pipeline = alpha ? pipeline.png({ compressionLevel: 9 }) : pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 88, mozjpeg: true });
  let out: { data: Buffer; info: sharp.OutputInfo };
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch {
    throw new AdapterError("bad_request", "image cannot be re-encoded");
  }
  return {
    bytes: out.data,
    mime: alpha ? "image/png" : "image/jpeg",
    ext: alpha ? "png" : "jpg",
    width: out.info.width,
    height: out.info.height,
  };
}

/**
 * Metadata the store publishes. Only what the user chose to make public:
 * no description, socials, creation tool or anything that could identify them.
 */
export function metadataJson(name: string, symbol: string, imageUrl: string | null): Buffer {
  const doc: Record<string, unknown> = { name, symbol, description: "", showName: true };
  if (imageUrl) doc.image = imageUrl;
  return Buffer.from(JSON.stringify(doc));
}

export interface PublishedMetadata {
  /** Metadata JSON URI for the token (pump.fun `uri`, <= 200 bytes). */
  uri: string;
  /** Public URL of the sanitized image (`tokens.image`), null without image. */
  imageUrl: string | null;
}

export interface MetadataStore {
  publish(meta: { name: string; symbol: string; image?: string | null }): Promise<PublishedMetadata>;
}

export function contentName(bytes: Uint8Array, ext: string): string {
  return `${createHash("sha256").update(bytes).digest("hex").slice(0, 40)}.${ext}`;
}

/** Shared flow: sanitize -> put image -> put JSON. */
abstract class BaseMetadataStore implements MetadataStore {
  protected abstract put(name: string, bytes: Buffer, mime: string): Promise<string>;

  async publish(meta: { name: string; symbol: string; image?: string | null }): Promise<PublishedMetadata> {
    let imageUrl: string | null = null;
    if (meta.image) {
      const { mime, bytes } = parseImageDataUrl(meta.image);
      const img = await sanitizeImage(bytes, mime);
      imageUrl = await this.put(contentName(img.bytes, img.ext), img.bytes, img.mime);
    }
    const json = metadataJson(meta.name, meta.symbol, imageUrl);
    const uri = await this.put(contentName(json, "json"), json, "application/json");
    if (Buffer.byteLength(uri) > 200) throw new AdapterError("internal", "metadata URI longer than 200 bytes");
    return { uri, imageUrl };
  }
}

/**
 * Files in `dir` (world-readable: they are public), URLs `${baseUrl}/<sha>.<ext>`.
 * Serve `dir` statically (nginx / core) at `baseUrl` with long cache headers.
 */
export class LocalMetadataStore extends BaseMetadataStore {
  constructor(
    private readonly dir: string,
    private readonly baseUrl: string,
  ) {
    super();
    if (!/^https?:\/\//.test(baseUrl)) throw new Error("UNZEEN_METADATA_BASE_URL must be an http(s) URL");
  }

  /** Public put for already-sanitized media (token intel: third-party images re-encoded by the indexer). */
  putMedia(name: string, bytes: Buffer): Promise<string> {
    if (!/^[0-9a-f]{40}\.(?:png|jpg)$/.test(name)) throw new Error("media name must be <sha40>.(png|jpg)");
    return this.put(name, bytes);
  }

  protected async put(name: string, bytes: Buffer): Promise<string> {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true, mode: 0o755 });
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes, { mode: 0o644 });
      fs.renameSync(tmp, file);
    }
    return `${this.baseUrl.replace(/\/+$/, "")}/${name}`;
  }
}

/** IPFS through Pinata's pinning API (v3 files). Needs PINATA_JWT. */
export class PinataMetadataStore extends BaseMetadataStore {
  constructor(
    private readonly jwt: string,
    private readonly gateway = "https://ipfs.io/ipfs",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  protected async put(name: string, bytes: Buffer, mime: string): Promise<string> {
    const form = new FormData();
    form.append("network", "public");
    form.append("name", name);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
    let res: Response;
    try {
      res = await this.fetchImpl("https://uploads.pinata.cloud/v3/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.jwt}` },
        body: form,
      });
    } catch {
      throw new AdapterError("venue_unavailable", "metadata upload failed (network)");
    }
    if (!res.ok) throw new AdapterError("venue_unavailable", `metadata upload failed (HTTP ${res.status})`);
    const body = (await res.json()) as { data?: { cid?: string } };
    const cid = body.data?.cid;
    if (!cid) throw new AdapterError("venue_unavailable", "metadata upload: no CID in response");
    return `${this.gateway.replace(/\/+$/, "")}/${cid}`;
  }
}

/** Store from env: PINATA_JWT -> Pinata, else UNZEEN_METADATA_DIR + UNZEEN_METADATA_BASE_URL. */
export function metadataStoreFromEnv(defaultDir: string, env: NodeJS.ProcessEnv = process.env): MetadataStore | null {
  const jwt = env.PINATA_JWT?.trim();
  if (jwt) return new PinataMetadataStore(jwt, env.PINATA_GATEWAY_URL?.trim() || undefined);
  const base = env.UNZEEN_METADATA_BASE_URL?.trim();
  if (!base) return null;
  const dir = env.UNZEEN_METADATA_DIR?.trim() || defaultDir;
  return new LocalMetadataStore(dir, base);
}

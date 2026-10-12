// Token images and metadata are served only through our own /media (T2, docs/analysis/token-intel.md).
// Anything else (IPFS, Arweave, the token author's host) would hand the viewer's IP and the mint to a
// third party, so it is dropped and the glyph fallback is shown instead.

import { networkConfig, type Network } from "@/lib/network";

const MEDIA_PATH = /^\/media\/[0-9a-f]{40}\.(png|jpe?g|webp)$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** Safe image src for a token, or null. Accepts `/media/<sha40>.<ext>` (relative or on our API origin) and inline data images. */
export function safeImageSrc(image: string | undefined | null, n?: Network): string | null {
  if (!image) return null;
  if (DATA_IMAGE.test(image)) return image; // local bytes, no request
  const api = networkConfig(n).apiUrl;
  if (MEDIA_PATH.test(image)) return api + image;
  if (api && image.startsWith(api + "/")) {
    const rest = image.slice(api.length);
    if (MEDIA_PATH.test(rest)) return image;
  }
  return null;
}

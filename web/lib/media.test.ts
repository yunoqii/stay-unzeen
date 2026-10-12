import { describe, expect, it } from "vitest";
import { safeImageSrc } from "./media";

const SHA = "a".repeat(40);

describe("token images only through our /media (T2)", () => {
  it("keeps /media/<sha40>.<ext>", () => {
    expect(safeImageSrc(`/media/${SHA}.png`, "devnet")).toBe(`/media/${SHA}.png`);
    expect(safeImageSrc(`/media/${SHA}.webp`, "devnet")).toBe(`/media/${SHA}.webp`);
  });

  it("drops IPFS, Arweave and any other host", () => {
    for (const u of [
      "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      "https://arweave.net/abc",
      "https://cf-ipfs.com/ipfs/x",
      `https://evil.example/media/${SHA}.png`,
      `//evil.example/media/${SHA}.png`,
      `/media/${SHA}.svg`,
      `/media/${SHA}.png?x=1`,
      `/media/../${SHA}.png`,
      "data:image/svg+xml;base64,PHN2Zz4=",
    ])
      expect(safeImageSrc(u, "devnet"), u).toBeNull();
  });

  it("allows local data images (no request)", () => {
    expect(safeImageSrc("data:image/png;base64,iVBORw0KGgo=", "devnet")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});

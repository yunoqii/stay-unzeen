import { safeImageSrc } from "@/lib/media";
import { cn } from "@/lib/utils";

/**
 * Token mark. The image is shown only when it comes from our own /media (T2): an IPFS / Arweave / author
 * URL would leak the viewer's IP and the mint, so it falls back to the monogram.
 */
export function TokenGlyph({ symbol, image, className }: { symbol: string; image?: string; className?: string }) {
  const src = safeImageSrc(image);
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" referrerPolicy="no-referrer" className={cn("size-9 rounded-lg object-cover", className)} />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg border border-white/[0.06] bg-[radial-gradient(120%_120%_at_30%_20%,#26262c,#0c0c0e)] font-mono text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      {symbol.slice(0, 2)}
    </span>
  );
}

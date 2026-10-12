import { cn } from "@/lib/utils";

/** Placeholder token mark: monogram on a shadowed tile. Real images come from `Token.image`. */
export function TokenGlyph({ symbol, image, className }: { symbol: string; image?: string; className?: string }) {
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt="" className={cn("size-9 rounded-lg object-cover", className)} />;
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

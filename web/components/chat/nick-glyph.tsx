import { cn } from "@/lib/utils";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** The 40 bits of an 8-char base32 nick. Pure, so the same nick draws the same glyph everywhere. */
export function nickBits(nick: string): boolean[] {
  const bits: boolean[] = [];
  for (const ch of nick) {
    const v = Math.max(0, CROCKFORD.indexOf(ch));
    for (let b = 4; b >= 0; b--) bits.push(((v >> b) & 1) === 1);
  }
  return bits;
}

/**
 * Deterministic avatar from the nickname alone (no photos, nothing fetched): a 5×5 mirrored pattern
 * from the first 15 bits, a shade from the next 2. Creator nicks draw in ZEC gold, everyone else in
 * shadow greys, so the badge is never the only cue and colour never carries meaning on its own.
 */
export function NickGlyph({ nick, creator, className }: { nick: string; creator?: boolean; className?: string }) {
  const bits = nickBits(nick);
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      if (!bits[y * 3 + x]) continue;
      cells.push({ x, y });
      if (x < 2) cells.push({ x: 4 - x, y });
    }
  const shade = (bits[15] ? 2 : 0) + (bits[16] ? 1 : 0);
  const fill = creator ? "var(--zec)" : ["var(--muted-foreground)", "var(--foreground)", "var(--faint-foreground)", "color-mix(in oklab, var(--zec) 45%, var(--muted-foreground))"][shade];
  return (
    <span aria-hidden className={cn("inline-grid size-7 shrink-0 place-items-center rounded-lg border bg-surface-1", creator ? "border-zec/40" : "border-border", className)}>
      <svg viewBox="0 0 5 5" className="size-[60%]" shapeRendering="crispEdges">
        {cells.map((c) => (
          <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1} height={1} fill={fill} opacity={0.9} />
        ))}
      </svg>
    </span>
  );
}

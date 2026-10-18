/** A tiny price line from public prices (oldest first). Green when it ends higher, red when lower. */
export function Sparkline({ points, className, width = 96, height = 28 }: { points?: readonly (string | number)[]; className?: string; width?: number; height?: number }) {
  const v = (points ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (v.length < 2) return <span aria-hidden className={className} style={{ width, height, display: "inline-block" }} />;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || max || 1;
  const step = width / (v.length - 1);
  const d = v.map((n, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 2 - ((n - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  const up = v[v.length - 1] >= v[0];
  return (
    <svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className}>
      <path d={d} fill="none" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" className={up ? "stroke-buy" : "stroke-sell"} />
    </svg>
  );
}

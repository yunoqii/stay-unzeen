import { cn } from "@/lib/utils";

const NODES = [
  { title: "Your Zcash wallet", sub: "ZODL or any shielded wallet", seen: "A shielded transaction. Sender, amount and memo encrypted.", tone: "zec" as const },
  { title: "Unzeen pool", sub: "Ledger of balances per anon key", seen: "Nothing on chain. Your requests are signed and padded.", tone: "ink" as const },
  { title: "Pool vaults", sub: "Shared, public, one per token", seen: "A vault signs the trade. Everyone’s trades, same vault.", tone: "ink" as const },
  { title: "Launchpads", sub: "pump.fun · Meteora DBC · Jupiter", seen: "“unzeen bought 1.2M $PEPE for 0.4 SOL”", tone: "ink" as const },
];

const LINKS = [
  { label: "shielded ZEC + signed memo", tone: "zec" as const, cut: false },
  { label: "no on-chain link", tone: "fog" as const, cut: true },
  { label: "vault-signed tx", tone: "fog" as const, cut: false },
];

/** The money path, left to right (top to bottom on phones). The tape marks the hop the chain cannot see. */
export function FlowDiagram() {
  return (
    <figure className="mt-16">
      <div className="flex flex-col items-stretch md:flex-row md:items-stretch">
        {NODES.map((n, i) => (
          <div key={n.title} className="contents">
            <div
              className={cn(
                "relative flex min-w-0 flex-col rounded-2xl border p-5 md:w-0 md:flex-[1.15]",
                n.tone === "zec" ? "border-zec/35 bg-zec-soft" : "border-border bg-surface-1",
              )}
            >
              <p className="text-[15px] font-medium tracking-tight">{n.title}</p>
              <p className="mt-0.5 text-xs text-faint-foreground">{n.sub}</p>
              <p className="mt-4 border-t border-border/60 pt-3 text-[13px] leading-snug text-pretty text-muted-foreground">
                <span className="mb-1 block text-[11px] text-faint-foreground">An observer sees</span>
                {n.seen}
              </p>
            </div>
            {i < LINKS.length && <Hop {...LINKS[i]} />}
          </div>
        ))}
      </div>
      <figcaption className="mt-6 max-w-[62ch] text-sm text-pretty text-faint-foreground">
        The pool’s own liquidity moves separately: it converts ZEC to SOL in fixed lots through NEAR Intents, on a schedule that does not depend on anyone’s trade.
      </figcaption>
    </figure>
  );
}

function Hop({ label, tone, cut }: { label: string; tone: "zec" | "fog"; cut: boolean }) {
  return (
    <div aria-hidden={cut ? undefined : true} className="relative flex min-h-24 shrink-0 items-center justify-center md:min-h-0 md:w-24 md:flex-col lg:w-28">
      <span data-tone={tone === "zec" ? "zec" : undefined} className="flow-line absolute inset-y-0 left-1/2 w-px -translate-x-1/2 md:inset-x-0 md:top-1/2 md:h-px md:w-auto md:translate-x-0 md:-translate-y-1/2" />
      {cut && <span className="redaction-tape absolute top-[22%] left-1/2 h-4 w-14 -translate-x-1/2 -translate-y-1/2 -rotate-12 rounded-[3px] md:top-1/2 md:h-12 md:w-5 md:rotate-12" />}
      <span
        className={cn(
          "relative z-10 rounded-full border bg-background px-2 py-0.5 text-[11px] whitespace-nowrap md:mt-16 md:border-0 md:bg-transparent md:px-0 md:text-center md:whitespace-normal",
          cut ? "border-zec/40 text-zec max-md:mt-6" : "border-border text-faint-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}

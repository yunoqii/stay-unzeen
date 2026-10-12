"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, LockSimple } from "@phosphor-icons/react";
import type { FairBid, FairLaunch, OwnFairLaunch } from "@/lib/api/types";
import "@/lib/fair/api";
import { getLaunches } from "@/lib/fair/api";
import { formatZec } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { Veiled } from "@/components/portfolio/peek";
import { SealedGlyphs, STATUS_LABEL } from "./parts";

const BID_LABEL: Record<FairBid["status"], string> = {
  sealed: "Sealed",
  cancelled: "Withdrawn",
  invalid: "Invalid · hold returned",
  revealed: "Revealed",
  settled: "Settled",
  released: "Released",
};

/**
 * Names for launch ids come from the public list (same request for everyone), never from per-launch
 * requests that would show which launches this key cares about.
 */
function useLaunchNames(): Map<string, FairLaunch["meta"]> {
  const network = useNetwork();
  const [names, setNames] = useState(new Map<string, FairLaunch["meta"]>());
  useEffect(() => {
    let alive = true;
    getLaunches({ limit: 100 })
      .then((l) => alive && setNames(new Map(l.map((x) => [x.id, x.meta]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [network]);
  return names;
}

/** Portfolio: own sealed bids and own sealed-bid launches (Portfolio.fairBids / fairLaunches). */
export default function FairPortfolio({ bids, launches }: { bids: FairBid[]; launches: OwnFairLaunch[] }) {
  const names = useLaunchNames();
  if (bids.length === 0 && launches.length === 0) return null;
  const label = (id: string) => {
    const m = names.get(id);
    return m ? `$${m.symbol}` : `launch ${id.slice(0, 6)}`;
  };
  return (
    <section aria-labelledby="sealed-t" className="rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="sealed-t" className="font-medium">
          Sealed bids
        </h2>
        <p className="text-xs text-faint-foreground">Amounts are known only to you</p>
      </div>
      {bids.length > 0 && (
        <ul className="mt-3 divide-y divide-border/60">
          {bids.map((b, i) => (
            <li key={`${b.launchId}:${i}`}>
              <Link href={`/launch/${b.launchId}`} className="group flex items-center gap-3 py-3 focus-visible:outline-none">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-muted-foreground">
                  <LockSimple size={14} weight={b.status === "sealed" ? "duotone" : "light"} className={b.status === "sealed" ? "text-zec" : undefined} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">
                    {label(b.launchId)}{" "}
                    <span className="tabular text-muted-foreground">
                      {b.amountZat ? (
                        <>
                          · <Veiled>{formatZec(b.amountZat)}</Veiled> ZEC
                        </>
                      ) : (
                        <>
                          · <SealedGlyphs length={4} seed={i} /> ZEC
                        </>
                      )}
                    </span>
                  </span>
                  <span className="tabular block text-xs text-muted-foreground">
                    {BID_LABEL[b.status]} · hold {formatZec(b.holdZat)}
                    {b.chargedZat ? ` · charged ${formatZec(b.chargedZat)}` : ""}
                    {b.releasedZat && b.releasedZat !== "0" ? ` · returned ${formatZec(b.releasedZat)}` : ""}
                  </span>
                </span>
                <ArrowRight size={13} weight="light" className="shrink-0 text-faint-foreground group-hover:text-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {launches.length > 0 && (
        <>
          <p className="mt-5 text-xs text-muted-foreground">Your sealed-bid launches</p>
          <ul className="mt-1 divide-y divide-border/60">
            {launches.map((l) => (
              <li key={l.launchId}>
                <Link href={`/launch/${l.launchId}`} className="group flex items-center justify-between gap-3 py-2.5 text-sm focus-visible:outline-none">
                  <span>{label(l.launchId)}</span>
                  <span className="text-xs text-muted-foreground group-hover:text-foreground">{STATUS_LABEL[l.status]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CircleNotch, Info } from "@phosphor-icons/react";
import { errorText } from "@/lib/api/client";
import type { FairBid, FairLaunch, PoolInfo } from "@/lib/api/types";
import { useKeyState } from "@/lib/crypto/session";
import { getLaunch, LAUNCH_POLL_MS, postFair } from "@/lib/fair/api";
import { useLocalBids, usePruneLocalBids } from "@/lib/fair/bid-store";
import { formatZec } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { useNow } from "@/hooks/use-now";
import { usePortfolio } from "@/hooks/use-portfolio";
import { EmptyState } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { LaunchKeyPrompt } from "@/components/launch/launch-form";
import { BidForm, SealedBid } from "./bid-panel";
import { CommitmentCard } from "./commitment-card";
import { countdown, RoundTicker, SealedGlyphs, SealedRings, StatusPill } from "./parts";
import { RevealResult } from "./reveal-result";

const EASE = [0.16, 1, 0.3, 1] as const;

const FAILURE: Record<NonNullable<FairLaunch["failure"]>, string> = {
  no_bids: "There were no valid bids, so nothing was bought.",
  drand_unavailable: "The drand round could not be fetched and verified within an hour.",
  venue_unavailable: "pump.fun was not available when the round fired.",
  tx_failed: "The launch transaction did not land.",
  internal: "The bids the pool held did not match the published commitment, so nothing was bought.",
};

type Load = { id: string; state: "loading" } | { id: string; state: "missing" } | { id: string; state: "error"; error: string } | { id: string; state: "ready"; launch: FairLaunch };

/** Polls the public launch on a fixed rhythm shared by every viewer. */
function useLaunch(id: string): Load {
  const network = useNetwork();
  const [st, setSt] = useState<Load & { network: string }>({ id, network, state: "loading" });
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const run = () => {
      getLaunch(id)
        .then((l) => alive && setSt(l ? { id, network, state: "ready", launch: l } : { id, network, state: "missing" }))
        .catch((e: unknown) => alive && setSt((p) => (p.id === id && p.network === network && p.state === "ready" ? p : { id, network, state: "error", error: errorText(e) })))
        .finally(() => {
          if (alive) t = setTimeout(run, LAUNCH_POLL_MS);
        });
    };
    run();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [id, network]);
  return st.id === id && st.network === network ? st : { id, state: "loading" };
}

/** The most relevant own bid on this launch: an active one first, otherwise the latest. */
function pickBid(bids: FairBid[] | undefined, id: string): FairBid | undefined {
  const mine = (bids ?? []).filter((b) => b.launchId === id);
  return mine.find((b) => b.status !== "cancelled") ?? mine[0];
}

export default function FairLaunchView({ id, pool }: { id: string; pool: PoolInfo }) {
  const load = useLaunch(id);
  const now = useNow(1000);
  const { portfolio, refresh } = usePortfolio();
  const own = portfolio?.fairLaunches?.find((l) => l.launchId === id);

  if (load.state === "loading" || now === null) return <ViewSkeleton />;
  if (load.state === "error") return <EmptyState title="Could not load this launch">{load.error}</EmptyState>;
  if (load.state === "missing")
    return own?.status === "scheduled" ? (
      <Scheduled id={id} publishedAt={own.publishedAt} closeAt={own.closeAt} now={now} onCancelled={() => void refresh()} />
    ) : (
      <EmptyState title="No launch here">
        It may not be published yet: new launches appear at the next batch boundary.{" "}
        <Link href="/launch" className="text-foreground underline underline-offset-4 hover:text-zec">
          Back to Launch
        </Link>
      </EmptyState>
    );
  return <Launch launch={load.launch} pool={pool} now={now} isCreator={!!own} />;
}

function Launch({ launch, pool, now, isCreator }: { launch: FairLaunch; pool: PoolInfo; now: number; isCreator: boolean }) {
  const key = useKeyState();
  const { portfolio, refresh } = usePortfolio();
  const local = useLocalBids().bids.find((b) => b.launchId === launch.id);
  usePruneLocalBids(portfolio?.fairBids);
  const bid = pickBid(portfolio?.fairBids, launch.id);
  const open = launch.status === "open" && now < launch.closeAt;
  const sealed = bid?.status === "sealed";
  const phase: "open" | "waiting" | "launched" | "ended" =
    open ? "open" : launch.status === "launched" ? "launched" : launch.status === "failed" || launch.status === "cancelled" ? "ended" : "waiting";

  return (
    <div>
      <Link href="/launch" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft size={12} aria-hidden /> Launch
      </Link>
      <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs tracking-wider text-faint-foreground uppercase">Sealed-bid launch · pump.fun</p>
          <h1 className="mt-2 text-3xl font-medium tracking-tight sm:text-4xl">
            ${launch.meta.symbol} <span className="text-muted-foreground">{launch.meta.name}</span>
          </h1>
        </div>
        <StatusPill status={launch.status} />
      </header>
      <div aria-hidden className="hatch mt-6 h-3" />

      <div className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-4 bg-background p-6 text-center">
          <SealedRings launch={launch} now={now} />
          <RoundTicker round={launch.drand.round} now={now} />
          <p className="max-w-[240px] text-xs text-pretty text-faint-foreground">
            {phase === "open"
              ? "Bids are sealed. Count revealed after the round."
              : phase === "waiting"
                ? "Window closed. Bids open together at the drand round, then one transaction buys for everyone."
                : phase === "launched"
                  ? "Revealed at the round. Same price for every bidder."
                  : "Nothing was bought from this launch."}
          </p>
        </div>

        <div className="min-w-0 bg-background p-5 sm:p-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={phase}
              initial={{ opacity: 0, filter: "blur(8px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(8px)" }}
              transition={{ duration: 0.3, ease: EASE }}
              className="space-y-5"
            >
              {phase === "open" && (
                <>
                  {key.status !== "unlocked" ? (
                    key.status === "loading" ? null : <LaunchKeyPrompt next={`/launch/${launch.id}`} verb="bid" />
                  ) : sealed ? (
                    <SealedBid launch={launch} bid={bid!} local={local} canCancel onChanged={() => void refresh()} />
                  ) : pool.fairLaunch ? (
                    <BidForm launch={launch} pool={pool} portfolio={portfolio} isCreator={isCreator} onSealed={() => void refresh()} />
                  ) : null}
                  <p className="flex gap-2 text-xs text-pretty text-muted-foreground">
                    <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
                    If only a few people bid, your amount may be close to the total bought, which is public after the launch.
                  </p>
                  {isCreator && <CancelLaunch id={launch.id} />}
                </>
              )}

              {phase === "waiting" && (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-1 p-4">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {launch.status === "revealing" ? "Opening bids" : launch.status === "executing" ? "Create + buy in one transaction" : "Total of all bids"}
                      </p>
                      <p className="mt-2 text-3xl">
                        <SealedGlyphs length={8} seed={1} className="text-3xl" />
                      </p>
                    </div>
                    {(launch.status === "revealing" || launch.status === "executing" || now >= launch.drand.roundTime) && (
                      <CircleNotch size={18} className="animate-spin text-zec motion-reduce:animate-none" aria-label="In progress" />
                    )}
                  </div>
                  {bid?.status === "sealed" && (
                    <p className="text-xs text-muted-foreground">
                      Your bid is sealed in the set (hold {formatZec(bid.holdZat)} ZEC). It opens with everyone else&apos;s
                      {now < launch.drand.roundTime ? ` in ${countdown(launch.drand.roundTime - now)}.` : "."}
                    </p>
                  )}
                  <CommitmentCard launch={launch} bid={bid} local={local} />
                </>
              )}

              {phase === "launched" && launch.result && (
                <>
                  <RevealResult launch={launch} bid={bid} />
                  <details className="group rounded-2xl">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Commitment and inclusion proof</summary>
                    <div className="mt-3">
                      <CommitmentCard launch={launch} bid={bid} local={local} />
                    </div>
                  </details>
                </>
              )}

              {phase === "ended" && (
                <div className="rounded-2xl border border-border p-5">
                  <p className="text-lg font-medium">Funds released</p>
                  <p className="mt-1 text-sm text-pretty text-muted-foreground">
                    {launch.status === "cancelled" ? "The creator cancelled this launch before the window closed." : FAILURE[launch.failure ?? "no_bids"]} Every hold and the
                    creator&apos;s fee went back to balances.
                  </p>
                  {bid && bid.releasedZat && <p className="tabular mt-3 text-sm">Returned to you: {formatZec(bid.releasedZat)} ZEC</p>}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function CancelLaunch({ id, onDone }: { id: string; onDone?: () => void }) {
  const network = useNetwork();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await postFair(network, { op: "fl_cancel_launch", launchId: id });
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <div className="border-t border-border/60 pt-4">
      <p className="text-xs text-muted-foreground">You created this launch.</p>
      {confirm ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-sell">Cancel it? Every bid and your fee go back.</span>
          <button type="button" disabled={busy} onClick={() => void go()} className="h-8 rounded-full border border-sell/50 px-3 text-xs text-sell hover:bg-sell/10 disabled:opacity-50">
            {busy ? "Cancelling…" : "Yes, cancel launch"}
          </button>
          <button type="button" onClick={() => setConfirm(false)} className="h-8 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground">
            Keep it
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirm(true)} className="mt-2 h-8 rounded-full border border-border px-3 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground">
          Cancel launch
        </button>
      )}
      {error && <p className="mt-2 text-xs text-sell">{error}</p>}
    </div>
  );
}

function Scheduled({ id, publishedAt, closeAt, now, onCancelled }: { id: string; publishedAt: number; closeAt: number; now: number; onCancelled: () => void }) {
  return (
    <div className="mx-auto max-w-md text-center">
      <SealedRings launch={{ publishedAt: now - 1, closeAt: publishedAt, drand: { round: 0, roundTime: publishedAt }, status: "open" }} now={now} />
      <p className="mt-4 text-lg font-medium">Scheduled</p>
      <p className="mt-1 text-sm text-pretty text-muted-foreground">
        Your launch goes public at the next batch boundary{now < publishedAt ? `, in about ${countdown(publishedAt - now)}` : ""}, so the moment you signed doesn&apos;t point at you. The bid window then runs for{" "}
        {countdown(closeAt - publishedAt)}.
      </p>
      <div className="mt-4 text-left">
        <CancelLaunch id={id} onDone={onCancelled} />
      </div>
    </div>
  );
}

function ViewSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-10 w-64 rounded-xl" />
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  );
}

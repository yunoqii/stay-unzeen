"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleNotch, Plus } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, API_MODE, errorText } from "@/lib/api/client";
import { mockTakeSnapshot } from "@/lib/api/mock";
import type { VerifySnapshot, VerifySnapshotSummary } from "@/lib/api/types";
import { useNetwork, type Network } from "@/lib/network";
import { getLatestSnapshot, getSnapshot, getSnapshotHistory, HISTORY_PAGE } from "@/lib/verify/api";
import { checkSnapshot, solvency } from "@/lib/verify/merkle-sum";
import { pinnedOperator } from "@/lib/verify/pinned";
import { EmptyState } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { OwnProof } from "./own-proof";
import { RootHistory } from "./root-history";
import { SnapshotHeader } from "./snapshot-header";
import { SolvencyTable } from "./solvency-table";
import { VaultList } from "./vault-list";

/** While the latest root waits for its memo-tx: re-read the public snapshot on a fixed rhythm. */
const ANCHOR_POLL_MS = 10_000;

export function VerifyApp() {
  const network = useNetwork();
  // A new network = a new pool, new roots, new key: start from scratch.
  return <VerifyView key={network} network={network} />;
}

type Load = { status: "loading" } | { status: "empty" } | { status: "error"; message: string } | { status: "ready"; snap: VerifySnapshot };

function VerifyView({ network }: { network: Network }) {
  const [latestId, setLatestId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null); // null = latest
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [history, setHistory] = useState<VerifySnapshotSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reload, setReload] = useState(0);
  const [symbols, setSymbols] = useState<Map<string, string>>(new Map());

  // Token tickers for mint rows (public list, same call the feed makes).
  useEffect(() => {
    let alive = true;
    api
      .getTokens()
      .then((ts) => alive && setSymbols(new Map(ts.map((t) => [t.mint, t.symbol]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const p = selected === null ? getLatestSnapshot() : getSnapshot(selected);
    p.then((snap) => {
      if (!alive) return;
      if (!snap) return setLoad(selected === null ? { status: "empty" } : { status: "error", message: "This snapshot is not available." });
      if (selected === null) setLatestId(snap.id);
      setLoad({ status: "ready", snap });
    }).catch((e: unknown) => alive && setLoad({ status: "error", message: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [selected, reload]);

  useEffect(() => {
    let alive = true;
    getSnapshotHistory()
      .then((h) => {
        if (!alive) return;
        setHistory(h);
        setHasMore(h.length === HISTORY_PAGE);
      })
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, [reload]);

  // v0.10: the signature comes first, the anchor once the memo-tx is confirmed: re-read until both are in.
  const snap = load.status === "ready" ? load.snap : null;
  const waiting = !!snap && (!snap.anchor || !snap.operator);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setReload((r) => r + 1), ANCHOR_POLL_MS);
    return () => clearInterval(t);
  }, [waiting]);

  const check = useMemo(() => (snap ? checkSnapshot(snap, pinnedOperator(network)) : null), [snap, network]);
  const rows = useMemo(() => (snap && check ? solvency(snap, check) : []), [snap, check]);

  const select = useCallback(
    (id: number) => {
      const next = id === latestId ? null : id;
      if (next === selected) return;
      setLoad({ status: "loading" });
      setSelected(next);
    },
    [latestId, selected],
  );

  const loadOlder = useCallback(async () => {
    const last = history?.[history.length - 1];
    if (!last) return;
    try {
      const more = await getSnapshotHistory(last.id);
      setHistory((h) => [...(h ?? []), ...more]);
      setHasMore(more.length === HISTORY_PAGE);
    } catch (e) {
      toast.error(errorText(e));
    }
  }, [history]);

  const takeMockSnapshot = async () => {
    const id = await mockTakeSnapshot(network);
    toast("Mock operator took snapshot #" + id, { description: "The signature follows in a moment, the Solana anchor about half a minute later." });
    setLoad({ status: "loading" });
    setSelected(null);
    setReload((r) => r + 1);
  };

  const mockTools =
    API_MODE === "mock" && network === "devnet" ? (
      <button
        type="button"
        onClick={takeMockSnapshot}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-4 font-mono text-xs tracking-wide text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Plus size={12} aria-hidden /> Take a snapshot now (mock operator)
      </button>
    ) : null;

  if (load.status === "loading" && !snap)
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-44 rounded-none" />
        <Skeleton className="h-56 rounded-none" />
        <span className="sr-only">Loading the latest snapshot</span>
      </div>
    );
  if (load.status === "empty")
    return (
      <EmptyState art title="No snapshot yet">
        <p>The pool publishes its first root at 00:00 UTC. Come back then: this page checks it right here, in your browser.</p>
        {mockTools && <div className="mt-5 flex justify-center">{mockTools}</div>}
      </EmptyState>
    );
  if (load.status === "error")
    return (
      <EmptyState title="Could not load the snapshot">
        <p>{load.message}</p>
        <button
          type="button"
          onClick={() => {
            setLoad({ status: "loading" });
            setSelected(null);
            setReload((r) => r + 1);
          }}
          className="mt-4 text-sm text-foreground underline underline-offset-4"
        >
          Back to the latest
        </button>
      </EmptyState>
    );
  if (!snap || !check) return null;

  const isLatest = latestId === null || snap.id === latestId;
  // The server keeps proofs for the latest and the previous snapshot only (48 h).
  const prevId = history?.find((h) => h.id < (latestId ?? snap.id))?.id;
  const proofAvailable = isLatest || snap.id === prevId;

  return (
    <div className="space-y-12">
      <SnapshotHeader snap={snap} check={check} isLatest={isLatest} pinned={pinnedOperator(network)} network={network} />

      <section aria-labelledby="solv-t">
        <SectionTitle id="solv-t" title="Solvency" note="Liabilities are the root sums. Assets are what the signed vaults hold at the same slot." />
        <SolvencyTable rows={rows} symbols={symbols} />
      </section>

      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-8">
        <section aria-labelledby="own-t" className="min-w-0">
          <SectionTitle id="own-t" title="Check my balance" note="Your share of each tree, recomputed from your own key up to the published roots." />
          <OwnProof key={`${network}:${snap.id}`} snap={snap} network={network} available={proofAvailable} symbols={symbols} />
        </section>
        <section aria-labelledby="hist-t" className="min-w-0">
          <SectionTitle id="hist-t" title="Root history" note="One root a day, 00:00 UTC. Kept forever." />
          <RootHistory items={history} selected={snap.id} onSelect={select} hasMore={hasMore} onMore={loadOlder} />
          {load.status === "loading" && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-faint-foreground" aria-live="polite">
              <CircleNotch size={11} className="animate-spin motion-reduce:animate-none" aria-hidden /> Loading snapshot…
            </p>
          )}
          {mockTools && <div className="mt-4">{mockTools}</div>}
        </section>
      </div>

      <section aria-labelledby="vault-t">
        <SectionTitle id="vault-t" title="Pool vaults" note="Every address the pool holds anything on. Each one signed this snapshot with its own key: nobody else's wallet can be borrowed." />
        <VaultList snap={snap} check={check} symbols={symbols} />
      </section>
    </div>
  );
}

export function SectionTitle({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="mb-4 max-w-2xl">
      <h2 id={id} className="text-lg font-medium tracking-tight">
        {title}
      </h2>
      {note && <p className="mt-1 text-sm text-pretty text-muted-foreground">{note}</p>}
    </div>
  );
}

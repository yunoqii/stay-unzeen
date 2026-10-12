"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { usePool } from "@/hooks/use-pool";
import type { MetaInput } from "@/lib/launch";
import { sealedOn } from "@/lib/features";
import type { PoolInfo } from "@/lib/api/types";
import { Skeleton } from "@/components/ui/skeleton";
import { LaunchRulesCard } from "./launch-rules-card";
import { LaunchForm } from "./launch-form";

export interface LaunchModesProps {
  pool: PoolInfo;
  meta: MetaInput;
  onMeta: (m: MetaInput) => void;
  /** The instant launch form, rendered by the modes switch when that mode is picked. */
  instant: React.ReactNode;
}

// A second launch mode lives in its own chunk. It is requested only when the server reports it on
// (PoolInfo.features), and is compiled in only with NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1 (off by default until 28.10).
const Modes =
  process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD === "1"
    ? dynamic<LaunchModesProps>(() => import("@/components/fair/launch-modes"), { ssr: false, loading: () => <Skeleton className="h-11 w-full max-w-md rounded-full" /> })
    : null;

const EMPTY: MetaInput = { name: "", symbol: "", image: null };

export function LaunchApp() {
  const { pool, error, retry } = usePool();
  const [meta, setMeta] = useState<MetaInput>(EMPTY);

  if (!pool && error)
    return (
      <div role="alert" className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
        {error}{" "}
        <button type="button" onClick={retry} className="text-foreground underline underline-offset-4 hover:text-zec">
          Try again
        </button>
      </div>
    );
  if (!pool)
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
    );

  const instant = (
    <>
      <LaunchForm pool={pool} meta={meta} onMeta={setMeta} />
      <div className="mt-10 border border-border">
        <LaunchRulesCard />
      </div>
    </>
  );

  return Modes && sealedOn(pool) ? <Modes pool={pool} meta={meta} onMeta={setMeta} instant={instant} /> : instant;
}

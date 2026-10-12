"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { use } from "react";
import { usePool } from "@/hooks/use-pool";
import { sealedOn } from "@/lib/features";
import type { PoolInfo } from "@/lib/api/types";
import { EmptyState } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

// Loaded only when the server reports the feature on; compiled out with NEXT_PUBLIC_FAIR_LAUNCH_BUILD=0.
const View =
  process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD !== "0"
    ? dynamic<{ id: string; pool: PoolInfo }>(() => import("@/components/fair/fair-launch-view"), { ssr: false, loading: () => <Skeleton className="h-72 rounded-2xl" /> })
    : null;

/** /launch/<id>: a launch in progress. Without the feature it is indistinguishable from a wrong address. */
export function LaunchRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { pool, error } = usePool();
  if (!pool && !error) return <Skeleton className="h-72 rounded-2xl" />;
  if (!View || !pool || !sealedOn(pool) || !/^[0-9a-f]{32}$/.test(id))
    return (
      <EmptyState title="Nothing to see here">
        This page stayed unzeen.{" "}
        <Link href="/launch" className="text-foreground underline underline-offset-4 hover:text-zec">
          Back to Launch
        </Link>
      </EmptyState>
    );
  return <View id={id} pool={pool} />;
}

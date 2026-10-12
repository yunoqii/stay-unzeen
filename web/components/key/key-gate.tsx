"use client";

import Link from "next/link";
import { Key, LockKey } from "@phosphor-icons/react";
import { useKeyState } from "@/lib/crypto/session";
import { shortAddr } from "@/lib/format";
import { NETWORK_CONFIG } from "@/lib/network";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/page-shell";

/** Pages that act for the anon key render only when it is unlocked; otherwise they lead to /key. */
export function KeyGate({ next, children }: { next: "/portfolio" | "/pay" | `/token/${string}`; children: React.ReactNode }) {
  const state = useKeyState();
  if (state.status === "loading")
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
    );
  if (state.status === "unlocked") return <>{children}</>;

  const href = `/key?next=${encodeURIComponent(next)}`;
  const net = NETWORK_CONFIG[state.network].label;
  if (state.status === "locked")
    return (
      <EmptyState icon={<LockKey size={28} weight="thin" />} title={`Your ${net} anon key is locked`}>
        <p>
          Unlock <span className="font-mono text-xs">{shortAddr(state.pubkey, 4, 4)}</span> with your password to see
          your balance. It stays in this tab and locks on reload.
        </p>
        <div className="mt-5 flex justify-center">
          <Button asChild className="h-10 rounded-full px-5">
            <Link href={href}>Unlock key</Link>
          </Button>
        </div>
      </EmptyState>
    );
  return (
    <EmptyState icon={<Key size={28} weight="thin" />} title={`No ${net} anon key on this device`}>
      <p>Create a 12-word key or restore one you already have. It is encrypted here and never sent to the server.</p>
      <div className="mt-5 flex justify-center">
        <Button asChild className="h-10 rounded-full px-5">
          <Link href={href}>Set up anon key</Link>
        </Button>
      </div>
    </EmptyState>
  );
}

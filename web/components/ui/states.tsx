"use client";

// Shared UX states (docs/design/ux-states.md): error with a retry, stale data note, connection banner.
// Empty states use EmptyState (components/layout/page-shell.tsx, with the `art` illustration).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowClockwise, CloudSlash, Hourglass, WifiSlash, WarningCircle } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import { useConnection } from "@/lib/connectivity";
import { onAutoLock } from "@/lib/crypto/session";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";

const TITLE: Partial<Record<string, string>> = {
  network: "Can't reach unzeen",
  internal: "Something broke on our side",
  rate_limited: "Slow down a little",
  unauthorized: "Your key could not be verified",
  locked: "Your key is locked",
  not_found: "Not found",
  venue_unavailable: "The launchpad isn't answering",
};

/** What the user can do about an error, by code. */
function actionFor(e: unknown): { href?: string; label: string } | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === "locked" || e.code === "unauthorized") return { href: "/key", label: "Unlock key" };
  if (e.code === "insufficient_balance") return { href: "/pay", label: "Top up" };
  return null;
}

/** An error in place of content: title by code, the same text as everywhere else, and a retry. */
export function ErrorState({ error, onRetry, title, className, compact }: { error: unknown; onRetry?: () => void; title?: string; className?: string; compact?: boolean }) {
  const code = error instanceof ApiError ? error.code : "internal";
  const act = actionFor(error);
  const [wait, setWait] = useState(error instanceof ApiError && error.code === "rate_limited" ? (error.retryAfter ?? 0) : 0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  return (
    <div role="alert" className={cn("flex flex-col items-center rounded-2xl border border-border px-6 text-center", compact ? "py-6" : "py-12", className)}>
      {code === "network" ? <WifiSlash size={22} weight="light" className="text-muted-foreground" aria-hidden /> : <WarningCircle size={22} weight="light" className="text-sell" aria-hidden />}
      <p className="mt-3 text-sm font-medium">{title ?? TITLE[code] ?? "Something went wrong"}</p>
      <p className="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">{typeof error === "string" ? error : errorText(error)}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={wait > 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-foreground transition-colors hover:border-border-strong disabled:text-faint-foreground"
          >
            <ArrowClockwise size={14} aria-hidden />
            {wait > 0 ? `Try again in ${wait}s` : "Try again"}
          </button>
        )}
        {act?.href && (
          <Link href={act.href} className="inline-flex h-9 items-center rounded-full bg-zec px-4 text-sm text-background">
            {act.label}
          </Link>
        )}
      </div>
    </div>
  );
}

/** "Updated 42s ago": shown only once data is older than `after` ms (a poll or socket fell behind). */
export function StaleNote({ at, after = 30_000, className }: { at: number | null; after?: number; className?: string }) {
  const now = useNow(5_000);
  if (at === null || now === null || now - at < after) return null;
  const s = Math.floor((now - at) / 1000);
  const ago = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  return (
    <span role="status" className={cn("inline-flex items-center gap-1.5 text-[11px] text-faint-foreground", className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-zec/70" />
      Updated {ago} ago
    </span>
  );
}

const BANNER = {
  offline: { icon: WifiSlash, text: "You're offline. Showing the last data we had; nothing is sent until you're back." },
  down: { icon: CloudSlash, text: "Can't reach unzeen right now. Retrying on the usual schedule." },
  slow: { icon: Hourglass, text: "Slow connection. Still working on it." },
} as const;

/** One banner under the header for the whole app: offline, API down, slow network. */
export function ConnectionBanner() {
  const c = useConnection();
  const router = useRouter();
  useEffect(
    () =>
      onAutoLock(() =>
        toast("Your key locked itself", {
          description: "30 minutes without activity. Unlock it again to trade or post.",
          action: { label: "Unlock", onClick: () => router.push("/key") },
        }),
      ),
    [router],
  );
  const b = c === "ok" ? null : BANNER[c];
  return (
    <AnimatePresence initial={false}>
      {b && (
        <motion.div
          key={c}
          role="status"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          style={{ overflow: "hidden" }}
          className={cn("border-b text-xs", c === "slow" ? "border-border/60 bg-surface-1 text-muted-foreground" : "border-sell/30 bg-sell/10 text-foreground/90")}
        >
          <p className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-4 py-2 sm:px-6">
            <b.icon size={14} weight="light" aria-hidden />
            {b.text}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

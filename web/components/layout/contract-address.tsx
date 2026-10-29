"use client";

import Link from "next/link";
import { CopyButton } from "@/components/ui/copy-button";
import { shortAddr } from "@/lib/format";
import { TOKEN_CA, TOKEN_CA_HREF } from "@/lib/site";
import { cn } from "@/lib/utils";

/**
 * The unzeen token contract address: a mono-caps "CA" label, the mint (short on narrow screens, full on
 * wide ones) linking to its token page, and a copy button that always copies the full address.
 * `hero` sits under the landing CTA; `compact` is the footer chip on every page.
 */
export function ContractAddress({ variant = "compact", className }: { variant?: "hero" | "compact"; className?: string }) {
  const hero = variant === "hero";
  return (
    <div
      className={cn(
        "inline-flex max-w-full min-w-0 items-center rounded-full border border-border bg-surface-1",
        hero ? "h-10 gap-3 pr-3 pl-4" : "h-8 gap-2 pr-2.5 pl-3",
        className,
      )}
    >
      <span className={cn("shrink-0 font-mono tracking-wider text-faint-foreground uppercase", hero ? "text-[11px]" : "text-[10px]")}>CA</span>
      <Link
        href={TOKEN_CA_HREF}
        aria-label={`Token contract address ${TOKEN_CA}`}
        title={TOKEN_CA}
        className={cn(
          "min-w-0 truncate rounded font-mono text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          hero ? "text-[13px]" : "text-[12px]",
        )}
      >
        <span className={hero ? "sm:hidden" : "md:hidden"}>{shortAddr(TOKEN_CA, 6, 6)}</span>
        <span className={hero ? "max-sm:hidden" : "max-md:hidden"}>{TOKEN_CA}</span>
      </Link>
      <CopyButton value={TOKEN_CA} label="Copy contract address" size={hero ? 14 : 12} className="shrink-0" />
    </div>
  );
}

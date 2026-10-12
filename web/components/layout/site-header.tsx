"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { API_MODE } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { KeyStatus } from "./key-status";
import { Wordmark } from "./logo";
import { NAV, isActive } from "./nav-items";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-(--header-h) max-w-6xl items-center justify-between gap-6 px-4 sm:px-6">
        <Link href="/" className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Wordmark />
        </Link>

        <nav aria-label="Primary" className="hidden md:block">
          <Suspense fallback={<DesktopNavList pathname={null} />}>
            <DesktopNavActive />
          </Suspense>
        </nav>

        <div className="flex items-center gap-2">
          {API_MODE === "mock" && (
            <span
              title="Running on mock data (NEXT_PUBLIC_API_MODE=mock)"
              className="rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase"
            >
              mock
            </span>
          )}
          <KeyStatus />
        </div>
      </div>
    </header>
  );
}

function DesktopNavActive() {
  return <DesktopNavList pathname={usePathname()} />;
}

function DesktopNavList({ pathname }: { pathname: string | null }) {
  return (
          <ul className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = pathname !== null && isActive(pathname, item.href);
              return (
                <li key={item.href} className="relative">
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative z-10 block rounded-full px-3.5 py-1.5 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                  {active && (
                    <motion.span
                      layoutId="nav-pill"
                      className="absolute inset-0 rounded-full bg-surface-3"
                      transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
  );
}

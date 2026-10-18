"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { NAV, isActive } from "./nav-items";

/** Thumb-reachable navigation on phones (paying from ZODL happens on mobile). */
export function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      <Suspense fallback={<BottomNavList pathname={null} />}>
        <BottomNavActive />
      </Suspense>
    </nav>
  );
}

function BottomNavActive() {
  return <BottomNavList pathname={usePathname()} />;
}

function BottomNavList({ pathname }: { pathname: string | null }) {
  return (
      <ul className="grid h-(--bottom-nav-h) grid-cols-6">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname !== null && isActive(pathname, href);
          return (
            <li key={href} className="relative">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-1 text-[11px] transition-colors duration-150",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon size={22} weight={active ? "duotone" : "light"} className={active ? "text-zec" : undefined} />
                {label}
              </Link>
              {active && (
                <motion.span
                  layoutId="bottom-nav-mark"
                  className="absolute top-0 left-1/2 h-px w-8 -translate-x-1/2 bg-zec"
                  transition={{ type: "spring", bounce: 0, duration: 0.3 }}
                />
              )}
            </li>
          );
        })}
      </ul>
  );
}

"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { API_MODE } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { DockItem, ProximityDock } from "@/components/motion/proximity-dock";
import { CaSearch } from "./ca-search";
import { KeyStatus } from "./key-status";
import { NetworkBanner } from "./network-banner";
import { NetworkSwitch } from "./network-switch";
import { ChainSwitch } from "./chain-switch";
import { PortfolioSync } from "./portfolio-sync";
import { TradingWatchers } from "@/components/trading/trading-watchers";
import { CoverTraffic } from "./cover-traffic";
import { ConnectionBanner } from "@/components/ui/states";
import { LogoLink } from "./logo";
import { NAV, NAV_SECONDARY, isActive } from "./nav-items";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-(--header-h) max-w-6xl items-center justify-between gap-6 px-4 sm:px-6">
        <LogoLink />

        <nav aria-label="Primary" className="hidden md:block">
          <Suspense fallback={<DesktopNavList pathname={null} />}>
            <DesktopNavActive />
          </Suspense>
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {API_MODE === "mock" && (
            <span
              title="Running on mock data (NEXT_PUBLIC_API_MODE=mock)"
              className="hidden rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase lg:inline"
            >
              mock
            </span>
          )}
          <CaSearch />
          <ChainSwitch />
          <NetworkSwitch />
          <KeyStatus />
          <PortfolioSync />
          <TradingWatchers />
          <CoverTraffic />
        </div>
      </div>
      <NetworkBanner />
      <ConnectionBanner />
    </header>
  );
}

function DesktopNavActive() {
  return <DesktopNavList pathname={usePathname()} />;
}

function DesktopNavList({ pathname }: { pathname: string | null }) {
  return (
          // New style (owner review): the proximity dock runs on the feed and token pages only for now.
          <ProximityDock enabled={pathname === "/" || !!pathname?.startsWith("/token/")} className="flex items-center gap-1">
            {[...NAV, ...NAV_SECONDARY].map((item) => {
              const active = pathname !== null && isActive(pathname, item.href);
              return (
                <DockItem key={item.href} className="relative">
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
                </DockItem>
              );
            })}
          </ProximityDock>
  );
}

"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { CaretDown, Info } from "@phosphor-icons/react";
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
import { NAV, NAV_SECONDARY, isActive, type NavItem } from "./nav-items";

/** The app header. Hidden on "/" (the landing draws its own), together with the network banner under it. */
export function SiteHeader() {
  return (
    // Fallback = the bar: dynamic routes (/token/[mint]) keep it in the static shell; "/" is static, so its
    // prerender already resolves the pathname and ships no header.
    <Suspense fallback={<SiteHeaderBar />}>
      <SiteHeaderOffLanding />
    </Suspense>
  );
}

function SiteHeaderOffLanding() {
  if (usePathname() === "/") return null;
  return <SiteHeaderBar />;
}

function SiteHeaderBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-(--header-h) max-w-6xl items-center justify-between gap-2 px-4 sm:gap-3 sm:px-6 lg:gap-6">
        <span className="relative shrink-0">
          <LogoLink />
          {/* Dev builds only; sits under the logo so it takes no room in the row. */}
          {API_MODE === "mock" && (
            <span
              title="Running on mock data (NEXT_PUBLIC_API_MODE=mock)"
              className="pointer-events-none absolute top-full left-7 -mt-0.5 font-mono text-[9px] leading-none tracking-wider text-faint-foreground uppercase"
            >
              mock
            </span>
          )}
        </span>

        <nav aria-label="Primary" className="hidden min-w-0 md:block">
          <Suspense fallback={<DesktopNavList pathname={null} />}>
            <DesktopNavActive />
          </Suspense>
        </nav>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
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

// Fits 768–1440 px on one row (owner review 24.10): Feed, Tokens, Launch, Portfolio always inline; Pulse and
// Verify inline from lg; Watchlist, Scenarios and Docs always in "More". Plain CSS breakpoints, no measuring.
function DesktopNavList({ pathname }: { pathname: string | null }) {
  const inMore = NAV_SECONDARY.some((i) => pathname !== null && isActive(pathname, i.href));
  const wideActive = NAV.some((i) => i.wide && pathname !== null && isActive(pathname, i.href));
  return (
    // New style (owner review): the proximity dock runs on the feed and token pages only for now.
    <ProximityDock enabled={pathname === "/feed" || !!pathname?.startsWith("/token/")} className="flex items-center gap-0.5 lg:gap-1">
      {NAV.map((item) => {
        const active = pathname !== null && isActive(pathname, item.href);
        return (
          <DockItem key={item.href} className={cn("relative", item.wide && "hidden lg:block")}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative z-10 block rounded-full px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none xl:px-3",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
            {active && <NavPill />}
          </DockItem>
        );
      })}
      <DockItem className="relative">
        <MoreMenu pathname={pathname} items={[...NAV.filter((i) => i.wide), ...NAV_SECONDARY]} />
        {/* Lit when the page lives in the menu; Pulse/Verify only count while they are hidden (under lg). */}
        {inMore && <NavPill />}
        {!inMore && wideActive && <NavPill className="lg:hidden" />}
      </DockItem>
    </ProximityDock>
  );
}

function NavPill({ className }: { className?: string }) {
  return <motion.span layoutId="nav-pill" className={cn("absolute inset-0 rounded-full bg-surface-3", className)} transition={{ type: "spring", bounce: 0, duration: 0.35 }} />;
}

const MENU_ITEM =
  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground outline-none select-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-foreground";

/** lg and up: Pulse and Verify are inline, so the menu drops them (CSS-hidden items would trap arrow keys). */
function useLg(): boolean {
  const [lg, setLg] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setLg(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return lg;
}

function MoreMenu({ pathname, items }: { pathname: string | null; items: NavItem[] }) {
  const lg = useLg();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger className="group relative z-10 flex items-center gap-1 rounded-full px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:text-foreground xl:px-3">
        More
        <CaretDown size={12} weight="bold" aria-hidden className="transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="z-50 min-w-48 rounded-xl border border-border bg-popover p-1 shadow-xl">
          {items.filter((i) => !(lg && i.wide)).map(({ href, label, icon: Icon }) => {
            const active = pathname !== null && isActive(pathname, href);
            return (
              <DropdownMenu.Item key={href} asChild className={cn(MENU_ITEM, active && "text-foreground")}>
                <Link href={href} aria-current={active ? "page" : undefined}>
                  <Icon size={16} weight={active ? "duotone" : "light"} className={active ? "text-zec" : undefined} aria-hidden />
                  {label}
                </Link>
              </DropdownMenu.Item>
            );
          })}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild className={MENU_ITEM}>
            <Link href="/">
              <Info size={16} weight="light" aria-hidden />
              About
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

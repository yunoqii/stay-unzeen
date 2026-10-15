import { Broadcast, Coins, FlowArrow, RocketLaunch, Wallet, SealCheck, type Icon } from "@phosphor-icons/react";

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Feed", icon: Broadcast },
  { href: "/tokens", label: "Tokens", icon: Coins },
  { href: "/launch", label: "Launch", icon: RocketLaunch },
  { href: "/portfolio", label: "Portfolio", icon: Wallet },
  { href: "/verify", label: "Verify", icon: SealCheck },
];

/** Desktop header only; on phones these live in the footer. */
export const NAV_SECONDARY: NavItem[] = [
  { href: "/scenarios", label: "Scenarios", icon: FlowArrow },
  { href: "/docs", label: "Docs", icon: SealCheck },
];

export function isActive(pathname: string, href: string) {
  // A token page is not the feed: no tab is lit there (owner review 15.10).
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

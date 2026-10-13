import { Broadcast, Coins, RocketLaunch, Wallet, SealCheck, type Icon } from "@phosphor-icons/react";

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
export const NAV_SECONDARY: NavItem[] = [{ href: "/docs", label: "Docs", icon: SealCheck }];

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" || pathname.startsWith("/token/") : pathname.startsWith(href);
}

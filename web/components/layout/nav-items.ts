import { Broadcast, RocketLaunch, Wallet, SealCheck, type Icon } from "@phosphor-icons/react";

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Feed", icon: Broadcast },
  { href: "/launch", label: "Launch", icon: RocketLaunch },
  { href: "/portfolio", label: "Portfolio", icon: Wallet },
  { href: "/verify", label: "Verify", icon: SealCheck },
];

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" || pathname.startsWith("/token/") : pathname.startsWith(href);
}

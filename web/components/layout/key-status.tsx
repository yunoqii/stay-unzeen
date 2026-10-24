"use client";

import Link from "next/link";
import { GearSix, Key, LockKey, LockKeyOpen } from "@phosphor-icons/react";
import { useKeyState } from "@/lib/crypto/session";
import { cn } from "@/lib/utils";

/** Header chip: where the anon key stands in this tab. Shows no part of the key. */
export function KeyStatus() {
  const state = useKeyState();
  if (state.status === "loading") return <span aria-hidden className="h-8 w-8 sm:max-md:w-20 lg:w-20" />;
  const { Icon, label } =
    state.status === "unlocked"
      ? { Icon: LockKeyOpen, label: "Unlocked" }
      : state.status === "locked"
        ? { Icon: LockKey, label: "Locked" }
        : { Icon: Key, label: "Set up key" };
  const chip = (
    <Link
      href="/key"
      aria-label={`Anon key: ${label}`}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        state.status === "unlocked"
          ? "border-zec/30 text-foreground hover:border-zec/60"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon size={14} weight={state.status === "unlocked" ? "duotone" : "light"} className={state.status === "unlocked" ? "text-zec" : undefined} />
      <span className="hidden sm:max-md:inline lg:inline">{label}</span>
    </Link>
  );
  if (state.status !== "unlocked") return chip;
  // Settings (default execution mode) live in /portfolio; reachable straight from the key chip on xl+ (narrower
  // headers have no room for it: Portfolio is one tap away).
  return (
    <span className="inline-flex items-center gap-1">
      {chip}
      <Link
        href="/portfolio#settings"
        aria-label="Settings"
        title="Settings"
        className="hidden size-8 place-items-center rounded-full border border-border text-muted-foreground xl:grid transition-colors duration-150 hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <GearSix size={14} weight="light" />
      </Link>
    </span>
  );
}

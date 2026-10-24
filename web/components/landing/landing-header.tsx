"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, XLogo } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { TapeMark, Wordmark } from "@/components/layout/logo";
import { PauseToggle } from "./motion-pref";
import { X_URL } from "./content";

const ANCHORS = [
  { href: "#how", label: "How it works" },
  { href: "#tour", label: "Product" },
  { href: "#privacy", label: "Privacy" },
  { href: "#faq", label: "FAQ" },
];

/** Light landing bar: logo, anchors, motion switch, X, and the way into the app. */
export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [peel, setPeel] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 border-b transition-[background-color,border-color] duration-300",
        scrolled ? "border-border/60 bg-background/80 backdrop-blur-xl" : "border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-(--landing-gutter)">
        <Link
          href="/"
          aria-label="unzeen"
          onPointerEnter={(e) => e.pointerType === "mouse" && setPeel(true)}
          onPointerLeave={() => setPeel(false)}
          onFocus={(e) => setPeel(e.currentTarget.matches(":focus-visible"))}
          onBlur={() => setPeel(false)}
          className="inline-flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-zec focus-visible:outline-none"
        >
          <TapeMark />
          <Wordmark peeled={peel} />
        </Link>

        <nav aria-label="On this page" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {ANCHORS.map((a) => (
              <li key={a.href}>
                <a
                  href={a.href}
                  className="rounded-full px-3 py-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {a.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-1 sm:gap-2">
          <PauseToggle />
          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="unzeen on X"
            className="hit hidden size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:grid"
          >
            <XLogo size={16} weight="regular" aria-hidden />
          </a>
          <Link
            href="/feed"
            className="group inline-flex h-9 items-center gap-1.5 rounded-full bg-zec pr-3 pl-4 text-[13px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-[#f8ca5c] focus-visible:ring-2 focus-visible:ring-zec focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          >
            Open app
            <ArrowRight size={14} weight="bold" aria-hidden className="transition-transform duration-200 ease-shadow group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

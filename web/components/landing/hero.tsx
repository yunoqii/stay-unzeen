"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowDown, ArrowRight } from "@phosphor-icons/react";
import { RedactionTape } from "@/components/motion/redaction-tape";
import { ContractAddress } from "@/components/layout/contract-address";
import { PhoneMock } from "./phone-mock";

const EASE = [0.16, 1, 0.3, 1] as const;

/** What a block explorer shows for the trade at the top of the phone feed. */
function ChainCard() {
  const rows: [string, React.ReactNode][] = [
    ["Signer", <span key="s">pool vault <span className="text-faint-foreground">9wQe…c07E</span></span>],
    ["Action", <span key="a">buy <span className="text-foreground">1.2M $PEPE</span></span>],
    ["Paid", <span key="p" className="text-buy">0.4 SOL</span>],
    [
      "Trader",
      <span key="t" className="relative inline-block w-24">
        &nbsp;
        <RedactionTape state="covered" instant className="inset-y-0.5" />
      </span>,
    ],
    ["Deposit", <span key="d" className="text-faint-foreground">no link on chain</span>],
  ];
  return (
    <div aria-hidden className="w-[248px] rounded-2xl border border-border bg-[#0d0d10]/95 p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)] backdrop-blur-md">
      <p className="text-[11px] text-faint-foreground">What the chain sees</p>
      <dl className="mt-3 grid grid-cols-[64px_1fr] gap-x-3 gap-y-2 font-mono text-[11.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-faint-foreground">{k}</dt>
            <dd className="truncate text-muted-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function LandingHero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      {/* The eclipse: a 10 KB still from the brand loop, local. Mood only. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[url('/hero/eclipse-poster.webp')] bg-cover bg-[position:72%_30%] opacity-60 max-lg:bg-[position:85%_0%] max-lg:opacity-40"
        style={{ maskImage: "linear-gradient(to bottom, #000 55%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, #000 55%, transparent)" }}
      />
      <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-(--landing-gutter) pt-32 pb-20 sm:pt-36 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-10 lg:pt-40 lg:pb-28">
        <div className="min-w-0">
          <h1 id="hero-title" className="text-[3rem] leading-[0.98] font-medium tracking-[-0.04em] text-balance sm:text-[4.25rem] lg:text-[4.5rem] xl:text-[4.875rem]">
            Launch anywhere.
            <br />
            <span className="text-muted-foreground">
              Stay{" "}
              <span className="relative inline-block text-foreground">
                unzeen
                <motion.span
                  aria-hidden
                  className="hatch-zec absolute inset-x-0 -bottom-2 h-3 origin-left sm:-bottom-3 sm:h-4"
                  initial={{ scaleX: 0, opacity: 0 }}
                  animate={{ scaleX: 1, opacity: 1 }}
                  transition={{ duration: 0.8, delay: 0.3, ease: EASE }}
                />
              </span>
              .
            </span>
          </h1>
          <p className="mt-8 max-w-[34rem] text-lg leading-relaxed text-pretty text-muted-foreground sm:text-[19px]">
            Buy, sell and launch tokens on pump.fun, Meteora and more, paid with shielded ZEC. Shared pool vaults sign every trade, so the feed says{" "}
            <span className="whitespace-nowrap text-foreground">“unzeen bought 1.2M $PEPE”</span> and never who.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/feed"
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-zec pr-5 pl-6 text-[15px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-[#f8ca5c] focus-visible:ring-2 focus-visible:ring-zec focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
            >
              Open app
              <ArrowRight size={16} weight="bold" aria-hidden className="transition-transform duration-200 ease-shadow group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#how"
              className="inline-flex h-12 items-center gap-2 rounded-full border border-border bg-surface-1 px-5 text-[15px] text-foreground transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              See how it works
              <ArrowDown size={14} weight="regular" aria-hidden />
            </a>
          </div>
          <ContractAddress variant="hero" className="mt-5" />
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-faint-foreground">
            <li>No wallet to connect</li>
            <li>No email, no sign-up</li>
            <li>Your key never leaves the browser</li>
          </ul>
        </div>

        <div className="relative mx-auto w-full max-w-[420px]">
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, delay: 0.15, ease: EASE }}>
            <PhoneMock />
          </motion.div>
          <motion.div
            className="absolute -bottom-6 -left-4 hidden sm:block lg:-left-28"
            initial={{ opacity: 0, x: -16, filter: "blur(8px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.8, delay: 0.7, ease: EASE }}
          >
            <ChainCard />
          </motion.div>
        </div>
      </div>
    </section>
  );
}

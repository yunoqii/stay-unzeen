import Link from "next/link";
import { ArrowRight, XLogo } from "@phosphor-icons/react/ssr";
import { ContractAddress } from "@/components/layout/contract-address";
import { X_URL } from "./content";

const LINKS = [
  { href: "/feed", label: "Live feed" },
  { href: "/tokens", label: "Tokens" },
  { href: "/verify", label: "Verify" },
  { href: "/stats", label: "Stats" },
  { href: "/docs", label: "Docs" },
];

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden border-t border-border/60">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[url('/hero/eclipse-poster.webp')] bg-[length:1280px_auto] bg-[position:right_-260px_center] bg-no-repeat opacity-40 max-sm:bg-[length:900px_auto] max-sm:bg-[position:right_-360px_bottom]"
        style={{ maskImage: "radial-gradient(ellipse 70% 80% at 70% 50%, #000 30%, transparent 75%)", WebkitMaskImage: "radial-gradient(ellipse 70% 80% at 70% 50%, #000 30%, transparent 75%)" }}
      />
      <div className="mx-auto w-full max-w-6xl px-(--landing-gutter) py-24 sm:py-32">
        <h2 id="cta-title" className="max-w-3xl text-[2.5rem] leading-[1] font-medium tracking-[-0.04em] text-balance sm:text-[3.75rem] lg:text-[4.5rem]">
          Your next trade <span className="text-muted-foreground">doesn’t need your name.</span>
        </h2>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Link
            href="/feed"
            className="group inline-flex h-12 items-center gap-2 rounded-full bg-zec pr-5 pl-6 text-[15px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-[#f8ca5c] focus-visible:ring-2 focus-visible:ring-zec focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          >
            Open app
            <ArrowRight size={16} weight="bold" aria-hidden className="transition-transform duration-200 ease-shadow group-hover:translate-x-0.5" />
          </Link>
          <Link
            href="/verify"
            className="inline-flex h-12 items-center rounded-full border border-border bg-surface-1 px-5 text-[15px] transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Check the pool first
          </Link>
        </div>
      </div>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-(--landing-gutter) py-8 text-sm md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <p className="text-faint-foreground">
              Launch anywhere. <span className="text-muted-foreground">Stay unzeen.</span>
            </p>
            <ContractAddress className="my-2" />
            <p className="max-w-[60ch] text-xs text-pretty text-faint-foreground">
              Built for ZECATHON 2026, Private Markets track. An unaudited custodial pool: mainnet is there to show it works with real venues, not to hold meaningful funds.
            </p>
          </div>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-muted-foreground transition-colors hover:text-foreground">
                    {l.label}
                  </Link>
                </li>
              ))}
              <li>
                <a href={X_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
                  <XLogo size={14} aria-hidden />
                  @stayunzeen
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </footer>
    </section>
  );
}

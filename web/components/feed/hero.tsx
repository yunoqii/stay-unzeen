import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

/**
 * Static eclipse: the reduced-motion / low-power fallback of the WebGL hero
 * (FRONTEND.md moment 2). The shader lands on top of this later.
 */
function Eclipse() {
  return (
    <div aria-hidden className="pointer-events-none absolute -top-40 right-[-12rem] size-[30rem] sm:-top-44 sm:right-[-6rem] lg:right-0">
      <div className="absolute inset-0 rounded-full bg-[radial-gradient(closest-side,transparent_88%,rgb(244_183_40/0.35)_95%,transparent)] blur-2xl" />
      <div className="absolute inset-[6%] rounded-full shadow-[0_0_0_1px_rgb(244_183_40/0.55),0_0_60px_6px_rgb(244_183_40/0.18)]" />
      <div className="absolute inset-[6%] translate-x-[3%] translate-y-[-2%] rounded-full bg-[radial-gradient(circle_at_65%_35%,#121215,#060607_60%)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]" />
    </div>
  );
}

export function Hero({ onBuy }: { onBuy?: () => void }) {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <Eclipse />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background" aria-hidden />
      <div className="relative mx-auto max-w-6xl px-4 pt-10 pb-10 sm:px-6 sm:pt-14 sm:pb-12">
        <p className="mb-4 font-mono text-xs tracking-wider text-faint-foreground uppercase">
          Private trading for Solana launchpads · paid in shielded ZEC
        </p>
        <h1 className="max-w-xl text-4xl leading-[1.05] font-medium tracking-tight text-balance sm:text-5xl lg:text-[3.5rem]">
          Launch anywhere.
          <br />
          <span className="text-muted-foreground">Stay unzeen.</span>
        </h1>
        <p className="mt-4 max-w-md text-base text-pretty text-muted-foreground">
          Every trade below is real and on-chain. Who made it is not.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="h-11 rounded-full px-5 text-[15px]">
            <Link href="/launch">
              Launch a token
              <ArrowRight weight="bold" data-icon="inline-end" />
            </Link>
          </Button>
          <Button
            variant="outline"
            size="lg"
            onClick={onBuy}
            className="h-11 rounded-full border-border bg-surface-1 px-5 text-[15px] hover:border-border-strong hover:bg-surface-2"
          >
            Buy privately
          </Button>
        </div>
      </div>
    </section>
  );
}

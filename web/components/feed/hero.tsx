"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Can this device afford the WebGL eclipse? Otherwise the static one stays (FRONTEND.md moment 2). */
function webglAllowed(): boolean {
  if (new URLSearchParams(window.location.search).get("eclipse") === "static") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return false;
  if ((nav.hardwareConcurrency ?? 8) < 4 || (nav.deviceMemory ?? 8) < 4) return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

const EclipseGL = dynamic(() => import("./eclipse-gl"), { ssr: false });

/** Static eclipse (CSS) under a lazily loaded WebGL one; the static one is also the fallback. */
function Eclipse() {
  const [gl, setGl] = useState(false);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const decide = () => setGl(webglAllowed());
    // Off the critical path: decide after the feed had its first paint.
    const idle = window.requestIdleCallback ? window.requestIdleCallback(decide, { timeout: 1500 }) : window.setTimeout(decide, 300);
    mq.addEventListener("change", decide);
    return () => {
      mq.removeEventListener("change", decide);
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle as number);
      else clearTimeout(idle as number);
    };
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || !gl) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [gl]);

  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute -top-40 right-[-12rem] size-[30rem] sm:-top-44 sm:right-[-6rem] lg:right-0">
      {/* Ambient glow: mood borrowed from a looping glow video, rebuilt as a CSS gradient in Zcash yellow (no video, no request). */}
      <div className="uz-glow absolute inset-[-35%] rounded-full bg-[radial-gradient(closest-side,rgb(244_183_40/0.14),rgb(244_183_40/0.05)_45%,transparent_70%)] blur-2xl" />
      <div className={cn("absolute inset-0 transition-opacity duration-700", ready && "opacity-0")}>
        <div className="absolute inset-0 rounded-full bg-[radial-gradient(closest-side,transparent_88%,rgb(244_183_40/0.35)_95%,transparent)] blur-2xl" />
        <div className="absolute inset-[6%] rounded-full shadow-[0_0_0_1px_rgb(244_183_40/0.55),0_0_60px_6px_rgb(244_183_40/0.18)]" />
        <div className="absolute inset-[6%] translate-x-[3%] translate-y-[-2%] rounded-full bg-[radial-gradient(circle_at_65%_35%,#121215,#060607_60%)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]" />
      </div>
      {gl && (
        <div className={cn("absolute inset-[-16.667%] opacity-0 transition-opacity duration-700", ready && "opacity-100")}>
          <EclipseGL active={visible} onReady={() => setReady(true)} />
        </div>
      )}
    </div>
  );
}

export function Hero({ onBuy }: { onBuy?: () => void }) {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <Eclipse />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background" aria-hidden />
      <div className="relative mx-auto max-w-6xl px-4 pt-8 pb-8 sm:px-6 sm:pt-12 sm:pb-10">
        <p className="mb-4 font-mono text-xs tracking-wider text-faint-foreground uppercase">
          Private trading for Solana launchpads · paid in shielded ZEC
        </p>
        <h1 className="max-w-xl text-4xl leading-[1.05] font-medium tracking-tight text-balance sm:text-5xl lg:text-[3.5rem]">
          Launch anywhere.
          <br />
          <span className="text-muted-foreground">
            Stay{" "}
            <span className="relative inline-block text-foreground/90">
              unzeen
              {/* Redaction tape under the name: the one thing on-chain that is never filled in. */}
              <motion.span
                aria-hidden
                className="hatch-zec absolute inset-x-0 -bottom-1.5 h-2.5 origin-left sm:-bottom-2 sm:h-3"
                initial={{ scaleX: 0, opacity: 0 }}
                animate={{ scaleX: 1, opacity: 1 }}
                transition={{ duration: 0.7, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
              />
            </span>
            .
          </span>
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

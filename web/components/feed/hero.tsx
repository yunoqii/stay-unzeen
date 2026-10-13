"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type EclipseMode = "static" | "video" | "gl";

/**
 * Which eclipse this device gets (FRONTEND.md moment 2):
 *   - reduced motion / Save-Data: the poster (a still frame of the loop), nothing moves, nothing heavy loads;
 *   - capable device with WebGL: the interactive shader (it leans toward the pointer: the loop cannot);
 *   - everything else (few cores / little memory / no WebGL): the 1.5 MB H.264 loop, hardware-decoded.
 * `?eclipse=static|video|gl` forces one (demos, screenshots).
 */
function eclipseMode(): EclipseMode {
  const forced = new URLSearchParams(window.location.search).get("eclipse");
  if (forced === "static" || forced === "video" || forced === "gl") return forced;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "static";
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return "static";
  if ((nav.hardwareConcurrency ?? 8) < 4 || (nav.deviceMemory ?? 8) < 4) return "video";
  try {
    const c = document.createElement("canvas");
    return c.getContext("webgl2") ?? c.getContext("webgl") ? "gl" : "video";
  } catch {
    return "video";
  }
}

const EclipseGL = dynamic(() => import("./eclipse-gl"), { ssr: false });

const CONTACT_EASE = [0.22, 1, 0.36, 1] as const;

/** Static eclipse (CSS) first; then the poster, the loop or the WebGL one on top, by device. */
function Eclipse({ contact }: { contact: boolean }) {
  const [mode, setMode] = useState<EclipseMode | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const decide = () => {
      setReady(false);
      setMode(eclipseMode());
    };
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
    if (!el || (mode !== "gl" && mode !== "video")) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [mode]);

  // The loop plays only while on screen.
  useEffect(() => {
    const v = video.current;
    if (!v || mode !== "video") return;
    if (visible) void v.play().catch(() => {});
    else v.pause();
  }, [mode, visible]);

  // M3 in the CSS / video modes: the whole eclipse slides into phase, a bead flashes at the last point of
  // contact and the glow (corona) settles. The WebGL eclipse does the same with uniforms.
  const css = contact && mode !== null && mode !== "gl" && mode !== "static";
  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute -top-44 right-[-14rem] size-[24rem] opacity-70 sm:-top-44 sm:right-[-6rem] sm:size-[30rem] sm:opacity-100 lg:right-0">
      {/* Ambient glow in Zcash yellow. */}
      <motion.div
        className="absolute inset-[-35%]"
        initial={false}
        animate={contact && mode !== "static" ? { opacity: [0, 0, 1] } : { opacity: 1 }}
        transition={{ duration: 1.95, times: [0, 0.54, 1], ease: "easeOut" }}
      >
        <div className="uz-glow absolute inset-0 rounded-full bg-[radial-gradient(closest-side,rgb(244_183_40/0.14),rgb(244_183_40/0.05)_45%,transparent_70%)] blur-2xl" />
      </motion.div>
      {css && (
        <motion.div
          className="absolute top-[13%] right-[17%] z-10 size-[12%] rounded-full bg-[radial-gradient(closest-side,#fff6dc,rgb(244_183_40/0.9)_25%,transparent)]"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: [0, 1, 0], scale: [0.6, 1.15, 1] }}
          transition={{ duration: 0.7, delay: 1.05, times: [0, 0.35, 1], ease: "easeOut" }}
        />
      )}
      <motion.div
        className="absolute inset-0"
        initial={css ? { x: "-3%", y: "2%" } : false}
        animate={{ x: "0%", y: "0%" }}
        transition={{ duration: 1.4, ease: CONTACT_EASE }}
      >
      <div className={cn("absolute inset-0 transition-opacity duration-700", ready && "opacity-0")}>
        <div className="absolute inset-0 rounded-full bg-[radial-gradient(closest-side,transparent_88%,rgb(244_183_40/0.35)_95%,transparent)] blur-2xl" />
        <div className="absolute inset-[6%] rounded-full shadow-[0_0_0_1px_rgb(244_183_40/0.55),0_0_60px_6px_rgb(244_183_40/0.18)]" />
        <div className="absolute inset-[6%] translate-x-[3%] translate-y-[-2%] rounded-full bg-[radial-gradient(circle_at_65%_35%,#121215,#060607_60%)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]" />
      </div>
      {(mode === "static" || mode === "video") && (
        // The frame is 16:9 with the disc at ~41% of its height, 72% across: scaled and shifted so the disc sits where the CSS one is.
        // The frame background is the page colour already; the radial mask fades its edges.
        <div
          className={cn("absolute top-1/2 left-1/2 aspect-video h-[215%] -translate-x-[72%] -translate-y-1/2 opacity-0 transition-opacity duration-700", ready && "opacity-100")}
          // The disc sits at 72% of the frame's width; a radial mask hides the frame's edges.
          style={{ maskImage: "radial-gradient(ellipse 30% 50% at 72% 50%, #000 55%, transparent 100%)", WebkitMaskImage: "radial-gradient(ellipse 30% 50% at 72% 50%, #000 55%, transparent 100%)" }}
        >
          {mode === "video" ? (
            <video
              ref={video}
              className="size-full object-cover"
              src="/hero/eclipse-loop.mp4"
              poster="/hero/eclipse-poster.webp"
              muted
              loop
              playsInline
              autoPlay
              preload="metadata"
              disablePictureInPicture
              onLoadedData={() => setReady(true)}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a local still, no optimizer round-trip needed
            <img src="/hero/eclipse-poster.webp" alt="" className="size-full object-cover" onLoad={() => setReady(true)} />
          )}
        </div>
      )}
      {mode === "gl" && (
        <div className={cn("absolute inset-[-16.667%] opacity-0 transition-opacity duration-700", ready && "opacity-100")}>
          <EclipseGL active={visible} contact={contact} onReady={() => setReady(true)} />
        </div>
      )}
      </motion.div>
    </div>
  );
}

export function Hero({ onBuy, contact = false }: { onBuy?: () => void; contact?: boolean }) {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <Eclipse contact={contact} />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-background" aria-hidden />
      <div className="relative mx-auto max-w-6xl px-4 pt-8 pb-8 sm:px-6 sm:pt-12 sm:pb-10">
        <p className="mb-4 font-mono text-xs tracking-wider text-faint-foreground uppercase">
          Private trading for launchpads · Your account is shielded ZEC
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
          Every trade below is real and on-chain. Who made it is not. Priced in <span className="text-zec/90">ZEC</span>, the currency of this market.
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

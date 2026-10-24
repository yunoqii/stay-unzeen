"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { PEEL_HOLD_MS, PeelTape, PEEL_TRANSITION } from "@/components/motion/tape-peel";

// Brand v4 (docs/brand/final/GUIDE.md, for-web/logo.tsx.example): mark = folded two-layer tape (simple level
// in the header), wordmark D2a "un▬een". The geometry below is copied from svg/unzeen-wordmark-small-on-dark.svg
// (outlined Geist Black, tape kit "simple"); do not redraw or recolour it. The only addition is the "z" glyph
// (same font, same scale and slot as the brand build) that the tape hides: it is drawn ONLY while the tape is off.

/** Two-layer tape mark. Several shapes and tones, so it ships as a file, not an inline path. */
export function TapeMark({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/logo-mark.svg" alt="" aria-hidden width={24} height={24} className={cn("size-6", className)} />;
}

const UN = [
  "M234.0 12Q149.0 12 102.5 -41.5Q56.0 -95 56.0 -192V-540H250.0V-236Q250.0 -184 264.0 -160.5Q278.0 -137 308.0 -137Q343.0 -137 361.0 -162.5Q379.0 -188 379.0 -246V-540H573.0V0H399.0L395.0 -86Q355.0 12 234.0 12Z",
  "M655.0 0V-540H829.0L833.0 -457Q855.0 -509 896.0 -530.5Q937.0 -552 989.0 -552Q1073.0 -552 1123.5 -499.0Q1174.0 -446 1174.0 -347V0H980.0V-280Q980.0 -339 968.5 -371.0Q957.0 -403 918.0 -403Q881.0 -403 865.0 -371.0Q849.0 -339 849.0 -280V0Z",
];
const EEN = [
  "M2104.0 12Q2017.0 12 1952.0 -23.0Q1887.0 -58 1851.0 -121.5Q1815.0 -185 1815.0 -270Q1815.0 -355 1851.0 -418.0Q1887.0 -481 1952.0 -516.5Q2017.0 -552 2104.0 -552Q2191.0 -552 2254.5 -515.5Q2318.0 -479 2352.0 -412.0Q2386.0 -345 2386.0 -254V-220H2015.0Q2017.0 -171 2042.5 -147.5Q2068.0 -124 2108.0 -124Q2137.0 -124 2157.5 -135.0Q2178.0 -146 2187.0 -174L2379.0 -164Q2357.0 -77 2283.0 -32.5Q2209.0 12 2104.0 12ZM2015.0 -324H2192.0Q2191.0 -371 2167.0 -395.5Q2143.0 -420 2104.0 -420Q2067.0 -420 2042.5 -394.0Q2018.0 -368 2015.0 -324Z",
  "M2709.0 12Q2622.0 12 2557.0 -23.0Q2492.0 -58 2456.0 -121.5Q2420.0 -185 2420.0 -270Q2420.0 -355 2456.0 -418.0Q2492.0 -481 2557.0 -516.5Q2622.0 -552 2709.0 -552Q2796.0 -552 2859.5 -515.5Q2923.0 -479 2957.0 -412.0Q2991.0 -345 2991.0 -254V-220H2620.0Q2622.0 -171 2647.5 -147.5Q2673.0 -124 2713.0 -124Q2742.0 -124 2762.5 -135.0Q2783.0 -146 2792.0 -174L2984.0 -164Q2962.0 -77 2888.0 -32.5Q2814.0 12 2709.0 12ZM2620.0 -324H2797.0Q2796.0 -371 2772.0 -395.5Q2748.0 -420 2709.0 -420Q2672.0 -420 2647.5 -394.0Q2623.0 -368 2620.0 -324Z",
  "M3049.0 0V-540H3223.0L3227.0 -457Q3249.0 -509 3290.0 -530.5Q3331.0 -552 3383.0 -552Q3467.0 -552 3517.5 -499.0Q3568.0 -446 3568.0 -347V0H3374.0V-280Q3374.0 -339 3362.5 -371.0Q3351.0 -403 3312.0 -403Q3275.0 -403 3259.0 -371.0Q3243.0 -339 3243.0 -280V0Z",
];
/** Geist Black "z" at the slot of the brand build (x 1200 in font units, track −0.03 em). */
const Z = "M1249.0 0V-140L1518.0 -403H1263.0V-540H1757.0V-400L1480.0 -137H1764.0V0Z";
const UNDER = "M97.10,49.81 L178.63,49.81 L164.67,58.12 L175.14,66.43 L164.67,74.75 L178.63,83.06 L97.10,83.06 L101.89,71.98 L98.30,60.89 L97.10,49.81Z";
const TAPE = "M114.24,45.01 L180.26,45.01 L164.75,54.25 L176.38,63.48 L164.75,72.71 L180.26,81.95 L98.73,81.95 L104.05,74.81 L100.06,67.67 L98.73,60.53Z";
/** Axis-aligned box of the rotated yellow strip (+ its shadow step) in the 325×110 wordmark box. */
const BOX = { x: 100, y: 32, w: 88, h: 66 };
const VB = { w: 325, h: 110 };

/** Wordmark D2a, inline so the yellow strip can peel off the "z". Silent for screen readers (the link names it). */
export function Wordmark({ peeled = false, className }: { peeled?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-block h-6 w-auto", className)} style={{ aspectRatio: `${VB.w} / ${VB.h}` }}>
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} className="absolute inset-0 size-full overflow-visible" focusable="false">
        <g transform="translate(10 84) scale(0.076)" fill="#EDEDF0">
          {UN.map((d) => (
            <path key={d.slice(0, 12)} d={d} />
          ))}
        </g>
        <g transform="translate(40 84) scale(0.076)" fill="#EDEDF0">
          {EEN.map((d) => (
            <path key={d.slice(0, 12)} d={d} />
          ))}
        </g>
        {/* Dark second piece: always under the yellow, never moves. */}
        <g transform="rotate(12 137.86342 66.43488)">
          <path d={UNDER} fill="#34343B" />
          <clipPath id="uz-logo-under">
            <path d={UNDER} />
          </clipPath>
          <g clipPath="url(#uz-logo-under)">
            <path d="M131.34,49.81 L139.65,83.06" stroke="#232328" strokeWidth="2.99" fill="none" />
            <path d="M134.00,49.81 L142.31,83.06" stroke="#44444C" strokeWidth="1.33" fill="none" />
          </g>
        </g>
        {/* The hidden letter exists only while the tape is off. */}
        <AnimatePresence>
          {peeled && (
            <motion.g
              key="z"
              data-testid="logo-z"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.16, delay: 0.08 }}
            >
              <g transform="translate(25 84) scale(0.076)" fill="#EDEDF0">
                <path d={Z} />
              </g>
            </motion.g>
          )}
        </AnimatePresence>
      </svg>
      <PeelTape
        peeled={peeled}
        style={{ left: `${(BOX.x / VB.w) * 100}%`, top: `${(BOX.y / VB.h) * 100}%`, width: `${(BOX.w / VB.w) * 100}%`, height: `${(BOX.h / VB.h) * 100}%` }}
      >
        <svg viewBox={`${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`} className="block size-full overflow-visible" focusable="false">
          <g transform="rotate(-20 139.494 63.48)">
            <path d={TAPE} fill="#7A560A" transform="translate(1.85 4.06)" />
            <path d={TAPE} fill="#F4B728" />
            <clipPath id="uz-logo-tape">
              <path d={TAPE} />
            </clipPath>
            <g clipPath="url(#uz-logo-tape)">
              <path d="M144.39,45.01 L134.04,81.95" stroke="#D99E17" strokeWidth="4.06" fill="none" />
            </g>
            <path d="M114.24,45.01 L98.73,60.53 L113.00,59.28Z" fill="#B98410" />
          </g>
        </svg>
      </PeelTape>
    </span>
  );
}

const SESSION_FLAG = "uz-peeled";

/**
 * Header logo link. Hover and keyboard focus peel the tape off the "z"; leaving sticks it back. Plays once by
 * itself ~600 ms after the first load of a browser session (a flag in sessionStorage, nothing else), never
 * on scroll, never in a loop.
 */
/** Header logo: goes to the app (the feed), not the landing at "/". */
export function LogoLink({ className, href = "/feed" }: { className?: string; href?: string }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    let seen = true;
    try {
      seen = sessionStorage.getItem(SESSION_FLAG) === "1";
      if (!seen) sessionStorage.setItem(SESSION_FLAG, "1");
    } catch {
      /* storage off: skip the intro */
    }
    if (seen) return;
    const off = PEEL_TRANSITION.duration * 1000 + PEEL_HOLD_MS;
    const t1 = setTimeout(() => setAuto(true), 600);
    const t2 = setTimeout(() => setAuto(false), 600 + off);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <Link
      href={href}
      aria-label="unzeen"
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={(e) => setFocus(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => setFocus(false)}
      className={cn("inline-flex shrink-0 items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-zec focus-visible:outline-none", className)}
    >
      <TapeMark />
      {/* Under 360 px (iPhone SE 1st gen) the switches need the room: the mark alone stays. */}
      <span className="contents max-[359px]:hidden">
        <Wordmark peeled={hover || focus || auto} />
      </span>
    </Link>
  );
}

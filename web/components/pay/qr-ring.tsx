"use client";

import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { cn } from "@/lib/utils";

const R = 47; // viewBox 100

/**
 * The QR sits in a ring. Waiting: the ring breathes. Seen: it fills with confirmations.
 * Credited: full, one short yellow flash.
 */
export function QrRing({
  value,
  progress,
  state,
  dimmed,
  label,
}: {
  value: string | null;
  /** 0..1 */
  progress: number;
  state: "waiting" | "seen" | "credited" | "error";
  dimmed?: boolean;
  label: string;
}) {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[22rem]">
      {state === "waiting" && <div aria-hidden className="qr-breathe absolute inset-0 rounded-full border border-zec/25" />}
      <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="0.6" className="stroke-border-strong" />
        <motion.circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          strokeWidth="1.1"
          strokeLinecap="round"
          className={cn(state === "error" ? "stroke-muted-foreground" : "stroke-zec")}
          initial={false}
          animate={{ pathLength: progress, opacity: progress > 0 ? 1 : 0 }}
          transition={{ type: "spring", bounce: 0, duration: 0.6 }}
        />
      </svg>

      <div className="absolute inset-[13%] overflow-hidden rounded-2xl bg-foreground p-3 shadow-[0_0_80px_-20px_rgb(244_183_40/0.35)]">
        {value ? (
          <QRCodeSVG
            value={value}
            size={256}
            level="M"
            marginSize={0}
            bgColor="#ededf0"
            fgColor="#060607"
            title={label}
            className={cn("size-full transition-[filter,opacity] duration-(--motion-base)", dimmed && "opacity-30 blur-[3px]")}
          />
        ) : (
          <div className="size-full rounded-lg bg-[repeating-linear-gradient(45deg,#d6d6db_0_6px,#ededf0_6px_12px)] opacity-60" />
        )}
        <AnimatePresence>
          {state === "credited" && (
            <motion.div
              key="flash"
              aria-hidden
              className="absolute inset-0 bg-zec"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.55, 0] }}
              transition={{ duration: 0.7, times: [0, 0.25, 1], ease: "easeOut" }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

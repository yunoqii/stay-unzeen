"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy } from "@phosphor-icons/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Copy with feedback where the eye already is: the icon turns into a check for 1.4 s, then back.
 * A toast only when a description adds something (e.g. "paste it later, ideally over Tor").
 */
export function CopyButton({
  value,
  label,
  toastText,
  toastDescription,
  className,
  children,
  size = 12,
}: {
  value: string;
  label: string;
  toastText?: string;
  toastDescription?: string;
  className?: string;
  children?: React.ReactNode;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (toastText) toast(toastText, toastDescription ? { description: toastDescription } : undefined);
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "hit hit-lg inline-flex items-center gap-1 rounded transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        copied ? "text-zec" : "text-faint-foreground hover:text-muted-foreground",
        className,
      )}
    >
      {children}
      <span className="relative inline-grid" style={{ width: size, height: size }} aria-hidden>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={copied ? "ok" : "copy"}
            className="absolute inset-0 grid place-items-center"
            initial={{ opacity: 0, scale: 0.6, filter: "blur(2px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.6, filter: "blur(2px)" }}
            transition={{ duration: 0.16 }}
          >
            {copied ? <Check size={size} weight="bold" /> : <Copy size={size} weight="light" />}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

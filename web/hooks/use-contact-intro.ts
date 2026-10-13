"use client";

import { useEffect, useState } from "react";

const KEY = "uz:contact";

/**
 * M3 "Contact" plays once per session (sessionStorage flag), never with reduced motion or Save-Data.
 * `?contact=1` forces it (video recording). Decided after mount, so the server render never animates.
 */
export function useContactIntro(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const forced = new URLSearchParams(window.location.search).get("contact") === "1";
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (!forced && (window.matchMedia("(prefers-reduced-motion: reduce)").matches || nav.connection?.saveData)) return;
    try {
      if (!forced && sessionStorage.getItem(KEY)) return;
      sessionStorage.setItem(KEY, "1");
    } catch {
      /* storage off: play it, it is harmless */
    }
    const t = setTimeout(() => setOn(true), 0);
    return () => clearTimeout(t);
  }, []);
  return on;
}

"use client";

import dynamic from "next/dynamic";

// Literal env check: without NEXT_PUBLIC_MOCK_CHAOS=1 the import below is dead code and the panel is
// not in the build at all.
const Panel = process.env.NEXT_PUBLIC_MOCK_CHAOS === "1" ? dynamic(() => import("./chaos-panel"), { ssr: false }) : null;

export function ChaosMount() {
  return Panel ? <Panel /> : null;
}

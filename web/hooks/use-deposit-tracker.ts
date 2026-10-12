"use client";

import { useEffect, useRef, useState } from "react";
import { API_MODE } from "@/lib/api/client";
import { mockDepositPhase } from "@/lib/api/mock";
import type { DepositInfo, Portfolio } from "@/lib/api/types";
import type { Network } from "@/lib/network";
import { usePortfolio } from "./use-portfolio";

export type DepositPhase =
  | { step: "waiting" }
  /** Mock: seen by the simulated wallet. Real: the user says it was sent (the API can't attribute before K). */
  | { step: "seen"; confirmations: number | null }
  | { step: "credited"; deposit: DepositInfo; balanceZat: string }
  | { step: "dust" }
  | { step: "rejected" };

const signature = (p: Portfolio) => `${p.deposits.length}|${JSON.stringify(p.deposits.slice(0, 3))}`;

/**
 * Follows a Top up through Waiting -> Seen -> Credited. "Credited" comes only from the signed
 * portfolio: a new entry at the head of `deposits` since this request was opened.
 */
export function useDepositTracker(network: Network, memo: string) {
  const { portfolio, refresh } = usePortfolio(4_000);
  const baseline = useRef<string | null>(null);
  const [phase, setPhase] = useState<DepositPhase>({ step: "waiting" });

  // Credited: the deposit list changed since the baseline.
  useEffect(() => {
    if (!portfolio) return;
    const sig = signature(portfolio);
    if (baseline.current === null) {
      baseline.current = sig;
      return;
    }
    if (sig !== baseline.current && portfolio.deposits[0]) {
      baseline.current = sig;
      setPhase({ step: "credited", deposit: portfolio.deposits[0], balanceZat: portfolio.zecBalance });
    }
  }, [portfolio]);

  // Mock only: the simulated chain tells us when the payment hits the mempool and gets confirmations.
  const step = phase.step;
  useEffect(() => {
    if (API_MODE !== "mock" || step === "credited") return;
    const t = setInterval(() => {
      const m = mockDepositPhase(network, memo);
      if (m.phase === "mempool" || m.phase === "confirming") setPhase({ step: "seen", confirmations: m.confirmations });
      else if (m.phase === "dust") setPhase({ step: "dust" });
      else if (m.phase === "frozen" || m.phase === "ignored") setPhase({ step: "rejected" });
      else if (m.phase === "credited") refresh();
    }, 1_000);
    return () => clearInterval(t);
  }, [network, memo, step, refresh]);

  return {
    phase,
    /** Real mode: the user reports having sent it; we can't see it before K confirmations. */
    markSent: () => setPhase((p) => (p.step === "waiting" ? { step: "seen", confirmations: null } : p)),
    reset: () => setPhase({ step: "waiting" }),
  };
}

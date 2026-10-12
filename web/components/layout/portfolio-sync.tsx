"use client";

import { usePortfolio } from "@/hooks/use-portfolio";

/**
 * Keeps the fixed-rhythm portfolio poll running on every page while the key is unlocked, so the
 * request pattern does not depend on which page is open or whether an action is pending.
 */
export function PortfolioSync() {
  usePortfolio();
  return null;
}

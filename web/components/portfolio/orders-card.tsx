"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Order, Token } from "@/lib/api/types";
import { useKeyState } from "@/lib/crypto/session";
import { useNetwork } from "@/lib/network";
import { rememberSymbol, useSessionOrders } from "@/lib/order-session";
import { isLive, ORDERS_PRIVACY_NOTE } from "@/lib/orders";
import { OrderRow } from "@/components/trade/orders-panel";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * All your private orders: open ones (with Cancel) from Portfolio.orders, and what triggered, filled,
 * expired, failed or was cancelled, kept for this tab's session (memory only).
 */
export function OrdersCard({ orders, tokens }: { orders: Order[] | null; tokens: Token[] | null }) {
  const network = useNetwork();
  const key = useKeyState();
  const session = useSessionOrders(network, key.status === "unlocked" ? key.pubkey : null);
  const byMint = useMemo(() => new Map((tokens ?? []).map((t) => [t.mint, t])), [tokens]);

  useEffect(() => {
    for (const t of tokens ?? []) rememberSymbol(t.mint, t.symbol);
  }, [tokens]);

  const { live, closed } = useMemo(() => {
    const server = orders ?? [];
    const ids = new Set(server.map((o) => o.id));
    const all = [...server, ...session.filter((s) => !ids.has(s.order.id)).map((s) => s.order)];
    return {
      live: all.filter(isLive).sort((a, b) => b.createdAt - a.createdAt),
      closed: all.filter((o) => !isLive(o)).sort((a, b) => b.createdAt - a.createdAt),
    };
  }, [orders, session]);

  if (live.length === 0 && closed.length === 0) return null;

  const row = (o: Order) => (
    <motion.li key={o.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: EASE }}>
      <OrderRow order={o} token={byMint.get(o.mint) ?? null} compact />
    </motion.li>
  );

  return (
    <section aria-labelledby="orders-title" className="rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="orders-title" className="font-medium">
          Orders
        </h2>
        <p className="text-xs text-faint-foreground">Visible only to your key</p>
      </div>

      {live.length > 0 ? (
        <ul className="mt-2 divide-y divide-border/60">
          <AnimatePresence initial={false}>{live.map(row)}</AnimatePresence>
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No open orders.</p>
      )}

      {closed.length > 0 && (
        <>
          <h3 className="mt-4 flex items-baseline justify-between text-xs text-muted-foreground">
            Closed
            <span className="text-faint-foreground">This session · kept in this tab only</span>
          </h3>
          <ul className="mt-1 divide-y divide-border/60 opacity-80">
            <AnimatePresence initial={false}>{closed.slice(0, 10).map(row)}</AnimatePresence>
          </ul>
        </>
      )}

      <p className="mt-3 text-[11px] text-pretty text-faint-foreground">
        {ORDERS_PRIVACY_NOTE} Place new ones from a token page.{" "}
        {live[0] && (
          <Link href={`/token/${live[0].mint}`} className="underline-offset-4 hover:text-muted-foreground hover:underline">
            Open the latest
          </Link>
        )}
      </p>
    </section>
  );
}

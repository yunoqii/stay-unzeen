"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowsDownUp } from "@phosphor-icons/react";
import { toast } from "sonner";
import type { Order } from "@/lib/api/types";
import { ApiError, errorText } from "@/lib/api/client";
import { notifyAccepted } from "@/lib/activity";
import { formatPrice } from "@/lib/format";
import type { Network } from "@/lib/network";
import { ORDER_LABEL } from "@/lib/orders";
import { cancelOrder, placeOrder } from "@/lib/order-session";
import { moveOrder } from "@/lib/order-move";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";

/**
 * Confirm a dragged order line. There is no edit in the API: the order is cancelled (its hold comes back) and the
 * same order is placed at the new price, with the time it had left. Two signatures, one confirmation.
 */
export function MoveOrderDialog({ network, symbol, order, leg, toPriceSol, onClose }: { network: Network; symbol: string; order: Order; leg?: "tp" | "sl"; toPriceSol: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(30_000);
  const plan = now === null ? ({ ok: false, reason: "…" } as const) : moveOrder(order, leg, toPriceSol, now);
  useEffect(() => {
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);
  const what = `${ORDER_LABEL[order.kind]}${leg ? ` · ${leg === "tp" ? "take profit" : "stop-loss"} leg` : ""}`;

  const confirm = async () => {
    if (!plan.ok) return;
    setBusy(true);
    try {
      await cancelOrder(network, order.id);
    } catch (e) {
      toast.error("Couldn't move the order", { description: errorText(e instanceof ApiError ? e : new ApiError("internal", String(e))) });
      setBusy(false);
      return;
    }
    try {
      const { op: _op, ...body } = plan.create;
      void _op;
      await placeOrder(network, body, symbol);
      toast.success(`${what} moved`, { description: `$${symbol} at ${formatPrice(plan.to)} SOL.` });
    } catch (e) {
      toast.error("The old order is cancelled, the new one was refused", { description: `${errorText(e instanceof ApiError ? e : new ApiError("internal", String(e)))} Place it again from the Orders tab.` });
    } finally {
      notifyAccepted();
      setBusy(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="move-t" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-border bg-popover p-5 shadow-2xl focus:outline-none">
        <h2 id="move-t" className="flex items-center gap-2 text-sm font-medium">
          <ArrowsDownUp size={16} aria-hidden /> Move {what}
        </h2>
        {plan.ok ? (
          <>
            <p className="tabular mt-3 text-sm">
              ${symbol}: {formatPrice(plan.from)} → <span className="text-zec">{formatPrice(plan.to)}</span> SOL
            </p>
            <p className="mt-2 text-xs text-pretty text-muted-foreground">
              The order is cancelled and placed again at the new price with the same amount, slippage and time left. Its hold is released and taken again; a stop-loss that was armed starts over.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-sell">{plan.reason}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy} className="rounded-full">
            Keep it
          </Button>
          {plan.ok && (
            <Button onClick={() => void confirm()} disabled={busy} className="rounded-full">
              {busy ? "Signing…" : "Move order"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

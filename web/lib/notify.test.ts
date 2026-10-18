import { describe, expect, it } from "vitest";
import type { Order, Portfolio, Scenario } from "@/lib/api/types";
import type { PriceAlert } from "@/lib/workspace/store";
import { diffEvents, dueAlerts, eventText, snapshotOf } from "./notify";

const order = (id: string, status: Order["status"], o: Partial<Order> = {}) => ({ id, status, mint: "M", kind: "stop_loss", ...o }) as Order;
const plan = (id: string, status: Scenario["status"], steps: [number, string][]) => ({ id, status, steps: steps.map(([i, s]) => ({ id: i, status: s, runs: 0 })) }) as unknown as Scenario;

describe("diffEvents (portfolio poll -> notifications)", () => {
  it("nothing on the first poll, nothing when unchanged", () => {
    const p = { orders: [order("a", "triggered")], scenarios: [] } as Pick<Portfolio, "orders" | "scenarios">;
    expect(diffEvents(null, p)).toEqual([]);
    expect(diffEvents(snapshotOf(p), p)).toEqual([]);
  });
  it("orders that fire, fill or fail; steps and plans that finish", () => {
    const before = snapshotOf({ orders: [order("a", "open"), order("b", "triggered"), order("c", "open")], scenarios: [plan("s", "active", [[0, "done"], [1, "waiting"]])] });
    const after = { orders: [order("a", "triggered"), order("b", "filled"), order("c", "cancelled"), order("new", "filled")], scenarios: [plan("s", "done", [[0, "done"], [1, "done"]])] };
    expect(diffEvents(before, after)).toEqual([
      { kind: "order", id: "a", mint: "M", orderKind: "stop_loss", status: "triggered" },
      { kind: "order", id: "b", mint: "M", orderKind: "stop_loss", status: "filled" },
      { kind: "step", scenario: "s", step: 1, status: "done" },
      { kind: "plan", scenario: "s", status: "done" },
    ]);
    expect(eventText({ kind: "order", id: "a", mint: "M", orderKind: "bracket", status: "triggered", leg: "sl" }, () => "PEPE", () => undefined).title).toBe("Bracket (SL leg) $PEPE triggered");
  });
});

describe("dueAlerts", () => {
  const a = (o: Partial<PriceAlert>) => ({ id: "1", mint: "M", symbol: "M", metric: "price", dir: "above", thresholdSol: 2e-9, createdAt: 0, ...o }) as PriceAlert;
  const list = [{ mint: "M", priceSol: "0.000000003", marketCapSol: "30" }];
  it("crossings above / below, by price or market cap; fired and unknown mints never", () => {
    expect(dueAlerts([a({})], list)).toHaveLength(1);
    expect(dueAlerts([a({ dir: "below" })], list)).toHaveLength(0);
    expect(dueAlerts([a({ metric: "mcap", dir: "below", thresholdSol: 40 })], list)).toHaveLength(1);
    expect(dueAlerts([a({ firedAt: 5 })], list)).toHaveLength(0);
    expect(dueAlerts([a({ mint: "X" })], list)).toHaveLength(0);
    expect(dueAlerts([a({})], [{ mint: "M", priceSol: "0", marketCapSol: "0" }])).toHaveLength(0);
  });
});

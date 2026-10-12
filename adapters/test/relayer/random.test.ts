import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTION_JITTER,
  DEFAULT_GAS_DROP,
  actionNotBefore,
  cryptoRng,
  pickGasDrop,
  retryNotBefore,
  seededRng,
  splitAmount,
  withdrawSchedule,
} from "../../src/relayer/random";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { MINT } from "./fakes";

const NOW = 1_700_000_000_000;

describe("jitter", () => {
  it("action not_before stays within epoch 3-10 s + 0-20 s and varies", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const d = actionNotBefore(NOW, cryptoRng) - NOW;
      expect(d).toBeGreaterThanOrEqual(DEFAULT_ACTION_JITTER.epochMinMs);
      expect(d).toBeLessThanOrEqual(DEFAULT_ACTION_JITTER.epochMaxMs + DEFAULT_ACTION_JITTER.jitterMaxMs);
      seen.add(d);
    }
    expect(seen.size).toBeGreaterThan(400); // not a constant / coarse delay
  });

  it("covers the whole window (no clustering at the minimum)", () => {
    const rng = seededRng(11);
    const ds = Array.from({ length: 2000 }, () => actionNotBefore(NOW, rng) - NOW);
    expect(Math.min(...ds)).toBeLessThan(6_000);
    expect(Math.max(...ds)).toBeGreaterThan(26_000);
  });

  it("the in-memory queue applies the jitter when no not_before is given", () => {
    const q = new InMemoryJobQueue(seededRng(1));
    const j = q.enqueue({ kind: "buy", venue: "pumpfun", mint: MINT, lamportsIn: 1n, minOut: 0n }, { now: NOW });
    expect(j.notBefore - NOW).toBeGreaterThanOrEqual(3_000);
  });

  it("withdraw parts get independent delays within the window", () => {
    const s = withdrawSchedule(NOW, 5, seededRng(3), { minMs: 60_000, maxMs: 600_000 });
    expect(s).toHaveLength(5);
    for (const t of s) {
      expect(t - NOW).toBeGreaterThanOrEqual(60_000);
      expect(t - NOW).toBeLessThanOrEqual(600_000);
    }
    expect(new Set(s).size).toBe(5);
  });

  it("retry backoff grows and is capped", () => {
    const rng = seededRng(4);
    expect(retryNotBefore(NOW, 1, rng) - NOW).toBeGreaterThanOrEqual(5_000);
    expect(retryNotBefore(NOW, 30, rng) - NOW).toBeLessThanOrEqual(450_000);
  });
});

describe("gas drop and split", () => {
  it("gas drop is random within the range, never below rent", () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 100; i++) {
      const g = pickGasDrop(cryptoRng);
      expect(g >= DEFAULT_GAS_DROP.min && g <= DEFAULT_GAS_DROP.max).toBe(true);
      seen.add(g);
    }
    expect(seen.size).toBeGreaterThan(90);
  });

  it("split keeps the sum and gives unequal positive parts", () => {
    const rng = seededRng(9);
    const parts = splitAmount(1_234_567_890n, 4, rng);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1_234_567_890n);
    expect(parts.every((p) => p > 0n)).toBe(true);
    expect(new Set(parts.map(String)).size).toBe(4);
    expect(() => splitAmount(10n, 3, rng)).toThrow();
  });
});

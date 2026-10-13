import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionForTests, SLOW_MS, trackRequest } from "./connectivity";

afterEach(() => {
  connectionForTests.reset();
  vi.useRealTimers();
});

describe("connection state", () => {
  it("two transport failures in a row = down; any answer clears it", () => {
    trackRequest()("transport");
    expect(connectionForTests.compute()).toBe("ok");
    trackRequest()("transport");
    expect(connectionForTests.compute()).toBe("down");
    trackRequest()("http");
    expect(connectionForTests.compute()).toBe("ok");
  });
  it("a request running past SLOW_MS = slow", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const done = trackRequest();
    expect(connectionForTests.compute()).toBe("ok");
    expect(connectionForTests.compute(1_000_000 + SLOW_MS)).toBe("slow");
    done("ok");
    expect(connectionForTests.compute(1_000_000 + SLOW_MS)).toBe("ok");
  });
});

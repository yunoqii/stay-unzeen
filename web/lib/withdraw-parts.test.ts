import { describe, expect, it } from "vitest";
import { countdown, partState } from "./withdraw-parts";

describe("M4 on real parts", () => {
  it("part state from the clock, its status and the action", () => {
    const p = { notBefore: 10_000, status: "queued" as const };
    expect(partState(p, 5_000, null)).toBe("travel");
    expect(partState(p, 10_000, null)).toBe("due");
    expect(partState({ ...p, status: "sent" }, 5_000, null)).toBe("sent");
    expect(partState(p, 5_000, "executed")).toBe("confirmed");
    expect(partState(p, 5_000, "failed")).toBe("failed");
  });

  it("countdown", () => {
    expect(countdown(40_000)).toBe("40s");
    expect(countdown(185_000)).toBe("3m 05s");
    expect(countdown(4_320_000)).toBe("1h 12m");
  });
});

import { describe, expect, it } from "vitest";
import { chooseRecentSlot, isNotRecentSlotError } from "../src/alt";

describe("lookup table recent slot", () => {
  it("picks a real block a few back, skipping skipped slots", () => {
    const blocks = [100, 101, 103, 104, 107, 108, 109, 110, 112, 113, 115];
    expect(chooseRecentSlot(blocks, 115, 3)).toBe(110);
    expect(blocks).toContain(chooseRecentSlot(blocks, 115));
    expect(chooseRecentSlot([], 999)).toBe(999);
    expect(chooseRecentSlot([5, 6], 6, 8)).toBe(5);
  });
  it("detects the ALT 'not a recent slot' failure in SendFailure logs", () => {
    const failure = {
      error: new Error("Simulation failed: InvalidInstructionData"),
      logs: [
        "Program AddressLookupTab1e1111111111111111111111111 invoke [1]",
        "510337237 is not a recent slot",
        "Program AddressLookupTab1e1111111111111111111111111 failed: invalid instruction data",
      ],
    };
    expect(isNotRecentSlotError(failure)).toBe(true);
    expect(isNotRecentSlotError({ error: new Error("insufficient lamports"), logs: [] })).toBe(false);
    expect(isNotRecentSlotError(new Error("123 is not a recent slot"))).toBe(true);
  });
});

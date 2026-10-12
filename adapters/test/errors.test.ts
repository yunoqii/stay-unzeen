import { describe, expect, it } from "vitest";
import { pumpIdl } from "@pump-fun/pump-sdk";
import { AdapterError, classifyError } from "../src/errors";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const ERRORS = (pumpIdl.errors as Array<{ code: number; name: string }>).map((e) => ({ code: e.code, name: e.name }));
const cls = (err: unknown, logs: string[] | null = null) => classifyError(err, logs, ERRORS, PUMP);

describe("classifyError", () => {
  it("anchor slippage log -> slippage / 422", () => {
    const e = cls(new Error("Simulation failed"), [
      `Program ${PUMP} invoke [1]`,
      "Program log: AnchorError thrown in programs/pump/src/lib.rs:1. Error Code: TooMuchSolRequired. Error Number: 6002. Error Message: slippage.",
      `Program ${PUMP} failed: custom program error: 0x1772`,
    ]);
    expect(e.code).toBe("slippage");
    expect(e.apiCode).toBe("slippage");
    expect(e.programError).toEqual({ code: 6002, name: "TooMuchSolRequired" });
  });

  it("custom program error hex without anchor log, resolved through the IDL", () => {
    const code = ERRORS.find((x) => x.name === "BuySlippageBelowMinTokensOut")!.code;
    const e = cls(new Error("x"), [`Program ${PUMP} failed: custom program error: 0x${code.toString(16)}`]);
    expect(e.code).toBe("slippage");
    expect(e.programError?.name).toBe("BuySlippageBelowMinTokensOut");
  });

  it("TooLittleSolReceived -> slippage", () => {
    expect(cls(new Error('{"InstructionError":[3,{"Custom":6003}]}')).code).toBe("slippage");
  });

  it("BondingCurveComplete -> graduated", () => {
    const e = cls(new Error("x"), ["Program log: AnchorError ... Error Code: BondingCurveComplete. Error Number: 6005."]);
    expect(e.code).toBe("graduated");
    expect(e.apiCode).toBe("graduated");
  });

  it("system transfer: insufficient lamports -> insufficient_sol", () => {
    const e = cls(new Error("Simulation failed"), [
      "Program 11111111111111111111111111111111 invoke [2]",
      "Transfer: insufficient lamports 1000, need 2039280",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x1",
    ]);
    expect(e.code).toBe("insufficient_sol");
    expect(e.apiCode).toBe("pool_liquidity");
  });

  it("empty fee payer -> insufficient_sol", () => {
    expect(
      cls(new Error("Attempt to debit an account but found no record of a prior credit.")).code,
    ).toBe("insufficient_sol");
  });

  it("token program insufficient funds -> insufficient_tokens / pool_liquidity", () => {
    const e = cls(new Error("x"), [
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]",
      "Program log: Error: insufficient funds",
      "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1",
    ]);
    expect(e.code).toBe("insufficient_tokens");
    expect(e.apiCode).toBe("pool_liquidity");
  });

  it("expired blockhash -> venue_unavailable", () => {
    expect(cls(new Error("Signature abc has expired: block height exceeded.")).code).toBe("venue_unavailable");
  });

  it("low custom codes are not attributed to pump", () => {
    expect(cls(new Error('{"InstructionError":[0,{"Custom":3}]}')).code).toBe("internal");
  });

  it("passes AdapterError through", () => {
    const orig = new AdapterError("not_found", "nope");
    expect(cls(orig)).toBe(orig);
  });
});

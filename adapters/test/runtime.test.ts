import { describe, expect, it } from "vitest";
import { checkRelayerRole, relayerDatabaseUrl } from "../src/relayer/runtime";

describe("D8: relayer DB role", () => {
  it("uses DATABASE_URL_RELAYER; without it refuses mainnet, warns on devnet", () => {
    const warns: string[] = [];
    const w = (m: string) => warns.push(m);
    expect(relayerDatabaseUrl("mainnet-beta", { DATABASE_URL_RELAYER: "postgres://r", DATABASE_URL: "postgres://o" }, w)).toBe("postgres://r");
    expect(() => relayerDatabaseUrl("mainnet-beta", { DATABASE_URL: "postgres://o" }, w)).toThrow(/refusing on mainnet/);
    expect(relayerDatabaseUrl("devnet", { DATABASE_URL: "postgres://o" }, w)).toBe("postgres://o");
    expect(warns).toHaveLength(1);
    expect(() => relayerDatabaseUrl("devnet", {}, w)).toThrow();
  });

  it("refuses a role that can read relayer_jobs.action_id on mainnet", async () => {
    const pool = (can: boolean) => ({ query: async () => ({ rows: [{ can }] }) }) as never;
    const warns: string[] = [];
    await expect(checkRelayerRole(pool(true), "mainnet-beta", (m) => warns.push(m))).rejects.toThrow(/action_id/);
    await checkRelayerRole(pool(true), "devnet", (m) => warns.push(m));
    await checkRelayerRole(pool(false), "mainnet-beta", (m) => warns.push(m));
    expect(warns).toHaveLength(1);
  });
});

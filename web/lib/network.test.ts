import { afterEach, describe, expect, it, vi } from "vitest";

// Each case re-imports lib/network with a different NEXT_PUBLIC_DEVNET (read once at module load).
async function load(devnet: string | undefined, stored: string | null, nodeEnv = "test") {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("NODE_ENV", nodeEnv);
  if (devnet !== undefined) vi.stubEnv("NEXT_PUBLIC_DEVNET", devnet);
  vi.stubEnv("NEXT_PUBLIC_HOOD", "");
  const store = new Map<string, string>(stored === null ? [] : [["unzeen.network", stored]]);
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  return import("./network");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("NEXT_PUBLIC_DEVNET", () => {
  it("unset: Devnet listed and the default", async () => {
    const n = await load(undefined, null);
    expect(n.NETWORKS).toEqual(["devnet", "mainnet"]);
    expect(n.DEFAULT_NETWORK).toBe("devnet");
    expect(n.getNetwork()).toBe("devnet");
  });

  it("production build, unset: Mainnet only", async () => {
    const n = await load(undefined, "devnet", "production");
    expect(n.NETWORKS).toEqual(["mainnet"]);
    expect(n.getNetwork()).toBe("mainnet");
  });

  it("production build, 1: Devnet back", async () => {
    const n = await load("1", null, "production");
    expect(n.NETWORKS).toEqual(["devnet", "mainnet"]);
  });

  it("0: Mainnet only, a stored Devnet choice lands on Mainnet", async () => {
    const n = await load("0", "devnet");
    expect(n.NETWORKS).toEqual(["mainnet"]);
    expect(n.DEFAULT_NETWORK).toBe("mainnet");
    expect(n.getNetwork()).toBe("mainnet");
    n.setNetwork("devnet");
    expect(n.getNetwork()).toBe("mainnet");
    expect(n.lastSolanaNetwork()).toBe("mainnet");
  });
});

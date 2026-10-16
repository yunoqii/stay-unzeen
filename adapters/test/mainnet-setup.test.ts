import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { confirmMainnet, fundingHint, setupFunding, setupGate } from "../src/mainnet-setup";
import { DBC_CONFIG_ACCOUNT_SIZE, dbcConfigAddress, dbcConfigEnvName } from "../src/meteora";

const MAIN_ENV = { UNZEEN_ALLOW_MAINNET: "yes", UNZEEN_ALLOW_MAINNET_SETUP: "yes" };

describe("GAP-3/4: mainnet setup gate (meteora:config, launchlab:platform)", () => {
  it("without --send: dry run or simulation on any cluster", () => {
    expect(setupGate({ cluster: "mainnet-beta", argv: [], env: {} }).mode).toBe("dry");
    expect(setupGate({ cluster: "mainnet-beta", argv: ["--simulate"], env: {} }).mode).toBe("simulate");
    expect(setupGate({ cluster: "devnet", argv: ["--send"], env: {} })).toEqual({ mode: "send", mainnet: false, confirm: null });
  });
  it("mainnet --send needs both env flags", () => {
    expect(() => setupGate({ cluster: "mainnet-beta", argv: ["--send"], env: { UNZEEN_ALLOW_MAINNET: "yes" } })).toThrow(/UNZEEN_ALLOW_MAINNET_SETUP=yes/);
    expect(() => setupGate({ cluster: "mainnet-beta", argv: ["--send"], env: { UNZEEN_ALLOW_MAINNET_SETUP: "yes" } })).toThrow(/refused/);
    // Both flags tolerate surrounding whitespace (env files with trailing spaces).
    expect(setupGate({ cluster: "mainnet-beta", argv: ["--send"], env: { UNZEEN_ALLOW_MAINNET: " yes ", UNZEEN_ALLOW_MAINNET_SETUP: "yes " } }).mode).toBe("send");
    expect(setupGate({ cluster: "mainnet-beta", argv: ["--send"], env: MAIN_ENV })).toEqual({ mode: "send", mainnet: true, confirm: null });
    expect(setupGate({ cluster: "mainnet-beta", argv: ["--send", "--confirm-mainnet", "Abc"], env: MAIN_ENV }).confirm).toBe("Abc");
    expect(setupGate({ cluster: "mainnet-beta", argv: ["--send", "--confirm-mainnet=Xyz"], env: MAIN_ENV }).confirm).toBe("Xyz");
  });
  it("explicit confirmation: exact payer address by flag or prompt; no TTY and no flag -> refused", async () => {
    const payer = Keypair.generate().publicKey.toBase58();
    await expect(confirmMainnet(payer, payer, null)).resolves.toBeUndefined();
    await expect(confirmMainnet(payer, "wrong", null)).rejects.toThrow(/does not match/);
    await expect(confirmMainnet(payer, null, null)).rejects.toThrow(/no TTY/);
    await expect(confirmMainnet(payer, null, async () => `${payer}\n`)).resolves.toBeUndefined();
    await expect(confirmMainnet(payer, null, async () => "yes")).rejects.toThrow(/did not match/);
  });
  it("partner funding: rent + margin, missing part, hint names the external wallet (never a vault)", () => {
    expect(setupFunding([5_974_080n], 0n)).toEqual({ need: 7_974_080n, missing: 7_974_080n });
    expect(setupFunding([5_974_080n], 10_000_000n)).toEqual({ need: 7_974_080n, missing: 0n });
    const h = fundingHint("P4rtner", 1_000_000n, 7_974_080n);
    expect(h).toContain("P4rtner");
    expect(h).toContain("missing 0.001000 SOL");
    expect(h).toMatch(/external wallet \(never from a vault/);
  });
});

describe("GAP-3: METEORA_DBC_CONFIG_MAINNET is picked up from env", () => {
  it("mainnet: no default; env value used; bad value throws", () => {
    const pk = Keypair.generate().publicKey.toBase58();
    expect(dbcConfigEnvName("mainnet-beta")).toBe("METEORA_DBC_CONFIG_MAINNET");
    expect(dbcConfigAddress("mainnet-beta", {})).toBeNull();
    expect(dbcConfigAddress("mainnet-beta", { METEORA_DBC_CONFIG_MAINNET: ` ${pk} ` })?.toBase58()).toBe(pk);
    expect(() => dbcConfigAddress("mainnet-beta", { METEORA_DBC_CONFIG_MAINNET: "nope" })).toThrow(/METEORA_DBC_CONFIG_MAINNET/);
    expect(DBC_CONFIG_ACCOUNT_SIZE).toBe(1048);
  });
});

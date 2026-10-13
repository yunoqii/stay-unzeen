// Drafts are stored only as an AES-GCM blob bound to the network and anon key (scenarios.md §4.2, S-12).

import { describe, expect, it } from "vitest";
import { deriveHistoryKey } from "@/lib/history/crypto";
import { draftFromTemplate, TEMPLATES } from "./templates";
import { openScenarioFile, sealScenarioFile, type ScenarioFile } from "./store";

const UA = "u1examplewithdrawaladdressthatmustneverappearinplaintext";

describe("encrypted scenario drafts", () => {
  it("round-trips, hides the content, and refuses another key or network", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveHistoryKey(secret, "devnet");
    const draft = draftFromTemplate(TEMPLATES[0], {});
    draft.steps[7] = { ...draft.steps[7], block: { type: "withdraw_zec", to: UA, amount: { pct: 100, of: "balance" }, exec: "max" } };
    const file: ScenarioFile = { v: 1, drafts: [draft], current: draft.id, signed: { ["ab".repeat(16)]: { name: "Exit plan", template: "private-buy-exit", at: 1 } } };
    const blob = await sealScenarioFile(key, "devnet", "PUB", file);
    const wire = JSON.stringify(blob);
    expect(wire).not.toContain(UA);
    expect(wire).not.toContain("Exit plan");
    expect(wire).not.toContain("withdraw_zec");
    expect(await openScenarioFile(key, "devnet", "PUB", blob)).toEqual(file);
    // bound to the pubkey and network through AAD
    expect((await openScenarioFile(key, "devnet", "OTHER", blob)).drafts).toEqual([]);
    expect((await openScenarioFile(key, "mainnet", "PUB", blob)).drafts).toEqual([]);
    const other = await deriveHistoryKey(crypto.getRandomValues(new Uint8Array(32)), "devnet");
    expect((await openScenarioFile(other, "devnet", "PUB", blob)).drafts).toEqual([]);
  });
});

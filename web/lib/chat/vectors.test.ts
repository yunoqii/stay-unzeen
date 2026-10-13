// core/testdata/chat-vectors.json (backend, API.md v0.12): the client's text rules, JSON byte count,
// nickname derivation (used by the mock) and the exact 1024-byte body must match byte for byte.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { chatNick } from "@/lib/api/mock-chat";
import { checkChatText, jsonBytes } from "./text";

const FILE = path.resolve(import.meta.dirname, "../../../core/testdata/chat-vectors.json");
const v = existsSync(FILE)
  ? (JSON.parse(readFileSync(FILE, "utf8")) as {
      kChat: string;
      nick: { anonPubkey: string; chainId: string; mint: string; member: string; creator: string }[];
      text: { text: string; valid: boolean; problem: string | null; jsonBytes: number; note: string }[];
      body: { body: string; bodyBytes: number };
    })
  : null;

describe.skipIf(!v)("chat vectors from core", () => {
  it("text rules: same verdict and the same rule code", () => {
    for (const t of v!.text) {
      const r = checkChatText(t.text);
      expect({ note: t.note, valid: r.ok, problem: r.ok ? null : r.problem }).toEqual({ note: t.note, valid: t.valid, problem: t.problem });
    }
  });
  it("JSON byte count", () => {
    for (const t of v!.text) expect(jsonBytes(t.text), t.note).toBe(t.jsonBytes);
  });
  it("nicknames (member and creator)", () => {
    const k = hexToBytes(v!.kChat);
    for (const n of v!.nick) {
      expect(chatNick(k, n.chainId, n.mint, n.anonPubkey, false)).toBe(n.member);
      expect(chatNick(k, n.chainId, n.mint, n.anonPubkey, true)).toBe(n.creator);
    }
  });
  it("the sample body is exactly 1024 bytes", () => {
    expect(new TextEncoder().encode(v!.body.body).length).toBe(v!.body.bodyBytes);
    expect(v!.body.bodyBytes).toBe(1024);
  });
});

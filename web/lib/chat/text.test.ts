import { describe, expect, it } from "vitest";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { CHAT_MAX_CHARS, charCount, checkChatText, isForbiddenCodePoint, jsonBytes, linksToYou, looksLikeSeedPhrase, normalizeChatText, numbersIn, remaining } from "./text";

const problem = (t: string) => {
  const r = checkChatText(t);
  return r.ok ? null : r.problem;
};

describe("chat text rules (chat.md §7.1)", () => {
  it("accepts plain text, emoji with ZWJ and variation selectors, CJK, RTL letters, a mint", () => {
    for (const t of ["gm", "send it 🚀", "👩‍👩‍👧 family", "❤️ love", "月まで", "שלום עולם", "CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "line one\nline two"]) {
      expect(problem(t), t).toBeNull();
    }
  });

  it("rule 1: must already be NFC", () => {
    const decomposed = "café"; // e + combining acute
    expect(problem(decomposed)).toBe("not_nfc");
    expect(problem(normalizeChatText(decomposed))).toBeNull();
  });

  it("rule 2: 1-280 code points and at most 800 JSON bytes", () => {
    expect(problem("")).toBe("empty");
    expect(problem("a".repeat(CHAT_MAX_CHARS))).toBeNull();
    expect(problem("a".repeat(CHAT_MAX_CHARS + 1))).toBe("too_long");
    // 280 emoji = 280 code points but 4 bytes each: over 800 bytes.
    expect(charCount("🚀".repeat(200))).toBe(200);
    expect(problem("🚀".repeat(200))).toBe("too_many_bytes");
    // Quotes and backslashes are escaped in JSON and count twice.
    expect(jsonBytes('"')).toBe(4);
    expect(jsonBytes('"'.repeat(280))).toBe(562);
    expect(remaining("ab")).toBe(278);
  });

  it("rule 3: no edge whitespace, at most 3 newlines, never three in a row", () => {
    expect(problem(" gm")).toBe("edge_space");
    expect(problem("gm\n")).toBe("edge_space");
    expect(problem("a\nb\nc\nd")).toBeNull();
    expect(problem("a\nb\nc\nd\ne")).toBe("newlines");
    expect(problem("a\n\n\nb")).toBe("newlines");
    expect(problem("a\n\nb")).toBeNull();
  });

  it("rule 4: control, bidi, invisible, private use, tags, noncharacters, lone surrogates", () => {
    const cases = [0x0000, 0x0009, 0x000d, 0x0085, 0x061c, 0x200e, 0x202e, 0x2066, 0x00ad, 0x200b, 0x2060, 0xfeff, 0x3164, 0x2028, 0xfffc, 0xe000, 0xf0000, 0x10fffd, 0xe0001, 0xe0100, 0xfdd0, 0xfffe, 0x1ffff, 0x10ffff];
    for (const cp of cases) {
      expect(isForbiddenCodePoint(cp), cp.toString(16)).toBe(true);
      expect(problem(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe("forbidden_char");
    }
    expect(problem("a\ud800b")).toBe("forbidden_char");
    // Allowed: ZWJ and FE00-FE0F.
    expect(isForbiddenCodePoint(0x200d)).toBe(false);
    expect(isForbiddenCodePoint(0xfe0f)).toBe(false);
    expect(isForbiddenCodePoint(0x000a)).toBe(false);
  });

  it("rule 5: at most 2 combining marks in a row", () => {
    const cp = (...xs: number[]) => String.fromCodePoint(...xs);
    // NFC has no precomposed x with these marks, so the text stays NFC.
    expect(problem(cp(0x78, 0x301, 0x302))).toBeNull();
    expect(problem(cp(0x78, 0x301, 0x302, 0x303))).toBe("zalgo");
    expect(problem(cp(0x78, 0x20d0, 0x20d0, 0x20d0))).toBe("zalgo");
  });

  it("rule 6: blocks 12+ BIP-39 words, whatever the case and separators", () => {
    const twelve = wordlist.slice(100, 112);
    expect(looksLikeSeedPhrase(twelve.join(" "))).toBe(true);
    expect(problem(twelve.map((w) => w.toUpperCase()).join(", "))).toBe("seed_phrase");
    expect(problem("my words: " + twelve.join("-"))).toBe("seed_phrase");
    expect(problem(wordlist.slice(0, 11).join(" "))).toBeNull();
    // Ordinary chatter has common English words, but not twelve list words.
    expect(problem("this token is going to the moon tonight, buy before it runs")).toBeNull();
  });

  it("normalizes CRLF and trims before checking", () => {
    expect(normalizeChatText("  a\r\nb\rc  ")).toBe("a\nb\nc");
  });
});

describe("soft self-link warning (chat.md §7.3)", () => {
  const mint = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  it("ignores this page's mint, flags other base58 addresses and Zcash addresses", () => {
    expect(linksToYou(`CA ${mint}`, { mint, ownAmounts: [] })).toBe(false);
    expect(linksToYou("send to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", { mint, ownAmounts: [] })).toBe(true);
    expect(linksToYou("utest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", { mint, ownAmounts: [] })).toBe(true);
  });
  it("flags amounts within 1% of your recent actions", () => {
    expect(numbersIn("aped 1.2M and 0,5")).toEqual([1_200_000, 0.5]);
    expect(linksToYou("just aped 0.5 zec", { mint, ownAmounts: [0.5] })).toBe(true);
    expect(linksToYou("bought 1.2m", { mint, ownAmounts: [1_195_000] })).toBe(true);
    expect(linksToYou("bought 1.3m", { mint, ownAmounts: [1_195_000] })).toBe(false);
  });
});

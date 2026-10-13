// Chat text rules, exactly as docs/analysis/chat.md §7.1 (the server checks the same and answers
// 400 chat_text_invalid; it never rewrites a signed text). Explicit code point ranges only, no Unicode
// category tables, so Rust and TS cannot drift with Unicode versions. Test vectors will come in
// core/testdata/chat-vectors.json; until then lib/chat/text.test.ts carries our own per rule.

import { wordlist } from "@scure/bip39/wordlists/english.js";

export const CHAT_MAX_CHARS = 280;
export const CHAT_MAX_JSON_BYTES = 800;
export const CHAT_MAX_NEWLINES = 3;
const MAX_COMBINING_RUN = 2;
const SEED_MIN_WORDS = 12;

export type ChatTextProblem =
  | "empty"
  | "not_nfc"
  | "too_long"
  | "too_many_bytes"
  | "edge_space"
  | "newlines"
  | "forbidden_char"
  | "zalgo"
  | "seed_phrase";

export type ChatTextCheck = { ok: true; text: string } | { ok: false; problem: ChatTextProblem; text: string };

/** [lo, hi] inclusive. */
const FORBIDDEN: ReadonlyArray<readonly [number, number]> = [
  // C0 / C1 except \n (U+000A)
  [0x0000, 0x0009],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  // bidi controls
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  // invisible
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200c],
  [0x2060, 0x2064],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  // line / paragraph separators, interlinear annotation, object replacement
  [0x2028, 0x2029],
  [0xfff9, 0xfffc],
  // private use
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
  // tags, supplementary variation selectors
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
  // noncharacters
  [0xfdd0, 0xfdef],
  // lone surrogates (only reachable through a broken string)
  [0xd800, 0xdfff],
];

const COMBINING: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

const inRanges = (cp: number, r: ReadonlyArray<readonly [number, number]>) => r.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Any of U+xFFFE / U+xFFFF. */
const isPlaneNonchar = (cp: number) => (cp & 0xfffe) === 0xfffe;

export function isForbiddenCodePoint(cp: number): boolean {
  return inRanges(cp, FORBIDDEN) || isPlaneNonchar(cp);
}

const enc = new TextEncoder();
/** UTF-8 bytes of the text as a JSON string (quotes and escapes included): what it costs in the body. */
export const jsonBytes = (text: string): number => enc.encode(JSON.stringify(text)).length;

/** Code points (scalar values), not UTF-16 units. */
export const charCount = (text: string): number => [...text].length;

const BIP39 = new Set(wordlist);

/** 12+ words of the English BIP-39 list, case-insensitive, split on spaces and punctuation. */
export function looksLikeSeedPhrase(text: string): boolean {
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  let hits = 0;
  for (const w of words) if (BIP39.has(w)) hits++;
  return hits >= SEED_MIN_WORDS;
}

/**
 * What the composer sends: NFC, CRLF / CR folded to \n, outer whitespace trimmed. Everything else is
 * left as typed and then checked: the client fixes only what the user cannot see.
 */
export function normalizeChatText(input: string): string {
  return input.replace(/\r\n?/g, "\n").normalize("NFC").trim();
}

/** §7.1 rules 1-6 on an already normalized text. Order: cheapest and most specific first. */
export function checkChatText(text: string): ChatTextCheck {
  const bad = (problem: ChatTextProblem): ChatTextCheck => ({ ok: false, problem, text });
  if (text.length === 0) return bad("empty");
  // Lone surrogates first: normalize() and JSON both behave oddly around them.
  if (/\p{Cs}/u.test(text)) return bad("forbidden_char");
  if (text !== text.normalize("NFC")) return bad("not_nfc");
  if (charCount(text) > CHAT_MAX_CHARS) return bad("too_long");
  if (jsonBytes(text) > CHAT_MAX_JSON_BYTES) return bad("too_many_bytes");
  if (/^\s|\s$/u.test(text)) return bad("edge_space");
  const newlines = text.split("\n").length - 1;
  if (newlines > CHAT_MAX_NEWLINES || text.includes("\n\n\n")) return bad("newlines");
  let run = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isForbiddenCodePoint(cp)) return bad("forbidden_char");
    run = inRanges(cp, COMBINING) ? run + 1 : 0;
    if (run > MAX_COMBINING_RUN) return bad("zalgo");
  }
  if (looksLikeSeedPhrase(text)) return bad("seed_phrase");
  return { ok: true, text };
}

export const PROBLEM_TEXT: Record<ChatTextProblem, string> = {
  empty: "Write something first.",
  not_nfc: "This text has an unusual encoding. Retype it and try again.",
  too_long: `Keep it under ${CHAT_MAX_CHARS} characters.`,
  too_many_bytes: "Too long once encoded (emoji and some scripts take more room). Shorten it.",
  edge_space: "Remove the spaces at the start or end.",
  newlines: `At most ${CHAT_MAX_NEWLINES} line breaks, and no empty double lines.`,
  forbidden_char: "Remove hidden, direction-changing or control characters (often pasted by accident).",
  zalgo: "Too many stacked accent marks.",
  seed_phrase: "This looks like a recovery phrase. Never post it anywhere: whoever has it owns your funds.",
};

/** How much is left, by the stricter of the two limits (characters, encoded bytes). Can go negative. */
export function remaining(text: string): number {
  return Math.min(CHAT_MAX_CHARS - charCount(text), CHAT_MAX_JSON_BYTES - jsonBytes(text));
}

// ---- soft warnings (§7.3): shown, never blocking ----

const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const ZCASH_RE = /\b(?:u1|utest1|zs1|ztestsapling1)[0-9a-z]{20,}\b|\bt[13m][1-9A-HJ-NP-Za-km-z]{30,40}\b/i;
const NUMBER_RE = /(\d+(?:[.,]\d+)?)\s*([kmb])?\b/gi;

export interface SelfLinkContext {
  /** This page's mint: posting it is the whole point of a token chat. */
  mint: string;
  /** UI amounts of your own actions of the last 24 h (ZEC, SOL, tokens). */
  ownAmounts: number[];
}

/** Numbers written in the text, with k / m / b suffixes. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const n = Number(m[1].replace(",", "."));
    if (!Number.isFinite(n)) continue;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
    out.push(n * mult);
  }
  return out;
}

/** True when the text carries an address, or an amount within 1 % of one of your recent actions. */
export function linksToYou(text: string, ctx: SelfLinkContext): boolean {
  for (const m of text.matchAll(BASE58_RE)) if (m[0] !== ctx.mint) return true;
  if (ZCASH_RE.test(text)) return true;
  const own = ctx.ownAmounts.filter((a) => a > 0);
  if (own.length === 0) return false;
  return numbersIn(text).some((n) => n > 0 && own.some((a) => Math.abs(n - a) <= a * 0.01));
}

export const SELF_LINK_TEXT = "This looks like an address or amount linked to you. Posting it publicly can connect you to it.";

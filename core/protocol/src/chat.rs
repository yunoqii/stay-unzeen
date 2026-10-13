//! Token chat (API.md v0.12 «Чат», docs/analysis/chat.md): nicknames and text rules.
//!
//! - Nick (R1/R2): `b32(HMAC-SHA256(K_chat, "unzeen/chat/nick/v1" ‖ chainId[2] ‖ mint[32] ‖
//!   anonPubkey[32] ‖ flag))[0..8]`, flag 0 = member, 1 = creator. `K_chat` lives outside the
//!   database, so a DB dump plus a known anon pubkey cannot link nicknames.
//! - Text: checked, never rewritten (the signature covers it). Explicit code point ranges only
//!   (no Unicode category tables), identical to `web/lib/chat/text.ts`.
//!
//! Vectors: `core/testdata/chat-vectors.json` (the web client checks the same file).

use bip0039::{English, Language};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use unicode_normalization::is_nfc;

use crate::ChainId;

pub const NICK_DOMAIN: &[u8] = b"unzeen/chat/nick/v1";
pub const REPORT_DOMAIN: &[u8] = b"unzeen/chat/report/v1";
pub const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
pub const NICK_CHARS: usize = 8;

pub const MAX_CHARS: usize = 280;
pub const MAX_JSON_BYTES: usize = 800;
pub const MAX_NEWLINES: usize = 3;
const MAX_COMBINING_RUN: usize = 2;
const SEED_MIN_WORDS: usize = 12;

/// Crockford base32 (lower case), MSB first, first `chars` characters.
pub fn crockford32(bytes: &[u8], chars: usize) -> String {
    let mut out = String::with_capacity(chars);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 && out.len() < chars {
            out.push(CROCKFORD[((acc >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        acc &= (1 << bits) - 1;
        if out.len() >= chars {
            break;
        }
    }
    out
}

fn hmac(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// Nickname of `pubkey` in the chat of `mint` (`creator` = the separate creator nickname).
pub fn nick(k_chat: &[u8; 32], chain: ChainId, mint: &[u8; 32], pubkey: &[u8; 32], creator: bool) -> String {
    let flag = [u8::from(creator)];
    let tag = hmac(k_chat, &[NICK_DOMAIN, &chain.to_bytes(), mint, pubkey, &flag]);
    crockford32(&tag, NICK_CHARS)
}

/// Dedup tag of a report (`reporter_tag`): per message, so reports of one key on different
/// messages are unlinkable.
pub fn report_tag(k_chat: &[u8; 32], msg_id: &[u8; 16], pubkey: &[u8; 32]) -> [u8; 32] {
    hmac(k_chat, &[REPORT_DOMAIN, msg_id, pubkey])
}

/// `^[0-9a-hjkmnp-tv-z]{8}$`
pub fn is_nick(s: &str) -> bool {
    s.len() == NICK_CHARS && s.bytes().all(|b| CROCKFORD.contains(&b))
}

/// Why a text is refused (the same codes as `ChatTextProblem` in `web/lib/chat/text.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextProblem {
    Empty,
    NotNfc,
    TooLong,
    TooManyBytes,
    EdgeSpace,
    Newlines,
    ForbiddenChar,
    Zalgo,
    SeedPhrase,
}

impl TextProblem {
    pub fn code(self) -> &'static str {
        match self {
            TextProblem::Empty => "empty",
            TextProblem::NotNfc => "not_nfc",
            TextProblem::TooLong => "too_long",
            TextProblem::TooManyBytes => "too_many_bytes",
            TextProblem::EdgeSpace => "edge_space",
            TextProblem::Newlines => "newlines",
            TextProblem::ForbiddenChar => "forbidden_char",
            TextProblem::Zalgo => "zalgo",
            TextProblem::SeedPhrase => "seed_phrase",
        }
    }
}

const FORBIDDEN: &[(u32, u32)] = &[
    // C0 / C1 except \n
    (0x0000, 0x0009),
    (0x000b, 0x001f),
    (0x007f, 0x009f),
    // bidi
    (0x061c, 0x061c),
    (0x200e, 0x200f),
    (0x202a, 0x202e),
    (0x2066, 0x2069),
    // invisible
    (0x00ad, 0x00ad),
    (0x034f, 0x034f),
    (0x115f, 0x1160),
    (0x17b4, 0x17b5),
    (0x180e, 0x180e),
    (0x200b, 0x200c),
    (0x2060, 0x2064),
    (0x3164, 0x3164),
    (0xfeff, 0xfeff),
    (0xffa0, 0xffa0),
    // separators, interlinear annotation, object replacement
    (0x2028, 0x2029),
    (0xfff9, 0xfffc),
    // private use
    (0xe000, 0xf8ff),
    (0xf0000, 0xffffd),
    (0x100000, 0x10fffd),
    // tags, supplementary variation selectors
    (0xe0000, 0xe007f),
    (0xe0100, 0xe01ef),
    // noncharacters
    (0xfdd0, 0xfdef),
];

const COMBINING: &[(u32, u32)] = &[
    (0x0300, 0x036f),
    (0x1ab0, 0x1aff),
    (0x1dc0, 0x1dff),
    (0x20d0, 0x20ff),
    (0xfe20, 0xfe2f),
];

fn in_ranges(cp: u32, r: &[(u32, u32)]) -> bool {
    r.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp))
}

pub fn is_forbidden(c: char) -> bool {
    let cp = c as u32;
    in_ranges(cp, FORBIDDEN) || cp & 0xfffe == 0xfffe
}

/// JavaScript `\s` (WhiteSpace + LineTerminator), so the edge rule matches the browser exactly.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// UTF-8 bytes of `JSON.stringify(text)` (quotes and escapes included).
pub fn json_bytes(text: &str) -> usize {
    serde_json::to_string(text).map_or(usize::MAX, |s| s.len())
}

/// ≥ 12 words of the English BIP-39 list (case-insensitive; anything that is not a letter
/// separates words).
pub fn looks_like_seed_phrase(text: &str) -> bool {
    text.to_lowercase()
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| !w.is_empty() && English::index_of(w).is_some())
        .count()
        >= SEED_MIN_WORDS
}

/// chat.md §7.1 rules, in the order of the web client.
pub fn check_text(text: &str) -> Result<(), TextProblem> {
    if text.is_empty() {
        return Err(TextProblem::Empty);
    }
    if !is_nfc(text) {
        return Err(TextProblem::NotNfc);
    }
    if text.chars().count() > MAX_CHARS {
        return Err(TextProblem::TooLong);
    }
    if json_bytes(text) > MAX_JSON_BYTES {
        return Err(TextProblem::TooManyBytes);
    }
    let (first, last) = (text.chars().next(), text.chars().next_back());
    if first.is_some_and(js_space) || last.is_some_and(js_space) {
        return Err(TextProblem::EdgeSpace);
    }
    if text.matches('\n').count() > MAX_NEWLINES || text.contains("\n\n\n") {
        return Err(TextProblem::Newlines);
    }
    let mut run = 0;
    for c in text.chars() {
        if is_forbidden(c) {
            return Err(TextProblem::ForbiddenChar);
        }
        run = if in_ranges(c as u32, COMBINING) { run + 1 } else { 0 };
        if run > MAX_COMBINING_RUN {
            return Err(TextProblem::Zalgo);
        }
    }
    if looks_like_seed_phrase(text) {
        return Err(TextProblem::SeedPhrase);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crockford_basics() {
        assert_eq!(crockford32(&[0, 0, 0, 0, 0], 8), "00000000");
        assert_eq!(crockford32(&[0xff; 5], 8), "zzzzzzzz");
        // 0b00001_00010_00011_... : first byte 0x08 → "1" then "0…"
        assert_eq!(crockford32(&[0x08, 0x86, 0x42, 0x98, 0xe8], 8), "12345678");
        assert!(is_nick("0123abcz") && !is_nick("0123abci") && !is_nick("short"));
    }

    #[test]
    fn rules() {
        assert_eq!(check_text("gm"), Ok(()));
        assert_eq!(check_text(""), Err(TextProblem::Empty));
        assert_eq!(check_text("e\u{301}"), Err(TextProblem::NotNfc));
        assert_eq!(check_text(" gm"), Err(TextProblem::EdgeSpace));
        assert_eq!(check_text("a\n\n\nb"), Err(TextProblem::Newlines));
        assert_eq!(check_text("a\u{202e}b"), Err(TextProblem::ForbiddenChar));
        assert_eq!(check_text("a\u{1fffe}"), Err(TextProblem::ForbiddenChar));
        assert_eq!(check_text("x\u{300}\u{301}\u{302}"), Err(TextProblem::Zalgo));
        assert_eq!(check_text("👨\u{200d}👩"), Ok(()));
        assert_eq!(check_text(&"a".repeat(281)), Err(TextProblem::TooLong));
        assert_eq!(check_text(&"€".repeat(280)), Err(TextProblem::TooManyBytes));
        let seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
        assert_eq!(check_text(seed), Err(TextProblem::SeedPhrase));
        assert_eq!(check_text(&seed.replace("accident", "zzz")), Ok(()));
    }
}

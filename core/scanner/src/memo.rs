//! ZIP-302 memo decoding.
//!
//! A shielded memo field is always 512 bytes. The first byte selects the format:
//! - `0x00..=0xF4` — UTF-8 text, right-padded with zero bytes;
//! - `0xF6` followed by 511 zero bytes — "no memo";
//! - `0xFF` — arbitrary binary data (the remaining 511 bytes);
//! - anything else (`0xF5`, `0xF6` with non-zero tail, `0xF7..=0xFE`) — reserved
//!   for future use; we surface it as raw bytes and never try to interpret it.
//!
//! Unzeen command memos (`{v, op, ...}`) are parsed on top of `MemoView::Text`
//! in a later step (days 3–5); this module only does the ZIP-302 layer.

use serde::Serialize;

pub const MEMO_LEN: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum MemoView {
    /// `0xF6` + zeros.
    Empty,
    /// Valid UTF-8 text with trailing zero padding stripped.
    Text(String),
    /// `0xFF` arbitrary data; hex of the 511 payload bytes with trailing zeros stripped.
    Arbitrary(String),
    /// Reserved / malformed (e.g. text marker but invalid UTF-8); hex of the full,
    /// zero-trimmed 512 bytes.
    Unknown(String),
}

impl MemoView {
    /// Decode a memo from its stored representation. Inputs shorter than 512 bytes are
    /// zero-padded (zcash_client_sqlite stores memos trimmed); longer inputs are rejected
    /// as `Unknown`.
    pub fn decode(raw: &[u8]) -> Self {
        if raw.len() > MEMO_LEN {
            return MemoView::Unknown(hex::encode(trim_zeros(raw)));
        }
        let mut buf = [0u8; MEMO_LEN];
        buf[..raw.len()].copy_from_slice(raw);
        Self::decode_full(&buf)
    }

    pub fn decode_full(buf: &[u8; MEMO_LEN]) -> Self {
        match buf[0] {
            0x00..=0xF4 => {
                let text = trim_zeros(buf);
                match std::str::from_utf8(text) {
                    Ok(s) => MemoView::Text(s.to_owned()),
                    Err(_) => MemoView::Unknown(hex::encode(text)),
                }
            }
            0xF6 if buf[1..].iter().all(|b| *b == 0) => MemoView::Empty,
            0xFF => MemoView::Arbitrary(hex::encode(trim_zeros(&buf[1..]))),
            _ => MemoView::Unknown(hex::encode(trim_zeros(buf))),
        }
    }

    /// Short human-readable form for CLI output.
    pub fn display(&self) -> String {
        match self {
            MemoView::Empty => "(empty)".into(),
            MemoView::Text(s) => format!("text: {s:?}"),
            MemoView::Arbitrary(h) => format!("arbitrary(hex): {h}"),
            MemoView::Unknown(h) => format!("unknown(hex): {h}"),
        }
    }
}

fn trim_zeros(b: &[u8]) -> &[u8] {
    let end = b.iter().rposition(|x| *x != 0).map_or(0, |i| i + 1);
    &b[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn padded(prefix: &[u8]) -> [u8; MEMO_LEN] {
        let mut b = [0u8; MEMO_LEN];
        b[..prefix.len()].copy_from_slice(prefix);
        b
    }

    #[test]
    fn empty_memo() {
        assert_eq!(MemoView::decode_full(&padded(&[0xF6])), MemoView::Empty);
        // Short stored form of the empty memo.
        assert_eq!(MemoView::decode(&[0xF6]), MemoView::Empty);
    }

    #[test]
    fn f6_with_nonzero_tail_is_not_empty() {
        let v = MemoView::decode_full(&padded(&[0xF6, 0x01]));
        assert_eq!(v, MemoView::Unknown("f601".into()));
    }

    #[test]
    fn ascii_text() {
        let json = br#"{"v":1,"op":"buy"}"#;
        assert_eq!(MemoView::decode(json), MemoView::Text(r#"{"v":1,"op":"buy"}"#.into()));
    }

    #[test]
    fn utf8_text_full_length() {
        // 2-byte chars filling the whole 512 bytes, no padding.
        let s = "ж".repeat(256);
        assert_eq!(s.len(), MEMO_LEN);
        assert_eq!(MemoView::decode(s.as_bytes()), MemoView::Text(s));
    }

    #[test]
    fn invalid_utf8_text_is_unknown() {
        let v = MemoView::decode(&[0x41, 0xC3, 0x28]);
        assert_eq!(v, MemoView::Unknown("41c328".into()));
    }

    #[test]
    fn arbitrary_data() {
        let v = MemoView::decode(&[0xFF, 0xDE, 0xAD, 0x00, 0xBE]);
        assert_eq!(v, MemoView::Arbitrary("dead00be".into()));
    }

    #[test]
    fn reserved_prefixes() {
        for p in [0xF5u8, 0xF7, 0xFE] {
            assert!(matches!(MemoView::decode(&[p, 1]), MemoView::Unknown(_)));
        }
    }

    #[test]
    fn oversize_is_unknown() {
        let big = vec![0x41u8; MEMO_LEN + 1];
        assert!(matches!(MemoView::decode(&big), MemoView::Unknown(_)));
    }

    #[test]
    fn all_zero_is_empty_text() {
        // 0x00 first byte = text marker; all zeros = empty string per ZIP-302.
        assert_eq!(MemoView::decode(&[]), MemoView::Text(String::new()));
    }

    #[test]
    fn agrees_with_zcash_protocol_for_text() {
        use zcash_protocol::memo::{Memo, MemoBytes};
        let mb = MemoBytes::from_bytes(b"hello unzeen").unwrap();
        let m = Memo::try_from(&mb).unwrap();
        match m {
            Memo::Text(t) => assert_eq!(MemoView::decode(mb.as_slice()), MemoView::Text(t.to_string())),
            _ => panic!("expected text"),
        }
    }
}

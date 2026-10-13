//! Chat vectors (API.md v0.12 «Чат»): core/testdata/chat-vectors.json. The web client
//! (`web/lib/chat/text.ts`, `chatNick`) must match them. Regenerate (only on purpose):
//!   UNZEEN_WRITE_VECTORS=1 cargo test -p unzeen-protocol --test chat_vectors

use serde_json::{Value, json};
use unzeen_protocol::{
    ChainId, SigningKey, SolanaCluster, ZcashNet, api_auth,
    chat::{self, TextProblem},
};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/chat-vectors.json");
const K_CHAT: [u8; 32] = [0x42; 32];

fn b58(b: &[u8]) -> String {
    bs58::encode(b).into_string()
}

fn text_cases() -> Vec<(String, Option<TextProblem>, &'static str)> {
    let seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    vec![
        ("gm frens".into(), None, "plain"),
        (
            "ser, CA pls: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P".into(),
            None,
            "address is fine",
        ),
        ("line1\nline2\nline3\nline4".into(), None, "3 newlines"),
        ("👨\u{200d}👩\u{200d}👧 ❤\u{fe0f}".into(), None, "ZWJ emoji + VS16"),
        ("é".into(), None, "precomposed NFC"),
        ("x\u{300}\u{301}".into(), None, "2 combining marks"),
        ("a".repeat(280), None, "280 chars"),
        ("€".repeat(266), None, "266 × 3 bytes + quotes = 800 JSON bytes"),
        (String::new(), Some(TextProblem::Empty), "empty"),
        ("e\u{301}".into(), Some(TextProblem::NotNfc), "decomposed"),
        ("a".repeat(281), Some(TextProblem::TooLong), "281 chars"),
        ("€".repeat(267), Some(TextProblem::TooManyBytes), "803 JSON bytes"),
        (
            "\u{1}".repeat(140),
            Some(TextProblem::TooManyBytes),
            "JSON escapes count (\\u0001 = 6 bytes), checked before chars",
        ),
        (" gm".into(), Some(TextProblem::EdgeSpace), "leading space"),
        ("gm\u{a0}".into(), Some(TextProblem::EdgeSpace), "trailing NBSP"),
        ("gm\n".into(), Some(TextProblem::EdgeSpace), "trailing newline"),
        (
            "\u{feff}gm".into(),
            Some(TextProblem::EdgeSpace),
            "leading BOM is JS \\s",
        ),
        ("a\nb\nc\nd\ne".into(), Some(TextProblem::Newlines), "4 newlines"),
        ("a\n\n\nb".into(), Some(TextProblem::Newlines), "triple newline"),
        ("a\tb".into(), Some(TextProblem::ForbiddenChar), "tab"),
        ("a\rb".into(), Some(TextProblem::ForbiddenChar), "CR"),
        ("a\u{85}b".into(), Some(TextProblem::ForbiddenChar), "NEL (not JS \\s)"),
        ("abc\u{202e}def".into(), Some(TextProblem::ForbiddenChar), "RLO"),
        ("a\u{200b}b".into(), Some(TextProblem::ForbiddenChar), "ZWSP"),
        ("a\u{2028}b".into(), Some(TextProblem::ForbiddenChar), "LINE SEPARATOR"),
        ("a\u{e000}b".into(), Some(TextProblem::ForbiddenChar), "private use"),
        ("a\u{e0041}b".into(), Some(TextProblem::ForbiddenChar), "tag char"),
        ("a\u{fdd0}b".into(), Some(TextProblem::ForbiddenChar), "noncharacter"),
        (
            "a\u{1fffe}b".into(),
            Some(TextProblem::ForbiddenChar),
            "plane noncharacter",
        ),
        (
            "x\u{300}\u{301}\u{302}".into(),
            Some(TextProblem::Zalgo),
            "3 combining marks",
        ),
        (seed.into(), Some(TextProblem::SeedPhrase), "12 BIP-39 words"),
        (
            seed.to_uppercase().replace(' ', ","),
            Some(TextProblem::SeedPhrase),
            "case and punctuation",
        ),
        (seed.replace(" accident", ""), None, "11 words"),
    ]
}

fn nick_cases() -> Vec<Value> {
    let mut out = Vec::new();
    for (i, (chain, label)) in [
        (ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet), "0202"),
        (ChainId::new(ZcashNet::Mainnet, SolanaCluster::MainnetBeta), "0101"),
    ]
    .into_iter()
    .enumerate()
    {
        for m in [7u8, 8] {
            let sk = SigningKey::from_bytes(&[(i as u8) + 1; 32]);
            let pk = sk.verifying_key().to_bytes();
            let mint = [m; 32];
            out.push(json!({
                "chainId": label,
                "mint": b58(&mint),
                "anonPubkey": b58(&pk),
                "member": chat::nick(&K_CHAT, chain, &mint, &pk, false),
                "creator": chat::nick(&K_CHAT, chain, &mint, &pk, true),
            }));
        }
    }
    out
}

/// A `chat` body padded to exactly 1024 bytes, `pad` last.
fn body_1024(mint: &str, text: &str) -> String {
    let head = json!({ "op": "chat", "mint": mint, "text": text }).to_string();
    let base = format!("{},\"pad\":\"\"}}", &head[..head.len() - 1]);
    let fill = 1024 - base.len();
    format!("{},\"pad\":\"{}\"}}", &head[..head.len() - 1], " ".repeat(fill))
}

fn build() -> Value {
    let texts: Vec<Value> = text_cases()
        .into_iter()
        .map(|(t, p, note)| {
            json!({
                "text": t,
                "valid": p.is_none(),
                "problem": p.map(TextProblem::code),
                "jsonBytes": chat::json_bytes(&t),
                "note": note,
            })
        })
        .collect();
    let chain = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
    let sk = SigningKey::from_bytes(&[1; 32]);
    let mint = b58(&[7; 32]);
    let body = body_1024(&mint, "gm frens");
    let h = api_auth::sign_request(
        chain,
        &sk,
        "POST",
        "/api/actions",
        body.as_bytes(),
        [9; 16],
        1_800_000_000_000,
    );
    let msg_id = [0xAB; 16];
    json!({
        "kChat": hex::encode(K_CHAT),
        "alphabet": std::str::from_utf8(chat::CROCKFORD).unwrap(),
        "nick": nick_cases(),
        "reportTag": {
            "msgId": hex::encode(msg_id),
            "anonPubkey": b58(&sk.verifying_key().to_bytes()),
            "tag": hex::encode(chat::report_tag(&K_CHAT, &msg_id, &sk.verifying_key().to_bytes())),
        },
        "text": texts,
        "body": {
            "chainId": "0202",
            "anonSecretHex": hex::encode([1u8; 32]),
            "path": "/api/actions",
            "body": body,
            "bodyBytes": body.len(),
            "headers": { "x-unzeen-pubkey": h.pubkey, "x-unzeen-nonce": h.nonce, "x-unzeen-ts": h.ts, "x-unzeen-sig": h.sig },
        },
    })
}

#[test]
fn chat_vectors() {
    let v = build();
    assert_eq!(v["body"]["bodyBytes"], 1024);
    for t in v["text"].as_array().unwrap() {
        let s = t["text"].as_str().unwrap();
        let got = chat::check_text(s).err().map(TextProblem::code);
        assert_eq!(got, t["problem"].as_str(), "{}", t["note"]);
    }
    let pretty = serde_json::to_string_pretty(&v).unwrap() + "\n";
    if std::env::var("UNZEEN_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::write(PATH, &pretty).unwrap();
        return;
    }
    let on_disk = std::fs::read_to_string(PATH).expect("chat-vectors.json (UNZEEN_WRITE_VECTORS=1 to create)");
    assert_eq!(on_disk, pretty, "vectors changed: regenerate on purpose only");
}

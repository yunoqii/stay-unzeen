-- Unzeen 0016: anonymous token chat (API.md v0.12 «Чат», docs/analysis/chat.md, lead R1–R6, R8).
--
-- Privacy: NO anon key, signature, nonce, IP or receive time in any chat table. A message carries
-- only its nick = HMAC(K_chat, …) with K_chat outside the database. Authorship (delete) is proven
-- by recomputing the nick from the request's key. Times are publication boundaries.
-- Owner role only (API). The relayer and indexer roles have no access.

CREATE SEQUENCE chat_seq;

CREATE TABLE chat_messages (
    id                BYTEA PRIMARY KEY CHECK (length(id) = 16),
    mint              TEXT NOT NULL,
    nick              TEXT NOT NULL CHECK (nick ~ '^[0-9a-hjkmnp-tv-z]{8}$'),
    is_creator        BOOLEAN NOT NULL,
    text              TEXT,                         -- NULL once removed
    status            TEXT NOT NULL CHECK (status IN ('pending', 'published', 'removed')),
    -- pending: earliest boundary (second-coarse; slow: +120..300 s). Set to ts at publication,
    -- so no receive time stays behind.
    publish_after     TIMESTAMPTZ NOT NULL,
    ts                TIMESTAMPTZ,                  -- publication boundary
    seq               BIGINT UNIQUE,                -- event order; re-issued on hide / removal
    hidden_by_creator BOOLEAN NOT NULL DEFAULT false,
    hide_req          BOOLEAN NOT NULL DEFAULT false, -- chat_hide, applied on the next boundary
    remove_req        TEXT CHECK (remove_req IN ('deleted', 'reports', 'operator')),
    removed_reason    TEXT CHECK (removed_reason IN ('deleted', 'reports', 'operator')),
    removed_at        TIMESTAMPTZ,
    CHECK (status <> 'published' OR (ts IS NOT NULL AND seq IS NOT NULL AND text IS NOT NULL)),
    CHECK (status <> 'removed' OR (text IS NULL AND removed_reason IS NOT NULL))
);
CREATE INDEX chat_messages_mint_seq ON chat_messages (mint, seq);
CREATE INDEX chat_messages_pending ON chat_messages (publish_after) WHERE status = 'pending';
CREATE INDEX chat_messages_requests ON chat_messages (id) WHERE hide_req OR remove_req IS NOT NULL;

-- reporter_tag = HMAC(K_chat, "unzeen/chat/report/v1" ‖ msg_id ‖ pubkey): dedup without the key.
CREATE TABLE chat_reports (
    msg_id       BYTEA NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
    reporter_tag BYTEA NOT NULL CHECK (length(reporter_tag) = 32),
    created_day  DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
    PRIMARY KEY (msg_id, reporter_tag)
);

CREATE TABLE chat_mutes (
    mint  TEXT NOT NULL,
    nick  TEXT NOT NULL,
    until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (mint, nick)
);

-- Idempotent replay of non-action signed POSTs (chat_*, noop) within the nonce window (≤ 120 s):
-- the request hash and the original answer. Deleted with the nonce.
ALTER TABLE api_nonces
    ADD COLUMN request_hash BYTEA CHECK (request_hash IS NULL OR length(request_hash) = 32),
    ADD COLUMN response     JSONB;

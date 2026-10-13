//! Token chat storage (migration 0016, API.md v0.12 «Чат»).
//!
//! No anon key, signature, nonce or receive time is ever stored next to a message. The only
//! per-key rows are `api_nonces` (pk, nonce, request hash, answer) for idempotent replay,
//! deleted with the nonce (≤ 120 s), exactly like signed GETs.
//!
//! Publication, removals and hides happen only in [`Ledger::chat_publish`], which the API calls
//! on the shared Delayed epoch boundaries.

use deadpool_postgres::GenericClient;
use serde_json::{Value, json};

use crate::{Ledger, LedgerError, Result, to_i64, to_u64};

/// Pending messages per mint / per pool (chat.md §4.2).
pub const MAX_PENDING_PER_MINT: i64 = 50;
pub const MAX_PENDING_TOTAL: i64 = 2000;
/// Tombstones of removed messages, hours.
pub const TOMBSTONE_HOURS: i32 = 24;
pub const RETENTION_DAYS: i32 = 30;
pub const MAX_PER_MINT: i64 = 1000;

/// Signed-request context of a chat_* / noop operation (nonce row for idempotent replay).
#[derive(Clone, Copy, Debug)]
pub struct NonceCtx {
    pub pk: [u8; 32],
    pub nonce: [u8; 16],
    pub request_hash: [u8; 32],
    /// `ts` of the request, unix ms (the nonce is kept until ts + NONCE_TTL).
    pub ts_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ChatPost {
    pub mint: String,
    pub nick: String,
    pub is_creator: bool,
    pub text: String,
    /// 0 = next boundary; slow mode: 120–300 s.
    pub delay_secs: f64,
}

/// What a moderation request needs to check authorship / rights in the API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatMsgMeta {
    pub mint: String,
    pub nick: String,
    pub is_creator: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatRequest {
    Delete,
    Hide,
}

/// `GET …/chat` modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatQuery {
    Latest { limit: i64 },
    Before { seq: i64, limit: i64 },
    After { seq: i64 },
}

fn msg_json(r: &tokio_postgres::Row) -> Value {
    let mut v = json!({
        "id": hex::encode(r.get::<_, Vec<u8>>(0)),
        "mint": r.get::<_, String>(1),
        "nick": r.get::<_, String>(2),
        "isCreator": r.get::<_, bool>(3),
        "text": r.get::<_, Option<String>>(4).unwrap_or_default(),
        "ts": r.get::<_, Option<i64>>(5).unwrap_or(0),
        "seq": r.get::<_, Option<i64>>(6).unwrap_or(0).to_string(),
    });
    if r.get::<_, bool>(7) {
        v["hiddenByCreator"] = json!(true);
    }
    v
}

const MSG_COLS: &str = "id, mint, nick, is_creator, text, (extract(epoch FROM ts) * 1000)::bigint, seq,
     hidden_by_creator, status, removed_reason";

async fn nonce_row<C: GenericClient>(tx: &C, n: &NonceCtx, response: &Value) -> Result<bool> {
    let keep_until_ms = to_i64(n.ts_ms.saturating_add(unzeen_protocol::api_auth::NONCE_TTL_MS))?;
    let (pk, nonce, hash): (&[u8], &[u8], &[u8]) = (&n.pk, &n.nonce, &n.request_hash);
    // A nonce already spent by a balance action is a replay too.
    if tx
        .query_opt(
            "SELECT 1 FROM actions WHERE anon_pubkey = $1 AND nonce = $2",
            &[&pk, &nonce],
        )
        .await?
        .is_some()
    {
        return Ok(false);
    }
    Ok(tx
        .execute(
            "INSERT INTO api_nonces (anon_pubkey, nonce, expires_at, request_hash, response)
             VALUES ($1, $2, to_timestamp($3::float8 / 1000), $4, $5) ON CONFLICT DO NOTHING",
            &[&pk, &nonce, &(keep_until_ms as f64), &hash, response],
        )
        .await?
        == 1)
}

impl Ledger {
    /// Same nonce + same body within the window → the original answer; a nonce used for
    /// anything else → `Replay`; unused → `None`.
    pub async fn chat_replay(&self, n: &NonceCtx) -> Result<Option<Value>> {
        let c = self.pool.get().await?;
        let (pk, nonce): (&[u8], &[u8]) = (&n.pk, &n.nonce);
        if let Some(r) = c
            .query_opt(
                "SELECT request_hash, response FROM api_nonces WHERE anon_pubkey = $1 AND nonce = $2",
                &[&pk, &nonce],
            )
            .await?
        {
            let (h, resp): (Option<Vec<u8>>, Option<Value>) = (r.get(0), r.get(1));
            return match (h, resp) {
                (Some(h), Some(v)) if h == n.request_hash => Ok(Some(v)),
                _ => Err(LedgerError::Replay),
            };
        }
        if c.query_opt(
            "SELECT 1 FROM actions WHERE anon_pubkey = $1 AND nonce = $2",
            &[&pk, &nonce],
        )
        .await?
        .is_some()
        {
            return Err(LedgerError::Replay);
        }
        Ok(None)
    }

    /// `noop` (R8): only the nonce row; the answer looks like a queued action.
    pub async fn noop(&self, n: &NonceCtx) -> Result<Value> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let v = json!({ "id": hex::encode(rand::random::<[u8; 16]>()), "status": "queued" });
        if !nonce_row(&tx, n, &v).await? {
            return Err(LedgerError::Replay);
        }
        tx.commit().await?;
        Ok(v)
    }

    pub async fn chat_mint_listed(&self, mint: &str) -> Result<bool> {
        let c = self.pool.get().await?;
        Ok(c.query_opt("SELECT 1 FROM tokens WHERE mint = $1", &[&mint])
            .await?
            .is_some())
    }

    pub async fn chat_is_creator(&self, pk: &[u8; 32], mint: &str) -> Result<bool> {
        let c = self.pool.get().await?;
        let pk_s: &[u8] = pk;
        Ok(c.query_opt(
            "SELECT 1 FROM creator_tokens WHERE mint = $1 AND anon_pubkey = $2",
            &[&mint, &pk_s],
        )
        .await?
        .is_some())
    }

    /// Account value for chat admission (R5), zat: available + held ZEC plus every token
    /// position at the last indexer tick price, converted at `lamports_per_zec_sell`
    /// (`None` = no rate: tokens count 0). Never stored, never returned to the client.
    pub async fn chat_account_value(&self, pk: &[u8; 32], lamports_per_zec_sell: Option<u64>) -> Result<(u64, bool)> {
        let c = self.pool.get().await?;
        let pk_s: &[u8] = pk;
        let (zat, frozen) = c
            .query_opt(
                "SELECT available_zat + held_zat, frozen FROM balances WHERE anon_pubkey = $1",
                &[&pk_s],
            )
            .await?
            .map_or((0, false), |r| (to_u64(r.get(0)), r.get(1)));
        let Some(rate) = lamports_per_zec_sell.filter(|r| *r > 0) else {
            return Ok((zat, frozen));
        };
        let lamports: i64 = c
            .query_one(
                "SELECT COALESCE(floor(sum((b.available + b.held)::numeric * p.price_sol * 1e9
                                            / power(10::numeric, COALESCE(t.decimals, 6)))), 0)::bigint
                 FROM token_balances b JOIN intel_prices p ON p.mint = b.mint
                 LEFT JOIN tokens t ON t.mint = b.mint
                 WHERE b.anon_pubkey = $1",
                &[&pk_s],
            )
            .await?
            .get(0);
        let tok_zat = ((to_u64(lamports) as u128) * 100_000_000 / rate as u128).min(u64::MAX as u128) as u64;
        Ok((zat.saturating_add(tok_zat), frozen))
    }

    /// `chat`: queue a message for the next boundary (or later with slow mode).
    pub async fn chat_post(&self, n: &NonceCtx, p: &ChatPost) -> Result<Value> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        if tx
            .query_opt("SELECT 1 FROM tokens WHERE mint = $1", &[&p.mint])
            .await?
            .is_none()
        {
            return Err(LedgerError::NotFound);
        }
        if tx
            .query_opt(
                "SELECT 1 FROM chat_mutes WHERE mint = $1 AND nick = $2 AND until > now()",
                &[&p.mint, &p.nick],
            )
            .await?
            .is_some()
        {
            return Err(LedgerError::ChatMuted);
        }
        // Serialize pending counts per mint (concurrent posters cannot overshoot the batch cap).
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtext('unzeen/chat/' || $1))",
            &[&p.mint],
        )
        .await?;
        let r = tx
            .query_one(
                "SELECT count(*) FILTER (WHERE mint = $1), count(*) FROM chat_messages WHERE status = 'pending'",
                &[&p.mint],
            )
            .await?;
        if r.get::<_, i64>(0) >= MAX_PENDING_PER_MINT || r.get::<_, i64>(1) >= MAX_PENDING_TOTAL {
            return Err(LedgerError::ChatFull);
        }
        let id: [u8; 16] = rand::random();
        let id_s: &[u8] = &id;
        tx.execute(
            "INSERT INTO chat_messages (id, mint, nick, is_creator, text, status, publish_after)
             VALUES ($1, $2, $3, $4, $5, 'pending', date_trunc('second', now()) + make_interval(secs => $6))",
            &[&id_s, &p.mint, &p.nick, &p.is_creator, &p.text, &p.delay_secs.max(0.0)],
        )
        .await?;
        let v = json!({ "id": hex::encode(id), "status": "queued", "nick": p.nick });
        if !nonce_row(&tx, n, &v).await? {
            return Err(LedgerError::Replay);
        }
        tx.commit().await?;
        Ok(v)
    }

    /// Message that moderation may act on (pending or published).
    pub async fn chat_message_meta(&self, id: &[u8; 16]) -> Result<Option<ChatMsgMeta>> {
        let c = self.pool.get().await?;
        let id_s: &[u8] = id;
        Ok(c.query_opt(
            "SELECT mint, nick, is_creator FROM chat_messages WHERE id = $1 AND status <> 'removed'",
            &[&id_s],
        )
        .await?
        .map(|r| ChatMsgMeta {
            mint: r.get(0),
            nick: r.get(1),
            is_creator: r.get(2),
        }))
    }

    /// `chat_delete` / `chat_hide` (rights checked by the caller): applied on the next boundary.
    pub async fn chat_request(&self, n: &NonceCtx, id: &[u8; 16], what: ChatRequest) -> Result<Value> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let id_s: &[u8] = id;
        let changed = match what {
            ChatRequest::Delete => {
                tx.execute(
                    "UPDATE chat_messages SET remove_req = COALESCE(remove_req, 'deleted')
                     WHERE id = $1 AND status <> 'removed'",
                    &[&id_s],
                )
                .await?
            }
            ChatRequest::Hide => {
                tx.execute(
                    "UPDATE chat_messages SET hide_req = NOT hidden_by_creator
                     WHERE id = $1 AND status <> 'removed'",
                    &[&id_s],
                )
                .await?
            }
        };
        if changed == 0 {
            return Err(LedgerError::NotFound);
        }
        let v = json!({ "id": hex::encode(id), "status": "queued" });
        if !nonce_row(&tx, n, &v).await? {
            return Err(LedgerError::Replay);
        }
        tx.commit().await?;
        Ok(v)
    }

    /// `chat_report`: `own` (the reporter's nick wrote it) → no effect. At `threshold` distinct
    /// reporters the message is removed (`reports`) on the next boundary.
    pub async fn chat_report(
        &self,
        n: &NonceCtx,
        id: &[u8; 16],
        reporter_tag: &[u8; 32],
        own: bool,
        threshold: i64,
    ) -> Result<Value> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        let id_s: &[u8] = id;
        let exists = tx
            .query_opt(
                "SELECT 1 FROM chat_messages WHERE id = $1 AND status <> 'removed' FOR UPDATE",
                &[&id_s],
            )
            .await?
            .is_some();
        if !exists {
            return Err(LedgerError::NotFound);
        }
        if !own {
            let tag: &[u8] = reporter_tag;
            tx.execute(
                "INSERT INTO chat_reports (msg_id, reporter_tag) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                &[&id_s, &tag],
            )
            .await?;
            tx.execute(
                "UPDATE chat_messages SET remove_req = COALESCE(remove_req, 'reports')
                 WHERE id = $1 AND (SELECT count(*) FROM chat_reports WHERE msg_id = $1) >= $2",
                &[&id_s, &threshold],
            )
            .await?;
        }
        let v = json!({ "id": hex::encode(id), "status": "executed" });
        if !nonce_row(&tx, n, &v).await? {
            return Err(LedgerError::Replay);
        }
        tx.commit().await?;
        Ok(v)
    }

    /// One Delayed boundary: publish due messages (random `seq` order inside the batch), then
    /// apply removals and hides. Returns (published, removed, hidden).
    pub async fn chat_publish(&self) -> Result<(usize, usize, usize)> {
        let mut c = self.pool.get().await?;
        let tx = c.transaction().await?;
        tx.execute("SELECT pg_advisory_xact_lock(hashtext('unzeen/chat/publish'))", &[])
            .await?;
        // Pending messages removed before publication never appear.
        tx.execute(
            "DELETE FROM chat_messages WHERE status = 'pending' AND remove_req IS NOT NULL",
            &[],
        )
        .await?;
        let mut due: Vec<Vec<u8>> = tx
            .query(
                "SELECT id FROM chat_messages WHERE status = 'pending' AND publish_after <= now() FOR UPDATE",
                &[],
            )
            .await?
            .into_iter()
            .map(|r| r.get(0))
            .collect();
        // Random order inside the batch: seq must not reveal who sent first.
        for i in (1..due.len()).rev() {
            let j = (rand::random::<u64>() % (i as u64 + 1)) as usize;
            due.swap(i, j);
        }
        for id in &due {
            tx.execute(
                "UPDATE chat_messages SET status = 'published', ts = date_trunc('second', now()),
                        publish_after = date_trunc('second', now()), seq = nextval('chat_seq'),
                        hidden_by_creator = hidden_by_creator OR hide_req, hide_req = false
                 WHERE id = $1",
                &[id],
            )
            .await?;
        }
        let removed = tx
            .execute(
                "UPDATE chat_messages SET status = 'removed', text = NULL, removed_reason = remove_req,
                        removed_at = date_trunc('second', now()), seq = nextval('chat_seq'), remove_req = NULL,
                        hide_req = false
                 WHERE status = 'published' AND remove_req IS NOT NULL",
                &[],
            )
            .await?;
        let hidden = tx
            .execute(
                "UPDATE chat_messages SET hidden_by_creator = true, hide_req = false, seq = nextval('chat_seq')
                 WHERE status = 'published' AND hide_req AND NOT hidden_by_creator",
                &[],
            )
            .await?;
        tx.execute(
            "UPDATE chat_messages SET hide_req = false WHERE status = 'published' AND hide_req",
            &[],
        )
        .await?;
        tx.commit().await?;
        Ok((due.len(), removed as usize, hidden as usize))
    }

    /// Public page of `mint` (API.md v0.12): `(messages, removed, cursor, more)`.
    pub async fn chat_page(&self, mint: &str, q: ChatQuery) -> Result<(Vec<Value>, Vec<Value>, i64, bool)> {
        let c = self.pool.get().await?;
        let cols = MSG_COLS;
        match q {
            ChatQuery::After { seq } => {
                let rows = c
                    .query(
                        &format!(
                            "SELECT {cols} FROM chat_messages
                             WHERE mint = $1 AND seq > $2 AND status IN ('published', 'removed')
                             ORDER BY seq LIMIT 101"
                        ),
                        &[&mint, &seq],
                    )
                    .await?;
                let more = rows.len() > 100;
                let rows = &rows[..rows.len().min(100)];
                let cursor = rows.last().and_then(|r| r.get::<_, Option<i64>>(6)).unwrap_or(seq);
                let (mut msgs, mut removed) = (Vec::new(), Vec::new());
                for r in rows {
                    if r.get::<_, String>(8) == "removed" {
                        removed.push(json!({
                            "id": hex::encode(r.get::<_, Vec<u8>>(0)),
                            "reason": r.get::<_, Option<String>>(9).unwrap_or_else(|| "operator".into()),
                        }));
                    } else {
                        msgs.push(msg_json(r));
                    }
                }
                Ok((msgs, removed, cursor, more))
            }
            ChatQuery::Latest { limit } | ChatQuery::Before { limit, .. } => {
                let before = match q {
                    ChatQuery::Before { seq, .. } => seq,
                    _ => i64::MAX,
                };
                let rows = c
                    .query(
                        &format!(
                            "SELECT {cols} FROM chat_messages
                             WHERE mint = $1 AND status = 'published' AND seq < $2
                             ORDER BY seq DESC LIMIT $3"
                        ),
                        &[&mint, &before, &(limit + 1)],
                    )
                    .await?;
                let more = rows.len() as i64 > limit;
                let msgs = rows.iter().take(limit as usize).map(msg_json).collect();
                let top: i64 = c
                    .query_one(
                        "SELECT COALESCE(max(seq), 0) FROM chat_messages WHERE mint = $1",
                        &[&mint],
                    )
                    .await?
                    .get(0);
                Ok((msgs, Vec::new(), top, more))
            }
        }
    }

    /// Hourly: tombstones after 24 h, published after 30 days or beyond 1000 per mint, reports
    /// after 7 days, expired mutes.
    pub async fn chat_janitor(&self) -> Result<u64> {
        let c = self.pool.get().await?;
        let mut n = c
            .execute(
                &format!(
                    "DELETE FROM chat_messages WHERE status = 'removed'
                       AND removed_at < now() - make_interval(hours => {TOMBSTONE_HOURS})"
                ),
                &[],
            )
            .await?;
        n += c
            .execute(
                &format!(
                    "DELETE FROM chat_messages WHERE status = 'published'
                       AND ts < now() - make_interval(days => {RETENTION_DAYS})"
                ),
                &[],
            )
            .await?;
        n += c
            .execute(
                "DELETE FROM chat_messages m USING (
                     SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY mint ORDER BY seq DESC) AS k
                                     FROM chat_messages WHERE status = 'published') x WHERE k > $1) old
                 WHERE m.id = old.id",
                &[&MAX_PER_MINT],
            )
            .await?;
        c.execute(
            "DELETE FROM chat_reports WHERE created_day < (now() AT TIME ZONE 'UTC')::date - 7",
            &[],
        )
        .await?;
        c.execute("DELETE FROM chat_mutes WHERE until < now()", &[]).await?;
        Ok(n)
    }

    /// Operator: remove one message (`operator`) on the next boundary.
    pub async fn chat_operator_remove(&self, id: &[u8; 16]) -> Result<bool> {
        let c = self.pool.get().await?;
        let id_s: &[u8] = id;
        Ok(c.execute(
            "UPDATE chat_messages SET remove_req = 'operator' WHERE id = $1 AND status <> 'removed'",
            &[&id_s],
        )
        .await?
            == 1)
    }

    /// Operator: remove every message of `mint` on the next boundary.
    pub async fn chat_purge(&self, mint: &str) -> Result<u64> {
        let c = self.pool.get().await?;
        Ok(c.execute(
            "UPDATE chat_messages SET remove_req = 'operator' WHERE mint = $1 AND status <> 'removed'",
            &[&mint],
        )
        .await?)
    }

    /// Operator: mute (nick, mint) for `hours`.
    pub async fn chat_mute(&self, mint: &str, nick: &str, hours: f64) -> Result<()> {
        if !unzeen_protocol::chat::is_nick(nick) {
            return Err(LedgerError::Range);
        }
        let c = self.pool.get().await?;
        c.execute(
            "INSERT INTO chat_mutes (mint, nick, until) VALUES ($1, $2, now() + make_interval(secs => $3))
             ON CONFLICT (mint, nick) DO UPDATE SET until = EXCLUDED.until",
            &[&mint, &nick, &(hours.max(0.0) * 3600.0)],
        )
        .await?;
        Ok(())
    }
}

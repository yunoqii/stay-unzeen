//! `scenario_create` / `scenario_start` / `scenario_cancel`, sealing with K_scn, the
//! `Portfolio.scenarios` and `PoolInfo.scenarios` blocks (API.md v0.19).

use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use serde::Deserialize;
use serde_json::{Value, json};
use unzeen_ledger::scenarios::{NewScenario, ScenarioView};

use super::validate::{self, Ctx, Kind, ValidationError};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
};

/// Blocks the executor runs today (S3). The rest of v0.19 is advertised as it lands (S4–S6);
/// a plan with another block → `bad_request` / `feature_disabled`, like a disabled feature.
pub const EXEC_BLOCKS: &[&str] = &[
    "manual_start",
    "wait_fixed",
    "wait_random",
    "buy",
    "sell",
    "sell_all",
    "end",
];

pub fn is_scenario_op(raw: &Value) -> bool {
    raw.get("op")
        .and_then(Value::as_str)
        .is_some_and(|o| o.starts_with("scenario_"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
#[allow(clippy::enum_variant_names)] // variant names are the wire ops
enum ScenarioOp {
    ScenarioCreate {
        plan: Value,
        #[serde(default)]
        replaces: Option<String>,
    },
    ScenarioStart {
        id: String,
    },
    ScenarioCancel {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        all: Option<bool>,
    },
}

fn id16(s: &str) -> ApiResult<[u8; 16]> {
    (s.len() == 32 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
        .then(|| hex::decode(s).ok())
        .flatten()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("id: 32 lowercase hex"))
}

pub fn validation_error(e: ValidationError) -> ApiError {
    let (status, code, msg) = match e.kind {
        Kind::Invalid => (
            axum::http::StatusCode::BAD_REQUEST,
            "scenario_invalid",
            "scenario plan is invalid",
        ),
        Kind::Rule => (
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "scenario_rule",
            "scenario plan breaks a privacy rule",
        ),
        Kind::BadRequest => (
            axum::http::StatusCode::BAD_REQUEST,
            "bad_request",
            "invalid action body",
        ),
    };
    ApiError {
        details: Some(e.code),
        details_step: e.step,
        ..ApiError::new(status, code, msg)
    }
}

/// Mask of an address for the plan echo (`Ab3d…9xYz`).
pub fn mask(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() <= 8 {
        return "…".into();
    }
    format!(
        "{}…{}",
        c[..4].iter().collect::<String>(),
        c[c.len() - 4..].iter().collect::<String>()
    )
}

fn aad(id: &[u8; 16], step: usize) -> Vec<u8> {
    let mut a = id.to_vec();
    a.extend_from_slice(&(step as u16).to_be_bytes());
    a
}

/// nonce(12) ‖ ChaCha20-Poly1305(K_scn, json, AAD = id ‖ u16(step)).
pub fn seal(key: &[u8; 32], id: &[u8; 16], step: usize, v: &Value) -> Vec<u8> {
    let nonce: [u8; 12] = rand::random();
    let c = ChaCha20Poly1305::new(key.into());
    let ct = c
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &serde_json::to_vec(v).expect("json"),
                aad: &aad(id, step),
            },
        )
        .expect("seal");
    let mut out = nonce.to_vec();
    out.extend(ct);
    out
}

pub fn unseal(key: &[u8; 32], id: &[u8; 16], step: usize, blob: &[u8]) -> Option<Value> {
    if blob.len() < 12 {
        return None;
    }
    let c = ChaCha20Poly1305::new(key.into());
    let pt = c
        .decrypt(
            Nonce::from_slice(&blob[..12]),
            Payload {
                msg: &blob[12..],
                aad: &aad(id, step),
            },
        )
        .ok()?;
    serde_json::from_slice(&pt).ok()
}

/// Split the sealed fields out of the plan: (echo plan, [(step, sealed json)]).
pub fn split_sealed(plan: &Value) -> (Value, Vec<(usize, Value)>) {
    let mut echo = plan.clone();
    let mut sealed = Vec::new();
    let Some(steps) = echo.get_mut("steps").and_then(Value::as_array_mut) else {
        return (echo, sealed);
    };
    for (i, s) in steps.iter_mut().enumerate() {
        let Some(b) = s.get_mut("block").and_then(Value::as_object_mut) else {
            continue;
        };
        let ty = b.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let mut secret = serde_json::Map::new();
        match ty.as_str() {
            "withdraw_token" | "withdraw_zec" => {
                if let Some(to) = b.get("to").cloned() {
                    secret.insert("to".into(), to.clone());
                    b["to"] = match to {
                        Value::Array(a) => {
                            Value::Array(a.iter().map(|x| json!(mask(x.as_str().unwrap_or("")))).collect())
                        }
                        x => json!(mask(x.as_str().unwrap_or(""))),
                    };
                }
            }
            "create" => {
                if let Some(m) = b.get_mut("create").and_then(Value::as_object_mut)
                    && let Some(meta) = m.get("meta").cloned()
                {
                    secret.insert("meta".into(), meta);
                    m.insert("meta".into(), json!({ "name": "", "symbol": "" }));
                }
            }
            "fl_bid" => {
                if let Some(ct) = b.get("ciphertext").cloned() {
                    secret.insert("ciphertext".into(), ct);
                    b["ciphertext"] = json!("");
                }
            }
            "chat" => {
                if let Some(t) = b.get("text").cloned() {
                    secret.insert("text".into(), t);
                    b["text"] = json!("");
                }
            }
            _ => {}
        }
        if !secret.is_empty() {
            sealed.push((i, Value::Object(secret)));
        }
    }
    (echo, sealed)
}

/// Every candidate literal mint of a plan (strings under `mint`/`from`/`to` of trade blocks).
fn literal_mints(plan: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for s in plan.get("steps").and_then(Value::as_array).into_iter().flatten() {
        let b = &s["block"];
        for k in ["mint", "from", "to"] {
            if k == "to" && b["type"] != "swap" {
                continue;
            }
            if let Some(m) = b.get(k).and_then(Value::as_str) {
                out.push(m.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

pub async fn validation_ctx(st: &AppState, plan: &Value) -> ApiResult<Ctx> {
    let venues = crate::venues_block(st)
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["trade"] == true)
        .filter_map(|v| v["venue"].as_str().map(String::from))
        .collect();
    Ok(Ctx {
        now_ms: crate::rate::now_ms(),
        min_deposit_zat: st.cfg.policy.min_deposit_zat,
        min_action_zat: st.cfg.policy.min_action_zat,
        venues,
        fair_launch: st.cfg.fair.enabled,
        chat: st.cfg.chat.enabled,
        full_trades: st.cfg.intel.full_trades,
        priced_mints: st.ledger.priced_mints(&literal_mints(plan)).await?,
    })
}

/// `POST /api/actions` with `op: scenario_*`.
pub async fn submit(
    st: &AppState,
    raw: Value,
    pk: &[u8; 32],
    nonce: &[u8; 16],
    request_hash: &[u8; 32],
) -> ApiResult<Value> {
    let op: ScenarioOp = serde_json::from_value(raw).map_err(|_| ApiError::bad_request("invalid action body"))?;
    match op {
        ScenarioOp::ScenarioCreate { plan, replaces } => {
            let ctx = validation_ctx(st, &plan).await?;
            let sum = validate::validate(&plan, &ctx).map_err(validation_error)?;
            let steps = plan["steps"].as_array().expect("validated");
            if let Some(i) = steps
                .iter()
                .position(|s| !EXEC_BLOCKS.contains(&s["block"]["type"].as_str().unwrap_or("")))
            {
                return Err(validation_error(ValidationError {
                    kind: Kind::BadRequest,
                    step: Some(i),
                    code: "feature_disabled",
                }));
            }
            // Checks that need server state, at creation rather than hours later (review 14).
            for (i, s) in steps.iter().enumerate() {
                let b = &s["block"];
                if b["type"] == "withdraw_zec" && crate::actions::check_ua(st, b["to"].as_str().unwrap_or("")).is_err()
                {
                    return Err(validation_error(ValidationError {
                        kind: Kind::Invalid,
                        step: Some(i),
                        code: "bad_address",
                    }));
                }
            }
            let replaces = replaces.as_deref().map(id16).transpose()?;
            let (echo, sealed_plain) = split_sealed(&plan);
            let key = st.cfg.scenarios.key.as_ref().ok_or_else(ApiError::internal)?;
            // AAD binds every blob to this plan (random salt kept in `state.sealId`) and step.
            let seal_id: [u8; 16] = rand::random();
            let sealed: Vec<(i16, Vec<u8>)> = sealed_plain
                .iter()
                .map(|(i, v)| (*i as i16, seal(&key.0, &seal_id, *i, v)))
                .collect();
            let s = NewScenario {
                plan: echo,
                ttl_secs: sum.ttl_secs,
                manual_start: sum.manual_start,
                network: st.cfg.cluster.into(),
                replaces,
                state: json!({ "sealId": hex::encode(seal_id), "steps": {}, "out": {} }),
            };
            let r = st.ledger.scenario_create(pk, nonce, request_hash, &s, &sealed).await?;
            Ok(json!({ "id": hex::encode(r.id), "status": r.status }))
        }
        ScenarioOp::ScenarioStart { id } => {
            let r = st.ledger.scenario_start(pk, nonce, request_hash, &id16(&id)?).await?;
            Ok(json!({ "id": id, "status": r.status }))
        }
        ScenarioOp::ScenarioCancel { id, all } => match (id, all) {
            (Some(id), None) => {
                st.ledger
                    .scenario_cancel(pk, nonce, request_hash, Some(&id16(&id)?))
                    .await?;
                Ok(json!({ "id": id, "status": "cancelled" }))
            }
            (None, Some(true)) => {
                let (_, ids) = st.ledger.scenario_cancel(pk, nonce, request_hash, None).await?;
                Ok(json!({ "ids": ids.iter().map(hex::encode).collect::<Vec<_>>(), "status": "cancelled" }))
            }
            _ => Err(ApiError::bad_request("scenario_cancel: id or all: true")),
        },
    }
}

/// `Scenario` (API.md v0.19) of an owner view.
pub fn scenario_json(v: &ScenarioView) -> Value {
    let n = v.plan["steps"].as_array().map_or(0, Vec::len);
    let st_of = |i: usize| v.state["steps"][i.to_string()].as_str().map(str::to_string);
    let steps: Vec<Value> = (0..n)
        .map(|i| {
            let runs: Vec<_> = v.runs.iter().filter(|r| r.1 as usize == i).collect();
            let status = st_of(i).unwrap_or_else(|| {
                if v.status == "active" && i == v.cursor {
                    "waiting".into()
                } else {
                    "pending".into()
                }
            });
            let mut o = json!({
                "id": i,
                "status": status,
                "runs": runs.iter().filter(|r| r.3.is_some()).count(),
            });
            if let Some(last) = runs.last() {
                if let Some(a) = last.3 {
                    o["actionId"] = json!(hex::encode(a));
                }
                if let Some(oid) = last.4 {
                    o["orderId"] = json!(hex::encode(oid));
                }
                if let Some(e) = &last.5 {
                    o["error"] = json!(e);
                }
            }
            if v.status == "active"
                && i == v.cursor
                && let Some(t) = v.next_at_ms
            {
                o["nextAt"] = json!(t);
            }
            o
        })
        .collect();
    let mut out = json!({
        "id": hex::encode(v.id),
        "status": v.status,
        "createdAt": v.created_at_ms,
        "expiresAt": v.expires_at_ms,
        "cursor": v.cursor,
        "plan": v.plan,
        "steps": steps,
    });
    if let Some(e) = &v.error {
        out["error"] = json!(e);
    }
    out
}

/// `PoolInfo.scenarios` (only when the flag is on).
pub fn pool_block(st: &AppState) -> Value {
    let blocks: Vec<&str> = validate::enabled_blocks(st.cfg.fair.enabled, st.cfg.chat.enabled)
        .into_iter()
        .filter(|b| EXEC_BLOCKS.contains(b))
        .collect();
    json!({
        "blocks": blocks,
        "maxSteps": validate::MAX_STEPS,
        "maxRuns": validate::MAX_RUNS,
        "maxActivePerKey": validate::MAX_ACTIVE_PER_KEY,
        "ttlSecs": {
            "min": validate::TTL_MIN_SECS,
            "max": validate::TTL_MAX_SECS,
            "maxNoWithdraw": validate::TTL_MAX_NO_WITHDRAW_SECS,
            "default": validate::TTL_DEFAULT_SECS,
        },
        "floors": super::exec::floors_json(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_roundtrip_and_binding() {
        let k = [7u8; 32];
        let id = [1u8; 16];
        let v = json!({ "to": "utest1abc" });
        let b = seal(&k, &id, 3, &v);
        assert_eq!(unseal(&k, &id, 3, &b), Some(v));
        assert_eq!(unseal(&k, &id, 4, &b), None, "bound to the step");
        assert_eq!(unseal(&k, &[2; 16], 3, &b), None, "bound to the plan");
        assert_eq!(unseal(&[8; 32], &id, 3, &b), None, "needs K_scn");
    }

    #[test]
    fn sealed_fields_leave_the_echo() {
        let plan = json!({ "v": 1, "steps": [
            { "id": 0, "block": { "type": "withdraw_token", "mint": "M", "amount": { "abs": "1" },
                                  "to": ["So11111111111111111111111111111111111111112"], "exec": "max" } },
            { "id": 1, "block": { "type": "chat", "mint": "M", "text": "gm" } },
        ]});
        let (echo, sealed) = split_sealed(&plan);
        assert_eq!(echo["steps"][0]["block"]["to"], json!(["So11…1112"]));
        assert_eq!(echo["steps"][1]["block"]["text"], "");
        assert_eq!(sealed.len(), 2);
        assert_eq!(sealed[1].1["text"], "gm");
    }
}

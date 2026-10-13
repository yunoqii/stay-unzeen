//! Plan validation (API.md v0.19 "Сценарии", spec §1–§2, §4.1). Pure: no I/O, no clock; the
//! caller passes `now` and the server facts in [`Ctx`]. Same rules as the web client, checked
//! by both against `core/testdata/scenario-vectors.json` (every invalid vector has exactly one
//! error, so the order in which checks run is not part of the contract).
//!
//! Error classes:
//! - `scenario_invalid` (400) — structure, references, ranges;
//! - `scenario_rule` (422) — privacy rules P1 `now_not_first`, P2 `withdraw_too_soon`,
//!   P8 `unpriced_mint` (P3–P7, P9 are server floors, not rejections);
//! - `bad_request` (400, code `feature_disabled`) — P10: a block of a disabled feature
//!   (`fl_*` without fair-launch, `chat` without chat, `maxSniperPct`/`maxDevPct` without full
//!   trades), answered exactly like an unknown op so a disabled feature leaks nothing.

use std::collections::HashSet;

use serde_json::{Map, Value};

pub const MAX_STEPS: usize = 12;
pub const MAX_RUNS: u32 = 40;
pub const MAX_ACTIVE_PER_KEY: u32 = 3;
pub const TTL_MIN_SECS: u64 = 3_600;
/// 72 h; plans without `withdraw_*` steps may live 7 days (owner decision 13.10).
pub const TTL_MAX_SECS: u64 = 259_200;
pub const TTL_MAX_NO_WITHDRAW_SECS: u64 = 604_800;
pub const TTL_DEFAULT_SECS: u64 = 86_400;
pub const WAIT_MIN_SECS: u64 = 30;
pub const DCA_MIN_EVERY_SECS: u64 = 600;
/// P2: a token withdrawal needs a wait of at least this between it and a trade of the mint.
pub const WITHDRAW_AFTER_TRADE_SECS: u64 = 3_600;
/// v0.18 token amount limit (< 1e38).
const AMOUNT_MAX_DIGITS: usize = 38;

/// Server facts the validator needs (all public or the server's own config).
#[derive(Clone, Debug, Default)]
pub struct Ctx {
    /// Unix ms at validation (`time_at` bounds).
    pub now_ms: u64,
    pub min_deposit_zat: u64,
    /// `PoolInfo.minActionZat` (DCA slices).
    pub min_action_zat: u64,
    /// Enabled venues (`PoolInfo.venues[].venue`).
    pub venues: Vec<String>,
    pub fair_launch: bool,
    pub chat: bool,
    pub full_trades: bool,
    /// Mints with an indexer price tick (`intel_prices`): P8.
    pub priced_mints: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// 400 `scenario_invalid`
    Invalid,
    /// 422 `scenario_rule`
    Rule,
    /// 400 `bad_request` (`feature_disabled`)
    BadRequest,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Invalid => "scenario_invalid",
            Kind::Rule => "scenario_rule",
            Kind::BadRequest => "bad_request",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationError {
    pub kind: Kind,
    /// Step index (= step id); `None` for plan-level errors.
    pub step: Option<usize>,
    pub code: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub steps: usize,
    /// Executions counting `repeat`, `dca` slices and `swap` legs (≤ 40).
    pub runs: u32,
    pub ttl_secs: u64,
    pub manual_start: bool,
    pub has_withdraw: bool,
}

pub type Outcome = Result<Summary, ValidationError>;

fn inv(step: Option<usize>, code: &'static str) -> ValidationError {
    ValidationError {
        kind: Kind::Invalid,
        step,
        code,
    }
}

fn rule(step: usize, code: &'static str) -> ValidationError {
    ValidationError {
        kind: Kind::Rule,
        step: Some(step),
        code,
    }
}

fn disabled(step: usize) -> ValidationError {
    ValidationError {
        kind: Kind::BadRequest,
        step: Some(step),
        code: "feature_disabled",
    }
}

const BLOCKS: &[&str] = &[
    "manual_start",
    "time_at",
    "price_cross",
    "deposit_received",
    "own_result",
    "curve_progress",
    "wait_fixed",
    "wait_random",
    "buy",
    "sell",
    "sell_all",
    "swap",
    "dca",
    "order_place",
    "order_cancel",
    "create",
    "fl_create",
    "fl_bid",
    "fl_cancel",
    "claim",
    "withdraw_token",
    "withdraw_zec",
    "check_safety",
    "repeat",
    "end",
    "chat",
];

/// Blocks enabled for `PoolInfo.scenarios.blocks`.
pub fn enabled_blocks(fair_launch: bool, chat: bool) -> Vec<&'static str> {
    BLOCKS
        .iter()
        .copied()
        .filter(|b| (fair_launch || !b.starts_with("fl_")) && (chat || *b != "chat"))
        .collect()
}

/// A mint as the plan names it: a literal base58 mint or "the mint of step k".
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum MintR {
    Lit(String),
    Step(usize),
}

/// What a step produces for later `{of: {step}}` / `{step}` references.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Out {
    None,
    Zat,
    Tokens,
}

fn out_of(ty: &str) -> Out {
    match ty {
        "deposit_received" | "sell" | "sell_all" | "claim" => Out::Zat,
        "buy" | "create" | "swap" => Out::Tokens,
        _ => Out::None,
    }
}

fn produces_mint(ty: &str) -> bool {
    matches!(ty, "create" | "swap")
}

/// Per-step facts for the plan-level rules.
#[derive(Clone, Debug, Default)]
struct Facts {
    exec_now: bool,
    /// Trade touching this mint (buy/sell/sell_all/swap legs/dca/create's own mint).
    traded: Vec<MintR>,
    withdraw_mint: Option<MintR>,
    /// Guaranteed minimum wait of a wait step (s).
    wait_min: u64,
    runs: u32,
    repeat: Option<(usize, u32)>,
    /// Mints that need a price tick (P8); resolved through swaps before the check.
    need_tick: Vec<MintR>,
    /// `swap`: its `to` (what `{step: k}` of this swap names).
    swap_to: Option<MintR>,
    /// Successors besides the next step: `onFail`/`onFalse` gotos, `repeat` jumps back.
    jumps: Vec<usize>,
    /// `end`: no successor.
    terminal: bool,
}

struct P<'a> {
    ctx: &'a Ctx,
    i: usize,
    types: &'a [String],
    ttl: u64,
}

impl P<'_> {
    fn e(&self, code: &'static str) -> ValidationError {
        inv(Some(self.i), code)
    }

    fn fields(&self, o: &Map<String, Value>, required: &[&str], optional: &[&str]) -> Result<(), ValidationError> {
        for k in o.keys() {
            if k != "type" && !required.contains(&k.as_str()) && !optional.contains(&k.as_str()) {
                return Err(self.e("bad_field"));
            }
        }
        if required.iter().any(|k| !o.contains_key(*k)) {
            return Err(self.e("bad_field"));
        }
        Ok(())
    }

    fn uint(&self, v: Option<&Value>, lo: u64, hi: u64) -> Result<u64, ValidationError> {
        match v.and_then(Value::as_u64) {
            Some(x) if (lo..=hi).contains(&x) => Ok(x),
            _ => Err(self.e("bad_range")),
        }
    }

    fn opt_timeout(&self, o: &Map<String, Value>) -> Result<(), ValidationError> {
        match o.get("timeoutSecs") {
            None => Ok(()),
            v => self.uint(v, WAIT_MIN_SECS, self.ttl).map(|_| ()),
        }
    }

    /// Earlier step reference `{step: k}` (k < i).
    fn step_ref(&self, v: &Value) -> Result<usize, ValidationError> {
        let o = v.as_object().filter(|o| o.len() == 1).ok_or(self.e("bad_ref"))?;
        let k = o.get("step").and_then(Value::as_u64).ok_or(self.e("bad_ref"))? as usize;
        if k >= self.i {
            return Err(self.e("bad_ref"));
        }
        Ok(k)
    }

    fn mint(&self, v: Option<&Value>) -> Result<MintR, ValidationError> {
        match v {
            Some(Value::String(s)) => {
                if is_b58_32(s) {
                    Ok(MintR::Lit(s.clone()))
                } else {
                    Err(self.e("bad_mint"))
                }
            }
            Some(o @ Value::Object(_)) => {
                let k = self.step_ref(o)?;
                if produces_mint(&self.types[k]) {
                    Ok(MintR::Step(k))
                } else {
                    Err(self.e("bad_ref"))
                }
            }
            _ => Err(self.e("bad_mint")),
        }
    }

    /// `AmountSpec` of `want` units (zat or tokens).
    fn amount(&self, v: Option<&Value>, want: Out) -> Result<(), ValidationError> {
        let o = v.and_then(Value::as_object).ok_or(self.e("bad_amount"))?;
        if let Some(a) = o.get("abs") {
            let ok = o.len() == 1
                && a.as_str().is_some_and(|s| {
                    let max = if want == Out::Zat { 18 } else { AMOUNT_MAX_DIGITS };
                    canonical_positive(s, max)
                        && (want != Out::Zat || s.parse::<u64>().is_ok_and(|z| z <= i64::MAX as u64))
                });
            return if ok { Ok(()) } else { Err(self.e("bad_amount")) };
        }
        if o.len() != 2 || !o.contains_key("pct") || !o.contains_key("of") {
            return Err(self.e("bad_amount"));
        }
        if !o
            .get("pct")
            .and_then(Value::as_u64)
            .is_some_and(|p| (1..=100).contains(&p))
        {
            return Err(self.e("bad_amount"));
        }
        match o.get("of") {
            Some(Value::String(s)) if s == "balance" => Ok(()),
            Some(r @ Value::Object(_)) => {
                let k = self.step_ref(r)?;
                if out_of(&self.types[k]) == want {
                    Ok(())
                } else {
                    Err(self.e("bad_ref"))
                }
            }
            _ => Err(self.e("bad_amount")),
        }
    }

    fn guard(&self, v: Option<&Value>, mint: &MintR, f: &mut Facts) -> Result<(), ValidationError> {
        let o = v
            .and_then(Value::as_object)
            .filter(|o| o.len() == 1)
            .ok_or(self.e("bad_guard"))?;
        if let Some(s) = o.get("slippageBps") {
            if !s.as_u64().is_some_and(|b| (50..=5_000).contains(&b)) {
                return Err(self.e("bad_guard"));
            }
            f.need_tick.push(mint.clone());
            return Ok(());
        }
        match o.get("limitPrice").and_then(Value::as_str) {
            Some(p) if is_decimal_positive(p) => Ok(()),
            _ => Err(self.e("bad_guard")),
        }
    }

    fn exec(&self, v: Option<&Value>, allow_now: bool, f: &mut Facts) -> Result<(), ValidationError> {
        match v.and_then(Value::as_str) {
            Some("delayed" | "max") => Ok(()),
            Some("now") if allow_now => {
                f.exec_now = true;
                Ok(())
            }
            _ => Err(self.e("bad_exec")),
        }
    }

    fn venue(&self, v: Option<&Value>) -> Result<(), ValidationError> {
        match v.and_then(Value::as_str) {
            Some(x) if self.ctx.venues.iter().any(|e| e == x) => Ok(()),
            _ => Err(self.e("bad_venue")),
        }
    }

    fn hex16(&self, v: Option<&Value>) -> Result<(), ValidationError> {
        match v.and_then(Value::as_str) {
            Some(s) if s.len() == 32 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) => Ok(()),
            _ => Err(self.e("bad_ref")),
        }
    }

    fn goto(&self, v: &Value, n: usize) -> Result<(), ValidationError> {
        match v.get("goto").and_then(Value::as_u64) {
            Some(g) if v.as_object().is_some_and(|o| o.len() == 1) && (g as usize) > self.i && (g as usize) < n => {
                Ok(())
            }
            _ => Err(self.e("bad_goto")),
        }
    }

    fn on_fail(&self, v: Option<&Value>, n: usize) -> Result<(), ValidationError> {
        let Some(v) = v else { return Ok(()) };
        match v {
            Value::String(s) if s == "stop" || s == "skip" => Ok(()),
            Value::Object(o) if o.contains_key("goto") => self.goto(v, n),
            Value::Object(o) if o.contains_key("retry") => {
                if o.len() != 2
                    || !o
                        .get("retry")
                        .and_then(Value::as_u64)
                        .is_some_and(|r| (1..=3).contains(&r))
                {
                    return Err(self.e("bad_on_fail"));
                }
                match o.get("then") {
                    Some(Value::String(s)) if s == "stop" || s == "skip" => Ok(()),
                    Some(g @ Value::Object(_)) => self.goto(g, n),
                    _ => Err(self.e("bad_on_fail")),
                }
            }
            _ => Err(self.e("bad_on_fail")),
        }
    }

    fn block(&self, b: &Map<String, Value>, n: usize) -> Result<Facts, ValidationError> {
        let mut f = Facts {
            runs: 1,
            ..Facts::default()
        };
        let ty = self.types[self.i].as_str();
        let i = self.i;
        match ty {
            "manual_start" | "end" => {
                self.fields(b, &[], &[])?;
                f.runs = 0;
                if ty == "manual_start" && i != 0 {
                    return Err(self.e("manual_start_not_first"));
                }
            }
            "time_at" => {
                self.fields(b, &["at"], &[])?;
                let at = b.get("at").and_then(Value::as_u64).ok_or(self.e("bad_range"))?;
                let ok = at % 60_000 == 0 && at >= self.ctx.now_ms + 60_000 && at <= self.ctx.now_ms + self.ttl * 1_000;
                if !ok {
                    return Err(self.e("bad_range"));
                }
                f.runs = 0;
            }
            "price_cross" => {
                self.fields(b, &["mint", "op", "priceSol"], &["timeoutSecs"])?;
                let m = self.mint(b.get("mint"))?;
                if !matches!(b.get("op").and_then(Value::as_str), Some("gte" | "lte")) {
                    return Err(self.e("bad_field"));
                }
                if !b
                    .get("priceSol")
                    .and_then(Value::as_str)
                    .is_some_and(is_decimal_positive)
                {
                    return Err(self.e("bad_range"));
                }
                self.opt_timeout(b)?;
                f.need_tick.push(m);
                f.runs = 0;
            }
            "deposit_received" => {
                self.fields(b, &["minZat"], &["timeoutSecs"])?;
                let ok = b
                    .get("minZat")
                    .and_then(Value::as_str)
                    .filter(|s| canonical_positive(s, 18))
                    .and_then(|s| s.parse::<u64>().ok())
                    .is_some_and(|z| z >= self.ctx.min_deposit_zat && z <= i64::MAX as u64);
                if !ok {
                    return Err(self.e("bad_amount"));
                }
                self.opt_timeout(b)?;
                f.runs = 0;
            }
            "own_result" => {
                self.fields(b, &["ref", "on"], &["timeoutSecs"])?;
                let r = b
                    .get("ref")
                    .and_then(Value::as_object)
                    .filter(|o| o.len() == 1)
                    .ok_or(self.e("bad_ref"))?;
                if r.contains_key("step") {
                    let k = self.step_ref(b.get("ref").expect("checked"))?;
                    if self.types[k] != "order_place" {
                        return Err(self.e("bad_ref"));
                    }
                } else if r.contains_key("orderId") {
                    self.hex16(r.get("orderId"))?;
                } else {
                    self.hex16(r.get("actionId"))?;
                }
                if !matches!(b.get("on").and_then(Value::as_str), Some("filled" | "failed" | "any")) {
                    return Err(self.e("bad_field"));
                }
                self.opt_timeout(b)?;
                f.runs = 0;
            }
            "curve_progress" => {
                self.fields(b, &["mint"], &["gtePct", "graduated", "timeoutSecs"])?;
                let m = self.mint(b.get("mint"))?;
                match (b.get("gtePct"), b.get("graduated")) {
                    (Some(p), None) => {
                        self.uint(Some(p), 1, 100)?;
                    }
                    (None, Some(Value::Bool(true))) => {}
                    _ => return Err(self.e("bad_field")),
                }
                self.opt_timeout(b)?;
                f.need_tick.push(m);
                f.runs = 0;
            }
            "wait_fixed" => {
                self.fields(b, &["secs"], &[])?;
                let s = self.uint(b.get("secs"), WAIT_MIN_SECS, self.ttl)?;
                // P7 jitter: ± max(30 s, 10 %) — the guaranteed minimum is below `secs`.
                f.wait_min = s.saturating_sub((s / 10).max(30));
                f.runs = 0;
            }
            "wait_random" => {
                self.fields(b, &["minSecs", "maxSecs"], &[])?;
                let lo = self.uint(b.get("minSecs"), WAIT_MIN_SECS, self.ttl)?;
                let hi = self.uint(b.get("maxSecs"), WAIT_MIN_SECS, self.ttl)?;
                if lo >= hi {
                    return Err(self.e("bad_range"));
                }
                f.wait_min = lo;
                f.runs = 0;
            }
            "buy" | "sell" | "sell_all" => {
                let req: &[&str] = match ty {
                    "buy" => &["venue", "mint", "zec", "guard", "exec"],
                    "sell" => &["venue", "mint", "amount", "guard", "exec"],
                    _ => &["venue", "mint", "guard", "exec"],
                };
                self.fields(b, req, &[])?;
                self.venue(b.get("venue"))?;
                let m = self.mint(b.get("mint"))?;
                match ty {
                    "buy" => self.amount(b.get("zec"), Out::Zat)?,
                    "sell" => self.amount(b.get("amount"), Out::Tokens)?,
                    _ => {}
                }
                self.guard(b.get("guard"), &m, &mut f)?;
                self.exec(b.get("exec"), true, &mut f)?;
                f.traded.push(m);
            }
            "swap" => {
                self.fields(
                    b,
                    &["from", "to", "amount", "guardSell", "guardBuy", "exec"],
                    &["venueSell", "venueBuy"],
                )?;
                let from = self.mint(b.get("from"))?;
                let to = self.mint(b.get("to"))?;
                if from == to {
                    return Err(self.e("same_mint"));
                }
                for k in ["venueSell", "venueBuy"] {
                    if b.contains_key(k) {
                        self.venue(b.get(k))?;
                    }
                }
                self.amount(b.get("amount"), Out::Tokens)?;
                self.guard(b.get("guardSell"), &from, &mut f)?;
                self.guard(b.get("guardBuy"), &to, &mut f)?;
                self.exec(b.get("exec"), false, &mut f)?;
                f.traded.extend([from, to.clone(), MintR::Step(i)]);
                f.swap_to = Some(to);
                f.runs = 2;
            }
            "dca" => {
                self.fields(
                    b,
                    &["side", "venue", "mint", "total", "slices", "everySecs", "guard", "exec"],
                    &[],
                )?;
                let side = b.get("side").and_then(Value::as_str);
                let want = match side {
                    Some("buy") => Out::Zat,
                    Some("sell") => Out::Tokens,
                    _ => return Err(self.e("bad_field")),
                };
                self.venue(b.get("venue"))?;
                let m = self.mint(b.get("mint"))?;
                self.amount(b.get("total"), want)?;
                let slices = self.uint(b.get("slices"), 2, 12)?;
                // An `abs` ZEC total must give every slice (±20 % weights) the minimum action.
                if want == Out::Zat
                    && let Some(t) = b["total"]["abs"].as_str().and_then(|s| s.parse::<u64>().ok())
                    && t / slices * 8 / 10 < self.ctx.min_action_zat
                {
                    return Err(self.e("bad_amount"));
                }
                let ev = b
                    .get("everySecs")
                    .and_then(Value::as_object)
                    .ok_or(self.e("bad_range"))?;
                if ev.len() != 2 {
                    return Err(self.e("bad_range"));
                }
                let lo = self.uint(ev.get("min"), DCA_MIN_EVERY_SECS, self.ttl)?;
                let hi = self.uint(ev.get("max"), DCA_MIN_EVERY_SECS, self.ttl)?;
                if lo > hi || slices.saturating_mul(hi) > self.ttl {
                    return Err(self.e("bad_range"));
                }
                self.guard(b.get("guard"), &m, &mut f)?;
                self.exec(b.get("exec"), false, &mut f)?;
                f.traded.push(m);
                f.runs = slices as u32;
            }
            "order_place" => {
                self.fields(b, &["order"], &[])?;
                let o = b.get("order").and_then(Value::as_object).ok_or(self.e("bad_field"))?;
                if o.contains_key("op") {
                    return Err(self.e("bad_field"));
                }
                let kind = o.get("kind").and_then(Value::as_str);
                let want = match kind {
                    Some("limit_buy") => Out::Zat,
                    Some("limit_sell" | "take_profit" | "stop_loss" | "bracket") => Out::Tokens,
                    _ => return Err(self.e("bad_field")),
                };
                // P2: a fired order is a public trade of the mint (any kind).
                let m = self.mint(o.get("mint"))?;
                self.amount(o.get("amount"), want)?;
                f.traded.push(m);
                // Prices, slippage, TTL: the ordinary order_create rules at execution (v0.8/v0.15).
            }
            "order_cancel" => {
                self.fields(b, &["ref"], &[])?;
                let r = b
                    .get("ref")
                    .and_then(Value::as_object)
                    .filter(|o| o.len() == 1)
                    .ok_or(self.e("bad_ref"))?;
                if r.contains_key("step") {
                    let k = self.step_ref(b.get("ref").expect("checked"))?;
                    if self.types[k] != "order_place" {
                        return Err(self.e("bad_ref"));
                    }
                } else {
                    self.hex16(r.get("orderId"))?;
                }
            }
            "create" => {
                self.fields(b, &["create"], &[])?;
                let c = b.get("create").and_then(Value::as_object).ok_or(self.e("bad_field"))?;
                for k in c.keys() {
                    if !["venue", "meta", "initialBuyZec", "quote", "platform", "exec"].contains(&k.as_str()) {
                        return Err(self.e("bad_field"));
                    }
                }
                self.venue(c.get("venue"))?;
                if c.get("venue").and_then(Value::as_str) == Some("jupiter") {
                    return Err(self.e("bad_venue"));
                }
                let meta: Option<crate::actions::Meta> =
                    c.get("meta").and_then(|m| serde_json::from_value(m.clone()).ok());
                if meta.is_none_or(|m| crate::actions::check_meta(&m).is_err()) {
                    return Err(self.e("bad_meta"));
                }
                if c.contains_key("initialBuyZec") {
                    self.amount(c.get("initialBuyZec"), Out::Zat)?;
                }
                if c.contains_key("exec") {
                    self.exec(c.get("exec"), true, &mut f)?;
                }
                f.traded.push(MintR::Step(i));
            }
            "fl_create" => {
                self.fields(b, &["launch"], &[])?;
                if !b.get("launch").is_some_and(Value::is_object) {
                    return Err(self.e("bad_field"));
                }
            }
            "fl_bid" => {
                self.fields(b, &["launchId", "holdZat", "ciphertext"], &[])?;
                self.hex16(b.get("launchId"))?;
                if !b
                    .get("holdZat")
                    .and_then(Value::as_str)
                    .is_some_and(|s| canonical_positive(s, 18))
                {
                    return Err(self.e("bad_amount"));
                }
                if b.get("ciphertext").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
                    return Err(self.e("bad_field"));
                }
            }
            "fl_cancel" => {
                self.fields(b, &["launchId"], &[])?;
                self.hex16(b.get("launchId"))?;
            }
            "claim" => {
                self.fields(b, &[], &["mint"])?;
                if b.contains_key("mint") {
                    self.mint(b.get("mint"))?;
                }
            }
            "withdraw_token" => {
                self.fields(b, &["mint", "amount", "to", "exec"], &["smart"])?;
                let m = self.mint(b.get("mint"))?;
                self.amount(b.get("amount"), Out::Tokens)?;
                let to: Vec<&str> = match b.get("to") {
                    Some(Value::String(s)) => vec![s.as_str()],
                    Some(Value::Array(a)) => a.iter().map(|x| x.as_str().unwrap_or("")).collect(),
                    _ => return Err(self.e("bad_address")),
                };
                let parts = match b.get("smart") {
                    None => 1,
                    Some(s) => {
                        let o = s.as_object().filter(|o| o.len() == 2).ok_or(self.e("bad_range"))?;
                        self.uint(o.get("maxDelayMin"), 1, 1_440)?;
                        self.uint(o.get("parts"), 2, 5)? as usize
                    }
                };
                let distinct: HashSet<&str> = to.iter().copied().collect();
                if to.len() != parts || distinct.len() != to.len() || !to.iter().all(|a| is_b58_32(a)) {
                    return Err(self.e("bad_address"));
                }
                self.exec(b.get("exec"), false, &mut f)?;
                f.withdraw_mint = Some(m);
            }
            "withdraw_zec" => {
                self.fields(b, &["to", "amount", "exec"], &[])?;
                // Network and Orchard receiver are checked by the server (`check_ua`).
                if !b
                    .get("to")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.starts_with('u') && s.len() >= 10)
                {
                    return Err(self.e("bad_address"));
                }
                self.amount(b.get("amount"), Out::Zat)?;
                self.exec(b.get("exec"), false, &mut f)?;
            }
            "check_safety" => {
                self.fields(b, &["mint", "require", "onFalse"], &[])?;
                self.mint(b.get("mint"))?;
                let r = b.get("require").and_then(Value::as_object).ok_or(self.e("bad_field"))?;
                if r.is_empty() {
                    return Err(self.e("bad_field"));
                }
                for (k, v) in r {
                    match k.as_str() {
                        "authoritiesRevoked" | "noRiskyExtensions" if v.as_bool() == Some(true) => {}
                        "maxTop10Pct" | "minLpBurnedPct" => {
                            self.uint(Some(v), 0, 100)?;
                        }
                        "maxSniperPct" | "maxDevPct" => {
                            self.uint(Some(v), 0, 100)?;
                            if !self.ctx.full_trades {
                                return Err(disabled(i));
                            }
                        }
                        _ => return Err(self.e("bad_field")),
                    }
                }
                match b.get("onFalse") {
                    Some(Value::String(s)) if s == "stop" => {}
                    Some(g @ Value::Object(_)) => {
                        self.goto(g, n)?;
                        f.jumps.push(g["goto"].as_u64().unwrap_or(0) as usize);
                    }
                    _ => return Err(self.e("bad_on_fail")),
                }
                f.runs = 0;
            }
            "repeat" => {
                self.fields(b, &["from", "times"], &[])?;
                let from = b.get("from").and_then(Value::as_u64).ok_or(self.e("bad_repeat"))? as usize;
                let times = b.get("times").and_then(Value::as_u64).ok_or(self.e("bad_repeat"))?;
                if from >= i || !(2..=10).contains(&times) {
                    return Err(self.e("bad_repeat"));
                }
                let forbidden = ["manual_start", "deposit_received", "create", "repeat"];
                if self.types[from..i]
                    .iter()
                    .any(|t| forbidden.contains(&t.as_str()) || t.starts_with("fl_"))
                {
                    return Err(self.e("bad_repeat"));
                }
                f.repeat = Some((from, times as u32));
                f.runs = 0;
            }
            "chat" => {
                self.fields(b, &["mint", "text"], &["showCreatorBadge"])?;
                self.mint(b.get("mint"))?;
                if b.get("text")
                    .and_then(Value::as_str)
                    .is_none_or(|t| unzeen_protocol::chat::check_text(t).is_err())
                {
                    return Err(self.e("bad_text"));
                }
                if b.get("showCreatorBadge").is_some_and(|v| !v.is_boolean()) {
                    return Err(self.e("bad_field"));
                }
            }
            _ => return Err(self.e("unknown_block")),
        }
        Ok(f)
    }
}

/// Validate `plan` (`ScenarioPlan`). `Ok` carries what the server needs to store it.
pub fn validate(plan: &Value, ctx: &Ctx) -> Outcome {
    let p = plan.as_object().ok_or(inv(None, "bad_field"))?;
    if p.keys().any(|k| !["v", "ttlSecs", "steps"].contains(&k.as_str())) {
        return Err(inv(None, "bad_field"));
    }
    if p.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(inv(None, "bad_version"));
    }
    let steps = p.get("steps").and_then(Value::as_array).ok_or(inv(None, "bad_field"))?;
    if steps.is_empty() {
        return Err(inv(None, "empty"));
    }
    if steps.len() > MAX_STEPS {
        return Err(inv(None, "too_many_steps"));
    }
    let n = steps.len();

    // Pass 1: shape, ids, block types, feature flags.
    let mut types: Vec<String> = Vec::with_capacity(n);
    for (i, s) in steps.iter().enumerate() {
        let o = s.as_object().ok_or(inv(Some(i), "bad_field"))?;
        if o.keys().any(|k| !["id", "block", "onFail"].contains(&k.as_str())) {
            return Err(inv(Some(i), "bad_field"));
        }
        if o.get("id").and_then(Value::as_u64) != Some(i as u64) {
            return Err(inv(Some(i), "bad_step_id"));
        }
        let ty = o
            .get("block")
            .and_then(|b| b.get("type"))
            .and_then(Value::as_str)
            .ok_or(inv(Some(i), "unknown_block"))?;
        if !BLOCKS.contains(&ty) {
            return Err(inv(Some(i), "unknown_block"));
        }
        if (ty.starts_with("fl_") && !ctx.fair_launch) || (ty == "chat" && !ctx.chat) {
            return Err(disabled(i));
        }
        types.push(ty.to_string());
    }
    let has_withdraw = types.iter().any(|t| t.starts_with("withdraw_"));
    let ttl_max = if has_withdraw {
        TTL_MAX_SECS
    } else {
        TTL_MAX_NO_WITHDRAW_SECS
    };
    let ttl = match p.get("ttlSecs") {
        None => TTL_DEFAULT_SECS,
        Some(v) => v
            .as_u64()
            .filter(|t| (TTL_MIN_SECS..=ttl_max).contains(t))
            .ok_or(inv(None, "bad_ttl"))?,
    };
    if types.iter().filter(|t| *t == "deposit_received").count() > 1 {
        let i = types.iter().rposition(|t| t == "deposit_received").expect("counted");
        return Err(inv(Some(i), "deposit_twice"));
    }

    // Pass 2: every block.
    let mut facts: Vec<Facts> = Vec::with_capacity(n);
    for (i, s) in steps.iter().enumerate() {
        let pp = P {
            ctx,
            i,
            types: &types,
            ttl,
        };
        let b = s["block"].as_object().ok_or(inv(Some(i), "unknown_block"))?;
        let mut f = pp.block(b, n)?;
        pp.on_fail(s.get("onFail"), n)?;
        // Control edges for P2: onFail goto (also after retries); repeat jumps back; end stops.
        let of = s.get("onFail");
        for g in [
            of.and_then(|x| x.get("goto")),
            of.and_then(|x| x.get("then")).and_then(|x| x.get("goto")),
        ]
        .into_iter()
        .flatten()
        {
            f.jumps.push(g.as_u64().unwrap_or(0) as usize);
        }
        if let Some((from, _)) = f.repeat {
            f.jumps.push(from);
        }
        f.terminal = types[i] == "end";
        facts.push(f);
    }

    // Repeats: non-overlapping ranges, total executions ≤ 40.
    let mut runs: u32 = facts.iter().map(|f| f.runs).sum();
    let mut covered = vec![false; n];
    for (i, f) in facts.iter().enumerate() {
        if let Some((from, times)) = f.repeat {
            if covered[from..i].iter().any(|c| *c) {
                return Err(inv(Some(i), "bad_repeat"));
            }
            covered[from..i].iter_mut().for_each(|c| *c = true);
            let body: u32 = facts[from..i].iter().map(|x| x.runs).sum();
            runs = runs.saturating_add(body.saturating_mul(times - 1));
        }
    }
    if runs > MAX_RUNS {
        return Err(inv(None, "too_many_runs"));
    }

    // P1 (lead decision 13.10): Now only on the first step after `manual_start` (a human
    // click), never after an event, never inside a repeat. A retried Now step runs `delayed`.
    for (i, f) in facts.iter().enumerate() {
        if f.exec_now && !(i == 1 && types[0] == "manual_start" && !covered[i]) {
            return Err(rule(i, "now_not_first"));
        }
    }
    // Mint classes: `{step: swap}` is the swap's `to` (recursively); `{step: create}` stays.
    let resolve = |m: &MintR| -> MintR {
        let mut m = m.clone();
        for _ in 0..MAX_STEPS {
            match &m {
                MintR::Step(k) if facts[*k].swap_to.is_some() => m = facts[*k].swap_to.clone().expect("some"),
                _ => break,
            }
        }
        m
    };
    let traded: Vec<Vec<MintR>> = facts.iter().map(|f| f.traded.iter().map(&resolve).collect()).collect();
    // P2: on EVERY path of the step graph (next, onFail/onFalse gotos, repeat back-jumps)
    // from a trade of M to a withdrawal of M, the guaranteed waits sum to ≥ 1 h.
    for (w, f) in facts.iter().enumerate() {
        let Some(m) = f.withdraw_mint.as_ref().map(&resolve) else {
            continue;
        };
        for (src, t) in traded.iter().enumerate() {
            if src == w || !t.contains(&m) {
                continue;
            }
            if min_wait_between(&facts, src, w).is_some_and(|d| d < WITHDRAW_AFTER_TRADE_SECS) {
                return Err(rule(w, "withdraw_too_soon"));
            }
        }
    }
    // P8: price-dependent blocks only on mints with a pool price tick; a mint created by the
    // plan is allowed, a `{step: swap}` must have a tick on its `to`.
    for (i, f) in facts.iter().enumerate() {
        let bad = f.need_tick.iter().map(&resolve).any(|m| match m {
            MintR::Lit(m) => !ctx.priced_mints.contains(&m),
            MintR::Step(_) => false,
        });
        if bad {
            return Err(rule(i, "unpriced_mint"));
        }
    }

    Ok(Summary {
        steps: n,
        runs,
        ttl_secs: ttl,
        manual_start: types[0] == "manual_start",
        has_withdraw,
    })
}

/// Smallest guaranteed wait (sum of `wait_min` of the steps strictly between) over all paths
/// `from → to` of the step graph; `None` if `to` is unreachable. Node-weighted Dijkstra (≤ 12
/// nodes, cycles from `repeat` are fine: weights are non-negative).
fn min_wait_between(facts: &[Facts], from: usize, to: usize) -> Option<u64> {
    let n = facts.len();
    // Every step may fail; `onFail: "skip"` / `{retry, then: "skip"}` lands on i + 1 like success.
    let succ = |i: usize| -> Vec<usize> {
        let mut s = facts[i].jumps.clone();
        if !facts[i].terminal && i + 1 < n {
            s.push(i + 1);
        }
        s
    };
    let mut dist = vec![u64::MAX; n];
    let mut done = vec![false; n];
    for s in succ(from) {
        dist[s] = 0;
    }
    loop {
        let u = (0..n)
            .filter(|i| !done[*i] && dist[*i] < u64::MAX)
            .min_by_key(|i| dist[*i])?;
        if u == to {
            return Some(dist[u]);
        }
        done[u] = true;
        // The wait of `u` counts only on its normal exit; a failure jump (onFail / onFalse goto)
        // or a repeat jump may leave without it.
        let through = dist[u].saturating_add(facts[u].wait_min);
        for v in succ(u) {
            let d = if facts[u].jumps.contains(&v) { dist[u] } else { through };
            if d < dist[v] {
                dist[v] = d;
            }
        }
    }
}

fn is_b58_32(s: &str) -> bool {
    unzeen_protocol::pubkey_from_b58(s).is_some_and(|b| unzeen_protocol::pubkey_to_b58(&b) == s)
}

fn canonical_positive(s: &str, max_digits: usize) -> bool {
    !s.is_empty() && s.len() <= max_digits && s.bytes().all(|b| b.is_ascii_digit()) && !s.starts_with('0')
}

/// Positive canonical decimal (`"0.0000012"`, `"3"`): ≤ 18 fractional digits, no exponent.
fn is_decimal_positive(s: &str) -> bool {
    let (i, f) = s.split_once('.').unwrap_or((s, ""));
    let digits = |x: &str| x.bytes().all(|b| b.is_ascii_digit());
    !i.is_empty()
        && digits(i)
        && digits(f)
        && f.len() <= 18
        && (i == "0" || !i.starts_with('0'))
        && (!s.contains('.') || !f.is_empty())
        && s.bytes().any(|b| (b'1'..=b'9').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimals() {
        for ok in ["1", "0.5", "0.000000001", "12.25"] {
            assert!(is_decimal_positive(ok), "{ok}");
        }
        for bad in ["0", "0.0", "", ".5", "5.", "01", "1e5", "-1", "1.0000000000000000001"] {
            assert!(!is_decimal_positive(bad), "{bad}");
        }
    }

    #[test]
    fn blocks_follow_flags() {
        assert!(
            !enabled_blocks(false, false)
                .iter()
                .any(|b| b.starts_with("fl_") || *b == "chat")
        );
        assert_eq!(enabled_blocks(true, true).len(), BLOCKS.len());
    }
}

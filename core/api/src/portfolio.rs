//! `GET /api/portfolio` body assembly (API v0.21): a fixed 16 KiB answer for every key.
//!
//! Every list has a count cap; holdings are paged (`?holdingsPage=N`, 20 per page). If the
//! capped lists still do not fit the budget, items are dropped from the end of the least
//! important lists first (the lists are ordered active-first) and counted in `more`. The base
//! fields plus one full holdings page with the longest possible values always fit
//! (`worst_case_base_fits`), so the answer is never larger than [`PORTFOLIO_BYTES`].

use serde_json::{Map, Value, json};

/// Fixed size of `GET /api/portfolio` (API v0.21).
pub const PORTFOLIO_BYTES: usize = 16_384;
/// Holdings per page.
pub const HOLDINGS_PAGE: usize = 20;

/// Count caps of the other lists (the ledger already returns the newest / active-first rows).
pub const CAP_SCENARIOS: usize = 3;
pub const CAP_ORDERS: usize = 8;
pub const CAP_ACTIONS: usize = 8;
pub const CAP_DEPOSITS: usize = 5;
pub const CAP_CLAIMABLE: usize = 5;
pub const CAP_FAIR_BIDS: usize = 3;
pub const CAP_FAIR_LAUNCHES: usize = 3;

/// Trim order when over budget: the first list loses its last item first.
const TRIM_ORDER: [&str; 7] = [
    "deposits",
    "actions",
    "fairLaunches",
    "claimable",
    "orders",
    "fairBids",
    "scenarios",
];

fn cap_of(name: &str) -> usize {
    match name {
        "scenarios" => CAP_SCENARIOS,
        "orders" => CAP_ORDERS,
        "actions" => CAP_ACTIONS,
        "deposits" => CAP_DEPOSITS,
        "claimable" => CAP_CLAIMABLE,
        "fairBids" => CAP_FAIR_BIDS,
        "fairLaunches" => CAP_FAIR_LAUNCHES,
        _ => usize::MAX,
    }
}

/// `holdingsPage` from the query (`None` query → page 0). Other parameters are refused so the
/// signed request-target stays one of a small set.
pub fn holdings_page(query: Option<&str>) -> Result<usize, &'static str> {
    let Some(q) = query.filter(|q| !q.is_empty()) else {
        return Ok(0);
    };
    let v = q.strip_prefix("holdingsPage=").ok_or("unknown query parameter")?;
    if v.is_empty() || v.len() > 4 || !v.bytes().all(|b| b.is_ascii_digit()) {
        return Err("holdingsPage must be a number");
    }
    v.parse().map_err(|_| "holdingsPage must be a number")
}

/// Build the body: `base` (scalars), all holdings of the key, the other lists (name, items
/// newest/active-first; absent lists are not emitted). Returns the object without `pad`.
pub fn assemble(
    mut base: Map<String, Value>,
    holdings: Vec<Value>,
    page: usize,
    lists: Vec<(&'static str, Vec<Value>)>,
) -> Value {
    let total = holdings.len();
    let start = page.saturating_mul(HOLDINGS_PAGE).min(total);
    let shown: Vec<Value> = holdings.into_iter().skip(start).take(HOLDINGS_PAGE).collect();
    let after = total - start - shown.len();
    base.insert("holdings".into(), Value::Array(shown));
    base.insert("holdingsPage".into(), json!(page));

    let mut more = Map::new();
    more.insert("holdings".into(), json!(after));
    let mut lists: Vec<(&'static str, Vec<Value>)> = lists
        .into_iter()
        .map(|(n, mut v)| {
            let cap = cap_of(n);
            let cut = v.len().saturating_sub(cap);
            v.truncate(v.len() - cut);
            more.insert(n.into(), json!(cut));
            (n, v)
        })
        .collect();

    let assemble_now = |lists: &[(&'static str, Vec<Value>)], more: &Map<String, Value>| {
        let mut o = base.clone();
        for (n, v) in lists {
            o.insert((*n).into(), Value::Array(v.clone()));
        }
        o.insert("more".into(), Value::Object(more.clone()));
        Value::Object(o)
    };
    let size = |v: &Value| serde_json::to_vec(v).map_or(usize::MAX, |b| b.len());
    // `,"pad":""` adds 9 bytes. Exact recount per dropped item: at most a few dozen items.
    let budget = PORTFOLIO_BYTES - 9;
    'trim: while size(&assemble_now(&lists, &more)) > budget {
        for name in TRIM_ORDER {
            if let Some((_, v)) = lists.iter_mut().find(|(n, v)| *n == name && !v.is_empty()) {
                v.pop();
                let m = more.get(name).and_then(Value::as_u64).unwrap_or(0) + 1;
                more.insert(name.into(), json!(m));
                continue 'trim;
            }
        }
        break;
    }
    assemble_now(&lists, &more)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Map<String, Value> {
        let big = u128::MAX.to_string();
        json!({ "zecBalance": u64::MAX.to_string(), "zecHeld": u64::MAX.to_string(), "frozen": false, "zecPending": big })
            .as_object()
            .unwrap()
            .clone()
    }

    fn holding() -> Value {
        let big = u128::MAX.to_string();
        json!({ "mint": format!("0x{}", "A".repeat(40)), "amount": big, "held": big })
    }

    fn body_len(v: &Value) -> usize {
        serde_json::to_vec(v).unwrap().len() + 9
    }

    #[test]
    fn worst_case_base_fits() {
        let all: Vec<(&'static str, Vec<Value>)> = TRIM_ORDER
            .iter()
            .map(|n| (*n, vec![json!({ "x": "y".repeat(20_000) })]))
            .collect();
        let v = assemble(base(), vec![holding(); 500], 7, all);
        assert!(body_len(&v) <= PORTFOLIO_BYTES, "{}", body_len(&v));
        assert_eq!(v["holdings"].as_array().unwrap().len(), HOLDINGS_PAGE);
        assert_eq!(v["more"]["holdings"], 500 - 8 * HOLDINGS_PAGE);
        for n in TRIM_ORDER {
            assert_eq!(v[n].as_array().unwrap().len(), 0, "{n}");
            assert_eq!(v["more"][n], 1, "{n}");
        }
    }

    #[test]
    fn caps_then_trim_order() {
        let item = |k: usize| json!({ "k": k, "blob": "z".repeat(900) });
        let lists = vec![
            ("scenarios", (0..5).map(item).collect()),
            ("orders", (0..20).map(item).collect()),
            ("actions", (0..20).map(item).collect()),
            ("deposits", (0..20).map(item).collect()),
        ];
        let v = assemble(base(), vec![holding(); 3], 0, lists);
        assert!(body_len(&v) <= PORTFOLIO_BYTES);
        // Caps first.
        assert_eq!(v["scenarios"].as_array().unwrap().len(), 3);
        assert_eq!(v["more"]["scenarios"], 2);
        // Deposits and actions are trimmed before orders and scenarios; newest kept.
        assert_eq!(v["deposits"].as_array().unwrap().len(), 0);
        assert_eq!(v["more"]["deposits"], 20);
        assert_eq!(v["orders"].as_array().unwrap().len(), 8);
        let a = v["actions"].as_array().unwrap();
        assert!(a.len() < 8);
        assert!(a.iter().enumerate().all(|(i, x)| x["k"] == i));
        assert_eq!(v["more"]["actions"], 20 - a.len());
        assert_eq!(v["more"]["holdings"], 0);
    }

    #[test]
    fn query() {
        assert_eq!(holdings_page(None), Ok(0));
        assert_eq!(holdings_page(Some("")), Ok(0));
        assert_eq!(holdings_page(Some("holdingsPage=3")), Ok(3));
        assert!(holdings_page(Some("holdingsPage=")).is_err());
        assert!(holdings_page(Some("holdingsPage=-1")).is_err());
        assert!(holdings_page(Some("holdingsPage=99999")).is_err());
        assert!(holdings_page(Some("x=1")).is_err());
    }
}

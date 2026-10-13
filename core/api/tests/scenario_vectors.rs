//! S1: the scenario validator against `core/testdata/scenario-vectors.json` (shared with the
//! web client's validator). No database.

use std::path::PathBuf;

use serde_json::Value;
use unzeen_api::scenarios::{Ctx, validate};

fn ctx(defaults: &Value, over: Option<&Value>) -> Ctx {
    let get = |k: &str| over.and_then(|o| o.get(k)).unwrap_or(&defaults[k]).clone();
    let strings = |v: Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect()
    };
    Ctx {
        now_ms: get("nowMs").as_u64().unwrap(),
        min_deposit_zat: get("minDepositZat").as_str().unwrap().parse().unwrap(),
        min_action_zat: get("minActionZat").as_str().unwrap().parse().unwrap(),
        venues: strings(get("venues")),
        fair_launch: get("fairLaunch").as_bool().unwrap(),
        chat: get("chat").as_bool().unwrap(),
        full_trades: get("fullTrades").as_bool().unwrap(),
        priced_mints: strings(get("pricedMints")),
        evm: false,
        ref_mints: over
            .and_then(|o| o.get("refMints"))
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[test]
fn scenario_vectors() {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/scenario-vectors.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let got = validate(&c["plan"], &ctx(&v["defaults"], c.get("ctx")));
        let e = &c["expect"];
        if e["ok"].as_bool().unwrap() {
            let s = got.unwrap_or_else(|err| panic!("{name}: expected ok, got {err:?}"));
            assert_eq!(u64::from(s.runs), e["runs"].as_u64().unwrap(), "{name}: runs");
            assert_eq!(s.ttl_secs, e["ttlSecs"].as_u64().unwrap(), "{name}: ttl");
        } else {
            let err = got.err().unwrap_or_else(|| panic!("{name}: expected an error"));
            assert_eq!(
                err.kind.as_str(),
                e["error"].as_str().unwrap(),
                "{name}: kind ({err:?})"
            );
            assert_eq!(err.code, e["code"].as_str().unwrap(), "{name}: code ({err:?})");
            assert_eq!(err.step.map(|s| s as u64), e["step"].as_u64(), "{name}: step ({err:?})");
        }
    }
}

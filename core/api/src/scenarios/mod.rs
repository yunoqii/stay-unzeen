//! Scenarios (API.md v0.19, spec `docs/analysis/scenarios.md`): one signed plan of up to 12
//! blocks executed step by step by core through the ordinary action path.
//!
//! S1 (this module): plan parsing and validation as pure functions ([`validate::validate`]),
//! checked against `core/testdata/scenario-vectors.json` together with the web client.
//! The executor, tables and ops (S2–S7) come next; nothing here touches the database.

pub mod validate;

pub use validate::{Ctx, Outcome, Summary, ValidationError, validate};

//! Scenarios (API.md v0.19, spec `docs/analysis/scenarios.md`): one signed plan of up to 12
//! blocks executed step by step by core through the ordinary action path.
//!
//! - [`validate`]: plan validation, pure (S1), checked against `core/testdata/scenario-vectors.json`
//!   together with the web client;
//! - [`ops`]: `scenario_create` / `start` / `cancel`, sealing (K_scn), Portfolio / PoolInfo blocks;
//! - [`exec`]: the executor loop (S3).

pub mod exec;
pub mod ops;
pub mod validate;

pub use validate::{Ctx, Outcome, Summary, ValidationError, validate};

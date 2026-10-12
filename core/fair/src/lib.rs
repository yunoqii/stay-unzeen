//! Unzeen fair-launch primitives (docs/API.md v0.6, spec docs/analysis/fair-launch.md).
//! Internal until 28.10 23:59 UTC (CLAUDE.md).
//!
//! No I/O here: the API server fetches beacons and talks to Postgres.
//!
//! - [`drand`]: quicknet constants, round <-> time, BLS check of a round signature, tlock
//!   header check and decryption. Decryption needs a [`drand::VerifiedBeacon`], which can only
//!   be obtained by verifying the signature first: a forged beacon can never mark bids invalid.
//! - [`bid`]: the 64-byte sealed-bid plaintext (`UZFL`).
//! - [`merkle`]: commitment tree over sealed bids and inclusion proofs.
//! - [`alloc`]: integer allocation math (pro rata, oversubscription, creator cap, charges).

pub mod alloc;
pub mod bid;
pub mod drand;
pub mod merkle;

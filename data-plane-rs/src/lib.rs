//! Shared Isaac data-plane primitives.
//!
//! The Axum worker and the Tauri desktop application consume this crate so
//! protocol and runtime behaviour do not diverge between deployment targets.

pub mod gateway;
pub mod http;
pub mod protocol;
pub mod state;
pub mod telemetry;

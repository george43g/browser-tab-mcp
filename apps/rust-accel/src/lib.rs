//! Optional Rust acceleration for the browser-tab-mcp starter template.
//!
//! Exposed via napi-rs v3. The TS side calls `tryLoadNative()` which
//! either returns this module (when the `.node` binary was built) or
//! returns null (when missing, when MCP_DISABLE_NATIVE=1, or on
//! unsupported platforms).
//!
//! The starter ships two functions:
//!   - `hello(name)`    plain string round-trip for integration tests
//!   - `noopAccel(input)` mirror of the `noop` MCP tool's hot path
//!
//! Real tools should replace these with their domain's hot work: SQLite
//! readers, blob parsers, regex passes, etc. Keep all type contracts in
//! `types.rs` and mirror them via @george43g/shared-types so the drift-
//! check test keeps the two languages honest.

mod types;

use napi::Error;
use napi_derive::napi;
use std::time::Instant;
use types::{NoopInput, NoopOutput};

/// Plain hello-world for integration tests.
#[napi]
pub fn hello(name: String) -> String {
    format!("hello, {} (from rust)", name)
}

/// Demo Rust path for the `noop` MCP tool. Echoes the input string,
/// optionally upper-cased, and reports the wall-clock duration in
/// microseconds.
#[napi]
pub fn noop_accel(input: NoopInput) -> Result<NoopOutput, Error> {
    let start = Instant::now();
    let echo = if input.upper {
        input.input.to_uppercase()
    } else {
        input.input.clone()
    };
    let elapsed = start.elapsed();
    let duration_micros = u32::try_from(elapsed.as_micros()).unwrap_or(u32::MAX);
    Ok(NoopOutput {
        echo,
        engine: "rust".to_string(),
        duration_micros,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_includes_name_and_rust_marker() {
        let out = hello("world".to_string());
        assert!(out.contains("world"));
        assert!(out.contains("rust"));
    }

    #[test]
    fn noop_accel_passthrough() {
        let r = noop_accel(NoopInput {
            input: "hi".to_string(),
            upper: false,
        })
        .unwrap();
        assert_eq!(r.echo, "hi");
        assert_eq!(r.engine, "rust");
    }

    #[test]
    fn noop_accel_upper() {
        let r = noop_accel(NoopInput {
            input: "hi".to_string(),
            upper: true,
        })
        .unwrap();
        assert_eq!(r.echo, "HI");
    }
}

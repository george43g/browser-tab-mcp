// Hand-mirrored counterparts of the Zod schemas in @george43g/shared-types.
//
// Field names MUST match the camelCase TS forms (we use serde rename rather
// than snake_case so JSON payloads round-trip cleanly between Rust and TS).
//
// The drift-check test at packages/shared-types/tests/drift.test.ts parses
// this file and fails CI if a field declared in MIRRORED_SCHEMAS is missing
// here. Add new fields in this file in the same commit you add them to the
// Zod schema.

use napi_derive::napi;

#[napi(object)]
pub struct NoopInput {
    pub input: String,
    pub upper: bool,
}

#[napi(object)]
pub struct NoopOutput {
    pub echo: String,
    /// Either "ts" or "rust"; the Rust path always returns "rust".
    pub engine: String,
    #[napi(js_name = "durationMicros")]
    pub duration_micros: u32,
}

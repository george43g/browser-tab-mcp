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

/// One on-screen CoreGraphics window. windowId is the CGWindowID — the
/// same id namespace yabai reports, which makes it the join key between
/// browser windows and the window manager. No titles are read (that would
/// require the Screen Recording TCC permission).
#[napi(object)]
pub struct CgWindowInfo {
    #[napi(js_name = "windowId")]
    pub window_id: u32,
    #[napi(js_name = "ownerPid")]
    pub owner_pid: i32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub layer: i32,
}

/// One active display. x/y are the display's global-screen origin (points,
/// top-left), so `display` targets in open_window/set_window translate into
/// global bounds. No TCC permission required (CGDisplayBounds is public).
#[napi(object)]
pub struct DisplayInfo {
    #[napi(js_name = "displayId")]
    pub display_id: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[napi(js_name = "isMain")]
    pub is_main: bool,
}

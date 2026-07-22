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
use types::{CgWindowInfo, DisplayInfo, NoopInput, NoopOutput};

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

/// Enumerate on-screen CoreGraphics windows: CGWindowID, owner pid,
/// bounds, layer. CGWindowIDs are the same namespace yabai window ids
/// live in, so this is the correlation source for `cgWindowId`.
///
/// Deliberately does NOT read kCGWindowName — window titles require the
/// Screen Recording TCC permission; ids/pids/bounds do not.
#[napi]
pub fn list_cg_windows() -> Vec<CgWindowInfo> {
    list_cg_windows_impl()
}

#[cfg(target_os = "macos")]
fn list_cg_windows_impl() -> Vec<CgWindowInfo> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionAll,
        CGWindowListCopyWindowInfo,
    };

    // kCGWindowListOptionAll (not OnScreenOnly): browser windows living on
    // other Spaces/displays must still correlate — OnScreenOnly hides them.
    let raw = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
    };
    if raw.is_null() {
        return Vec::new();
    }
    let entries: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_create_rule(raw) };

    // The CGWindow dictionary keys are CFStrings whose contents equal the
    // constant names ("kCGWindowNumber", ...) — documented, stable API.
    let key_number = CFString::from_static_string("kCGWindowNumber");
    let key_pid = CFString::from_static_string("kCGWindowOwnerPID");
    let key_layer = CFString::from_static_string("kCGWindowLayer");
    let key_bounds = CFString::from_static_string("kCGWindowBounds");
    let key_x = CFString::from_static_string("X");
    let key_y = CFString::from_static_string("Y");
    let key_w = CFString::from_static_string("Width");
    let key_h = CFString::from_static_string("Height");

    let num = |dict: &CFDictionary<CFString, CFType>, key: &CFString| -> Option<f64> {
        dict.find(key)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_f64())
    };

    let mut out = Vec::new();
    for dict in entries.iter() {
        let (Some(window_id), Some(owner_pid)) = (num(&dict, &key_number), num(&dict, &key_pid))
        else {
            continue;
        };
        let layer = num(&dict, &key_layer).unwrap_or(0.0);
        let bounds = dict
            .find(&key_bounds)
            .and_then(|v| v.downcast::<CFDictionary>())
            .map(|b| {
                let b: CFDictionary<CFString, CFType> =
                    unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
                (
                    num(&b, &key_x).unwrap_or(0.0),
                    num(&b, &key_y).unwrap_or(0.0),
                    num(&b, &key_w).unwrap_or(0.0),
                    num(&b, &key_h).unwrap_or(0.0),
                )
            })
            .unwrap_or((0.0, 0.0, 0.0, 0.0));
        out.push(CgWindowInfo {
            window_id: window_id as u32,
            owner_pid: owner_pid as i32,
            x: bounds.0,
            y: bounds.1,
            w: bounds.2,
            h: bounds.3,
            layer: layer as i32,
        });
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn list_cg_windows_impl() -> Vec<CgWindowInfo> {
    Vec::new()
}

/// Enumerate active displays with their global-screen bounds. Feeds the
/// `display` targeting in open_window/set_window (index into this array)
/// so window placement can be expressed per-monitor. Empty when the native
/// module is unavailable — the TS side then errors on display targeting
/// and still honors explicit absolute bounds.
#[napi]
pub fn list_displays() -> Vec<DisplayInfo> {
    list_displays_impl()
}

#[cfg(target_os = "macos")]
fn list_displays_impl() -> Vec<DisplayInfo> {
    use core_graphics::display::CGDisplay;

    let main_id = CGDisplay::main().id;
    let ids = match CGDisplay::active_displays() {
        Ok(ids) => ids,
        Err(_) => return Vec::new(),
    };
    ids.into_iter()
        .map(|id| {
            let bounds = CGDisplay::new(id).bounds();
            DisplayInfo {
                display_id: id,
                x: bounds.origin.x,
                y: bounds.origin.y,
                w: bounds.size.width,
                h: bounds.size.height,
                is_main: id == main_id,
            }
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn list_displays_impl() -> Vec<DisplayInfo> {
    Vec::new()
}

/// Whether this process already holds Screen Recording (TCC) permission,
/// checked WITHOUT prompting. Feeds the `doctor` Screen Recording check for
/// tier-2 window capture (`screencapture -l`). Returns false off macOS or when
/// the permission is absent — the daemon's capture then produces the real
/// actionable failure at call time.
#[napi]
pub fn preflight_screen_capture() -> bool {
    preflight_screen_capture_impl()
}

#[cfg(target_os = "macos")]
fn preflight_screen_capture_impl() -> bool {
    // CG_EXTERN bool CGPreflightScreenCaptureAccess(void) — non-prompting.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
fn preflight_screen_capture_impl() -> bool {
    false
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

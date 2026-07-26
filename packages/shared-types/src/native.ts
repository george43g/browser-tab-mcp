/**
 * Native (rust-accel) shapes — the CoreGraphics window/display info the
 * `list_cg_windows()` / `list_displays()` napi bindings return.
 *
 * These MUST stay mirrored in `apps/rust-accel/src/types.rs`; they're
 * registered in `MIRRORED_SCHEMAS` (see index.ts), and the drift-check test
 * (`tests/drift.test.ts`) fails CI if a field name diverges. Adding a field
 * here means adding it to the Rust struct in the same commit.
 */

import { z } from "zod";

/**
 * One on-screen CoreGraphics window as reported by the rust-accel
 * `list_cg_windows()` binding. windowId is the CGWindowID — the same id
 * namespace yabai uses, hence the cgWindowId join key on BrowserWindow.
 */
export const CgWindowInfoSchema = z.object({
  windowId: z.number().int().describe("CGWindowID (== yabai window id)."),
  ownerPid: z.number().int().describe("Owning process pid."),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  layer: z.number().int().describe("CG window layer; 0 = normal app windows."),
});
export type CgWindowInfo = z.infer<typeof CgWindowInfoSchema>;

/**
 * One active display as reported by the rust-accel `list_displays()`
 * binding. x/y are the display's global-screen origin (points, top-left);
 * the `display` index in open_window/set_window is an offset into the
 * returned array. Used to translate a display target into global bounds.
 */
export const DisplayInfoSchema = z.object({
  displayId: z.number().int().describe("CoreGraphics display id."),
  x: z.number().describe("Left edge in global screen points."),
  y: z.number().describe("Top edge in global screen points."),
  w: z.number().describe("Width in points."),
  h: z.number().describe("Height in points."),
  isMain: z.boolean().describe("True for the main (menu-bar / origin) display."),
});
export type DisplayInfo = z.infer<typeof DisplayInfoSchema>;

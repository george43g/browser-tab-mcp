/**
 * Shared types for browser-tab — the single source of truth for the daemon
 * contract, the extension↔daemon wire protocol, the MCP tool I/O schemas,
 * and the rust-accel native shapes.
 *
 * This is a thin barrel: every symbol is authored in a domain module under
 * `src/` and re-exported here. Consumers import from the package root only
 * (there is no subpath export map), so the split is invisible to them.
 *
 * Any Zod schema registered in `MIRRORED_SCHEMAS` below MUST have a matching
 * Rust struct in `apps/rust-accel/src/types.rs`. The drift-check test
 * (`tests/drift.test.ts`) parses the Rust file and asserts the field names
 * match — add a field here and add it to the Rust file in the same commit,
 * or CI fails.
 */

export * from "./base.js";
export * from "./build-stamp.js";
export * from "./contract.js";
export * from "./enrichment.js";
export * from "./history.js";
export * from "./journal.js";
export * from "./native.js";
export * from "./page.js";
export * from "./tools.js";
export * from "./wire.js";

// ── List of schema names that MUST be mirrored in Rust ────────────────

/**
 * Source of truth for the drift-check test. Each entry here is a tuple of
 * (TS schema export name, Rust struct name, expected field names).
 *
 * When you add a new schema, register it here AND mirror it in
 * apps/rust-accel/src/types.rs. The drift-check will fail otherwise.
 */
export const MIRRORED_SCHEMAS = [
  {
    tsName: "NoopInputSchema",
    rustName: "NoopInput",
    fields: ["input", "upper"],
  },
  {
    tsName: "NoopOutputSchema",
    rustName: "NoopOutput",
    fields: ["echo", "engine", "durationMicros"],
  },
  {
    tsName: "CgWindowInfoSchema",
    rustName: "CgWindowInfo",
    fields: ["windowId", "ownerPid", "x", "y", "w", "h", "layer"],
  },
  {
    tsName: "DisplayInfoSchema",
    rustName: "DisplayInfo",
    fields: ["displayId", "x", "y", "w", "h", "isMain"],
  },
] as const;

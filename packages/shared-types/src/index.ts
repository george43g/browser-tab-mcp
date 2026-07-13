/**
 * Shared types for the starter template.
 *
 * All Zod schemas exported here MUST have a corresponding Rust struct in
 * `apps/rust-accel/src/types.rs`. The drift-check test in
 * `tests/drift.test.ts` parses the Rust file and asserts the field names
 * match. If you add a field here, add it to the Rust file in the same
 * commit — CI will fail otherwise.
 */

import { z } from "zod";

// ── noop demo tool ────────────────────────────────────────────────────

/**
 * Input for the `noop` demo tool — exists purely so the starter has a
 * realistic round-trip example through both TS and Rust paths.
 */
export const NoopInputSchema = z.object({
  input: z.string().describe("Arbitrary string. Will be echoed back."),
  upper: z.boolean().default(false).describe("If true, return the echoed string in upper-case."),
});

export type NoopInput = z.infer<typeof NoopInputSchema>;

export const NoopOutputSchema = z.object({
  echo: z.string().describe("The echoed (possibly upper-cased) string."),
  engine: z.enum(["ts", "rust"]).describe("Which implementation path produced the result."),
  durationMicros: z.number().int().describe("Wall-clock duration in microseconds."),
});

export type NoopOutput = z.infer<typeof NoopOutputSchema>;

// ── health_check ──────────────────────────────────────────────────────

/**
 * health_check tool input — no arguments. Keeps the schema declared so
 * `toMcpTools()` always has a valid input schema.
 */
export const HealthCheckInputSchema = z.object({});
export type HealthCheckInput = z.infer<typeof HealthCheckInputSchema>;

export const HealthSnapshotSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  issues: z.array(z.string()),
  uptimeS: z.number().int(),
  pid: z.number().int(),
  node: z.string(),
  heapMb: z.number(),
  rssMb: z.number(),
  eventLoopP99Ms: z.number(),
  eventLoopMaxMs: z.number(),
  toolCalls: z.number().int(),
  recentErrors: z.number().int(),
  lastActivityAgeS: z.number().int(),
});
export type HealthSnapshotShape = z.infer<typeof HealthSnapshotSchema>;

// ── get_logs (dev-only) ───────────────────────────────────────────────

export const GetLogsInputSchema = z.object({
  tail: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("Number of log lines to return (1-500). Default 50."),
  source: z
    .enum(["memory", "file", "all"])
    .default("memory")
    .describe("memory = in-process ring buffer; file = NDJSON on disk; all = both."),
});
export type GetLogsInput = z.infer<typeof GetLogsInputSchema>;

export const GetLogsOutputSchema = z.object({
  source: z.string(),
  lines: z.array(z.string()),
});
export type GetLogsOutput = z.infer<typeof GetLogsOutputSchema>;

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
] as const;

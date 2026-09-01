// CANONICAL TOOL PATTERN — copy this file when adding a new MCP tool.
//
//  1. Define Zod input/output schemas in @george43g/shared-types
//     (or `<name>.schema.ts` for non-mirrored tool-local types).
//  2. .describe() EVERY field — these become LLM-facing tool docs.
//  3. Set sensible defaults; never require fields that can be inferred.
//  4. Annotations: readOnlyHint | destructiveHint | idempotentHint | openWorldHint.
//  5. Per-tool timeout in the ToolDefinition (or rely on default 30s).
//  6. Return content + structuredContent (always; the dispatcher does this for you).
//  7. Wrap untrusted user-content with sanitize() and (if appropriate) wrapUntrusted().
//  8. Add a test in tests/integration.test.ts; add a stress case if lifecycle-affecting.
//  9. If you mirror the schema in Rust, register it in MIRRORED_SCHEMAS.

import type { ToolDefinition } from "@george43g/mcp-kit";
import { sanitize } from "@george43g/mcp-kit";
import { NoopInputSchema, NoopOutputSchema } from "@george43g/shared-types";
import { tryLoadNative } from "../native-bridge.js";

/**
 * Demo tool: echo input, optionally upper-cased, returning the echoed
 * string plus which engine produced it ("rust" or "ts"). Exists so the
 * starter has a realistic round-trip example through both paths.
 */
export const noopTool: ToolDefinition<typeof NoopInputSchema, typeof NoopOutputSchema> = {
  name: "noop",
  description:
    "Echoes the input string back. If `upper` is true, returns it in upper-case. " +
    "Demonstrates the canonical tool pattern (Zod schema, structuredContent return, " +
    "Rust acceleration fallback). Use as a template when adding your own tools.",
  input: NoopInputSchema,
  output: NoopOutputSchema,
  annotations: {
    title: "No-op probe",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  timeoutMs: 10_000,
  handler: async (input, signal) => {
    if (signal?.aborted) {
      throw new Error("Cancelled by client");
    }
    // Optional test hook: artificial delay used by the stress harness to
    // make the forced-timeout case deterministic. Sub-millisecond handlers
    // would race a 1ms timeout otherwise.
    const delayMs = Number.parseInt(process.env.MCP_TEST_NOOP_DELAY_MS ?? "0", 10);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delayMs);
        t.unref?.();
      });
    }
    const native = tryLoadNative();
    if (native) {
      return native.noopAccel(input);
    }
    const start = process.hrtime.bigint();
    const safe = sanitize(input.input) ?? "";
    const echo = input.upper ? safe.toUpperCase() : safe;
    const durationMicros = Number((process.hrtime.bigint() - start) / 1000n);
    return { echo, engine: "ts" as const, durationMicros };
  },
};

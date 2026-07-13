---
name: mcp-tool-author
description: Authoring checklist for adding new MCP tools to a browser-tab-mcp tool. Use whenever the user asks to add or modify a tool.
---

# Adding an MCP tool — canonical checklist

Use this skill whenever the user asks to add, modify, or refactor an MCP tool in any repo cloned from `mcp-cli-starter-template`. Following this checklist keeps every tool in the codebase uniform and avoids subtle robustness bugs (missing timeouts, ignored abort signals, unsanitized output).

## 1. Define the schemas

Two Zod schemas — input and output — `.describe()` every field:

```ts
export const FooInputSchema = z.object({
  query: z.string().describe("Search query; substring match, case-insensitive"),
  limit: z.number().int().min(1).max(500).default(20).describe("Max results"),
});

export const FooOutputSchema = z.object({
  results: z.array(z.object({ id: z.string(), title: z.string() })),
  total: z.number().int(),
});
```

If the schema mirrors a Rust struct, declare it in `@george43g/shared-types` and register the entry in `MIRRORED_SCHEMAS`. Otherwise keep it inline in `src/tools/<name>.ts`.

## 2. Write the ToolDefinition

```ts
export const fooTool: ToolDefinition<typeof FooInputSchema, typeof FooOutputSchema> = {
  name: "foo",
  description: "One paragraph summary the LLM will see. State purpose, when to use, when NOT to.",
  input: FooInputSchema,
  output: FooOutputSchema,
  annotations: {
    readOnlyHint: true,       // does it read state only?
    destructiveHint: false,   // does it overwrite/delete anything?
    idempotentHint: true,     // does calling twice == calling once?
    openWorldHint: false,     // does it call external systems?
  },
  timeoutMs: 30_000,          // omit to use the 30s default
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    // ... your work here ...
    return { results: [...], total: 42 };
  },
};
```

## 3. Honor the invariants

Encoded by `@george43g/mcp-kit`'s `buildDispatcher`, but you must follow them in your handler:

1. **Timeout** — the wrapper sets one for you; just don't make the work unbounded inside.
2. **Activity beacon** — handled by the dispatcher.
3. **Perf span** — handled by the dispatcher; if you want sub-spans inside, use `perf("sub-span")`.
4. **Actionable errors** — throw `new Error("clear message...")`. The dispatcher wraps with the tool name and hint.
5. **Abort signal** — check `signal?.aborted` between iterations of any long loop. Return early if true.
6. **No stdout writes** — log via `@george43g/robustness/logger` only. Never `console.log` after the stdio transport opens.
7. **Sanitize external content** — pass user-content surfaces through `sanitize()`. Wrap with `wrapUntrusted()` when the content came from outside your control (web scrape, email body, etc).

## 4. Register the tool

Add to `apps/browser-tab-mcp/src/tools/registry.ts`:

```ts
import { fooTool } from "./foo.js";
// ...
return makeRegistry([healthCheckTool, noopTool, fooTool, getLogsTool]);
```

## 5. Add an integration test

`apps/browser-tab-mcp/tests/integration.test.ts`:

```ts
describe("foo", () => {
  it("returns results matching the schema", async () => {
    const r = await callMcpTool("foo", { query: "test" });
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as any).total).toBeGreaterThanOrEqual(0);
  });
});
```

## 6. Stress harness — only if lifecycle-affecting

If the tool can block the event loop, spawn subprocesses, hold network connections, or otherwise affect process health, add a stress case to `apps/browser-tab-mcp/scripts/stress-mcp.ts`. Run `pnpm stress` to verify.

## 7. Documentation

- Update the tool table in `apps/browser-tab-mcp/README.md` if there is one.
- Update `AGENTS.md` if the tool needs special handling notes (auth, permissions, etc).
- VHS tape: only update if the tool changes the user-facing CLI subcommand list.

## 8. Verify

```bash
pnpm verify                  # lint + typecheck + test + build
pnpm --filter @george43g/browser-tab-mcp stress  # 11-case robustness suite
```

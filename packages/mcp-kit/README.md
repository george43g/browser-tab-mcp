# @george43g/mcp-kit

Workspace package: the MCP plumbing every tool in this repo runs through —
tool registry, dispatcher, stdio transport, resources, and the sanitize /
prompt-injection guards. It is generic on purpose; browser knowledge lives in
`shared-types` and the app.

## Modules

| Module | Exports | Role |
|---|---|---|
| `tool-registry` | `ToolDefinition`, `makeRegistry`, `ContentBlock` | Declare tools (Zod in/out schemas, timeout, `devOnly`, annotations, optional `toContent` image blocks); `toMcpTools()` converts to the SDK `Tool[]` shape for `tools/list`. |
| `dispatch` | `buildDispatcher` | One dispatcher for MCP, CLI, REPL, and TUI: validation, `withTimeout`, AbortSignal, `wrapToolError`, fail-closed `devOnly` enforcement. |
| `transports/stdio` | `startStdio` | Stdio JSON-RPC transport wiring; nothing may write to stdout after connect. |
| `resources` | `buildResourcesHandler` | MCP resources + URI templates (health, dev logs today; selection/plan records later). |
| `sanitize` | `sanitize`, `sanitizeContent` | ANSI/OSC strip, C0 → U+FFFD, truncation for user-content surfaces. |
| `prompt-injection` | `wrapUntrusted`, `wrapInstructions` | `<untrusted>` wrapping + UUID-gated instructions (see `docs/GUARDRAILS_MCP_RESPONSES.md`). |

## Tool annotations

`ToolDefinition.annotations` is **required** and passes through to `tools/list`
verbatim. Every tool must declare a non-empty `title` and all four hints
**explicitly** — the SDK's defaults skew permissive (`destructiveHint` and
`openWorldHint` both default *true*), so an omitted hint is an accidental
claim, not a neutral one:

```ts
annotations: {
  title: "Close tab",
  readOnlyHint: false,
  destructiveHint: true,   // irreversibly loses user state
  idempotentHint: false,
  openWorldHint: false,    // true ONLY for tools that load arbitrary URLs
},
```

Truthfulness rules this repo applies (enforced by
`apps/browser-tab-mcp/tests/tool-annotations.contract.test.ts`):

- every registered tool declares a title and all four hints as literal booleans;
- a `readOnlyHint: true` tool never sets `destructiveHint: true`;
- `destructiveHint: true` is reserved for irreversible loss of user state
  (`close_tab`, `close_window`, `bookmarks` subtree removal, `tab_action`
  navigate/discard) — growing that set is a deliberate, commented act;
- `openWorldHint: true` marks only the tools that reach the open web by
  loading caller-supplied URLs (`open_tab`, `open_window`, `tab_action`
  navigate). Reading local stores (history, bookmarks) or already-rendered
  pages (`get_page`, `screenshot`) is a closed domain.

Annotations are **hints for hosts, not enforcement** — the dispatcher ignores
them. Enforcement stays where it is: `devOnly` fail-closed in the dispatcher,
URL scheme allowlisting in `url-policy`, destructive-action semantics in each
tool.

# Guardrails: gated instructions in MCP tool responses

To reduce prompt-injection and out-of-context execution, MCP tool responses can embed instructions wrapped in gated tags. The model is trained to treat content inside the tags as executable or authoritative ONLY when a matching UUID appears in the user's message or subject — proving the user explicitly requested that specific response.

## Why

MCP tool responses are presented to the LLM as data. Naive LLM behavior: read tool output → if it says "run command X", run it. That's a prompt-injection vector — an email body, a search result, a chat snippet can all contain text that looks like instructions.

Two defenses, both implemented in `@george43g/mcp-kit`:

1. **`wrapUntrusted(text)`** — wraps arbitrary external content with `<untrusted>...</untrusted>` markers. The LLM treats tagged content as data, not commands.
2. **`wrapInstructions(text, uuid)`** — emits genuine instructions but gates them behind a UUID echo. The user must include the UUID in their next message for the LLM to follow the steps.

## Pattern: gated instructions

```ts
import { wrapInstructions } from "@george43g/mcp-kit";

const { text, uuid } = wrapInstructions("Step 1: list files. Step 2: filter by ext.");
return {
  content: [{ type: "text", text }],
  structuredContent: { uuid, steps: 2 },
};
```

The wrapped output looks like:

```xml
<instructions uuid="d8a3...">
Step 1: list files.
Step 2: filter by ext.
</instructions>
```

If the user's next message contains `d8a3...`, the LLM executes the steps. Otherwise the LLM treats the embedded text as data and asks the user how they want to proceed.

## Pattern: untrusted user-content surfaces

```ts
import { sanitize, wrapUntrusted } from "@george43g/mcp-kit";

handler: async ({ messageId }) => {
  const body = await fetchEmailBody(messageId);
  const safe = sanitize(body) ?? "(empty)";
  return {
    subject,
    bodyText: wrapUntrusted(safe),
  };
};
```

`sanitize()` strips ANSI/CSI/OSC sequences and replaces C0 control characters with U+FFFD. `wrapUntrusted()` adds the structural markers.

## When to use which

| Source of content | Use |
|-------------------|-----|
| User-controlled text the LLM should treat as data (chat snippet, email body, scraped page) | `wrapUntrusted()` after `sanitize()` |
| Server-generated instructions the user explicitly asked for | `wrapInstructions(steps, uuid)` |
| Server-generated metadata (status counters, IDs, etc) | Plain `structuredContent` — no wrapping |
| Server-generated error messages | `wrapToolError(toolName, message, hint)` |

## Discipline

Every new tool author MUST:

- Sanitize any user-content surface returned from the tool.
- Wrap external content with `wrapUntrusted()` — even when it looks innocuous.
- Never embed instructions in plain text. If the tool needs to direct the LLM (multi-step workflow, follow-up actions), use `wrapInstructions()`.
- Document the UUID-gating contract in the tool's description if relevant.

## Reference

The pattern is documented at the protocol level in MCP best-practices guidance. Implementation in `packages/mcp-kit/src/prompt-injection.ts`.

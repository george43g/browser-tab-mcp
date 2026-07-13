---
name: browser-tab
description: Use when working with the browser-tab MCP tool — covers invoking tools, choosing the right transport (stdio/HTTP), running the CLI/TUI/REPL surfaces, and reading logs. Loaded automatically when the user references browser-tab or its bin.
---

<!--
================================================================================
AI AGENT INSTRUCTIONS — READ THIS BLOCK FIRST.

This file ships as a SCAFFOLD inside the mcp-cli-starter-template. It was
written into this repo when the tool was generated via `mcp-scaffold init`
(or applied to an existing repo via `mcp-scaffold apply`).

The contents below describe the STARTER's example tools (health_check, noop)
and the GENERIC command surface (mcp/tui/doctor/repl). They are placeholders.

**Your job, on first read, is to rewrite this file to describe what the tool
actually does.** Specifically:

1. Read the tool's real source under `src/tools/`. Each tool has a Zod input
   schema with `.describe(...)` annotations — those are the source of truth.
2. Read `src/tools/registry.ts` to see which tools are exposed and any
   dev-only gating.
3. Read `README.md` for the user-facing summary.
4. Replace the "Tools" section below with one row per real tool: name,
   when-to-use, important constraints (timeouts, side-effects, auth needs).
5. Replace the "Common workflows" section with the actual workflows the tool
   was built for.
6. Keep the "Command surface" section accurate — it's structurally stable
   across all tools cloned from this template.

After rewriting, REMOVE this entire HTML comment block. Future agents reading
this skill should see only the tool-specific guidance.
================================================================================
-->

# browser-tab

> Single-bin MCP server with CLI/TUI/REPL surfaces. All four surfaces dispatch
> to the same in-process registry of tools — adding a tool to `src/tools/` makes
> it appear in MCP `tools/list`, the CLI as a subcommand, and the REPL.

## When to invoke this skill

Use this skill when the user:
- Mentions `browser-tab` by name or references its bin.
- Asks to run, debug, or inspect the browser-tab tool.
- Asks to add a new tool, change a transport, or read logs.

If the user is doing something tangential (e.g., editing unrelated files in
the repo), do NOT pull this skill in.

## Command surface (stable across the template)

```
browser-tab mcp              run the MCP server (stdio)
browser-tab mcp --http       run via Streamable HTTP (needs MCP_HTTP_TOKEN)
browser-tab tui              launch the Ink TUI
browser-tab doctor           preflight checks (Node version, native deps, env)
browser-tab repl             interactive REPL — same dispatcher as MCP
browser-tab health           one-shot health snapshot
browser-tab noop --input hi  call any tool directly (subcommand per ToolDefinition)
```

Global flags:
- `--json` machine-readable output (REPL/CLI; MCP always uses JSON envelopes)
- `-q/--quiet` suppress non-error output
- `-v/--verbose` debug-level info to stderr
- `--no-color` disable colors

## Picking a transport

- **stdio (default)** — for MCP hosts that spawn the server as a child process
  (Claude Desktop/Code, Cursor, Warp, OpenCode). Lowest overhead. JSON-RPC owns
  stdout; logging goes to NDJSON files only.
- **HTTP (`--http`)** — for hosted deployments, multiple clients, or when the
  MCP host can't spawn child processes. Requires `MCP_HTTP_TOKEN` (generate via
  `openssl rand -hex 32`). Default bind `127.0.0.1` — terminate TLS at a
  reverse proxy (Caddy, nginx, Cloudflare Tunnel).

## Tools

| Tool | Use it when… | Notes |
|---|---|---|
| `health_check` | You need to verify the server is alive and the runtime is healthy. | Read-only, idempotent. Returns counters + uptime + memory. Never touches external I/O — safe to call anytime, even when the network is down. |
| `noop` | Demo / smoke test the dispatcher round-trip from outside the tool. | Echoes a string with optional `upper` flag. Routes through the Rust accelerator if available; transparently falls back to TS. |
| `get_logs` | You need recent log lines for debugging. **Dev mode only.** | Set `BROWSER_TAB_DEV=1` to enable. Returns the in-memory ring buffer (last 500 lines). |

## Common workflows

### Verifying the server is healthy
```
browser-tab health
```
Returns a one-shot snapshot. Use `--json` for machine-readable output.

### Calling a tool from the CLI
```
browser-tab noop --input "hello" --upper
```
The CLI is 1:1 with MCP — anything callable via `tools/call` is also a CLI
subcommand with `--flag` per Zod field.

### Inspecting logs
Logs are NDJSON at `$TMPDIR/browser-tab/browser-tab-{PID}-{date}.ndjson`. In dev mode,
`get_logs` returns the same content over MCP.

```
browser-tab repl
> get_logs --count 100
```

### HTTP transport
```
export MCP_HTTP_TOKEN=$(openssl rand -hex 32)
browser-tab mcp --http --port 8080

# In another shell — health probe (no auth)
curl http://127.0.0.1:8080/health

# Authenticated initialize
curl -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $MCP_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
```

## Adding a new tool (for the agent maintaining the codebase)

See `.claude/skills/mcp-tool-author/SKILL.md` for the full checklist. Short
version:
1. Define Zod `input`/`output` schemas in `src/tools/<name>.ts` with
   `.describe(...)` on every field.
2. Implement `handler(input, signal?)` — honor the abort signal in loops.
3. Add the `ToolDefinition` to `src/tools/registry.ts` (with optional
   `timeoutMs` override and `annotations`).
4. Add a unit test colocated as `<name>.test.ts`.
5. Add an integration assertion in `tests/integration.test.ts`.
6. If lifecycle-affecting, add a stress case in `scripts/stress-mcp.ts`.

The unified registry means MCP/CLI/REPL surfaces update automatically —
no per-surface drift.

## Troubleshooting

| Symptom | Check |
|---|---|
| MCP host doesn't see the tool after a code change | The host caches the session. Restart the host. The dev proxy auto-reloads on src/** changes but the host needs to reconnect. |
| `--http` refuses to start | Missing `MCP_HTTP_TOKEN`. Generate with `openssl rand -hex 32`. |
| Native module fails to load | Run `pnpm --filter rust-accel build`. If `rustc` is missing, set `MCP_DISABLE_NATIVE=1` to force the TS path. |
| Orphan processes | `ps aux \| grep browser-tab` and kill. The shutdown registry should catch this; file a bug if it doesn't. |

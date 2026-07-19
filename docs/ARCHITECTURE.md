# Architecture

`mcp-cli-starter-template` is a Turborepo monorepo with two apps and ten packages. The split is intentional: anything that doesn't depend on the tool's domain lives in a package and is reused; anything that does lives in the app.

## Workspace map

```
apps/
  browser-tab-mcp/   — the example tool (clone-and-rename target)
  rust-accel/     — napi-rs v3 crate, optional acceleration

packages/
  robustness/     — env helpers, logger, watchdog, shutdown, with-timeout,
                    health, retry, rate-limit. ZERO domain knowledge.
  mcp-kit/        — tool-registry, dispatcher, stdio transport,
                    sanitize, prompt-injection helpers.
  cli-kit/        — commander program builder, tty/color/output helpers,
                    env↔CLI-flag binder, interactive REPL.
  tui-kit/        — Ink theme system, hooks (useDevStats / useMouse /
                    useVimKeys), components (DevStatsPanel, StatusBar,
                    HelpBar, FullScreenInk), memoryCache, boundIfNeeded.
  env-loader/     — Vite-style .env precedence in plain Node.
  secrets/        — env-JSON → 1Password → file chain (no Keychain).
  shared-types/   — Zod schemas + Rust mirror + drift-check test.
  tsconfig/       — base.json + node.json + react.json.
  biome-config/   — single biome.json source for the whole workspace.
  vitest-config/  — shared preset for packages + lower-threshold preset
                    for apps.
```

## Dependency direction (always upward)

```
                  apps/browser-tab-mcp
                       │
   ┌───────────────────┼─────────────────────┐
   ▼                   ▼                     ▼
 cli-kit            mcp-kit               tui-kit
   │                   │                     │
   └────────┬──────────┴──────────┬──────────┘
            ▼                     ▼
       robustness           shared-types ← apps/rust-accel
            │                     │            (the Rust side
            └─────────┬───────────┘             of the contract)
                      ▼
                   (Node)
```

Packages never depend on apps. Apps depend on packages. `rust-accel` depends only on `shared-types` (via the hand-mirrored types in `src/types.rs`).

## The dispatcher invariants

Every MCP tool call passes through `@george43g/mcp-kit/dispatch.ts:buildDispatcher`, which encodes:

1. **withTimeout** wraps every handler — declare `timeoutMs` in `ToolDefinition` or rely on `MCP_TOOL_TIMEOUT_DEFAULT_MS` (default 30s).
2. **noteActivity** fires per dispatch — feeds the idle-restart watchdog.
3. **perf** span around every handler — produces NDJSON perf entries + the `_meta.duration_ms` footer.
4. **Errors wrapped** with `wrapToolError(toolName, message, hint)` — never a bare `error.message`.
5. **AbortSignal honored** — long-running loops check `signal?.aborted` between iterations.
6. **No stdout writes** — JSON-RPC owns it after `StdioServerTransport.connect()`. All logging via `@george43g/robustness/logger`.
7. **structuredContent** + **_meta** in every response — engine label (`ts` or `rust`) and duration_ms.

These invariants exist as a comment block in `apps/browser-tab-mcp/src/dispatcher.ts`. Do not weaken them without a corresponding update to `AGENTS.md`.

## The robustness harness

Three watchdog monitors fire on unref'd timers and self-kill the process via `shutdown()` if they detect an unrecoverable condition. The MCP host (Cursor / Claude / Warp) respawns a clean instance.

| Monitor | Trigger |
|---------|---------|
| Event-loop lag (spike) | p99 > `MCP_EVENT_LOOP_KILL_MS` (default 10s) for one 5s window |
| Event-loop lag (sustained) | p99 ≥ `MCP_EVENT_LOOP_SUSTAINED_MS` (default 750ms) for N consecutive samples |
| Memory (RSS) | RSS ≥ `MCP_MAX_RSS_MB` (default 1024) |
| Memory (heap leak) | Heap monotonically grew on `MCP_HEAP_GROWTH_SAMPLES` consecutive samples |
| Idle uptime | uptime > 24h AND no activity for 1h |

External observers can sample the watchdog state by setting `MCP_WATCHDOG_STATE_PATH` — the watchdog writes a JSON snapshot per event-loop tick. The CI stress harness uses this.

## Transport: stdio

The MCP server speaks stdio only — the right shape for a tool spawned locally by an MCP host. `runMcpServer()` wires the `Server` instance to `startStdio` from `@george43g/mcp-kit`.

## Optional Rust acceleration

`apps/rust-accel/` is napi-rs v3. The TS side calls `tryLoadNative()` which returns null when the `.node` binary is missing — the TS fallback path runs unchanged.

`MCP_DISABLE_NATIVE=1` forces the fallback in any environment. CI tests both paths.

Type contract: hand-mirrored. `packages/shared-types/src/index.ts` declares the Zod schemas; `apps/rust-accel/src/types.rs` declares the matching Rust structs. `MIRRORED_SCHEMAS` in shared-types lists what must align, and `packages/shared-types/tests/drift.test.ts` parses the Rust file and fails CI on any drift.

## Env layout

Two complementary mechanisms:

1. **Node-native `--env-file-if-exists`** in every package.json script. Loads in order: `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`. Vite-style precedence — last write wins.
2. **`@george43g/env-loader`** for tools that need to read env before spawning a subprocess (e.g., the dev MCP proxy).

Every recognized env var is also accepted as a CLI flag via `@george43g/cli-kit/env-flag-binder`. `MCP_LOG_DIR` ↔ `--log-dir`, `MCP_DISABLE_NATIVE` ↔ `--disable-native`, etc.

## Secrets

Default chain: env-JSON → 1Password CLI → file (`~/.browser-tab/credentials.json`). Apple Keychain is deliberately omitted from the starter; add per-tool if needed.

Env-JSON is the CI / Docker / k8s primary path. 1Password is optional — gracefully degrades when the `op` CLI isn't installed.

## Removing surfaces

Each surface is independently deletable:

- **No TUI**: delete `apps/browser-tab-mcp/src/tui/`, the `browser-tab-tui` bin entry in `package.json`, the `tui` subcommand from `src/cli.ts`, and the TUI entry from `vite.config.ts`. Optionally delete `packages/tui-kit` from `pnpm-workspace.yaml`.
- **No Rust**: delete `apps/rust-accel/`, `src/native-bridge.ts`, and the `tryLoadNative()` call in `src/tools/noop.ts`. Remove `MIRRORED_SCHEMAS` from `packages/shared-types/src/index.ts` and the drift-check test.
- **No `get_logs`**: delete `src/tools/get-logs.ts` and remove it from `src/tools/registry.ts`.

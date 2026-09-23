# tmux-control-mcp

MCP server + CLI + TUI, cloned from `mcp-cli-starter-template`.

## Quick start

```bash
pnpm install
pnpm build           # compile TS + (optional) Rust accelerator
pnpm test            # run unit + integration tests
pnpm stress          # 15-assertion robustness harness
```

## Bins

| Bin | Purpose | Default transport |
|-----|---------|-------------------|
| `tmux-control-mcp` | MCP server | stdio (`--http` for Streamable HTTP) |
| `tmux-control-cli` | Commander CLI: `mcp`, `http`, `tui`, `doctor`, `health`, `noop`, `cli` (REPL) | n/a (in-process dispatch) |
| `tmux-control-tui` | Ink TUI | n/a |

## Tools

Every tool the registry exposes. `tests/docs-integrity.contract.test.ts` fails
if this table and `src/tools/registry.ts` disagree.

| Tool | CLI | What it does |
|------|-----|--------------|
| `health_check` | `health` | Server health snapshot; answers without external I/O |
| `noop` | `noop --input <text>` | Scaffold demo: echoes its input |
| `get_logs` | none yet | Recent log lines; dev-only (`MCP_DEV=1`), refused otherwise |

## Adding a tool

1. Copy `src/tools/noop.ts` to `src/tools/<your-tool>.ts`.
2. Define Zod input/output schemas (in `@george43g/shared-types` if you want to mirror in Rust, else inline in the tool file).
3. Register the new tool in `src/tools/registry.ts`.
4. Add an integration test in `tests/integration.test.ts`.
5. If the tool affects process lifecycle, add a case in `scripts/stress-mcp.ts`.

The dispatcher already wires `withTimeout`, `perf` spans, abort propagation, structured error wrapping, and structuredContent return — your handler just needs to be a pure `(input, signal) => output` async function.

## Secrets

`@george43g/secret-store` resolves a secret through one ordered chain, most explicit first: **env var → `.env` file → OS keychain → external command** (the last is opt-in via `SECRET_STORE_EXEC_BIN`/`_ARGS`). It contains no vault code and never will — pulling a secret *out of* 1Password/Vault/AWS SM is a secret manager's job, and keeping that boundary is what stops vault credentials reaching every tool's dependency tree.

HTTP mode's bearer token is the worked example (`src/commands/http.ts`). `MCP_HTTP_TOKEN` is still checked first, so exporting it behaves exactly as before; the rest of the chain only adds places to look when it is unset. Reads degrade to `null`, so a container that only ever sees env vars pays nothing for the layers beneath.

To use it for your own tool's secrets:

```ts
import { resolveSecret } from "@george43g/secret-store";

const found = await resolveSecret({ toolPrefix: "tmux-control", name: "api_key" });
// → { value, source } | null — looks for TMUX_CONTROL_API_KEY, then .env, then the keychain
```

## Logging

Logs go through `@george43g/robustness` — never `console.log`, which would
corrupt the JSON-RPC stream once the stdio transport is open.

In **stdio mode** the server calls `setStderrMirror(true)`, so info/warn/error
lines are mirrored to stderr and your MCP host (Claude Desktop, Cursor, …)
surfaces them in its own connection log. That is the difference between "the
server just stopped" and an actual error message. The mirror is deliberately
NOT enabled in HTTP or TUI mode: the TUI renders to the same terminal and stray
stderr writes would garble it.

Useful knobs, all read at call time so CLI flags still reach them:

| Variable | Effect |
|---|---|
| `MCP_LOG_TO_FILE=0` | Stop writing NDJSON to disk. Set this if your users should not accumulate `$TMPDIR` logs. |
| `MCP_LOG_REDACT=0` | Disable redaction. On by default: phone numbers and secret-shaped strings are rewritten before any sink sees them. |
| `MCP_LOG_DIR` | Where NDJSON files go (default `$TMPDIR/<tool>/`, 10MB rotation). |

### Log branding happens on import, not at startup

`src/log-brand.ts` calls `setLogFilePrefix()` as a **module-scope side effect**,
and every process entry point (`src/cli.ts`, `src/index.ts`, `src/tui/index.tsx`)
imports it **first**, above any import that can log.

This is not stylistic. The logger fixes its file path at the **first write**, not
at configuration time, and derives the directory from whatever prefix is set at
that instant. Branding from inside a function is therefore correct only by call
ordering: anything that logs earlier wins the directory for the whole process,
and the logs still work — they are just in the wrong place, silently.

**If you add an entry point, import `./log-brand.js` first.** If you rename the
package, nothing needs changing; the slug is derived from `APP_NAME`.

Two caveats worth knowing before you rely on the directory name:

- `MCP_LOG_PREFIX` moves the whole **directory**, not just the filename, because
  the directory is `join(tmpdir(), prefix)`.
- A dependency that pulls in its own copy of `@george43g/robustness` gets its own
  module-scope logger state, and this app cannot brand it. If you see records
  under `$TMPDIR/mcp/` that you expected here, that is the cause — check whether
  the kit resolves the same physical copy your app does.

The equivalent programmatic setters (`setFileLogging`, `setLogRedaction`,
`setStderrMirror`) take precedence over the environment.

### Process markers — telling a clean exit from a crash

Every run — stdio or HTTP — writes two markers, and `AGENTS.md` states the rule
that depends on them: **a log file without a `shutdown` line means the process
crashed.**

```json
{"msg":"startup","data":{"pid":75652,"entrypoint":"tmux-control-mcp"}}
{"msg":"shutdown","data":{"pid":75652,"reason":"stdin_eof","uptime_s":41}}
```

`reason` names *why*, not merely *that*: `stdin_eof` (the MCP host disconnected —
the most common exit of all), `signal:SIGTERM`, `watchdog:rss_exceeded`,
`uncaught_exception`, or `normal`. A supervisor respawn and a crash loop look
identical without it.

Two caveats worth knowing:

- **The HTTP path was the exception until recently.** `runHttpMcp` registered
  `handle.close()` as a cleanup but never called `installShutdownHandlers()`, so
  nothing trapped a signal, the cleanup could not run, and no markers were
  written: a `SIGTERM` terminated the process at status 143 with in-flight
  requests dropped and a log indistinguishable from a crash. It now installs the
  handlers and writes both markers, and a `SIGTERM` exits 0:

  ```json
  {"msg":"startup","data":{"pid":85509,"entrypoint":"@george43g/tmux-control-mcp"}}
  {"msg":"shutdown: signal_received","data":{"signal":"SIGTERM"}}
  {"msg":"shutdown","data":{"pid":85509,"reason":"signal:SIGTERM","uptime_s":4}}
  ```

  If you scaffolded before this, add `installShutdownHandlers()` to
  `runHttpMcp` — `tests/http-lifecycle.test.ts` is the check.
- The rule above was **false before this was added**: `logStartup` shipped
  without its counterpart, so every clean exit looked like a crash. If you
  scaffolded before then, check that `startStdio` registers the marker.

#### The dev proxy manufactured false crashes, and your config may still

`scripts/mcp-dev-proxy.ts` restarts the server on every source change by
sending it `SIGTERM`. It used to launch it through `node_modules/.bin/tsx` —
which is a **supervisor, not a runner**: it runs your code as a grandchild and
relays signals on a 30ms IPC-ack budget, then `SIGKILL`s it when the ack is
late. A server mid-request is exactly the child whose ack is late, and a
`SIGKILL`ed process writes no `shutdown` marker. So a routine save produced a
log file that, by the rule above, reads as a crash.

Killing the process *group* does not help: the wrapper is in the same group and
escalates anyway.

The proxy now builds the command itself — `node --import <tsx loader> <entry>`,
one process — and takes only the entry from you:

```json
"env": { "MCP_DEV": "1", "MCP_DEV_ENTRY": "apps/tmux-control-mcp/src/index.ts" }
```

**If you scaffolded before this, check your MCP host config for an explicit
`MCP_DEV_CMD`.** An override beats the safer default by construction, so a repo
that pins `"MCP_DEV_CMD": "pnpm tsx …"` in `.mcp.json`, `.codex/config.toml` or
a generated `opencode.json` stays exactly as broken while looking fixed.
Replace it with `MCP_DEV_ENTRY` and regenerate any derived config. The proxy
prints a warning on startup when it sees a `tsx`-shaped override, so you do not
have to remember to look.

`MCP_DEV_CMD` still works as a full command override — you then own the hazard.

### The watchdog: enforcing on stdio, observe-only on HTTP

stdio serves one client and can safely self-kill on event-loop lag or memory
growth. An HTTP server is shared, and the decision to restart it belongs to
whatever supervises it — so `runHttpMcp` installs the watchdog with a hook that
withholds the kill:

```ts
installWatchdog({ onBreach: () => "observe" });
```

It samples and logs exactly as it does on stdio; only the kill is withheld. The
same `MCP_MAX_RSS_MB=50` that makes the stdio server exit 1 leaves the HTTP
server serving:

```
[warn] watchdog_breach_observed: rss_exceeded {"rss_mb":101.4,"threshold_mb":50}
[warn] watchdog_breach_observed: rss_exceeded {"rss_mb":101.4,"threshold_mb":50}
```

**To enforce it, delete the `onBreach` line** in `src/commands/http.ts`. The
watchdog then behaves as it does on stdio — `watchdog_kill: <reason>`, a 5s
force-exit net, then `shutdown(1)`. Do that only if something will restart the
process; a shared server that exits and stays down is worse than a slow one.
Per-condition policy is a verdict, not a flag, so you can enforce some and
observe others:

```ts
installWatchdog({ onBreach: ({ reason }) => (reason === "rss_exceeded" ? "observe" : "kill") });
```

**Know the log volume before you deploy it.** An observed breach is *not*
latched — it logs one `warn` line per breaching sample, for as long as the
breach lasts:

| Condition | Sample interval | Lines/day while breaching |
|---|---|---|
| `event_loop_blocked`, `event_loop_sustained_lag` | `MCP_EVENT_LOOP_SAMPLE_MS`, default 5s | ~17,300 (~4MB) |
| `rss_exceeded`, `memory_leak_suspected` | `MCP_MEMORY_SAMPLE_MS`, default 60s | ~1,440 (~215KB) |
| `idle_restart` | `MCP_IDLE_CHECK_MS`, default 10min | ~144 |

That is deliberate: the values change between lines, so a latch would throw away
the trend you need to tell "leaking" from "plateaued". If it is too much for
your deployment, widen the sample interval, raise the threshold, set
`MCP_LOG_TO_FILE=0`, or point `MCP_LOG_DIR` at a location your platform rotates
**and reaps** — the logger rotates at 10MB by opening a new file and never
deletes the old ones.

## Removing surfaces

- **Drop HTTP support**: delete the `http` subcommand from `src/cli.ts`, the `--http` branch from `src/index.ts`, and case #9 from `scripts/stress-mcp.ts`. Remove `MCP_HTTP_TOKEN` from `.env.example`. If nothing else in your tool resolves a secret, drop `@george43g/secret-store` from `package.json` too.
- **Drop TUI support**: delete `src/tui/`, the `tui` subcommand from `src/cli.ts`, the `tmux-control-tui` bin entry from `package.json`, and the TUI entry from `vite.config.ts` `lib.entry`.
- **Drop Rust acceleration**: delete `apps/rust-accel/`, the `src/native-bridge.ts` file, and the `tryLoadNative()` call in `src/tools/noop.ts`.
- **Drop `get_logs`**: delete `src/tools/get-logs.ts` and remove it from the registry.

## Dev-only tools are gated on the call path

`get_logs` is registered `devOnly`, so it is filtered out of `tools/list` unless
`MCP_DEV` is set. **That filter is cosmetic on its own** — a client that already
knows the name can still call it. The gate that actually stops the call is the
`devOnlyEnabled` predicate passed to `buildDispatcher()` in `src/dispatcher.ts`:

```ts
buildDispatcher({ registry, /* … */ devOnlyEnabled: devModeEnabled });
```

Without it, a `devOnly` tool is hidden **and callable**, and nothing fails —
no type error, no test failure; the tool simply answers. With it, calling
`get_logs` by name with `MCP_DEV` unset returns `Unknown tool name`, which is the
behaviour you want: a dev-only tool that is not enabled must be indistinguishable
from one that does not exist.

**If you add your own `devOnly` tool, you inherit this — do not remove the
predicate.**

## Shell completions

Bash/zsh/fish completions + manpage + per-subcommand markdown docs are generated from `.usage.kdl` via `usage(1)`. The scaffold ships the spec, a generated baseline using the clone's real bin name, regeneration tasks, and a byte-level freshness check.

The intended workflow is: edit `.usage.kdl`, regenerate, review the diff, and commit the spec and artifacts together. CI's `pnpm check:usage` step (and the matching `cli-artifacts-drift` workflow on the scaffolder side) fails any edit that changes `.usage.kdl` without a matching regeneration.

Update flow:

```bash
mise install                                  # one-time: installs pinned usage(1)
pnpm artifacts                                # regenerate completions/ + man/ + docs/cli/
pnpm check:usage                              # byte-check the committed baseline
git add .usage.kdl completions man docs/cli
pnpm completions:install                      # auto-detect $SHELL and install into the right path
```

`pnpm check:usage` and CI enforce freshness from the initial scaffold onward.

`completions:install` (script: `scripts/install-completions.sh`) handles the well-known locations for each shell:

| Shell | Default install path |
|-------|----------------------|
| bash  | `~/.local/share/bash-completion/completions/tmux-control` (XDG) or `~/.bash_completion.d/tmux-control` |
| zsh   | `${ZDOTDIR:-~}/.zsh/completion/_tmux-control` |
| fish  | `~/.config/fish/completions/tmux-control.fish` |

CI gate `scripts/check-usage-freshness.mjs` (`pnpm check:usage`) fails the build if `.usage.kdl` was edited without regenerating the artifacts.

## Install in Claude Desktop (.mcpb bundle)

Claude Desktop loads MCP servers from `.mcpb` bundles — zip archives with a `manifest.json` + the runtime files. Build one with:

```bash
pnpm pack:mcpb         # runs `pnpm build` then bundles into tmux-control-mcp-<version>.mcpb
```

The output `.mcpb` drops into Claude Desktop via drag-and-drop (or **Settings → Extensions → Install from file**). Claude reads `manifest.json` (MCPB spec v0.3), spawns `node ${__dirname}/dist/index.js` for stdio transport, and surfaces this server's tools + resources in the catalogue.

The shipping manifest lives at `manifest.json` and pins:

- `manifest_version: "0.3"` — MCPB spec pin
- `server.type: "node"`, `entry_point: dist/index.js`
- `compatibility.platforms: ["darwin", "linux", "win32"]`
- `compatibility.runtimes.node: ">=24.0.0"`

To customize: edit `manifest.json` (e.g. add a `icon` field, update the description) — the build script reads it verbatim and only overrides `version` from `package.json`.

See `../../docs/ARCHITECTURE.md` for the full package map.

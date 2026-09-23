# Operations and runtime — commands, env, watchdog, lifecycle, logs, troubleshooting, cloud agents, MCP configs

Moved verbatim from `AGENTS.md` on 2026-09-24 (BACKLOG B28 reopened); "this file" in the text below means `AGENTS.md` as it was then.

## Commands

| Command | Purpose |
|---|---|
| `pnpm install` | Install workspace deps |
| `pnpm build` | Turbo: build everything (TS + optional native) |
| `pnpm dev` | Turbo: watch mode across all packages |
| `pnpm test` | Run all unit + integration tests (no coverage — fast) |
| `pnpm test:no-native` | Force TS fallback path (`MCP_DISABLE_NATIVE=1`) |
| `COVERAGE=1 pnpm test` | Collect coverage + write reports (lcov in CI, html locally). **Non-gating.** |
| `COVERAGE=1 COVERAGE_GATE=1 pnpm test` | Additionally FAIL under-threshold (the future gate; dormant in CI today) |
| `pnpm typecheck` | Turbo: `tsc --noEmit` per package |
| `pnpm lint` | Biome check |
| `pnpm lint:fix` | Biome write |
| `pnpm stress` | Run every MCP app's stress harness against its built bin (browser-tab: 14 cases) |
| `pnpm deps:check [--registry] [--all] [--filter X]` | Dependency freshness. Reads the **resolved** version out of `node_modules`, never the manifest — a specifier is not evidence of what runs. Offline it checks install integrity only; `--registry` is the mode that matters and it separates **STARVED** (a 0.x caret pins the MINOR, so no install can ever reach the new version — blocking) from **LOCK-STALE** (the range admits it, the install hasn't — `pnpm update`) from an ordinary next-major, which is collapsed to one line because reporting it as a defect is how a report stops being read. Three real instances preceded it, each found by an outside session rather than by us. |
| `pnpm verify` | lint + typecheck + test + build (CI shape) |
| `pnpm verify:macos` | **the checks CI no longer makes.** Compiles rust-accel's `#[cfg(target_os = "macos")]` CoreGraphics code, loads the built `.node`, calls `listCgWindows()`/`listDisplays()` for real, asserts the `#[napi(js_name)]` field names at runtime, then runs the suite on the native path. Wired to `.githooks/pre-push`. |

Per-app:
- `pnpm --filter browser-tab-mcp dev:mcp` — `tsx src/cli.ts mcp` with env files loaded
- `pnpm --filter browser-tab-mcp mcp` — run the built MCP via stdio
- `pnpm --filter browser-tab-mcp tui` — launch the Ink TUI
- `pnpm --filter browser-tab-mcp doctor` — preflight checks (Node, native module, Automation TCC, correlation tier)
- `node apps/browser-tab-mcp/dist/cli.js daemon run|install|status|token` — daemon lifecycle (launchd label `com.george43g.browser-tab`)
- `pnpm --filter @george43g/chrome-extension build` — MV3 bundle → `apps/chrome-extension/dist` (load unpacked)
- `pnpm --filter @george43g/safari-extension convert` — (re)generate the Safari Xcode project (full Xcode; only when the file set / manifest structure changes — regen re-unsigns)
- `pnpm --filter @george43g/safari-extension sideload` — fast Safari loop: prune → build dist → `xcodebuild` → open app to re-register (code-only changes; **named `sideload`, not `rebuild`, which is a pnpm built-in**)
- `pnpm --filter @george43g/safari-extension unregister` — prune stale/duplicate Safari extension registrations (`clean.sh --all` for a hard reset)
- `pnpm --filter @george43g/browser-tab-mcp stress:tui` — TUI soak. **Two independent verdicts, and neither may swallow the other:** the workload (`stress-tui-workload.tsx`) owns CORRECTNESS — it renders the real `App` against a real daemon across six terminal geometries and fails on any frame taller than the terminal or any line wider than it (measured in cells via `visualWidth`, not glyphs) — while the driver (`stress-tui.ts`) owns RESOURCES (RSS / event-loop p99 from the watchdog state file) **and derives the correctness verdict from the workload's report file**, so a real frame violation reaches the exit code even if a hang-kill would have suppressed it (the phantom-pass fix). The driver fails if the workload dies prematurely or the report is unreadable. **Zero collected samples is a failure**, not a clean run: the harness previously printed `max RSS 0MB, max lag 0ms, 0 samples` and exited 0. Phase A must stay async — a synchronous hot loop starves the event loop and the watchdog never ticks, which is exactly how that happened. Scale the render phase with `BROWSER_TAB_FAKE_SCALE` / `BROWSER_TAB_FAKE_TABS`: the fake adapter's default titles are far too short to reach a width budget, and rendering them measures the fixture, not the layout.

State/paths at runtime: socket `~/.browser-tab/daemon.sock`, extension token `~/.browser-tab/extension-token`, snapshot cache `~/.cache/browser-tab/{snapshot,last}.json`, liveness beacon `~/.cache/browser-tab/heartbeat.json`, launchd logs `~/Library/Logs/browser-tab/`.

**Heartbeat vs snapshot — two files, two meanings, don't merge them.** `snapshot.json` is rewritten ONLY on a state diff (debounced ≤1/s), so its mtime means *"state changed"* and can be hours old while perfectly correct — it cannot distinguish a quiet daemon from a dead one. `heartbeat.json` (`SnapshotWriter.heartbeat`, `daemon/paths.ts:heartbeatPath`) is written at the **end of every completed engine tick** via `EngineLoop.setOnTick`, so its mtime means *"alive"*. It rides the tick rather than a `setInterval` **on purpose**: a timer keeps beating while the read loop is wedged on a hung `osascript`, which is exactly the failure a consumer is trying to detect. It's removed on a clean `stop()` so a stopped daemon reads as down immediately; a crash leaves it to age out. Carries `snapshotChangedAt` so one read separates "alive" from "current". Shell consumers `stat` it instead of forking `daemon status` (~130ms of node boot). New env: `BROWSER_TAB_HEARTBEAT_PATH`.

## Env layout (Vite-style precedence)

For any `--mode`, env files load in this order (each overrides the previous):

```
.env  →  .env.local  →  .env.[mode]  →  .env.[mode].local
```

- `.env` (gitignored): baseline defaults
- `.env.local` (gitignored): your machine-specific paths/tokens
- `.env.test` (gitignored, per-machine): test-mode overrides for Vitest's default `test` mode
- **`apps/browser-tab-mcp/.env.example` (committed)**: the exhaustive list of every recognized variable with its default. This lives in the app, not the repo root — the `--env-file-if-exists` flags are per-app. Adding a new `process.env.X` / `env*("X")` read means adding it here in the same commit.

Scripts in each app's `package.json` pass `--env-file-if-exists` flags so the precedence is honored without dotenv. The `@george43g/env-loader` package implements the same precedence for tools that need to read env before spawning a subprocess (e.g., the dev MCP proxy).

**Rule (curated, not exhaustive)**: a deliberately small set of env vars is *also* accepted as a CLI flag — the ones you plausibly flip for a single invocation. The list is `ENV_FLAGS` in `apps/browser-tab-mcp/src/env-flags.ts` (10 today: `--log-dir`, `--disable-native`, `--socket-path`, `--ws-port`, `--state-dir`, `--cache-dir`, `--browsers`, `--poll-ms`, `--fake-adapter`, `--dev`), bound via `bindEnvFlags`/`applyEnvFromFlags` from `@george43g/cli-kit/env-flag-binder` with `stripPrefixes: ["BROWSER_TAB_", "MCP_"]`. Flag names are *derived* (`BROWSER_TAB_SOCKET_PATH` → `--socket-path`), precedence is flag > env. Everything else is env-only by design: most of the ~68 settable vars are robustness tuning that belongs in an env file, and each flag costs a `--help` line, a completion entry and a manpage row. **Adding one trips `pnpm check:usage`** — update `apps/browser-tab-mcp/.usage.kdl` and regenerate `completions/`, `man/`, `docs/cli/` (never hand-edit those).

## Self-healing watchdog

Three monitors run on unref'd timers. They self-kill the process via `shutdown()` when something is unrecoverable, so the MCP host (Cursor/Claude/Warp) respawns a clean instance.

| Monitor | Trigger | Default | Env override |
|---|---|---|---|
| Event-loop lag (spike) | p99 lag over 5s window | warn 500ms / kill 10s | `MCP_EVENT_LOOP_WARN_MS`, `MCP_EVENT_LOOP_KILL_MS`, `MCP_EVENT_LOOP_SAMPLE_MS` |
| Event-loop lag (sustained) | p99 ≥ threshold for N consecutive samples | 750ms × 6 samples | `MCP_EVENT_LOOP_SUSTAINED_MS`, `MCP_EVENT_LOOP_SUSTAINED_SAMPLES` |
| Memory | RSS exceeded OR 10 consecutive monotonic heap growth samples | RSS 1024MB | `MCP_MAX_RSS_MB`, `MCP_HEAP_GROWTH_SAMPLES`, `MCP_MEMORY_SAMPLE_MS` |
| Idle/uptime | uptime > 24h AND no activity for 1h | 24h / 1h | `MCP_RESTART_AFTER_MS`, `MCP_RESTART_QUIET_MS`, `MCP_IDLE_CHECK_MS` |

The watchdog writes its state to JSON each tick when `MCP_WATCHDOG_STATE_PATH` is set, so external observers (CI stress harness, dashboards) can sample without parsing logs.

## Process lifecycle

- `@george43g/robustness/shutdown` — central cleanup registry. All entry points register cleanup functions. Traps SIGINT, SIGTERM, SIGHUP, SIGQUIT, stdin EOF (MCP host died), and parent-PID change (orphan reparenting to launchd/init).
- 3s safety net force-exit if cleanup stalls.

## Logs

**Three prefixes, one per process kind, and the prefix IS the directory.** The logger resolves
its directory as `join(tmpdir(), logFilePrefix())`, so branding a process moves its whole log
directory, not just the filename:

| Process | Brands in | Directory |
|---|---|---|
| MCP server (`mcp`), TUI (`tui`) | `src/index.ts`, `src/tui/index.tsx` | `$TMPDIR/browser-tab-mcp/` |
| daemon (`daemon run`) | `src/daemon/index.ts` | `$TMPDIR/browser-tab-daemon/` |
| every other CLI subcommand | `main()` in `src/cli.ts` | `$TMPDIR/browser-tab-cli/` |

The CLI one is **not** merged into `browser-tab-mcp/` on purpose: `pruneLogs` keeps N files per
*directory* (default 5) and protects only a live process's newest file, so CLI one-shots sharing
a directory would evict the long-lived server's session history. Until 2026-08-23 the CLI
branded nothing at all and fell through to robustness's default `$TMPDIR/mcp/` — a bucket shared
with every other tool built from this template that also forgot, and with this repo's own vitest
runs. `tests/cli-log-branding.integration.test.ts` is the guard; adding a new process entry point
means branding it there too.

Filenames are `{prefix}-{PID}-{date}.ndjson`. Lines:
- `level: "info" | "warn" | "error"` — events
- `level: "perf"` with `dur_ms` — performance spans
- `msg: "heartbeat"` — periodic memory/uptime (every 60s)
- `msg: "startup"` / `msg: "shutdown"` — process markers (file without `shutdown` = crash)

Also in-memory ring buffer (last 500 lines). In dev mode (`MCP_DEV=1`), a `get_logs` MCP tool is registered for AI-driven log inspection.

## Troubleshooting

- **Build hangs**: check `pnpm dev` isn't already running in another shell (Vite watch can deadlock turbo).
- **Native module fails to load**: run `pnpm --filter rust-accel build` manually. If it fails with "rustc not found", install Rust or set `MCP_DISABLE_NATIVE=1`.
- **MCP host doesn't see tool changes**: the dev proxy auto-reloads on `src/**` but the host caches the session. Restart your MCP host (Cursor/Claude/Warp).
- **Orphaned MCP processes**: `ps aux | grep browser-tab` and kill stragglers. The shutdown registry should catch this, but if it doesn't, file a bug.

## Cloud-agent (Cursor/Claude/Codex remote) specifics

- **Node version**: ≥24. The setup script handles `nvm install 24` and corepack/pnpm activation.
- **Environment mode**: on Linux/cloud, `.env.test` covers test mode; `.env.local` is per-developer and should not exist in cloud workspaces. If the agent needs a baseline config, fill `.env` from `.env.example`.
- **Native module**: cloud workspaces typically lack a Rust toolchain. The `build:native:optional` script silently skips when `rustc` is missing; the TS fallback path is used automatically.
- **Running tests**: `pnpm test` (default mode). Tests gate behavior with `MCP_DISABLE_NATIVE=1` where the native path can't be assumed.

## MCP servers (project scope)

Canonical set: `.mcp.json` (standard MCP schema, `${VAR}` placeholders only —
never literal secrets). `.cursor/mcp.json` and `.warp/.mcp.json` are symlinks
to it; `opencode.json`'s `mcp` key is GENERATED. All four are owned by the
global **`mcpsync`** CLI (it retired the old `~/dotfiles/mcp/render.js` on
2026-08-03) — regenerate the whole set from the repo root with:
`mcpsync sync --scope project`. Global servers and scope decisions:
`~/dotfiles/docs/mcp-registry.md`.

**Everything release-please rewrites is Biome-excluded too** — the root
`package.json`, `apps/browser-tab-mcp/package.json`, and the connector's
`package.json` + `public/manifest.json`. release-please **re-serialises** each
JSON file it touches rather than editing one line, so its output format is its
own: cutting v1.2.0 expanded `"host_permissions": ["<all_urls>"]` across three
lines and turned `pnpm lint` red on `main` at the release commit, after the
release had shipped. Same principle as the mcpsync/napi files below — a tool
owns the format, so Biome doesn't. `release-versions.contract.test.ts` fails if
a release-please-owned file is missing its `!` entry.

These four files are **Biome-excluded** (`biome.json` `files.includes`): mcpsync
owns their format and emits expanded JSON that Biome's formatter would rewrite,
so — like the napi-generated `apps/rust-accel/index.{js,d.ts}` — they're
tool-owned and out of Biome's jurisdiction. Don't hand-format them or re-add
them to the lint set; edit `.mcp.json` then re-run `mcpsync sync --scope project`.

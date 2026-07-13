# browser-tab-mcp

MCP server + CLI + TUI, cloned from `mcp-cli-starter-template`.

## Quick start

```bash
pnpm install
pnpm build           # compile TS + (optional) Rust accelerator
pnpm test            # run unit + integration tests
pnpm stress          # 9-case robustness harness
```

## Bins

| Bin | Purpose | Default transport |
|-----|---------|-------------------|
| `browser-tab-mcp` | MCP server | stdio (`--http` for Streamable HTTP) |
| `browser-tab-cli` | Commander CLI: `mcp`, `http`, `tui`, `doctor`, `health`, `noop`, `cli` (REPL) | n/a (in-process dispatch) |
| `browser-tab-tui` | Ink TUI | n/a |

## Adding a tool

1. Copy `src/tools/noop.ts` to `src/tools/<your-tool>.ts`.
2. Define Zod input/output schemas (in `@george43g/shared-types` if you want to mirror in Rust, else inline in the tool file).
3. Register the new tool in `src/tools/registry.ts`.
4. Add an integration test in `tests/integration.test.ts`.
5. If the tool affects process lifecycle, add a case in `scripts/stress-mcp.ts`.

The dispatcher already wires `withTimeout`, `perf` spans, abort propagation, structured error wrapping, and structuredContent return — your handler just needs to be a pure `(input, signal) => output` async function.

## Removing surfaces

- **Drop HTTP support**: delete the `http` subcommand from `src/cli.ts`, the `--http` branch from `src/index.ts`, and case #9 from `scripts/stress-mcp.ts`. Remove `MCP_HTTP_TOKEN` from `.env.example`.
- **Drop TUI support**: delete `src/tui/`, the `tui` subcommand from `src/cli.ts`, the `browser-tab-tui` bin entry from `package.json`, and the TUI entry from `vite.config.ts` `lib.entry`.
- **Drop Rust acceleration**: delete `apps/rust-accel/`, the `src/native-bridge.ts` file, and the `tryLoadNative()` call in `src/tools/noop.ts`.
- **Drop `get_logs`**: delete `src/tools/get-logs.ts` and remove it from the registry.

## Shell completions

Bash/zsh/fish completions + manpage + per-subcommand markdown docs are generated on demand from `.usage.kdl` via `usage(1)`. The scaffold ships the spec + the regen tasks but NOT the pre-generated artifacts (they reference the clone's actual bin name, not the placeholder).

The intended workflow is: generate the artifacts once, commit them, then let CI's `pnpm check:usage` step (and the matching `cli-artifacts-drift` workflow on the scaffolder side) fail any future edit that changes `.usage.kdl` without a matching regen.

First-run flow:

```bash
mise install                                  # one-time: installs usage(1)
pnpm artifacts                                # regenerate completions/ + man/ + docs/cli/
git add completions man docs/cli              # check in the baseline
git commit -m "chore: initial usage(1) artifacts"
pnpm completions:install                      # auto-detect $SHELL and install into the right path
```

From the second run forward, `pnpm check:usage` (and CI) enforces freshness — edit `.usage.kdl` and forget to regen, build fails.

`completions:install` (script: `scripts/install-completions.sh`) handles the well-known locations for each shell:

| Shell | Default install path |
|-------|----------------------|
| bash  | `~/.local/share/bash-completion/completions/browser-tab` (XDG) or `~/.bash_completion.d/browser-tab` |
| zsh   | `${ZDOTDIR:-~}/.zsh/completion/_browser-tab` |
| fish  | `~/.config/fish/completions/browser-tab.fish` |

CI gate `scripts/check-usage-freshness.mjs` (`pnpm check:usage`) fails the build if `.usage.kdl` was edited without regenerating the artifacts.

## Install in Claude Desktop (.mcpb bundle)

Claude Desktop loads MCP servers from `.mcpb` bundles — zip archives with a `manifest.json` + the runtime files. Build one with:

```bash
pnpm pack:mcpb         # runs `pnpm build` then bundles into browser-tab-mcp-<version>.mcpb
```

The output `.mcpb` drops into Claude Desktop via drag-and-drop (or **Settings → Extensions → Install from file**). Claude reads `manifest.json` (MCPB spec v0.3), spawns `node ${__dirname}/dist/index.js` for stdio transport, and surfaces this server's tools + resources in the catalogue.

The shipping manifest lives at `manifest.json` and pins:

- `manifest_version: "0.3"` — MCPB spec pin
- `server.type: "node"`, `entry_point: dist/index.js`
- `compatibility.platforms: ["darwin", "linux", "win32"]`
- `compatibility.runtimes.node: ">=24.0.0"`

To customize: edit `manifest.json` (e.g. add a `icon` field, update the description) — the build script reads it verbatim and only overrides `version` from `package.json`.

See `../../docs/ARCHITECTURE.md` for the full package map.

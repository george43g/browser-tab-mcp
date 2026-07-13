<div align="center">

# browser-tab

**MCP server + CLI + TUI — one bin, three surfaces, production-ready from commit 1.**

[![CI](https://github.com/george43g/mcp-cli-starter-template/actions/workflows/ci.yml/badge.svg)](https://github.com/george43g/mcp-cli-starter-template/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@george43g/browser-tab-mcp.svg)](https://www.npmjs.com/package/@george43g/browser-tab-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

[Install](#install) · [Tools](#tools) · [Connect from your editor](#one-click-install) · [Docs](#docs) · [Skill for AI agents](#install-the-companion-skill)

![browser-tab TUI](docs/screenshots/overview.gif)

</div>

---

> **This README is a scaffold.** Edit it to describe what your tool actually does. The structure below — install snippets, tool table, IDE integrations, skill install — is the recommended public-style format.

## Install

```bash
# Run directly (no install needed)
npx @george43g/browser-tab-mcp mcp

# Or install globally
npm  install -g @george43g/browser-tab-mcp
pnpm add  -g @george43g/browser-tab-mcp
```

After install, `browser-tab` is on your PATH. All subcommands route through that single bin:

```bash
browser-tab mcp              # run the MCP server (stdio)
browser-tab mcp --http       # run via Streamable HTTP (requires MCP_HTTP_TOKEN)
browser-tab tui              # launch the Ink TUI
browser-tab doctor           # preflight checks (Node version, native deps, env)
browser-tab repl             # interactive REPL — same dispatcher as MCP
browser-tab health           # one-shot health snapshot
browser-tab noop --input hi  # call any tool directly from the CLI
```

## One-click install

Paste these into your MCP host's config. The bin name is `browser-tab` once installed via npm; the `npx` form works without a local install.

### Claude Desktop / Code (`claude_desktop_config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "browser-tab": {
      "command": "npx",
      "args": ["-y", "@george43g/browser-tab-mcp", "mcp"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "browser-tab": {
      "command": "npx",
      "args": ["-y", "@george43g/browser-tab-mcp", "mcp"]
    }
  }
}
```

### Warp / Codex / OpenCode

Identical JSON snippet — they all consume the same shape under `mcpServers`. See `opencode.json` and `.cursor/mcp.json` in this repo for working examples (with relative paths for local dev).

## Tools

The starter ships two demo tools plus a dev-only log inspector. Replace these with your own — declare a `ToolDefinition` in `src/tools/<name>.ts`, register it in `src/tools/registry.ts`, and it'll appear in MCP `tools/list`, the CLI as a subcommand, and the REPL automatically.

| Tool | Description | Annotations |
|---|---|---|
| `health_check` | Returns server/runtime/transport snapshot. Never touches external I/O. | read-only, idempotent |
| `noop` | Echo a string (optionally upper-cased). Demonstrates the Rust acceleration fallback path. | read-only, idempotent |
| `get_logs` | **Dev-mode only** (`BROWSER_TAB_DEV=1`). Returns the last N lines from the in-memory ring buffer. | read-only |

## Install the companion skill

This repo ships with a Claude skill that teaches an AI agent how to use your tool end-to-end. The skill lives at `skills/browser-tab/SKILL.md` and is meant to be rewritten by you (or by the AI itself, after first reading the tool) to document the tool's actual behavior.

```bash
# Copy the skill into your global Claude skills dir
mkdir -p ~/.claude/skills/browser-tab
cp skills/browser-tab/SKILL.md ~/.claude/skills/browser-tab/

# Or symlink (so updates from this repo show up automatically)
ln -s "$(pwd)/skills/browser-tab/SKILL.md" ~/.claude/skills/browser-tab/SKILL.md
```

## Docs

| File | What it covers |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Canonical agent guide (also `CLAUDE.md`, `.cursorrules` as symlinks) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How packages fit together; which to delete if you don't need a surface |
| [`docs/HTTP_MODE.md`](docs/HTTP_MODE.md) | Streamable HTTP transport: bearer auth, `/health`, reverse-proxy patterns |
| [`docs/RUST_ACCELERATION.md`](docs/RUST_ACCELERATION.md) | napi-rs build, `.node` binary handling, drift-check between Zod and serde |
| [`docs/TUI_DESIGN.md`](docs/TUI_DESIGN.md) | Theme system, keybindings, dev stats, cache invariants |
| [`docs/GUARDRAILS_MCP_RESPONSES.md`](docs/GUARDRAILS_MCP_RESPONSES.md) | UUID-gated instructions + prompt-injection defense |
| [`docs/RELEASE.md`](docs/RELEASE.md) | Enabling semantic-release for npm publish |

## What's inside (template author's eyes only)

This section is for the engineer running the scaffolder — delete it once you've made the tool your own.

```
apps/
  browser-tab-mcp/             your tool — clone-and-rename target
    src/
      cli.ts                THE SINGLE BIN — commander dispatch
      index.ts              runMcpServer() + callMcpTool() (library exports)
      commands/http.ts      HTTP transport wiring (delete file to drop HTTP)
      tui/                  Ink TUI — delete dir + the `tui` subcmd if not needed
      tools/                health_check + noop demo + dev-only get_logs
      dispatcher.ts         invariants block; withTimeout + perf + abort + error wrap
      native-bridge.ts      tryLoadNative() with MCP_DISABLE_NATIVE escape
    scripts/
      mcp-dev-proxy.ts      handshake-replay proxy for live source-reload
      stress-mcp.ts         9-case robustness harness
      screenshots/          VHS .tape files driving docs/screenshots/*.gif
    .usage.kdl              CLI spec → completions + manpage + markdown docs
  rust-accel/               napi-rs crate (optional acceleration)

packages/
  robustness, mcp-kit, cli-kit, tui-kit, env-loader, secrets, shared-types,
  tsconfig, biome-config, vitest-config

mise.toml                   toolchain pins (node, pnpm) + named tasks
.github/workflows/          ci.yml, release.yml (disabled by default), readme-check.yml, screenshots.yml
docs/                       Mintlify-ready (docs.json + MDX pages)
skills/browser-tab/             Repo-installable companion skill (rewrite at scaffold time)
```

## License

MIT

/**
 * The curated env-var ↔ CLI-flag contract.
 *
 * AGENTS.md used to claim "every recognized env var is also accepted as a CLI
 * flag". That was never true — ~46 vars are recognized and none were bound. A
 * flag for every knob is also the wrong goal: most are robustness tuning that
 * belongs in env files, and each one costs a line of `--help`, a completion
 * entry and a manpage row.
 *
 * So the contract is now explicit and small: these are the knobs you plausibly
 * flip for ONE invocation — paths, ports, target browsers, and the two dev
 * toggles. They are also exactly what the e2e harness already sets via env to
 * drive an isolated daemon, so binding them makes that reproducible by hand.
 *
 * Everything else stays env-only and is documented in `.env.example`.
 *
 * Flag names are derived by `bindEnvFlags`: strip the prefix, lowercase,
 * `_` → `-`. `BROWSER_TAB_SOCKET_PATH` → `--socket-path`. Precedence is
 * flag > env, applied by `applyEnvFromFlags` before anything reads env.
 */

import type { BinderOptions, EnvFlagBinding } from "@george43g/cli-kit";

export const ENV_FLAG_OPTS: BinderOptions = { stripPrefixes: ["BROWSER_TAB_", "MCP_"] };

export const ENV_FLAGS: EnvFlagBinding[] = [
  { envVar: "MCP_LOG_DIR", description: "Directory for NDJSON logs" },
  {
    envVar: "MCP_DISABLE_NATIVE",
    description: "Force the TS path, skipping the native module",
    boolean: true,
  },
  { envVar: "BROWSER_TAB_SOCKET_PATH", description: "Daemon unix socket path" },
  { envVar: "BROWSER_TAB_WS_PORT", description: "Extension WebSocket port (127.0.0.1)" },
  { envVar: "BROWSER_TAB_STATE_DIR", description: "Daemon state dir (token, journals)" },
  { envVar: "BROWSER_TAB_CACHE_DIR", description: "Snapshot/content/screenshot cache dir" },
  { envVar: "BROWSER_TAB_BROWSERS", description: "Comma-separated browsers to poll" },
  { envVar: "BROWSER_TAB_POLL_MS", description: "AppleScript poll interval in ms" },
  {
    envVar: "BROWSER_TAB_FAKE_ADAPTER",
    description: "Use the fake adapter (no real browsers)",
    boolean: true,
  },
  { envVar: "MCP_DEV", description: "Enable dev-only tools such as get_logs", boolean: true },
];

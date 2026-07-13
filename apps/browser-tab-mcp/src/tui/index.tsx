/**
 * TUI entry — wraps the App in ThemeProvider + fullscreen-ink, installs
 * the shutdown registry, and returns once the user quits.
 *
 * Loaded dynamically by `src/cli.ts` when the `tui` subcommand runs.
 * Not a separate bin — the single `browser-tab` bin dispatches via subcommands.
 *
 * To remove TUI support: delete this file + `src/tui/`, drop the `tui`
 * subcommand from `src/cli.ts`.
 */

import {
  envStr,
  installShutdownHandlers,
  installWatchdog,
  logStartup,
  registerCleanup,
  setLogFilePrefix,
  startHeapMonitor,
} from "@george43g/robustness";
import { renderFullScreen, ThemeProvider } from "@george43g/tui-kit";
import { APP_NAME } from "../meta.js";
import { App } from "./App.js";

export async function runTui(): Promise<void> {
  const slug = APP_NAME.replace(/^@[^/]+\//, "");
  setLogFilePrefix(slug);

  installShutdownHandlers();
  installWatchdog();
  startHeapMonitor();
  logStartup(`${APP_NAME}-tui`);

  const preset = envStr("MCP_TUI_THEME", "safe") as "safe" | "powerline";
  const accent = envStr("MCP_TUI_ACCENT", "#1982FC");

  const screen = await renderFullScreen(
    <ThemeProvider preset={preset} accent={accent}>
      <App />
    </ThemeProvider>,
  );

  registerCleanup(() => screen.unmount());

  await screen.waitUntilExit();
}

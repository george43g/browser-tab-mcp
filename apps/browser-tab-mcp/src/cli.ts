/**
 * browser-tab — the single bin. Commander dispatch over subcommands.
 *
 * Subcommands:
 *   mcp                 Run the MCP server (stdio)
 *   tui                 Launch the Ink TUI
 *   doctor              Run preflight checks
 *   health              Print a health snapshot (calls health_check in-process)
 *   noop --input ...    Demo: call the noop tool in-process
 *   repl                Drop into an interactive REPL driving the dispatcher
 *
 * To remove TUI support: delete the `tui` subcommand below + `src/tui/`.
 */

import { copyFileSync } from "node:fs";
import {
  applyEnvFromFlags,
  bindEnvFlags,
  color,
  isInteractive,
  printJson,
  resolveOutputMode,
} from "@george43g/cli-kit";
import { WIRE_PROTOCOL_VERSION } from "@george43g/shared-types";
import { Command } from "commander";
import { checkLocalAccess, formatAccessReport } from "./access-check.js";
import { compareBuilds } from "./build-compare.js";
import { daemonStatus } from "./client/tabs-service.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { callMcpTool } from "./dispatcher.js";
import { ENV_FLAG_OPTS, ENV_FLAGS } from "./env-flags.js";
import { runMcpServer } from "./index.js";
import { APP_NAME, APP_VERSION, buildStamp, builtAt } from "./meta.js";
import { layoutWidth, renderForTool } from "./render.js";

/** Parse a `--bounds x,y,w,h` string into a WindowBounds, or undefined when absent. */
function parseBounds(s?: string): { x: number; y: number; w: number; h: number } | undefined {
  if (!s) return undefined;
  const parts = s.split(",").map((n) => Number.parseInt(n.trim(), 10));
  const [x, y, w, h] = parts;
  if (parts.length !== 4 || [x, y, w, h].some((n) => n === undefined || Number.isNaN(n))) {
    throw new Error(`--bounds must be four integers "x,y,w,h"; got "${s}".`);
  }
  return { x: x as number, y: y as number, w: w as number, h: h as number };
}

/**
 * Print a tool result.
 *
 * Mode comes from cli-kit's `resolveOutputMode`: explicit `--json` wins, then a
 * non-TTY stdout (being piped), then `CI=true`, else human. So every existing
 * script keeps byte-identical JSON and only an interactive terminal gets prose.
 *
 * `tool` is optional: pass it to opt a command into a human renderer. Without
 * one — or for a tool `renderForTool` doesn't know — output falls back to the
 * dispatcher's JSON text block, so nothing silently loses information.
 */
async function printResult(
  result: Awaited<ReturnType<typeof callMcpTool>>,
  json: boolean,
  tool?: string,
) {
  if (resolveOutputMode({ json }) === "json") {
    printJson(result.structuredContent ?? result);
    return;
  }
  const human =
    tool && !result.isError
      ? renderForTool(tool, result.structuredContent, layoutWidth())
      : undefined;
  if (human !== undefined) {
    process.stdout.write(`${human}\n`);
    return;
  }
  for (const item of result.content ?? []) {
    if (item.type === "text") {
      process.stdout.write(`${item.text}\n`);
    } else if (item.type === "image") {
      process.stdout.write(`[image ${item.mimeType}, ${item.data.length} base64 chars]\n`);
    }
  }
  if (result.isError) process.exit(1);
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = new Command();
  // Bin name = the tool name (no -cli suffix). Subcommands route to MCP/TUI/etc.
  program
    .name(APP_NAME.replace(/^@[^/]+\//, "").replace(/-mcp$/, ""))
    .description("browser-tab — single bin; subcommands run the MCP server, TUI, doctor, etc.")
    // Report the BUILD, not just the semver — semver only moves on release, so
    // it cannot tell you which of two builds is actually running.
    .version(builtAt() ? `${buildStamp()} (built ${builtAt()})` : buildStamp(), "-V, --version")
    .option("--json", "Emit machine-readable JSON")
    .option("-q, --quiet", "Suppress non-error output")
    .option("-v, --verbose", "Log debug-level info to stderr")
    .option("--no-color", "Disable colors");

  // The curated env↔flag contract (see env-flags.ts). Registered on the ROOT
  // command so `browser-tab --socket-path … daemon status` works for every
  // subcommand, and applied via a preAction hook so the values are in
  // process.env before any action reads them.
  bindEnvFlags(program, ENV_FLAGS, ENV_FLAG_OPTS);
  program.hook("preAction", () => {
    applyEnvFromFlags(program, ENV_FLAGS, ENV_FLAG_OPTS);
  });

  program
    .command("mcp")
    .description("Run the MCP server (stdio)")
    .action(async () => {
      await runMcpServer();
    });

  program
    .command("tui")
    .description("Launch the Ink TUI")
    .action(async () => {
      if (!isInteractive()) {
        process.stderr.write(
          `${color.yellow("Refusing to launch TUI: stdin or stdout is not a TTY.")}\n`,
        );
        process.exit(1);
      }
      const { runTui } = await import("./tui/index.js");
      await runTui();
    });

  program
    .command("doctor")
    .description("Run preflight checks (Node version, native module, config dir)")
    .action(async () => {
      const report = await checkLocalAccess();
      process.stdout.write(`${formatAccessReport(report)}\n`);
      // Extension staleness — best-effort; only meaningful when the daemon is up
      // (a down daemon yields no extensionInfo, so this simply prints nothing).
      const status = await daemonStatus();
      const extInfo = (status.extensionInfo ?? []) as Array<{
        browser: string;
        protocolVersion: number;
        stale: boolean;
        extVersion?: string;
      }>;
      for (const e of extInfo) {
        if (!e.stale) continue;
        process.stdout.write(
          `⚠ ${e.browser} extension is stale (protocol v${e.protocolVersion} < daemon v${WIRE_PROTOCOL_VERSION}) — reload it (chrome://extensions) or sideload+toggle (Safari) to restore v2 commands, journaling, and capabilities.\n`,
        );
      }

      // Protocol staleness only catches a bundle old enough to speak an older
      // wire version. A rebuild that was never reloaded speaks the SAME
      // protocol while running different code — invisible until something
      // misbehaves. Build stamps make it obvious.
      const daemonBuild = typeof status.build === "string" ? status.build : null;
      if (daemonBuild) {
        process.stdout.write(`  ℹ  daemon build ${daemonBuild}\n`);
        const reload = "Reload it (chrome://extensions) or sideload+toggle (Safari).";
        for (const e of extInfo) {
          if (!e.extVersion) continue;
          const cmp = compareBuilds(daemonBuild, e.extVersion);
          if (cmp.kind === "unstamped") {
            process.stdout.write(
              `⚠ ${e.browser} extension reports "${e.extVersion}" with no build stamp — it predates build stamping. Rebuild and reload it.\n`,
            );
          } else if (cmp.kind === "mismatch") {
            process.stdout.write(
              `⚠ ${e.browser} extension build ${e.extVersion} ≠ daemon build ${daemonBuild} — a rebuilt extension is not a reloaded one. ${reload}\n`,
            );
          }
        }
      }
      if (!report.ok) process.exit(1);
    });

  program
    .command("health")
    .description("Print server health snapshot")
    .action(async () => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("health_check", {});
      await printResult(result, json);
    });

  program
    .command("list")
    .description("List open browser windows and tabs (Chrome/Brave/Chromium/Safari)")
    .option("--browser <name>", "Restrict to one browser: chrome|chromium|brave|safari")
    .option("--window <id>", "Restrict to one window (opaque windowId from a previous list)")
    .option("--url <substring>", "Filter tabs by URL substring (drops non-matching windows)")
    .option("--fields <set>", "Field set: core (trimmed) or full (default)", "full")
    .action(async (opts: { browser?: string; window?: string; url?: string; fields?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("list_tabs", {
        ...(opts.browser ? { browser: opts.browser } : {}),
        ...(opts.window ? { windowId: opts.window } : {}),
        ...(opts.url ? { urlFilter: opts.url } : {}),
        fields: opts.fields === "core" ? "core" : "full",
      });
      await printResult(result, json, "list_tabs");
    });

  program
    .command("journal")
    .description("Show recorded focus/navigation history (windowMru|tabMru|journey|recent)")
    .option("--view <view>", "windowMru | tabMru | journey | recent", "recent")
    .option("--browser <name>", "Restrict to one browser")
    .option("--window <id>", "Window handle (required for tabMru)")
    .option("--tab <id>", "Tab handle (required for journey)")
    .option("--limit <n>", "Max records", "20")
    .action(
      async (opts: {
        view?: string;
        browser?: string;
        window?: string;
        tab?: string;
        limit?: string;
      }) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("journal", {
          view: opts.view ?? "recent",
          ...(opts.browser ? { browser: opts.browser } : {}),
          ...(opts.window ? { windowId: opts.window } : {}),
          ...(opts.tab ? { tabId: opts.tab } : {}),
          limit: Number.parseInt(opts.limit ?? "20", 10),
        });
        await printResult(result, json, "journal");
      },
    );

  program
    .command("history")
    .description("Query the browser's global URL history (Chrome-family; Safari opt-in)")
    .option("--browser <name>", "Limit to one browser (omit to merge all reachable sources)")
    .option("--query <text>", "Case-insensitive substring filter on URL/title")
    .option("--start <ms>", "Only visits at/after this epoch ms")
    .option("--end <ms>", "Only visits at/before this epoch ms")
    .option("--limit <n>", "Max rows", "50")
    .action(
      async (opts: {
        browser?: string;
        query?: string;
        start?: string;
        end?: string;
        limit?: string;
      }) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("history", {
          ...(opts.browser ? { browser: opts.browser } : {}),
          ...(opts.query ? { query: opts.query } : {}),
          ...(opts.start ? { startTime: Number.parseInt(opts.start, 10) } : {}),
          ...(opts.end ? { endTime: Number.parseInt(opts.end, 10) } : {}),
          maxResults: Number.parseInt(opts.limit ?? "50", 10),
        });
        await printResult(result, json, "history");
      },
    );

  program
    .command("page")
    .description("Extract a tab's content or live state (needs daemon + extension)")
    .argument("<tabId>", "Extension-generation tab handle from `browser-tab list`")
    .option("--mode <mode>", "text | metadata | state", "text")
    .option("--force", "Bypass the navEpoch cache and re-extract", false)
    .action(async (tabId: string, opts: { mode?: string; force?: boolean }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("get_page", {
        tabId,
        mode: opts.mode ?? "text",
        force: opts.force ?? false,
      });
      await printResult(result, json);
    });

  program
    .command("annotate")
    .description("Read or write a URL-keyed note in the daemon annotation store")
    .argument("<url>", "The page URL to annotate")
    .option("--note <text>", "Note to store (omit to read the existing note)")
    .action(async (url: string, opts: { note?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("annotate", {
        url,
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      });
      await printResult(result, json);
    });

  program
    .command("screenshot")
    .description("Capture a tab or window as a jpeg (needs the daemon + extension for tabs)")
    .argument("<id>", "Tab handle (tier 'tab'), or a window handle with --window (tier 'window')")
    .option("--window", "Treat <id> as a window handle: tier 2 screencapture (opt-in)", false)
    .option(
      "--focus",
      "Tier 'tab': activate the tab first if it isn't active (changes user state)",
      false,
    )
    .option("--force", "Bypass the navEpoch shot cache and recapture", false)
    .option("--out <file>", "Copy the captured jpeg to this path")
    .action(
      async (
        id: string,
        opts: { window?: boolean; focus?: boolean; force?: boolean; out?: string },
      ) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("screenshot", {
          ...(opts.window ? { windowId: id } : { tabId: id }),
          focus: opts.focus ?? false,
          force: opts.force ?? false,
        });
        const sc = result.structuredContent as { path?: string } | undefined;
        if (opts.out && sc?.path) copyFileSync(sc.path, opts.out);
        await printResult(result, json);
      },
    );

  program
    .command("focus")
    .description("Focus a tab and raise its window")
    .argument("<tabId>", "Opaque tabId from `browser-tab list`")
    .action(async (tabId: string) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      await printResult(await callMcpTool("focus_tab", { tabId }), json);
    });

  program
    .command("close")
    .description("Close a tab")
    .argument("<tabId>", "Opaque tabId from `browser-tab list`")
    .action(async (tabId: string) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      await printResult(await callMcpTool("close_tab", { tabId }), json);
    });

  program
    .command("open")
    .description("Open an http(s) URL in a new tab")
    .argument("<url>", "URL to open")
    .option("--browser <name>", "chrome|chromium|brave|safari")
    .option("--window <id>", "Open in a specific window (opaque windowId)")
    .option("--no-activate", "Open in the background")
    .action(async (url: string, opts: { browser?: string; window?: string; activate: boolean }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("open_tab", {
        url,
        activate: opts.activate,
        ...(opts.browser ? { browser: opts.browser } : {}),
        ...(opts.window ? { windowId: opts.window } : {}),
      });
      await printResult(result, json);
    });

  program
    .command("move")
    .description("Move a tab to another window (true moves need daemon + extension)")
    .argument("<tabId>", "Opaque tabId from `browser-tab list`")
    .option("--target-window <id>", "Destination windowId")
    .option("--index <n>", "0-based destination position")
    .option("--new-window", "Move into a newly created window", false)
    .option("--allow-reload", "Safari: accept the reload-based AppleScript move", false)
    .action(
      async (
        tabId: string,
        opts: { targetWindow?: string; index?: string; newWindow: boolean; allowReload: boolean },
      ) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("move_tab", {
          tabId,
          newWindow: opts.newWindow,
          allowReload: opts.allowReload,
          ...(opts.targetWindow ? { targetWindowId: opts.targetWindow } : {}),
          ...(opts.index !== undefined ? { targetIndex: Number.parseInt(opts.index, 10) } : {}),
        });
        await printResult(result, json);
      },
    );

  program
    .command("act")
    .description(
      "Run an action on a tab (mute|unmute|pin|unpin|discard|reload|navigate|back|forward|duplicate)",
    )
    .argument("<tabId>", "Opaque tabId from `browser-tab list`")
    .argument("<action>", "mute|unmute|pin|unpin|discard|reload|navigate|back|forward|duplicate")
    .option("--url <url>", "Destination URL (required for navigate)")
    .action(async (tabId: string, action: string, opts: { url?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("tab_action", {
        tabId,
        action,
        ...(opts.url ? { url: opts.url } : {}),
      });
      await printResult(result, json);
    });

  program
    .command("group")
    .description("Manage Chrome tab groups (create|add|remove|update|move)")
    .argument("<action>", "create|add|remove|update|move")
    .option("--tabs <ids>", "Comma-separated tab handles (create/add/remove)")
    .option("--group <id>", "Group handle (add/remove/update/move)")
    .option("--browser <name>", "chrome|chromium|brave")
    .option("--title <title>", "Group title (create/update)")
    .option("--color <color>", "grey|blue|red|yellow|green|pink|purple|cyan|orange")
    .option("--collapsed", "Collapse the group (update)")
    .option("--target-window <id>", "Destination window (move)")
    .option("--index <n>", "0-based destination position (move)")
    .action(
      async (
        action: string,
        opts: {
          tabs?: string;
          group?: string;
          browser?: string;
          title?: string;
          color?: string;
          collapsed?: boolean;
          targetWindow?: string;
          index?: string;
        },
      ) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("group_tabs", {
          action,
          ...(opts.tabs ? { tabIds: opts.tabs.split(",").map((s) => s.trim()) } : {}),
          ...(opts.group ? { groupId: opts.group } : {}),
          ...(opts.browser ? { browser: opts.browser } : {}),
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.color ? { color: opts.color } : {}),
          ...(opts.collapsed ? { collapsed: true } : {}),
          ...(opts.targetWindow ? { targetWindowId: opts.targetWindow } : {}),
          ...(opts.index !== undefined ? { index: Number.parseInt(opts.index, 10) } : {}),
        });
        await printResult(result, json);
      },
    );

  const windowCmd = program.command("window").description("Window operations: open | set | close");
  windowCmd
    .command("open")
    .description("Open a new window with one or more URLs")
    .argument("<url...>", "http(s) URLs (first becomes active)")
    .option("--browser <name>", "chrome|chromium|brave|safari")
    .option("--bounds <x,y,w,h>", "Global-coordinate frame")
    .option("--display <n>", "0-based display index (fills that monitor)")
    .option("--state <state>", "normal|minimized|maximized|fullscreen")
    .option("--incognito", "Open a private/incognito window")
    .option("--no-focus", "Open in the background")
    .action(
      async (
        urls: string[],
        opts: {
          browser?: string;
          bounds?: string;
          display?: string;
          state?: string;
          incognito?: boolean;
          focus: boolean;
        },
      ) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("open_window", {
          urls,
          focused: opts.focus,
          incognito: opts.incognito ?? false,
          ...(opts.browser ? { browser: opts.browser } : {}),
          ...(parseBounds(opts.bounds) ? { bounds: parseBounds(opts.bounds) } : {}),
          ...(opts.display !== undefined ? { display: Number.parseInt(opts.display, 10) } : {}),
          ...(opts.state ? { state: opts.state } : {}),
        });
        await printResult(result, json);
      },
    );
  windowCmd
    .command("set")
    .description("Move/resize/minimize/foreground a window")
    .argument("<windowId>", "Opaque windowId from `browser-tab list`")
    .option("--bounds <x,y,w,h>", "Global-coordinate frame")
    .option("--display <n>", "0-based display index (fills that monitor)")
    .option("--state <state>", "normal|minimized|maximized|fullscreen")
    .option("--focus", "Raise/foreground the window")
    .action(
      async (
        windowId: string,
        opts: { bounds?: string; display?: string; state?: string; focus?: boolean },
      ) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("set_window", {
          windowId,
          ...(parseBounds(opts.bounds) ? { bounds: parseBounds(opts.bounds) } : {}),
          ...(opts.display !== undefined ? { display: Number.parseInt(opts.display, 10) } : {}),
          ...(opts.state ? { state: opts.state } : {}),
          ...(opts.focus ? { focused: true } : {}),
        });
        await printResult(result, json);
      },
    );
  windowCmd
    .command("close")
    .description("Close an entire window and all its tabs")
    .argument("<windowId>", "Opaque windowId from `browser-tab list`")
    .action(async (windowId: string) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      await printResult(await callMcpTool("close_window", { windowId }), json);
    });

  registerDaemonCommand(program);

  program
    .command("noop")
    .description("Demo: call the noop tool")
    .requiredOption("--input <text>", "Input string to echo")
    .option("--upper", "Return upper-cased", false)
    .action(async (opts: { input: string; upper: boolean }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("noop", { input: opts.input, upper: opts.upper });
      await printResult(result, json);
    });

  program
    .command("repl")
    .alias("console")
    .description("Interactive REPL driving the in-process dispatcher")
    .action(async () => {
      const { runRepl } = await import("@george43g/cli-kit");
      await runRepl({
        prompt: APP_NAME.replace(/^@[^/]+\//, "").replace(/-mcp$/, ""),
        banner: color.dim(`${APP_NAME} ${APP_VERSION} — type 'help' for commands.`),
        dispatcher: {
          async listTools() {
            const { makeAppRegistry } = await import("./tools/registry.js");
            return makeAppRegistry().tools.map((t) => ({
              name: t.name,
              description: t.description,
            }));
          },
          async callTool(name, args) {
            return callMcpTool(name, args);
          },
        },
        shortcuts: [
          {
            command: "health",
            tool: "health_check",
            help: "Print server health snapshot",
            buildArgs: () => ({}),
          },
          {
            command: "list",
            tool: "list_tabs",
            help: "list [browser] — list open browser windows/tabs",
            buildArgs: (a) => (a[0] ? { browser: a[0] } : {}),
          },
          {
            command: "noop",
            tool: "noop",
            help: "noop <input> [upper]",
            buildArgs: (a) => ({ input: a[0] ?? "", upper: a[1] === "upper" }),
          },
        ],
      });
    });

  await program.parseAsync(argv as string[]);
}

const isMain = (() => {
  try {
    const arg = process.argv[1] ?? "";
    return arg.endsWith("/dist/cli.js") || arg.endsWith("/src/cli.ts");
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${color.red((err as Error).message)}\n`);
    process.exit(1);
  });
}

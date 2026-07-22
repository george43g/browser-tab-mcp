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

import { color, isInteractive } from "@george43g/cli-kit";
import { Command } from "commander";
import { checkLocalAccess, formatAccessReport } from "./access-check.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { callMcpTool } from "./dispatcher.js";
import { runMcpServer } from "./index.js";
import { APP_NAME, APP_VERSION } from "./meta.js";

async function printResult(result: Awaited<ReturnType<typeof callMcpTool>>, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result.structuredContent ?? result, null, 2)}\n`);
    return;
  }
  for (const item of result.content ?? []) {
    process.stdout.write(`${item.text}\n`);
  }
  if (result.isError) process.exit(1);
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = new Command();
  // Bin name = the tool name (no -cli suffix). Subcommands route to MCP/TUI/etc.
  program
    .name(APP_NAME.replace(/^@[^/]+\//, "").replace(/-mcp$/, ""))
    .description("browser-tab — single bin; subcommands run the MCP server, TUI, doctor, etc.")
    .version(APP_VERSION, "-V, --version")
    .option("--json", "Emit machine-readable JSON")
    .option("-q, --quiet", "Suppress non-error output")
    .option("-v, --verbose", "Log debug-level info to stderr")
    .option("--no-color", "Disable colors");

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
      await printResult(result, json);
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

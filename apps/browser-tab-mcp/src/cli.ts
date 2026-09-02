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

import { copyFileSync, readFileSync } from "node:fs";
import {
  applyEnvFromFlags,
  bindEnvFlags,
  color,
  disableColors,
  isInteractive,
  printJson,
  resolveOutputMode,
} from "@george43g/cli-kit";
import { setLogFilePrefix, setLogLevel } from "@george43g/robustness/logger";
import { type BrowserId, WIRE_PROTOCOL_VERSION } from "@george43g/shared-types";
import { Command, Option } from "commander";
import {
  buildReport,
  checkLocalAccess,
  type ExtensionStatusLike,
  extensionCheckItems,
  formatAccessReport,
} from "./access-check.js";
import { compareBuilds } from "./build-compare.js";
import {
  daemonStatus,
  getOperation,
  listOperations,
  reloadExtension,
} from "./client/tabs-service.js";
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
 * A failing tool has no `structuredContent`, so JSON mode used to print the raw
 * MCP envelope (`{content:[{type:"text",…}],isError:true}`) — a different
 * top-level shape from the success case, which meant `jq '.rows'` quietly
 * yielded `null` instead of failing. Emit one documented shape instead, so a
 * consumer can branch on a single key.
 *
 * Returns undefined for a successful result (caller falls through to the
 * normal payload).
 */
/**
 * One optional STRING option, as a payload fragment.
 *
 * WHY NOT `opts.x ? { k: opts.x } : {}`. That idiom cannot tell "flag absent"
 * from "flag given an empty string" — both are falsy, so the key was simply
 * dropped. `--browser ""` therefore did not narrow the query, it silently
 * WIDENED it to every browser; `--window ""` listed every window. A filter that
 * quietly becomes its own opposite is worse than an error, so an empty value is
 * now rejected by name.
 */
function str<K extends string>(key: K, flag: string, value: string | undefined) {
  if (value === undefined) return {} as Record<K, string>;
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${flag} was given an empty value — omit the flag to leave it unset.`);
  }
  return { [key]: trimmed } as Record<K, string>;
}

/** Same, for an option whose payload is a number. */
function num<K extends string>(key: K, flag: string, value: string | undefined) {
  if (value === undefined) return {} as Record<K, number>;
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${flag} was given an empty value — omit the flag to leave it unset.`);
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) throw new Error(`${flag} expects a number, got "${value}".`);
  return { [key]: n } as Record<K, number>;
}

/**
 * Comma-separated handles. An empty entry is rejected rather than filtered:
 * `--tabs "a,,b"` is a typo, and silently acting on two tabs when three were
 * named is the same class of quiet wrong as the empty-string case above.
 */
function csvStr<K extends string>(key: K, flag: string, value: string | undefined) {
  if (value === undefined) return {} as Record<K, string[]>;
  const parts = value.split(",").map((v) => v.trim());
  if (parts.length === 0 || parts.some((v) => v === "")) {
    throw new Error(`${flag} has an empty entry — expected a comma-separated list of handles.`);
  }
  return { [key]: parts } as Record<K, string[]>;
}

function errorEnvelope(
  result: Awaited<ReturnType<typeof callMcpTool>>,
  tool?: string,
): { error: { tool: string; message: string } } | undefined {
  if (!result.isError) return undefined;
  const message = (result.content ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
  return { error: { tool: tool ?? "unknown", message: message || "Tool failed." } };
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
 *
 * **Failure is signalled before the mode switch, never after it.** The exit code
 * used to be set at the bottom of the human branch, which the JSON branch
 * returns before ever reaching — so a failing tool exited 0 for every piped,
 * `--json` or CI caller and 1 only for a human watching a terminal. That is
 * backwards: the non-interactive callers are the ones that can't read prose.
 * `process.exitCode` (not `process.exit()`) so a pending stdout write on a pipe
 * still flushes.
 */
/**
 * Set by `--quiet` before any action runs. Module-level rather than threaded
 * through 17 call sites: it is a process-wide output mode, not a per-call one.
 */
let quiet = false;

async function printResult(
  result: Awaited<ReturnType<typeof callMcpTool>>,
  json: boolean,
  tool?: string,
) {
  if (result.isError) process.exitCode = 1;
  // `--quiet` suppresses the SUCCESS payload only. Errors still print, and the
  // exit code is set above either way — a quiet failure that also exits 0 would
  // be a silent failure, which is the one thing a flag like this must not cause.
  if (quiet && !result.isError) return;
  if (resolveOutputMode({ json }) === "json") {
    printJson(errorEnvelope(result, tool) ?? result.structuredContent ?? result);
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
  // Exit code already set above, before the mode switch — deliberately not
  // process.exit() here, which can truncate the write we just queued.
}

/**
 * Make the three global flags DO something.
 *
 * `-q`, `-v` and `--no-color` were declared on the root command — and so shown
 * in `--help` for every subcommand — but nothing ever read them. A flag that is
 * documented and inert is worse than a missing one: it invites a workaround
 * that silently doesn't work.
 *
 * Commander maps `--no-color` to `color: false` (NOT `noColor`), which is the
 * detail that makes this a two-line fix rather than a rewrite.
 */
function applyGlobalFlags(program: Command): void {
  const opts = program.opts<{ color?: boolean; quiet?: boolean; verbose?: boolean }>();
  if (opts.color === false) disableColors();
  if (opts.verbose) setLogLevel("debug");
  quiet = opts.quiet === true;
}

/**
 * Construct the commander program without running it.
 *
 * Split out of `main` so the surface can be INSPECTED rather than grepped:
 * `tests/interface-parity.contract.test.ts` walks the real command tree to
 * assert every tool is reachable from the CLI. A regex over this file would
 * pass on a command that is registered but broken, and would need rewriting
 * whenever the declaration style changes.
 */
export function buildProgram(): Command {
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
    applyGlobalFlags(program);
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
      // Extension staleness — best-effort; only meaningful when the daemon is
      // up (a down daemon yields no extensionInfo, so this contributes
      // nothing). Folded into ONE report so the verdict line accounts for it:
      // these used to print underneath an already-emitted "Doctor: all clear."
      const status = await daemonStatus();
      const full = buildReport([
        ...report.items,
        ...extensionCheckItems(
          (status.extensionInfo ?? []) as ExtensionStatusLike[],
          typeof status.build === "string" ? status.build : null,
          WIRE_PROTOCOL_VERSION,
          compareBuilds,
        ),
      ]);
      process.stdout.write(`${formatAccessReport(full)}\n`);
      if (!full.ok) process.exit(1);
    });

  program
    .command("health")
    .description("Print server health snapshot")
    .action(async () => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("health_check", {});
      await printResult(result, json, "health_check");
    });

  program
    .command("bookmark")
    .alias("bm")
    .description(
      "Read or edit bookmarks (search|list|create|update|remove) — needs daemon + extension",
    )
    .argument("<action>", "search | list | create | update | remove")
    .option("--browser <name>", "Which browser (required when >1 extension is connected)")
    .option("--query <text>", "search: substring over title and URL")
    .option("--folder <id>", "list: folder to read (omit for the root)")
    .option("--recursive", "list: flatten the whole subtree")
    .option("--id <id>", "update/remove: node to act on")
    .option("--parent <id>", "create: destination folder")
    .option("--title <title>", "create/update: title (create with no --url makes a folder)")
    .option("--url <url>", "create/update: target URL")
    .option("--limit <n>", "Max rows", "100")
    .action(
      async (
        action: string,
        opts: {
          browser?: string;
          query?: string;
          folder?: string;
          recursive?: boolean;
          id?: string;
          parent?: string;
          title?: string;
          url?: string;
          limit?: string;
        },
      ) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("bookmarks", {
          action,
          ...str("browser", "--browser", opts.browser),
          ...str("query", "--query", opts.query),
          ...str("folderId", "--folder", opts.folder),
          ...(opts.recursive ? { recursive: true } : {}),
          ...str("id", "--id", opts.id),
          ...str("parentId", "--parent", opts.parent),
          // `title` keeps `!== undefined` rather than `str()`: clearing a title
          // with `--title ""` is a legitimate update, so empty is a VALUE here,
          // not the "flag given nothing" mistake the helper exists to catch.
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...str("url", "--url", opts.url),
          ...num("maxResults", "--limit", opts.limit),
        });
        await printResult(result, json, "bookmarks");
      },
    );

  program
    .command("logs")
    .description("Show recent daemon/server log lines (dev-only: needs MCP_DEV=1)")
    .addOption(
      new Option("--source <src>", "memory (ring buffer) | file (NDJSON on disk) | all")
        .choices(["memory", "file", "all"])
        .default("memory"),
    )
    .option("--tail <n>", "How many lines (1-500)", "50")
    .action(async (opts: { source?: string; tail?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      // Registered unconditionally, and gated by the DISPATCHER — the same
      // decision as `toMcpTools()`. Hiding the command from `--help` when
      // MCP_DEV is unset would make the help text (and the generated usage
      // artifacts, which CI checks for freshness) depend on the environment,
      // and hiding never disabled anything anyway: `buildDispatcher` fails
      // closed and refuses with the same "Unknown tool name" as a tool that
      // does not exist.
      const result = await callMcpTool("get_logs", {
        source: opts.source ?? "memory",
        ...num("tail", "--tail", opts.tail),
      });
      await printResult(result, json, "get_logs");
    });

  program
    .command("list")
    .description("List open browser windows and tabs (Chrome/Brave/Chromium/Edge/Safari)")
    .option("--browser <name>", "Restrict to one browser: chrome|chromium|brave|edge|safari")
    .option("--window <id>", "Restrict to one window (opaque windowId from a previous list)")
    .option("--url <substring>", "Filter tabs by URL substring (drops non-matching windows)")
    // A ternary silently mapped every non-"core" value to "full", so
    // `--fields nonsense` looked like it worked. `.choices()` rejects it.
    .addOption(
      new Option("--fields <set>", "Field set: summary (no tab rows), core (trimmed) or full")
        .choices(["summary", "core", "full"])
        .default("full"),
    )
    .action(async (opts: { browser?: string; window?: string; url?: string; fields?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("list_tabs", {
        ...str("browser", "--browser", opts.browser),
        ...str("windowId", "--window", opts.window),
        ...str("urlFilter", "--url", opts.url),
        // .choices() already rejected anything else, so pass it through.
        fields: opts.fields ?? "full",
      });
      await printResult(result, json, "list_tabs");
    });

  program
    .command("journal")
    .description("Show recorded focus/navigation history (windowMru|tabMru|journey|recent)")
    .addOption(
      new Option("--view <view>", "Which journal view to show")
        .choices(["windowMru", "tabMru", "journey", "recent"])
        .default("recent"),
    )
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
        // Enforce the view's own required argument HERE, not just daemon-side.
        // The daemon does throw, but `journal` degrades to an empty result when
        // the daemon is down — so a missing `--window` produced "no records",
        // indistinguishable from "this window has no history".
        const needs = { tabMru: ["--window", opts.window], journey: ["--tab", opts.tab] } as const;
        const need = needs[opts.view as keyof typeof needs];
        if (need && !need[1]) {
          throw new Error(`journal --view ${opts.view} requires ${need[0]} <id>.`);
        }
        const result = await callMcpTool("journal", {
          view: opts.view ?? "recent",
          ...str("browser", "--browser", opts.browser),
          ...str("windowId", "--window", opts.window),
          ...str("tabId", "--tab", opts.tab),
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
          ...str("browser", "--browser", opts.browser),
          ...str("query", "--query", opts.query),
          ...num("startTime", "--start", opts.start),
          ...num("endTime", "--end", opts.end),
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
      await printResult(result, json, "get_page");
    });

  program
    .command("select")
    .description("Resolve a control-language selector against the live snapshot (needs daemon)")
    .requiredOption(
      "--selector <json>",
      "Selector AST as JSON; @<file> reads a file, `-` reads stdin (shell-quote-free)",
    )
    .addOption(
      new Option("--projection <p>", "Result shape")
        .choices(["core", "ids", "count"])
        .default("core"),
    )
    .action(async (opts: { selector: string; projection?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      // Lossless JSON input per the plan: inline, @file, or stdin — an AI or
      // script should never have to shell-quote a nested selector.
      let raw = opts.selector;
      if (raw === "-") {
        raw = readFileSync(0, "utf8");
      } else if (raw.startsWith("@")) {
        raw = readFileSync(raw.slice(1), "utf8");
      }
      let selector: unknown;
      try {
        selector = JSON.parse(raw);
      } catch (err) {
        throw new Error(`--selector is not valid JSON: ${(err as Error).message}`);
      }
      const result = await callMcpTool("select_tabs", {
        selector,
        projection: opts.projection ?? "core",
      });
      await printResult(result, json, "select_tabs");
    });

  program
    .command("plan")
    .description("Plan one tab transform without applying it (needs daemon)")
    .option("--selector <json>", "Selector AST as JSON; @<file> or `-` for stdin")
    .option("--selection <id>", "A current select_tabs selectionId (instead of --selector)")
    .requiredOption("--transform <json>", "Transform as JSON; @<file> or `-` for stdin")
    .addOption(new Option("--pin-policy <p>", "Pinned members policy").choices(["skip"]))
    .action(
      async (opts: {
        selector?: string;
        selection?: string;
        transform: string;
        pinPolicy?: string;
      }) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const readJsonArg = (raw: string, flag: string): unknown => {
          let text = raw;
          if (raw === "-") text = readFileSync(0, "utf8");
          else if (raw.startsWith("@")) text = readFileSync(raw.slice(1), "utf8");
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`${flag} is not valid JSON: ${(err as Error).message}`);
          }
        };
        const result = await callMcpTool("plan_tab_change", {
          ...(opts.selector !== undefined
            ? { selector: readJsonArg(opts.selector, "--selector") }
            : {}),
          ...(opts.selection !== undefined ? { selectionId: opts.selection } : {}),
          transform: readJsonArg(opts.transform, "--transform"),
          ...(opts.pinPolicy !== undefined ? { pinPolicy: opts.pinPolicy } : {}),
        });
        await printResult(result, json, "plan_tab_change");
      },
    );

  program
    .command("apply")
    .description("Apply a live-layout plan from `browser-tab plan` (needs daemon + extension)")
    .requiredOption("--plan <id>", "planId from plan_tab_change (must still be current)")
    .option(
      "--conflict <mode>",
      "Stale-plan policy: error (default) | replan (same members, budget 1) | best-effort",
    )
    .action(async (opts: { plan: string; conflict?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("apply_tab_layout", {
        planId: opts.plan,
        ...(opts.conflict !== undefined ? { conflict: opts.conflict } : {}),
      });
      await printResult(result, json, "apply_tab_layout");
    });

  /**
   * Deliberately CLI-only, like reload-extension: the MCP-visible form of the
   * operation journal is PR-L's evidence-gated resources question, and every
   * mutation result already carries its own operationId inline.
   */
  program
    .command("operations")
    .description("Read the daemon's operation journal (apply/copy/cut executions)")
    .option("--id <operationId>", "Fetch one operation record")
    .option("--limit <n>", "How many recent operations to list", "20")
    .action(async (opts: { id?: string; limit?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      try {
        const result =
          opts.id !== undefined
            ? await getOperation({ operationId: opts.id })
            : await listOperations({ limit: Number(opts.limit ?? 20) });
        printJson(result);
      } catch (err) {
        if (json) {
          printJson({ error: { message: (err as Error).message } });
        } else {
          process.stderr.write(`${(err as Error).message}\n`);
        }
        process.exitCode = 1;
      }
    });

  program
    .command("copy")
    .description("Reconstruct selected tabs at a destination; sources stay open (needs daemon)")
    .option("--selector <json>", "Selector AST as JSON; @<file> or `-` for stdin")
    .option("--selection <id>", "A current select_tabs selectionId (instead of --selector)")
    .option("--to-window <windowId>", "Copy into an existing window")
    .option("--new-window <browser>", "Copy into a new window in this browser")
    .option("--idempotency-key <key>", "Retry-safe: same key replays the stored outcome")
    .action(
      async (opts: {
        selector?: string;
        selection?: string;
        toWindow?: string;
        newWindow?: string;
        idempotencyKey?: string;
      }) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        if ((opts.toWindow === undefined) === (opts.newWindow === undefined)) {
          throw new Error("provide exactly one of --to-window | --new-window");
        }
        const readJsonArg = (raw: string, flag: string): unknown => {
          let text = raw;
          if (raw === "-") text = readFileSync(0, "utf8");
          else if (raw.startsWith("@")) text = readFileSync(raw.slice(1), "utf8");
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`${flag} is not valid JSON: ${(err as Error).message}`);
          }
        };
        const result = await callMcpTool("copy_tabs", {
          ...(opts.selector !== undefined
            ? { selector: readJsonArg(opts.selector, "--selector") }
            : {}),
          ...(opts.selection !== undefined ? { selectionId: opts.selection } : {}),
          destination:
            opts.toWindow !== undefined
              ? { kind: "window", windowId: opts.toWindow }
              : { kind: "newWindow", browser: opts.newWindow },
          ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        });
        await printResult(result, json, "copy_tabs");
      },
    );

  program
    .command("cut")
    .description("DESTRUCTIVE: reconstruct selected tabs elsewhere, then close the sources")
    .option("--selector <json>", "Selector AST as JSON; @<file> or `-` for stdin")
    .option("--selection <id>", "A current select_tabs selectionId (instead of --selector)")
    .option("--to-window <windowId>", "Transfer into an existing window")
    .option("--new-window <browser>", "Transfer into a new window in this browser")
    .option(
      "--confirm-destruction",
      "REQUIRED: acknowledge sources will close (their live page state is unrecoverable)",
      false,
    )
    .addOption(
      new Option("--mode <m>", "Close policy")
        .choices(["after-each-success", "all-before-close"])
        .default("after-each-success"),
    )
    .option("--idempotency-key <key>", "Retry-safe: same key replays the stored outcome")
    .action(
      async (opts: {
        selector?: string;
        selection?: string;
        toWindow?: string;
        newWindow?: string;
        confirmDestruction?: boolean;
        mode?: string;
        idempotencyKey?: string;
      }) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        if ((opts.toWindow === undefined) === (opts.newWindow === undefined)) {
          throw new Error("provide exactly one of --to-window | --new-window");
        }
        if (opts.confirmDestruction !== true) {
          throw new Error(
            "cut closes source tabs; pass --confirm-destruction to acknowledge that their " +
              "live page state cannot be recovered.",
          );
        }
        const readJsonArg = (raw: string, flag: string): unknown => {
          let text = raw;
          if (raw === "-") text = readFileSync(0, "utf8");
          else if (raw.startsWith("@")) text = readFileSync(raw.slice(1), "utf8");
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`${flag} is not valid JSON: ${(err as Error).message}`);
          }
        };
        const result = await callMcpTool("cut_tabs", {
          ...(opts.selector !== undefined
            ? { selector: readJsonArg(opts.selector, "--selector") }
            : {}),
          ...(opts.selection !== undefined ? { selectionId: opts.selection } : {}),
          destination:
            opts.toWindow !== undefined
              ? { kind: "window", windowId: opts.toWindow }
              : { kind: "newWindow", browser: opts.newWindow },
          confirmDestruction: true,
          mode: opts.mode ?? "after-each-success",
          ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        });
        await printResult(result, json, "cut_tabs");
      },
    );

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
      await printResult(result, json, "annotate");
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
        await printResult(result, json, "screenshot");
      },
    );

  program
    .command("focus")
    .description("Focus a tab and raise its window")
    // commander maps `--no-raise` to `opts.raise === false`, defaulting true —
    // so the raise stays the default and this is purely an opt-out.
    .option("--no-raise", "Activate the tab without raising or un-minimizing its window")
    .argument("<tabId>", "Opaque tabId from `browser-tab list`")
    .action(async (tabId: string, opts: { raise: boolean }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      await printResult(
        await callMcpTool("focus_tab", { tabId, raiseWindow: opts.raise }),
        json,
        "focus_tab",
      );
    });

  program
    .command("close")
    .description("Close a tab")
    .argument("<tabId>", "Opaque tabId from `browser-tab list`")
    .action(async (tabId: string) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      await printResult(await callMcpTool("close_tab", { tabId }), json, "close_tab");
    });

  /**
   * Deliberately a CLI-only surface. There is no `reload_extension` MCP tool,
   * so a model driving this server cannot restart the extension it is talking
   * through — that would be a self-inflicted outage, and the failure would look
   * like a transport bug rather than a tool call. Operators get it; models
   * don't.
   */
  program
    .command("reload-extension")
    .description("Restart a browser's connector extension from disk (dev deploy loop)")
    .option("--browser <name>", "chrome|chromium|brave|edge|safari", "chrome")
    .action(async (opts: { browser?: string }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const browser = (opts.browser ?? "chrome") as BrowserId;
      // A failed reload THROWS (the daemon has no partial success to report),
      // so catch it here and honour --json rather than letting a stack trace
      // be the user interface.
      try {
        const result = await reloadExtension(browser);
        if (resolveOutputMode({ json }) === "json") {
          printJson(result);
          return;
        }
        process.stdout.write(`${color.green("✓")} ${browser} extension reloaded and reconnected\n`);
      } catch (err) {
        process.exitCode = 1;
        const message = (err as Error).message;
        if (resolveOutputMode({ json }) === "json") {
          printJson({ error: { command: "reload_extension", browser, message } });
          return;
        }
        process.stderr.write(`${color.red("✗")} ${message}\n`);
      }
    });

  program
    .command("open")
    .description("Open an http(s) URL in a new tab")
    .argument("<url>", "URL to open")
    .option("--browser <name>", "chrome|chromium|brave|edge|safari")
    .option("--window <id>", "Open in a specific window (opaque windowId)")
    .option("--no-activate", "Open in the background")
    .action(async (url: string, opts: { browser?: string; window?: string; activate: boolean }) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      const result = await callMcpTool("open_tab", {
        url,
        activate: opts.activate,
        ...str("browser", "--browser", opts.browser),
        ...str("windowId", "--window", opts.window),
      });
      await printResult(result, json, "open_tab");
    });

  program
    .command("move")
    .description(
      "Move a tab within its window (--to/--by) or to another (true moves need daemon + extension)",
    )
    .argument("<tabId>", "Opaque tabId from `browser-tab list`")
    .option("--target-window <id>", "Destination windowId")
    .option("--index <n>", "0-based destination position (legacy; prefer --to)")
    .option(
      "--to <pos>",
      "Signed one-based position: 1 = first, -1 = last (same-window without --target-window)",
    )
    .option("--by <n>", "Signed relative displacement within the tab's own window (e.g. -1, 3)")
    .option("--new-window", "Move into a newly created window", false)
    .option("--allow-reload", "Safari: accept the reload-based AppleScript move", false)
    .action(
      async (
        tabId: string,
        opts: {
          targetWindow?: string;
          index?: string;
          to?: string;
          by?: string;
          newWindow: boolean;
          allowReload: boolean;
        },
      ) => {
        const json = program.opts<{ json?: boolean }>().json ?? false;
        const result = await callMcpTool("move_tab", {
          tabId,
          newWindow: opts.newWindow,
          allowReload: opts.allowReload,
          ...str("targetWindowId", "--target-window", opts.targetWindow),
          ...(opts.index !== undefined ? { targetIndex: Number.parseInt(opts.index, 10) } : {}),
          ...(opts.to !== undefined ? { to: Number.parseInt(opts.to, 10) } : {}),
          ...(opts.by !== undefined ? { by: Number.parseInt(opts.by, 10) } : {}),
        });
        await printResult(result, json, "move_tab");
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
        ...str("url", "--url", opts.url),
      });
      await printResult(result, json, "tab_action");
    });

  program
    .command("group")
    .description("Manage Chrome tab groups (create|add|remove|update|move)")
    .argument("<action>", "create|add|remove|update|move")
    .option("--tabs <ids>", "Comma-separated tab handles (create/add/remove)")
    .option("--group <id>", "Group handle (add/remove/update/move)")
    .option("--browser <name>", "chrome|chromium|brave|edge")
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
          ...csvStr("tabIds", "--tabs", opts.tabs),
          ...str("groupId", "--group", opts.group),
          ...str("browser", "--browser", opts.browser),
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...str("color", "--color", opts.color),
          ...(opts.collapsed ? { collapsed: true } : {}),
          ...str("targetWindowId", "--target-window", opts.targetWindow),
          ...(opts.index !== undefined ? { index: Number.parseInt(opts.index, 10) } : {}),
        });
        await printResult(result, json, "group_tabs");
      },
    );

  const windowCmd = program.command("window").description("Window operations: open | set | close");
  windowCmd
    .command("open")
    .description("Open a new window with one or more URLs")
    .argument("<url...>", "http(s) URLs (first becomes active)")
    .option("--browser <name>", "chrome|chromium|brave|edge|safari")
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
          ...str("browser", "--browser", opts.browser),
          ...(parseBounds(opts.bounds) ? { bounds: parseBounds(opts.bounds) } : {}),
          ...(opts.display !== undefined ? { display: Number.parseInt(opts.display, 10) } : {}),
          ...str("state", "--state", opts.state),
        });
        await printResult(result, json, "open_window");
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
          ...str("state", "--state", opts.state),
          ...(opts.focus ? { focused: true } : {}),
        });
        await printResult(result, json, "set_window");
      },
    );
  windowCmd
    .command("close")
    .description("Close an entire window and all its tabs")
    .argument("<windowId>", "Opaque windowId from `browser-tab list`")
    .action(async (windowId: string) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      await printResult(await callMcpTool("close_window", { windowId }), json, "close_window");
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
      await printResult(result, json, "noop");
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
          // Straight passthrough since cli-kit 2.0.0: its ToolCallResult carries
          // the same text|image ContentBlock union our dispatcher emits, and it
          // renders an image block as `[image image/jpeg, 61.4 KB]` itself. The
          // adapter that used to flatten images into a summary line is gone.
          callTool: callMcpTool,
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

  return program;
}

/**
 * Brand this process's NDJSON log files before anything can write one.
 *
 * WHY IT IS HERE AND NOT IN `buildProgram()`. `setLogFilePrefix` mutates a
 * module-global in the logger, and `buildProgram()` is called IN-PROCESS by
 * `tests/interface-parity.contract.test.ts` to enumerate the command surface.
 * Branding from there would contaminate the vitest worker — the exact class of
 * cross-test bleed this repo keeps paying for. `main()` runs only when the bin
 * is the entry point, so it is the one place that is both early enough and
 * private to a real invocation.
 *
 * WHY IT MATTERS AT ALL. The logger's directory IS the prefix:
 * `getLogDir()` = `envStr(key("LOG_DIR"), join(tmpdir(), logFilePrefix()))`
 * (`@george43g/robustness@0.11.0` `dist/logger.js:170-172`), and the prefix
 * defaults to `"mcp"`. Without this line every dispatcher-routed subcommand
 * wrote into `$TMPDIR/mcp/` — a bucket shared with every other tool built from
 * `mcp-cli-starter-template` that also forgot to brand, and with this repo's
 * own vitest runs. Two consequences, both measured:
 *
 *   1. `pruneLogs` keeps N files PER DIRECTORY (default 5,
 *      `dist/logger.js:66`) and protects only a live process's newest file, so
 *      a handful of `browser-tab list` one-shots evicted the long-lived MCP
 *      server's session history. Hence a slug DISTINCT from the server's
 *      `browser-tab-mcp` rather than sharing one.
 *   2. `browser-tab logs --source file` filters by `${logFilePrefix()}-`
 *      (`dist/logger.js:183`), so in the shared bucket it read back OTHER
 *      tools' `mcp-*.ndjson`. Branding makes that command honest too.
 *
 * The three long-lived entry points set a more specific prefix of their own —
 * `runMcpServer` (`src/index.ts`), `runDaemon` (`src/daemon/index.ts`),
 * `runTui` (`src/tui/index.tsx`) — and all three run inside a subcommand
 * action, i.e. strictly after this line. `tests/cli-log-branding.integration.test.ts`
 * asserts that ordering rather than trusting it.
 */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  setLogFilePrefix("browser-tab-cli");
  await buildProgram().parseAsync(argv as string[]);
}

/**
 * Is this file the process entry point?
 *
 * WINDOWS BUG THIS FIXES. The check used to be `arg.endsWith("/dist/cli.js")`.
 * On Windows `process.argv[1]` is `D:\a\...\dist\cli.js` — BACKSLASHES — so
 * it never matched, `main()` never ran, and `browser-tab <anything>` printed
 * nothing and exited 0. Not a degraded CLI: a silent one. It was caught by the
 * windows-latest CI leg on that leg's first green-ish run, via a bundle test
 * asserting the built bin produces output at all.
 *
 * Normalising separators rather than using `import.meta.url` because the
 * comparison is against `process.argv[1]`, which is what the OS actually
 * invoked, and that is the value that differs per platform.
 */
export function isEntryPoint(argv1: string | undefined): boolean {
  // Normalise separators: on Windows `process.argv[1]` uses backslashes, and a
  // suffix test written with forward slashes silently never matches.
  const arg = (argv1 ?? "").replace(/\\/g, "/");
  return arg.endsWith("/dist/cli.js") || arg.endsWith("/src/cli.ts");
}

const isMain = (() => {
  try {
    return isEntryPoint(process.argv[1]);
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

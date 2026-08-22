/**
 * The CLI's NDJSON logs land in ITS OWN directory, not the shared default one.
 *
 * THE DEFECT THIS PINS (BACKLOG.md B11, 2026-08-23). `src/cli.ts` never called
 * `setLogFilePrefix`, so every dispatcher-routed subcommand fell through to
 * robustness's default prefix `"mcp"` and wrote into `$TMPDIR/mcp/`. That
 * directory is not ours: it is the default for every tool built from
 * `mcp-cli-starter-template` that also forgot to brand — on the machine where
 * this was found it was dominated by a DIFFERENT app's logs — and this repo's
 * own vitest runs write there too. An outside session found it, not us.
 *
 * TWO PARTS, AND ONLY ONE OF THEM PROVES ANYTHING.
 *
 *   (a) `writes its own branded directory` is the PROOF. It runs commands
 *       known to emit a log line and asserts the branded directory appears
 *       with a real file in it. If the `setLogFilePrefix` call in `main()` is
 *       reverted, this reddens.
 *
 *   (b) `no command writes into the shared default bucket` is a REGRESSION
 *       GUARD, not a coverage claim, and the difference matters. A command
 *       that emits no log line creates no directory and passes — correctly,
 *       because it has nothing to misplace. Read as proof of coverage it would
 *       be vacuous for most of the surface; read as a negative guard it is
 *       exactly right, because a future command that logs under the default
 *       prefix WOULD create `mcp/` and fail here.
 *
 * That distinction is written down because this repo has repeatedly shipped an
 * apparatus that passed while proving nothing, and the fix each time was to
 * say which assertion carries the weight.
 *
 * ACCEPTED GAP: library entry points imported in-process (vitest workers,
 * `callMcpTool` from another package) never run `main()` and are not covered.
 * They are not a shipped surface.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomWsPort } from "@george43g/test-kit";
import { afterAll, describe, expect, it } from "vitest";
import { cliCommandNamesWithoutAliases } from "./helpers/cli-surface.js";

const execFileP = promisify(execFile);

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(APP, "dist", "cli.js");

/** The directory robustness uses when nobody brands — what we must never create. */
const DEFAULT_BUCKET = "mcp";
/** The directory `main()` brands into. */
const BRANDED_BUCKET = "browser-tab-cli";

const scratch: string[] = [];

function isolatedTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bt-brand-"));
  scratch.push(dir);
  return dir;
}

/**
 * Run the built bin with a private `TMPDIR` and nothing pointing the logger
 * elsewhere. `MCP_LOG_DIR` is deleted rather than merely unset in our own env,
 * because an inherited value would silently move the very directory under test.
 */
async function runCli(
  args: string[],
  tmp: string,
  timeoutMs = 20_000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: tmp,
    BROWSER_TAB_FAKE_ADAPTER: "1",
    ...extraEnv,
  };
  delete env.MCP_LOG_DIR;
  delete env.BROWSER_TAB_LOG_DIR;
  delete env.MCP_LOG_PREFIX;
  // Point IPC at a path inside the scratch dir so a real daemon on this
  // machine can never absorb the call (the 2026-08-22 Windows defect).
  env.BROWSER_TAB_SOCKET_PATH ??=
    process.platform === "win32" ? `\\\\.\\pipe\\bt-brand-${process.pid}` : join(tmp, "d.sock");
  try {
    await execFileP("node", [CLI, ...args], { env, timeout: timeoutMs });
  } catch {
    // A non-zero exit is fine and often expected (missing required args, no
    // daemon). This test is about WHERE the process logged, not whether the
    // command succeeded.
  }
}

const ndjsonIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ndjson")) : [];

/**
 * Commands that must not be driven for real, each with the reason. Asserted
 * below to be a SUBSET of the enumerated names, so a rename makes this list
 * stale and loud rather than silently over-broad.
 */
const UNSAFE_TO_DRIVE: Record<string, string> = {
  "daemon install": "registers a real LaunchAgent / Task Scheduler task",
  "daemon uninstall": "deregisters the developer's real daemon",
  "daemon stop": "stops the developer's real daemon (same body as uninstall, deliberately)",
  "daemon restart": "restarts the developer's real daemon",
  "daemon run": "long-running; never returns on its own",
  mcp: "long-running stdio server; never returns on its own",
  repl: "reads stdin interactively",
  console: "alias of repl",
  doctor: "probes Automation TCC and can raise a consent dialog on an ungranted machine",
};

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("CLI log branding", () => {
  it("requires a built bin (this test is about the shipped binary)", () => {
    expect(existsSync(CLI), `${CLI} missing — run \`pnpm build\` first`).toBe(true);
  });

  // (a) THE PROOF. These three all emit at least a `dispatch.<tool>` perf span,
  // so a branded directory MUST appear. Revert the `setLogFilePrefix` call in
  // `main()` and every one of these fails.
  it.each([
    ["list", ["list", "--json"]],
    ["journal", ["journal"]],
    ["noop", ["noop", "--input", "hi"]],
  ] as const)("%s writes its own branded directory, not the shared one", async (_label, args) => {
    const tmp = isolatedTmp();
    await runCli([...args], tmp);

    const branded = ndjsonIn(join(tmp, BRANDED_BUCKET));
    expect(
      branded.length,
      `expected ${BRANDED_BUCKET}/*.ndjson in ${tmp}; got ${readdirSync(tmp).join(", ") || "<empty>"}`,
    ).toBeGreaterThan(0);
    expect(branded.every((f) => f.startsWith(`${BRANDED_BUCKET}-`))).toBe(true);
    expect(existsSync(join(tmp, DEFAULT_BUCKET))).toBe(false);
  });

  // (b) THE GUARD. Negative-only: see the header for why passing here is not a
  // coverage claim.
  describe("no command writes into the shared default bucket", () => {
    const all = [...cliCommandNamesWithoutAliases()].sort();

    it("has a non-trivial surface to sweep (canary on the enumeration)", () => {
      // If `cliCommandNames()` ever returned an empty set, every assertion
      // below would pass vacuously — which is the failure mode of a sweep.
      expect(all.length).toBeGreaterThan(20);
    });

    it("only exempts commands it actually knows about", () => {
      const enumerated = new Set(all);
      // `console` is an alias and so is absent from the alias-free enumeration;
      // it is listed for the reader's benefit, not as an exemption that fires.
      const unknown = Object.keys(UNSAFE_TO_DRIVE).filter(
        (name) => name !== "console" && !enumerated.has(name),
      );
      expect(
        unknown,
        `UNSAFE_TO_DRIVE names commands that no longer exist: ${unknown.join(", ")}. ` +
          `Rename or drop them — a stale exemption silently widens this sweep's blind spot.`,
      ).toEqual([]);
    });

    it.each(all)("%s", async (name) => {
      const tmp = isolatedTmp();
      // Unsafe commands are driven as `--help`, which still runs `main()` (and
      // therefore the branding line) but stops before the action. That is a
      // weaker check, and deliberately so — see UNSAFE_TO_DRIVE.
      const args = name in UNSAFE_TO_DRIVE ? [...name.split(" "), "--help"] : name.split(" ");
      await runCli(args, tmp, 15_000);

      expect(
        existsSync(join(tmp, DEFAULT_BUCKET)),
        `\`browser-tab ${name}\` created ${DEFAULT_BUCKET}/ — it logged before ` +
          `main() branded the prefix, or it bypasses main() entirely. Files: ` +
          `${ndjsonIn(join(tmp, DEFAULT_BUCKET)).join(", ")}`,
      ).toBe(false);
    });
  });

  // 1.2 — the ordering the three long-lived entry points depend on.
  it("lets a more specific entry point override the CLI brand", async () => {
    const tmp = isolatedTmp();
    // `daemon run` brands itself `browser-tab-daemon` inside its action, i.e.
    // strictly after main()'s call. Start it, let it log, then let the execFile
    // timeout kill it — it never returns on its own.
    //
    // Full isolation matters more here than anywhere else in this file: an
    // unisolated `daemon run` would write the real snapshot/heartbeat cache,
    // mint the real extension token, and try to bind the real WS port out from
    // under a developer's running daemon. Own band per the convention in
    // `packages/test-kit/src/fakes/daemon-env.ts` (21900-21999 was free).
    await runCli(["daemon", "run"], tmp, 4_000, {
      BROWSER_TAB_STATE_DIR: join(tmp, "state"),
      BROWSER_TAB_CACHE_DIR: join(tmp, "cache"),
      BROWSER_TAB_TOKEN_PATH: join(tmp, "extension-token"),
      BROWSER_TAB_WS_PORT: String(randomWsPort(21_900, 100)),
      BROWSER_TAB_POLL_MS: "60000",
    });

    expect(
      ndjsonIn(join(tmp, "browser-tab-daemon")).length,
      `daemon run should brand itself browser-tab-daemon; ${tmp} holds ` +
        `${readdirSync(tmp).join(", ") || "<empty>"}`,
    ).toBeGreaterThan(0);
    expect(existsSync(join(tmp, DEFAULT_BUCKET))).toBe(false);
  });
});

/**
 * Exit-code and error-shape contract for the CLI.
 *
 * The bug these guard: the failure signal used to be set at the BOTTOM of
 * `printResult`'s human branch, which the JSON branch returns before reaching.
 * So a failing tool exited 0 for every piped / `--json` / CI caller and 1 only
 * for a human watching a terminal — backwards, since the non-interactive
 * callers are exactly the ones that cannot read the prose.
 *
 * Vitest runs with a non-TTY stdout, so the default mode here IS the json
 * branch; the human branch is exercised by faking `isTTY`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

const setLogLevel = vi.hoisted(() => vi.fn());
vi.mock("@george43g/robustness/logger", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setLogLevel,
}));

let failing = true;

vi.mock("./dispatcher.js", () => ({
  callMcpTool: async (tool: string) =>
    failing
      ? {
          content: [{ type: "text", text: `Tool "${tool}" failed: Malformed handle "nonsense".` }],
          isError: true,
        }
      : {
          content: [{ type: "text", text: "{}" }],
          structuredContent: { ok: true },
          isError: false,
        },
}));

const stdout: string[] = [];
let write: { mockRestore(): void };
const savedExitCode = process.exitCode;
const savedIsTTY = process.stdout.isTTY;

beforeEach(() => {
  failing = true;
  stdout.length = 0;
  process.exitCode = undefined;
  write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  write.mockRestore();
  process.exitCode = savedExitCode;
  process.stdout.isTTY = savedIsTTY;
});

const run = (...args: string[]) => main(["node", "browser-tab", ...args]);
const out = () => stdout.join("");

describe("CLI exit codes on tool failure", () => {
  it("exits non-zero when piped — the case that used to silently exit 0", async () => {
    process.stdout.isTTY = false;
    await run("focus", "nonsense");
    expect(process.exitCode).toBe(1);
  });

  it("exits non-zero with --json — CI's case", async () => {
    await run("--json", "focus", "nonsense");
    expect(process.exitCode).toBe(1);
  });

  it("still exits non-zero on the human branch", async () => {
    process.stdout.isTTY = true;
    await run("focus", "nonsense");
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code alone on success", async () => {
    failing = false;
    await run("--json", "focus", "t:chrome:x1");
    expect(process.exitCode).toBeUndefined();
  });
});

describe("CLI JSON error shape", () => {
  it("emits one documented envelope instead of leaking the MCP result", async () => {
    await run("--json", "focus", "nonsense");
    const parsed = JSON.parse(out());
    expect(parsed.error.tool).toBe("focus_tab");
    expect(parsed.error.message).toContain("Malformed handle");
    // The raw envelope must NOT leak — a `jq '.rows'` consumer got `null` from
    // it instead of an error, which is the failure mode being closed.
    expect(parsed.content).toBeUndefined();
    expect(parsed.isError).toBeUndefined();
  });

  it("keeps success output as the bare domain object", async () => {
    failing = false;
    await run("--json", "focus", "t:chrome:x1");
    const parsed = JSON.parse(out());
    expect(parsed).toEqual({ ok: true });
    expect(parsed.error).toBeUndefined();
  });

  it("stays parseable JSON on failure", async () => {
    await run("--json", "history");
    expect(() => JSON.parse(out())).not.toThrow();
  });
});

/**
 * The three global flags used to be inert.
 *
 * `-q`, `-v` and `--no-color` were declared on the root command — so `--help`
 * advertised them under every subcommand — and nothing read any of them. A
 * documented flag that does nothing is worse than a missing one: it invites a
 * workaround that silently doesn't work.
 */
describe("global flags actually do something", () => {
  const savedNoColor = process.env.NO_COLOR;
  const savedForceColor = process.env.FORCE_COLOR;

  afterEach(() => {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedForceColor;
    setLogLevel.mockClear();
  });

  it("--no-color disables colour", async () => {
    delete process.env.NO_COLOR;
    failing = false;
    await run("--no-color", "--json", "focus", "t:chrome:x1");
    expect(process.env.NO_COLOR).toBe("1");
  });

  it("--verbose turns the log level up", async () => {
    failing = false;
    await run("--verbose", "--json", "focus", "t:chrome:x1");
    expect(setLogLevel).toHaveBeenCalledWith("debug");
  });

  it("--quiet suppresses success output", async () => {
    failing = false;
    await run("--quiet", "--json", "focus", "t:chrome:x1");
    expect(out()).toBe("");
  });

  // The one thing a quiet flag must never do is hide a failure.
  it("--quiet still reports errors, and never masks the exit code", async () => {
    await run("--quiet", "--json", "focus", "nonsense");
    expect(out()).not.toBe("");
    expect(process.exitCode).toBe(1);
  });
});

/**
 * `--fields` was a ternary, not a choice: every value that wasn't exactly
 * "core" became "full", so `--fields nonsense` looked like it worked. Same
 * class as `journal --view tabMru` accepting a missing `--window` — the CLI
 * relayed an invalid request instead of refusing it.
 */
describe("options refuse what they cannot honour", () => {
  it("rejects an unknown --fields value instead of silently defaulting", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(run("list", "--fields", "nonsense")).rejects.toThrow(/exit:1/);
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  // Daemon-side validation isn't enough: `journal` DEGRADES to an empty result
  // when the daemon is down, so a missing --window rendered as "no records" —
  // indistinguishable from "this window has no history".
  it("refuses `journal --view tabMru` with no --window", async () => {
    await expect(run("journal", "--view", "tabMru")).rejects.toThrow(/requires --window/);
  });

  it("refuses `journal --view journey` with no --tab", async () => {
    await expect(run("journal", "--view", "journey")).rejects.toThrow(/requires --tab/);
  });
});

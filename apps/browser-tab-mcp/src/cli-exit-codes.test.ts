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

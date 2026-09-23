/**
 * The REPL over a REAL pipe, in a real child process.
 *
 * `packages/cli-kit` has unit tests for the same contract, and they were not
 * enough: for a long time every scripted case fed exactly one line through an
 * in-memory stream to a dispatcher that resolved on the microtask queue, so a
 * loop which silently dropped every line after the first passed all of them.
 * Two downstream consumers reported the truncation before the suite could
 * express it.
 *
 * This test exists because that class of false confidence is only broken by
 * driving the thing the user actually drives: `printf ... | cli console`, with
 * a real dispatcher doing real async work. If it ever regresses, the failure
 * here is the one that matters.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(import.meta.dirname, "..");
const TSX = resolve(APP_DIR, "node_modules/.bin/tsx");

/** Feed `lines` to `cli console` over stdin and return everything it wrote. */
function pipeToConsole(lines: string[]): Promise<{ out: string; code: number | null }> {
  return new Promise((resolvePipe, rejectPipe) => {
    const child = spawn(TSX, ["src/cli.ts", "console"], {
      cwd: APP_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      // Keep the child's output deterministic regardless of the host terminal.
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
    });

    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.on("error", rejectPipe);
    child.on("close", (code) => resolvePipe({ out, code }));

    child.stdin.write(lines.map((l) => `${l}\n`).join(""));
    child.stdin.end();
  });
}

describe("repl over a real pipe", () => {
  it("runs every piped command, not just the first", async () => {
    const { out, code } = await pipeToConsole(["health", "noop one", "noop two upper", "quit"]);

    expect(code).toBe(0);
    // One assertion per command, so a partial regression names which command
    // was lost rather than just "output differs".
    expect(out).toContain('"status"'); // health
    expect(out).toContain('"echo": "one"'); // first noop
    expect(out).toContain('"echo": "TWO"'); // second noop, upper-cased
  }, 60_000);

  it("drains the tail when the pipe ends without an explicit quit", async () => {
    // EOF arrives while the last command is still in flight. Resolving
    // straight from readline's "close" truncates here.
    const { out } = await pipeToConsole(["noop first", "noop second", "noop third"]);

    expect(out).toContain('"echo": "first"');
    expect(out).toContain('"echo": "second"');
    expect(out).toContain('"echo": "third"');
  }, 60_000);
});

/**
 * The degradation paths of the build stamp.
 *
 * These are the branches that only run where things are BROKEN — no git, a
 * shallow container, a packed tarball — so nothing else in the suite reaches
 * them, and they are exactly the ones that must not throw. `execFileSync` is
 * mocked rather than the environment simulated, because there is no portable
 * way to un-install git for one test.
 *
 * Lives in its own file: `src/meta.ts` caches the stamp at module scope, and
 * vitest isolates module registries per file, so this gets a clean one.
 */

import { describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  get execFileSync() {
    return execFileSync;
  },
}));

describe("buildStamp when git is unavailable", () => {
  it("falls back to bare semver instead of throwing", async () => {
    execFileSync.mockImplementation(() => {
      throw new Error("spawn git ENOENT");
    });
    const { APP_VERSION, buildStamp } = await import("../src/meta.js");
    expect(buildStamp()).toBe(APP_VERSION);
  });
});

describe("buildStamp in a shallow checkout", () => {
  it("reports a count of 0 rather than a wrong-but-plausible 1", async () => {
    // The whole point of the shallow probe. `git rev-list --count HEAD` returns
    // 1 in a depth-1 clone — a number that looks real and is not. A visible 0
    // is better than a believable lie.
    vi.resetModules();
    execFileSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--short=7") return "abc1234\n";
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "true\n";
      if (args[0] === "rev-list") return "1\n"; // what a shallow clone would say
      if (args[0] === "status") return "";
      return "";
    });
    const { buildStamp } = await import("../src/meta.js");
    expect(buildStamp()).toMatch(/\+0\.abc1234$/);
  });
});

describe("buildStamp on a clean full checkout", () => {
  it("omits the dirty marker", async () => {
    vi.resetModules();
    execFileSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--short=7") return "deadbee\n";
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "false\n";
      if (args[0] === "rev-list") return "412\n";
      if (args[0] === "status") return ""; // clean
      return "";
    });
    const { buildStamp } = await import("../src/meta.js");
    expect(buildStamp()).toMatch(/\+412\.deadbee$/);
    expect(buildStamp()).not.toContain("dirty");
  });

  it("adds the dirty marker when the tree has changes", async () => {
    vi.resetModules();
    execFileSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--short=7") return "deadbee\n";
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "false\n";
      if (args[0] === "rev-list") return "412\n";
      if (args[0] === "status") return " M src/meta.ts\n";
      return "";
    });
    const { buildStamp } = await import("../src/meta.js");
    expect(buildStamp()).toMatch(/\+412\.deadbee\.dirty$/);
  });
});

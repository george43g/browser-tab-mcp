/**
 * tmux-control's README lists every registered tool in its `## Tools` table,
 * and nothing that is not one. Enumerated from the registry, so a new tool
 * without a row turns this red.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readmeToolTableProblems } from "@george43g/test-kit/contracts";
import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("docs integrity (tmux-control)", () => {
  it("README.md's Tools table lists every registered tool", () => {
    const readme = readFileSync(join(APP_DIR, "README.md"), "utf8");
    const tools = makeAppRegistry().tools.map((t) => t.name);
    expect(readmeToolTableProblems("tmux-control-mcp", readme, tools)).toEqual([]);
  });
});

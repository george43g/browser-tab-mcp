/**
 * The surface-coverage ledger (`docs/surfaces/effect-coverage.json`) covers
 * exactly the surfaces tmux-control has: its rows carry
 * `"app": "tmux-control-mcp"`, and they are checked against this app's own
 * registry and commander tree. Same checks as browser-tab's, from
 * `@george43g/test-kit/contracts`. Every row is "pending" today: nothing yet
 * proves a tmux-control surface's EFFECT (Phase 3 brings the tmux tier).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Ledger, ledgerProblems } from "@george43g/test-kit/contracts";
import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";
import { cliOnlySurfaces } from "./helpers/cli-surface.js";

const APP = "tmux-control-mcp";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ledger = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "docs/surfaces/effect-coverage.json"), "utf8"),
) as Ledger;
const toolNames = makeAppRegistry().tools.map((t) => t.name);
const cliOnly = [...cliOnlySurfaces(toolNames)];

describe("surface-coverage ledger (tmux-control)", () => {
  it("enumerates something from both readers", () => {
    // Both returning [] would make the next assertion pass vacuously.
    expect(toolNames.length).toBeGreaterThan(0);
    expect(cliOnly.length).toBeGreaterThan(0);
  });

  it("covers exactly the surfaces tmux-control exposes", () => {
    expect(ledgerProblems({ ledger, app: APP, toolNames, cliOnly, repoRoot: REPO_ROOT })).toEqual(
      [],
    );
  });
});

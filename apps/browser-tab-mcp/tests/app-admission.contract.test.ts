/**
 * Every MCP app in this repo is admitted to every guard — and a second app
 * that is not turns this red instead of passing silently.
 *
 * The rules live in `helpers/app-admission.ts`; this file runs them twice:
 * against the real repo (must be clean), and against a fixture repo holding a
 * complete app plus a bare second one (must name every missing piece). The
 * fixture is the proof: without it, "the real repo is clean" would also be
 * what a checker that inspects nothing reports.
 *
 * WHY IT LIVES HERE. Repo-level invariants live in browser-tab-mcp's suite
 * (see release-versions.contract.test.ts); there is no root test package.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { admissionGaps, REQUIRED_CONTRACT_TESTS } from "./helpers/app-admission.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const marked = (name: string, scripts: Record<string, string> = {}) =>
  JSON.stringify({ name, dependencies: { "@george43g/mcp-kit": "^2.0.0" }, scripts });

/** A repo with one fully admitted app (`good-mcp`) and one bare one (`bare-mcp`). */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "bt-admission-"));
  scratch.push(root);
  write(
    root,
    "apps/good-mcp/package.json",
    marked("@x/good-mcp", { "check:usage": "x", stress: "x", test: "x" }),
  );
  for (const files of Object.values(REQUIRED_CONTRACT_TESTS)) {
    write(root, `apps/good-mcp/${files[0]}`, "");
  }
  write(root, "apps/good-mcp/README.md", "");
  write(root, "apps/good-mcp/.usage.kdl", "");
  write(root, "apps/bare-mcp/package.json", marked("@x/bare-mcp"));
  write(
    root,
    "docs/surfaces/effect-coverage.json",
    JSON.stringify({ surfaces: [{ app: "good-mcp", surface: "noop" }] }),
  );
  write(root, "release-please-config.json", JSON.stringify({ packages: { "apps/good-mcp": {} } }));
  write(root, "turbo.json", JSON.stringify({ globalEnv: ["CI", "MCP_DEV"] }));
  return root;
}

describe("app admission", () => {
  it("admits every MCP app in this repo to every guard", () => {
    expect(admissionGaps(REPO)).toEqual([]);
  });

  it("names every missing piece of a bare second app — and nothing of the complete one", () => {
    const gaps = admissionGaps(fixtureRepo());
    expect(gaps.filter((g) => g.startsWith("good-mcp"))).toEqual([]);
    const bare = gaps.filter((g) => g.startsWith("bare-mcp"));
    for (const expected of [
      /no row in docs\/surfaces\/effect-coverage\.json/,
      /no surface ledger contract test/,
      /no MCP↔CLI parity contract test/,
      /no tool annotations contract test/,
      /no README tool table contract test/,
      /no log branding contract test/,
      /no README\.md/,
      /no \.usage\.kdl/,
      /no "check:usage" script/,
      /no "stress" script/,
      /no release-please line/,
    ]) {
      expect(
        bare.some((g) => expected.test(g)),
        `expected a gap matching ${expected}; got:\n${bare.join("\n")}`,
      ).toBe(true);
    }
  });

  it("flags a ledger row for an app that does not exist", () => {
    const root = fixtureRepo();
    write(
      root,
      "docs/surfaces/effect-coverage.json",
      JSON.stringify({
        surfaces: [
          { app: "good-mcp", surface: "noop" },
          { app: "gone-mcp", surface: "noop" },
          { surface: "no_app_field" },
        ],
      }),
    );
    const gaps = admissionGaps(root);
    expect(gaps).toContain('ledger row "noop" names app "gone-mcp", which is not an MCP app');
    expect(gaps).toContain(
      'ledger row "no_app_field" names app "undefined", which is not an MCP app',
    );
  });

  it("flags app-specific variables in turbo's globalEnv", () => {
    const root = fixtureRepo();
    write(root, "turbo.json", JSON.stringify({ globalEnv: ["CI", "BROWSER_TAB_POLL_MS"] }));
    expect(admissionGaps(root).join("\n")).toMatch(/globalEnv holds app-specific.*BROWSER_TAB/);
  });

  it("flags a name-shaped glob --filter in ci.yml", () => {
    const root = fixtureRepo();
    write(
      root,
      ".github/workflows/ci.yml",
      'steps:\n  - run: pnpm --filter "@george43g/*-mcp" check:usage\n',
    );
    expect(admissionGaps(root).join("\n")).toMatch(/glob --filter/);
  });
});

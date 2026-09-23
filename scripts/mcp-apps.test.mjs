import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Runs the REAL script as a subprocess against fixture repos — copied from this
 * repo at test time, never reimplemented. Same pattern and same reason as
 * check-stdout-purity.test.mjs: what CI consumes is the exit code and the
 * stdout, so that is what gets asserted.
 *
 * The red drill that matters is "zero marked apps → exit 1". The whole defect
 * (DEFERRED #52) was a selection that produced an empty set and still exited 0,
 * so proving the empty case goes RED is the point of this file.
 */

const SCRIPT = fileURLToPath(new URL("./mcp-apps.mjs", import.meta.url));
const LIB = fileURLToPath(new URL("./lib/mcp-apps.mjs", import.meta.url));

const sandboxes = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function run(files) {
  const root = mkdtempSync(join(tmpdir(), "mcp-apps-"));
  sandboxes.push(root);
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts", "mcp-apps.mjs"));
  copyFileSync(LIB, join(root, "scripts", "lib", "mcp-apps.mjs"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  try {
    const stdout = execFileSync("node", [join(root, "scripts", "mcp-apps.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      cwd: root,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
  }
}

const MARKED = JSON.stringify({
  name: "@x/server-mcp",
  dependencies: { "@george43g/mcp-kit": "^2.0.0" },
});
const MARKED_DEV_NO_SUFFIX = JSON.stringify({
  name: "@x/second",
  devDependencies: { "@george43g/mcp-kit": "^2.0.0" },
});
const PLAIN = JSON.stringify({ name: "@x/tool", dependencies: { commander: "^14.0.0" } });

describe("mcp-apps", () => {
  it("prints a marked app's package name", () => {
    const r = run({ "apps/server/package.json": MARKED });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), "@x/server-mcp");
  });

  it("does not print an app that lacks the marker", () => {
    const r = run({ "apps/server/package.json": MARKED, "apps/cli-tool/package.json": PLAIN });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["@x/server-mcp"]);
  });

  it("FAILS when no app declares the marker — nothing-to-check is not a pass", () => {
    const r = run({ "apps/cli-tool/package.json": PLAIN });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no apps\/\* workspace declares @george43g\/mcp-kit/);
  });

  it("FAILS when apps/ does not exist at all", () => {
    const r = run({ "package.json": PLAIN });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no apps\/\* workspace declares/);
  });

  it("selects an app whose name does NOT end in -mcp — the suffix is not the marker", () => {
    const r = run({
      "apps/server/package.json": MARKED,
      "apps/second/package.json": MARKED_DEV_NO_SUFFIX,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["@x/second", "@x/server-mcp"]);
  });

  it("FAILS on a marked workspace with no package name — pnpm --filter cannot address it", () => {
    const r = run({
      "apps/nameless/package.json": JSON.stringify({
        dependencies: { "@george43g/mcp-kit": "^2.0.0" },
      }),
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no package name/);
  });
});

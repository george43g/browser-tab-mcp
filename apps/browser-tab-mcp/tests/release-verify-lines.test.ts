/**
 * `scripts/verify-release.mjs` verifies EVERY release line, not just ".".
 *
 * The script used to read `manifest["."]` only. With a second release-please
 * package (D4: tmux-control has its own line) a tmux-control release that
 * merged but never got its tag would leave the verify job GREEN — the v1.0.0
 * silent abort, back for every line but the first.
 *
 * This drives the REAL script as a process against a fixture repo: a
 * two-package config and a fake `git` on PATH answering `ls-remote --tags`.
 * No `gh` on PATH, which the script treats as "not checked" rather than
 * failed, so the only facts in play are the tags.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  groupTagged,
  isGroupReleaseTitle,
  lineFacts,
  lineForComponent,
  parseRemoteTags,
  type ReleaseLine,
  releaseLines,
  untaggedPending,
  verdict,
} from "../../../scripts/verify-release.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const CONFIG = {
  packages: {
    ".": { "release-type": "node", "exclude-paths": ["apps/second-mcp"] },
    "apps/second-mcp": {
      "release-type": "node",
      component: "second",
      "include-component-in-tag": true,
    },
  },
  "include-component-in-tag": false,
  // As in the real config: unset, release-please merges every line into one
  // PR whenever there is more than one package.
  "separate-pull-requests": true,
};

function run(manifest: Record<string, string>, remoteTags: string[]) {
  // realpath: macOS tmpdir is a /var -> /private/var symlink, and the script's
  // main-guard compares import.meta.url against argv[1]. Unresolved, the
  // script would do nothing and exit 0 — a vacuous pass of exactly the kind
  // this file exists to rule out.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bt-release-lines-")));
  scratch.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO, "scripts/verify-release.mjs"), join(root, "scripts/verify-release.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(root, "release-please-config.json"), JSON.stringify(CONFIG));
  writeFileSync(join(root, ".release-please-manifest.json"), JSON.stringify(manifest));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const lines = remoteTags.map((t) => `0000000\trefs/tags/${t}`).join("\\n");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '${lines}\\n'\n`);
  chmodSync(join(bin, "git"), 0o755);
  const r = spawnSync(process.execPath, [join(root, "scripts/verify-release.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: bin },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(process.platform === "win32")("verify-release across release lines", () => {
  it("passes when every line's manifest version is tagged", () => {
    const r = run({ ".": "1.14.0", "apps/second-mcp": "0.1.0" }, ["v1.14.0", "second-v0.1.0"]);
    expect(r.out).toMatch(/release check/);
    expect(r.status, r.out).toBe(0);
  });

  it("FAILS when the second line's release merged but was never tagged", () => {
    const r = run({ ".": "1.14.0", "apps/second-mcp": "0.1.0" }, ["v1.14.0"]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/second-v0\.1\.0 does not exist/);
  });

  it("FAILS when the root line is untagged, even though the second line is fine", () => {
    const r = run({ ".": "1.15.0", "apps/second-mcp": "0.1.0" }, ["v1.14.0", "second-v0.1.0"]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/v1\.15\.0 does not exist/);
  });

  it("treats a line with no tag of its own yet as never released, not as a failure", () => {
    const r = run({ ".": "1.14.0", "apps/second-mcp": "0.0.0" }, ["v1.14.0"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/second.*nothing to verify|no release tags exist yet/);
  });
});

describe("releaseLines / lineFacts / untaggedPending — the per-line pieces", () => {
  const lines = releaseLines(CONFIG, { ".": "1.14.0", "apps/second-mcp": "0.1.0" }, (p) =>
    p === "." ? "browser-tab" : "@george43g/second-mcp",
  );

  it("derives one line per configured package, with release-please's tag shapes", () => {
    expect(lines.map((l) => [l.path, l.component, l.expectedTag, l.branch])).toEqual([
      [".", "browser-tab", "v1.14.0", "release-please--branches--main--components--browser-tab"],
      [
        "apps/second-mcp",
        "second",
        "second-v0.1.0",
        "release-please--branches--main--components--second",
      ],
    ]);
  });

  it("does not let another line's tag satisfy this one", () => {
    const tags = parseRemoteTags("a\trefs/tags/second-v0.1.0\nb\trefs/tags/v1.13.0\n");
    const root = lineFacts(lines[0] as ReleaseLine, {
      tags,
      tagsReadable: true,
      ghPresent: false,
      releaseExists: null,
      openReleasePr: null,
      openPrQueryFailed: false,
      pendingMergedPrs: null,
    });
    expect(root.tagExists).toBe(false);
    expect(verdict(root).ok).toBe(false);
  });

  it("maps a component-titled release PR to its own line's tag", () => {
    const tagged = new Set(["second-v0.1.0"]);
    const isTagged = (version: string, component: string | null) => {
      const line = lineForComponent(lines, component);
      return line ? tagged.has(`${line.tagPrefix}${version}`) : false;
    };
    expect(
      untaggedPending(
        [
          { number: 1, title: "chore(main): release second 0.1.0" },
          { number: 2, title: "chore(main): release 1.15.0" },
        ],
        isTagged,
      ),
    ).toEqual(["#2 chore(main): release 1.15.0"]);
  });
});

describe("the combined node-workspace release PR (per-package lines, 2026-10-04)", () => {
  // tmux-control and the shared packages it depends on set
  // `separate-pull-requests: false`; the node-workspace plugin releases them in
  // ONE PR titled `chore: release main` on the componentless branch, while the
  // root line keeps its own PR. That title names no component and no version.
  const GROUPED = {
    packages: {
      ".": { "release-type": "simple", component: "browser-tab" },
      "apps/second-mcp": {
        "release-type": "node",
        component: "second",
        "include-component-in-tag": true,
        "separate-pull-requests": false,
      },
      "packages/shared": {
        "release-type": "node",
        component: "pkg-shared",
        "include-component-in-tag": true,
        "separate-pull-requests": false,
      },
      "packages/unreleased": {
        "release-type": "node",
        component: "pkg-unreleased",
        "include-component-in-tag": true,
        "separate-pull-requests": false,
      },
    },
    "include-component-in-tag": false,
    "separate-pull-requests": true,
  };
  const lines = releaseLines(
    GROUPED,
    {
      ".": "1.15.0",
      "apps/second-mcp": "0.1.1",
      "packages/shared": "0.1.1",
      "packages/unreleased": "0.0.0",
    },
    () => undefined,
  );

  it("puts grouped lines on the componentless branch and keeps the root line's own", () => {
    expect(lines.map((l) => [l.path, l.grouped, l.branch])).toEqual([
      [".", false, "release-please--branches--main--components--browser-tab"],
      ["apps/second-mcp", true, "release-please--branches--main"],
      ["packages/shared", true, "release-please--branches--main"],
      ["packages/unreleased", true, "release-please--branches--main"],
    ]);
  });

  it("recognises only the combined title as the group PR", () => {
    expect(isGroupReleaseTitle("chore: release main")).toBe(true);
    expect(isGroupReleaseTitle("chore(main): release 1.15.1")).toBe(false);
    expect(isGroupReleaseTitle("chore(main): release tmux-control 0.1.0")).toBe(false);
  });

  it("calls a merged group PR tagged only when every released grouped line has its tag", () => {
    const all = new Set(["v1.15.0", "second-v0.1.1", "pkg-shared-v0.1.1"]);
    expect(groupTagged(lines, all)).toBe(true);
    expect(groupTagged(lines, new Set(["v1.15.0", "second-v0.1.1"]))).toBe(false);
  });

  it("reports an untagged group PR instead of failing to parse its title", () => {
    const pr = [{ number: 7, title: "chore: release main" }];
    const never = () => false;
    expect(untaggedPending(pr, never, () => true)).toEqual([]);
    expect(untaggedPending(pr, never, () => false)).toEqual(["#7 chore: release main"]);
  });

  it("treats a group PR as untagged when no line is grouped", () => {
    const separate = releaseLines(CONFIG, { ".": "1.14.0", "apps/second-mcp": "0.1.0" }, () => "x");
    expect(groupTagged(separate, new Set(["v1.14.0", "second-v0.1.0"]))).toBe(false);
  });
});

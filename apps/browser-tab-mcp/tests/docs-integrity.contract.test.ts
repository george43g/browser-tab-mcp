/**
 * Docs integrity — every path the ENTRY-POINT docs assert must resolve.
 *
 * Added 2026-09-03 acting on the harness-drift audit, which found: a dead
 * link in skills.md (`.agents/skills/browser-tab-dev/` — never existed in
 * git), two diverged skill copies (Codex read a PR SOP naming a release tool
 * this repo dropped), and three self-contradictory claims in AGENTS.md.
 * Prose rots faster than review catches it; this is the cheapest mechanical
 * floor under it (the harness-engineering skill's own required deliverable).
 *
 * Scope, deliberately: markdown LINK TARGETS in the entry-point docs,
 * backticked REPO-ROOTED FILE PATHS in AGENTS.md/skills.md (conservative
 * pattern — commands, globs and symbol names stay prose), and the
 * .agents/skills symlinks. Anything subtler needs a parser this test does
 * not want to become.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The docs whose links are load-bearing for agents entering the repo. */
const ENTRY_DOCS = [
  "AGENTS.md",
  "skills.md",
  "docs/agent-handoff/README.md",
  "apps/chrome-extension/README.md",
  "packages/test-kit/README.md",
];

function linkTargets(doc: string): Array<{ target: string; line: number }> {
  const text = readFileSync(join(ROOT, doc), "utf8");
  const out: Array<{ target: string; line: number }> = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)) {
      const t = (m[1] as string).trim();
      // Only repo-relative file targets: skip URLs, anchors, mail, templates.
      if (/^[a-z]+:/.test(t) || t === "" || t.includes("${")) continue;
      out.push({ target: t, line: i + 1 });
    }
  }
  return out;
}

/**
 * Backticked tokens that read as repo file paths. AGENTS.md carries its
 * paths as prose backticks, not links (zero markdown links in the file —
 * measured, which made the link check vacuous there), so this is the
 * assertion that actually covers the entry point. Conservative: rooted at a
 * known top-level dir and carrying an extension, so command examples and
 * glob prose stay out.
 */
function backtickedPaths(doc: string): Array<{ target: string; line: number }> {
  const text = readFileSync(join(ROOT, doc), "utf8");
  const out: Array<{ target: string; line: number }> = [];
  const pattern =
    /`((?:docs|apps|packages|scripts|\.github|\.githooks|\.claude|\.agents)\/[A-Za-z0-9_./-]+\.[a-z0-9]+)`/g;
  for (const [i, line] of text.split("\n").entries()) {
    for (const m of line.matchAll(pattern)) {
      const t = m[1] as string;
      if (t.includes("*") || t.includes("{")) continue; // glob prose
      out.push({ target: t, line: i + 1 });
    }
  }
  return out;
}

describe("docs integrity", () => {
  for (const doc of ENTRY_DOCS) {
    it(`${doc}: every relative markdown link resolves`, () => {
      const dead = linkTargets(doc).filter(
        ({ target }) => !existsSync(resolve(ROOT, dirname(doc), target)),
      );
      expect(
        dead,
        `dead link target(s) in ${doc} — fix the link or the file it names:\n` +
          dead.map((d) => `  ${doc}:${d.line} → ${d.target}`).join("\n"),
      ).toEqual([]);
    });
  }

  it("AGENTS.md + skills.md: every backticked repo-rooted file path resolves", () => {
    const dead: string[] = [];
    let considered = 0;
    for (const doc of ["AGENTS.md", "skills.md"]) {
      for (const { target, line } of backtickedPaths(doc)) {
        considered += 1;
        if (!existsSync(resolve(ROOT, target))) dead.push(`${doc}:${line} → ${target}`);
      }
    }
    // Anti-vacuity floor: AGENTS.md names dozens of paths; extracting almost
    // none means the pattern broke, not that the docs went quiet.
    expect(considered, "path extractor found a real sample").toBeGreaterThan(10);
    expect(
      dead,
      `stale path(s) — fix the prose or restore the file:\n  ${dead.join("\n  ")}`,
    ).toEqual([]);
  });

  it(".agents/skills entries link into .claude/skills — never a divergeable copy", () => {
    // The audit's root cause for the diverged PR SOP: an independent copy of
    // the skill that only one tool's edits reached. The invariant is
    // NON-DIVERGENCE, and its on-disk shape is platform-dependent: POSIX
    // checks out a symlink; Windows runners (`core.symlinks=false` — this
    // test's first CI run proved it) materialize the same git object as a
    // PLAIN FILE whose content is the link target. Both forms are the one
    // git object and both are asserted; a real DIRECTORY is the hazard and
    // always fails.
    const dir = join(ROOT, ".agents/skills");
    const entries = readdirSync(dir).filter((e) => !e.startsWith("."));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const p = join(dir, e);
      const st = lstatSync(p);
      let target: string;
      if (st.isSymbolicLink()) {
        target = readlinkSync(p);
      } else if (st.isFile()) {
        target = readFileSync(p, "utf8").trim();
      } else {
        expect.fail(
          `${p} is a real directory — .agents/skills/* must be links into .claude/skills ` +
            `(an independent copy is how the PR SOP silently diverged; 2026-09-02 audit)`,
        );
      }
      expect(target.replaceAll("\\", "/")).toBe(`../../.claude/skills/${e}`);
      expect(
        existsSync(join(ROOT, ".claude/skills", e, "SKILL.md")),
        `link target .claude/skills/${e} must hold a SKILL.md`,
      ).toBe(true);
    }
  });

  it("the e2e test-count claims in AGENTS.md defer to run-guard, never a literal count", () => {
    // Two hard-coded counts drifted ("3", then "60"); the enforced floor in
    // e2e/run-guard.ts is the number's only home. A regression here is
    // someone writing "runs the N Playwright tests" again.
    const text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(text).not.toMatch(/runs the \d+ Playwright tests/);
    expect(text).toMatch(/EXPECTED_MIN_TESTS/);
  });

  it("AGENTS.md claims no enforcement it does not have for the stdout rule", () => {
    // "CI grep enforces this" stood for months with no such grep anywhere.
    const text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(text).not.toMatch(/CI grep enforces this\./);
  });
});

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
 * backticked REPO-ROOTED FILE PATHS in AGENTS.md/skills.md/docs/agents/*.md
 * (conservative pattern — commands, globs and symbol names stay prose), and
 * the .agents/skills symlinks. Anything subtler needs a parser this test does
 * not want to become.
 *
 * 2026-09-24 (BACKLOG B28 reopened): AGENTS.md became a router under Codex's
 * 32 KiB `project_doc_max_bytes` and its sections moved verbatim into
 * docs/agents/. Every check that used to read AGENTS.md alone now reads the
 * router PLUS those docs (AGENT_DOCS), or a moved section would silently lose
 * the floor B28 relied on. Two checks were added for the split itself: the
 * instruction-chain byte cap, and preservation of the old section headings.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Where the router's detail lives. Enumerated from disk, never hand-listed,
 * so a new file here is covered by every check below the moment it exists.
 */
const AGENT_DOCS_DIR = "docs/agents";
const AGENT_DOC_FILES = readdirSync(join(ROOT, AGENT_DOCS_DIR))
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => `${AGENT_DOCS_DIR}/${f}`);

/** The router plus every doc it routes to — what used to be one AGENTS.md. */
const AGENT_DOCS = ["AGENTS.md", ...AGENT_DOC_FILES];

/** The docs whose links are load-bearing for agents entering the repo. */
const ENTRY_DOCS = [
  ...AGENT_DOCS,
  "skills.md",
  "docs/agent-handoff/README.md",
  "apps/chrome-extension/README.md",
  "packages/test-kit/README.md",
];

function read(doc: string): string {
  return readFileSync(join(ROOT, doc), "utf8");
}

/**
 * Codex's default `project_doc_max_bytes` (openai/codex
 * codex-rs/config/defaults.toml). Codex concatenates every AGENTS.md from the
 * repo root down to the working directory and silently cuts at this many
 * bytes — a Codex session here on 2026-09-21 never saw anything after
 * "## Env layout", i.e. none of the guardrails.
 */
const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;

/**
 * Every `## ` heading of AGENTS.md as it stood before the 2026-09-24 split
 * (plus its one `### `). Each must still be a heading in the router or in a
 * docs/agents file: dropping one by accident is how a rule disappears.
 */
const PRE_SPLIT_HEADINGS = [
  "What This Repo Is",
  "Stack",
  "Workspace topology",
  "Commands",
  "Connector extension (Chrome + Safari)",
  'Extension–daemon merge (why the extension "wins")',
  "Env layout (Vite-style precedence)",
  "MCP best practices enforced in this codebase",
  "Self-healing watchdog",
  "Process lifecycle",
  "Logs",
  "Stress harness",
  "Post-step verification rule",
  "Guardrails (interpretation/MCP)",
  "Native Rust acceleration (optional)",
  "Testing posture & taxonomy",
  "Effect coverage — the ledger, and why it is not a table in this file",
  "CI / Release",
  "Cloud-agent (Cursor/Claude/Codex remote) specifics",
  "Troubleshooting",
  "MCP servers (project scope)",
];

function linkTargets(doc: string): Array<{ target: string; line: number }> {
  const text = read(doc);
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
  const text = read(doc);
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

  it("AGENTS.md + docs/agents + skills.md: every backticked repo-rooted file path resolves", () => {
    const dead: string[] = [];
    let considered = 0;
    for (const doc of [...AGENT_DOCS, "skills.md"]) {
      for (const { target, line } of backtickedPaths(doc)) {
        considered += 1;
        if (!existsSync(resolve(ROOT, target))) dead.push(`${doc}:${line} → ${target}`);
      }
    }
    // Anti-vacuity floor, over the UNION: the router names few paths by
    // design, the docs it routes to name dozens; extracting almost none means
    // the pattern broke, not that the docs went quiet.
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

  it("the e2e test-count claims in the agent docs defer to run-guard, never a literal count", () => {
    // Two hard-coded counts drifted ("3", then "60"); the enforced floor in
    // e2e/run-guard.ts is the number's only home. A regression here is
    // someone writing "runs the N Playwright tests" again — in the router OR
    // any doc it routes to (a negative match on AGENTS.md alone would pass
    // vacuously now that the testing text lives in docs/agents/testing.md).
    for (const doc of AGENT_DOCS) {
      expect(read(doc), doc).not.toMatch(/runs the \d+ Playwright tests/);
    }
    // The pointer must live where the testing text now lives.
    expect(read(`${AGENT_DOCS_DIR}/testing.md`)).toMatch(/EXPECTED_MIN_TESTS/);
    expect(read(`${AGENT_DOCS_DIR}/ci-release.md`)).toMatch(/EXPECTED_MIN_TESTS/);
  });

  it("README.md's Tools table lists EVERY registered tool — no silent omissions", () => {
    // Measured 2026-09-04 during George's completeness review (B26): the table
    // carried 14 of 25 tools while its own preamble reads "Every MCP tool is
    // also a CLI subcommand" — so the omission read as a catalogue, not as a
    // selection. The whole write-side (tab_action, group_tabs, the window
    // trio), all of perception (get_page/annotate/screenshot) and all of
    // memory (journal/history/bookmarks) were invisible to anyone entering
    // through the front door. A prose table is allowed to be long; it is not
    // allowed to be quietly partial.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("\n## Tools\n"));
    const table = section.slice(0, section.indexOf("\n### "));
    const listed = new Set([...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] as string));
    const registered = makeAppRegistry().tools.map((t) => t.name);
    const missing = registered.filter((n) => !listed.has(n));
    const orphaned = [...listed].filter((n) => !registered.includes(n));
    expect(missing, "tool(s) with no README row — add one, or the table is lying").toEqual([]);
    expect(orphaned, "README row(s) for tools that no longer exist").toEqual([]);
  });

  it("the connector requests no cookies/site-data permission — refused, not overlooked", () => {
    // George, 2026-09-05, deciding gap G7: "say that its refused for now,
    // unless we think of some feature in the future that wants it." The
    // failure this pins is not a bug — it is a permission bump nobody
    // notices. A cookie clear logs the user out of an origin everywhere and
    // is unrecoverable, so acquiring the capability should cost a decision:
    // if a feature genuinely needs it, delete this test in the same PR that
    // adds the permission, and move the line in docs/CONTROL-SURFACE.md out
    // of the boundary section.
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "apps/chrome-extension/public/manifest.json"), "utf8"),
    ) as { permissions?: string[] };
    const perms = manifest.permissions ?? [];
    // Anti-vacuity: an empty/renamed permissions array must not pass silently.
    expect(perms.length, "manifest permissions were read at all").toBeGreaterThan(3);
    for (const banned of ["cookies", "browsingData", "contentSettings"]) {
      expect(
        perms,
        `"${banned}" is a refused capability (G7) — see docs/CONTROL-SURFACE.md`,
      ).not.toContain(banned);
    }
  });

  it("the agent docs claim no enforcement they do not have for the stdout rule", () => {
    // "CI grep enforces this" stood for months with no such grep anywhere.
    // The rule's text now lives in docs/agents/mcp-rules.md; the router keeps
    // a one-liner. Check both, and prove the moved text is really there so
    // the negative match cannot pass on an empty file.
    for (const doc of AGENT_DOCS) {
      expect(read(doc), doc).not.toMatch(/CI grep enforces this\./);
    }
    expect(read(`${AGENT_DOCS_DIR}/mcp-rules.md`)).toMatch(/StdioServerTransport\.connect\(\)/);
  });

  it("every root-to-leaf AGENTS.md chain fits Codex's project_doc_max_bytes", () => {
    // Idea from ~/repos/executive/scripts/check-harness.mjs (§ 4b), which
    // checks root + one level of team/ dirs; generalised here to any depth.
    // Enumerated with git, not a filesystem walk: agent worktrees nested
    // inside the checkout carry their own AGENTS.md and must not be counted.
    const tracked = execFileSync(
      "git",
      ["ls-files", "-z", "--", "*AGENTS.md", ":(glob)**/AGENTS.md"],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\0")
      .filter((f) => f === "AGENTS.md" || f.endsWith("/AGENTS.md"));
    const trackedSet = new Set(tracked);
    expect(trackedSet.has("AGENTS.md"), "the root AGENTS.md is tracked").toBe(true);
    const over: string[] = [];
    for (const leaf of trackedSet) {
      // Codex reads root → cwd: every tracked AGENTS.md in an ancestor dir.
      const parts = leaf.split("/").slice(0, -1);
      const chain: string[] = [];
      for (let i = 0; i <= parts.length; i++) {
        const candidate = [...parts.slice(0, i), "AGENTS.md"].join("/");
        if (trackedSet.has(candidate)) chain.push(candidate);
      }
      const bytes = chain.reduce((sum, f) => sum + statSync(join(ROOT, f)).size, 0);
      if (bytes > CODEX_PROJECT_DOC_MAX_BYTES) {
        over.push(`${chain.join(" + ")} = ${bytes} B`);
      }
    }
    expect(
      over,
      `instruction chain(s) over Codex's ${CODEX_PROJECT_DOC_MAX_BYTES}-byte project_doc_max_bytes — ` +
        "Codex silently drops everything past the cap, safety rules included. Fix: move detail " +
        "out of the AGENTS.md files into docs/agents/ and leave a routing line that names the " +
        `task needing it (see docs/agents/README.md):\n  ${over.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every docs/agents file is routed to from AGENTS.md", () => {
    // A moved section no agent is routed to is a deleted rule.
    const router = read("AGENTS.md");
    expect(AGENT_DOC_FILES.length, "docs/agents was read at all").toBeGreaterThan(5);
    const unrouted = AGENT_DOC_FILES.filter((f) => !router.includes(`](${f}`));
    expect(
      unrouted,
      "docs/agents file(s) with no link from AGENTS.md — add a routing line naming the task that needs it",
    ).toEqual([]);
  });

  it("every pre-split AGENTS.md section heading still exists in the router or docs/agents", () => {
    const headings = new Set<string>();
    for (const doc of AGENT_DOCS) {
      for (const m of read(doc).matchAll(/^#{1,6} (.+?)\s*$/gm)) headings.add(m[1] as string);
    }
    const lost = PRE_SPLIT_HEADINGS.filter((h) => !headings.has(h));
    expect(
      lost,
      "section heading(s) from the pre-split AGENTS.md are gone — a section was dropped. " +
        "Restore it in docs/agents/ (verbatim), or, if it was retired on purpose, remove it " +
        "from PRE_SPLIT_HEADINGS in the same commit and say why",
    ).toEqual([]);
  });
});

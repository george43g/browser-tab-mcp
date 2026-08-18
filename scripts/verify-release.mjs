/**
 * Did the release actually happen?
 *
 * WHY THIS EXISTS. This repo's release has failed *silently* twice, in two
 * different ways, and both times the workflow was green:
 *
 *   1. v1.0.0 — the release PR merged, the version bump and CHANGELOG landed on
 *      `main`, and the cut aborted with "There are untagged, merged release PRs
 *      outstanding". No tag, no GitHub Release, no red build. It was cut by
 *      hand days later.
 *   2. 2026-08-17 — a GitHub API degradation failed six consecutive runs. Those
 *      at least went red, but nothing distinguished "transient" from "broken
 *      config", so the first response was to change permissions that were never
 *      the problem.
 *
 * A workflow that is green when nothing shipped is worse than one that is red.
 * So the invariant is stated positively and checked on EVERY push, not only on
 * release pushes:
 *
 *   the version in .release-please-manifest.json has a git tag AND a published
 *   GitHub Release, and no merged release PR is still waiting to be tagged.
 *
 * That holds in the quiet state (nothing to release), immediately after a cut,
 * and everywhere in between — so it needs no argument, no event inspection, and
 * no knowledge of which push it is running on. It is also the reason this is a
 * script rather than inline YAML: `pnpm release:check` answers "is the release
 * machinery healthy" locally, in a second, and the decision logic is unit
 * tested (apps/browser-tab-mcp/tests/release-verify.test.ts).
 *
 * Exit 0 = healthy. Exit 1 = something shipped incompletely; the output says
 * what to do about it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The pure verdict. Every input is a fact someone else gathered, so this can be
 * tested without a network, a token, or a git remote.
 *
 * `null` means "could not determine" and is deliberately NOT treated as a
 * failure — a developer without `gh` on PATH should get a useful partial answer
 * rather than a scary red one. CI always has `gh`, so CI always gets the full
 * check.
 *
 * @param {object} facts
 * @param {string} facts.expectedTag        tag the manifest baseline implies, e.g. "v1.1.1"
 * @param {boolean} facts.anyTagsExist      does the repo have any release tag at all
 * @param {boolean} facts.tagExists         does `expectedTag` exist on the remote
 * @param {boolean|null} facts.releaseExists is there a published GitHub Release for it
 * @param {string[]|null} facts.pendingMergedPrs merged PRs still labelled `autorelease: pending`
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
export function verdict({ expectedTag, anyTagsExist, tagExists, releaseExists, pendingMergedPrs }) {
  const problems = [];
  const notes = [];

  if (!anyTagsExist) {
    // A repo that has never released has nothing to verify. Saying so beats
    // failing every push until the first release lands.
    notes.push("no release tags exist yet — nothing to verify");
    return { ok: true, problems, notes };
  }

  if (!tagExists) {
    problems.push(
      `.release-please-manifest.json is at ${expectedTag.replace(/^v/, "")} but tag ` +
        `${expectedTag} does not exist. The release PR merged and the cut did not ` +
        `happen. Recover: gh release create ${expectedTag} --target <merge-commit> ` +
        `--notes "<the CHANGELOG section>", then swap the release PR's label ` +
        `"autorelease: pending" -> "autorelease: tagged" and re-run the Release workflow.`,
    );
  } else if (releaseExists === false) {
    problems.push(
      `tag ${expectedTag} exists but has no published GitHub Release. The changelog ` +
        `for this version is not visible to anyone. Recover: gh release create ` +
        `${expectedTag} --notes "<the CHANGELOG section>".`,
    );
  } else if (releaseExists === null) {
    notes.push(`GitHub Release for ${expectedTag} not checked (gh unavailable)`);
  }

  if (pendingMergedPrs === null) {
    notes.push("merged-but-untagged release PRs not checked (gh unavailable)");
  } else if (pendingMergedPrs.length > 0) {
    problems.push(
      `merged release PR(s) still labelled "autorelease: pending": ${pendingMergedPrs.join(", ")}. ` +
        `release-please aborts every subsequent cut while one of these is outstanding ` +
        `("There are untagged, merged release PRs outstanding"), so releases stop ` +
        `silently. Tag it, then relabel it "autorelease: tagged".`,
    );
  }

  return { ok: problems.length === 0, problems, notes };
}

/** Run a command; return its stdout, or `null` if it is unavailable or fails. */
function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function gatherFacts() {
  const manifest = JSON.parse(readFileSync(join(REPO, ".release-please-manifest.json"), "utf8"));
  const expectedTag = `v${manifest["."]}`;

  // `git ls-remote` asks the REMOTE, so a stale local tag cache cannot make a
  // missing release look present — the exact way this check could lie.
  const remoteTags = tryRun("git", ["ls-remote", "--tags", "origin"]) ?? "";
  const anyTagsExist = /refs\/tags\/v\d/.test(remoteTags);
  const tagExists = remoteTags.includes(`refs/tags/${expectedTag}`);

  const gh = tryRun("gh", ["--version"]) !== null;
  const releaseExists = gh
    ? tryRun("gh", ["release", "view", expectedTag, "--json", "tagName"]) !== null
    : null;

  let pendingMergedPrs = null;
  if (gh) {
    const raw = tryRun("gh", [
      "pr",
      "list",
      "--state",
      "merged",
      "--label",
      "autorelease: pending",
      "--json",
      "number,title",
      "--limit",
      "20",
    ]);
    if (raw !== null) {
      try {
        pendingMergedPrs = JSON.parse(raw).map((pr) => `#${pr.number} ${pr.title}`);
      } catch {
        pendingMergedPrs = null;
      }
    }
  }

  return { expectedTag, anyTagsExist, tagExists, releaseExists, pendingMergedPrs };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const facts = gatherFacts();
  const { ok, problems, notes } = verdict(facts);

  process.stdout.write(`release check — baseline ${facts.expectedTag}\n`);
  for (const note of notes) process.stdout.write(`  note: ${note}\n`);
  for (const problem of problems) process.stdout.write(`\n  PROBLEM: ${problem}\n`);

  // `--annotate` emits GitHub Actions `::error::` lines, which annotate the run
  // and surface in the job summary so a failure is legible without opening the
  // log. It is a FLAG rather than a `GITHUB_ACTIONS` env sniff so the call site
  // decides — the workflow asks for annotations, a local `pnpm release:check`
  // gets plain prose, and nothing has to reach into the ambient environment.
  if (!ok && process.argv.includes("--annotate")) {
    for (const problem of problems) {
      process.stdout.write(`::error::${problem.replace(/\n/g, " ")}\n`);
    }
  }
  if (ok) process.stdout.write("  ok\n");
  process.exit(ok ? 0 : 1);
}

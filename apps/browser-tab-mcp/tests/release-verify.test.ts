/**
 * The release-health decision table (`scripts/verify-release.mjs`).
 *
 * Each case is a way this repo's release has failed, or could fail, WITH A
 * GREEN BUILD — which is the only reason the script exists. Testing the pure
 * verdict rather than the `gh` plumbing means the interesting half runs with no
 * network, no token, and no remote.
 *
 * WHY IT LIVES IN tests/ RATHER THAN COLOCATED. The module under test is a
 * repo-root script (next to `build-stamp.mjs`), so it has no owning package to
 * colocate in. `browser-tab-mcp` is the release artifact, so its suite is where
 * release machinery is checked — same reasoning as
 * release-versions.contract.test.ts.
 */

import { describe, expect, it } from "vitest";
import { untaggedPending, verdict } from "../../../scripts/verify-release.mjs";

/** A repo in the healthy steady state: released, tagged, published, nothing pending. */
const healthy = {
  expectedTag: "v1.1.1",
  anyTagsExist: true,
  tagExists: true,
  releaseExists: true,
  pendingMergedPrs: [],
};

describe("untaggedPending — the label/tag race", () => {
  // release-please creates the tag and Release FIRST, then swaps the label
  // `autorelease: pending` -> `tagged`. Between those two calls a healthy
  // release is indistinguishable from the v1.0.0 silent abort — and the Release
  // workflow runs its verify job in exactly that window. Observed live on the
  // v1.2.1 cut: tag present, Release published, label still `pending`.
  const tagged = (v: string) => v === "1.2.1";

  it("ignores a pending label once the version is actually tagged", () => {
    expect(untaggedPending([{ number: 60, title: "chore(main): release 1.2.1" }], tagged)).toEqual(
      [],
    );
  });

  it("still reports a merged release PR whose version was never tagged", () => {
    expect(untaggedPending([{ number: 44, title: "chore(main): release 9.9.9" }], tagged)).toEqual([
      "#44 chore(main): release 9.9.9",
    ]);
  });

  it("reads a v-prefixed title", () => {
    expect(untaggedPending([{ number: 7, title: "chore: release v1.2.1" }], tagged)).toEqual([]);
  });

  it("reports, rather than skips, a title it cannot parse", () => {
    // An unknown state in the release path should be loud, not silently fine.
    const out = untaggedPending([{ number: 8, title: "chore(main): something else" }], tagged);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("could not read a version");
  });

  it("separates the tagged from the untagged in one pass", () => {
    const out = untaggedPending(
      [
        { number: 60, title: "chore(main): release 1.2.1" },
        { number: 61, title: "chore(main): release 1.3.0" },
      ],
      tagged,
    );
    expect(out).toEqual(["#61 chore(main): release 1.3.0"]);
  });
});

describe("release verdict", () => {
  it("passes in the quiet, fully-released state", () => {
    const v = verdict(healthy);
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
  });

  it("passes — with a note — before the first release exists", () => {
    // A repo that has never released must not fail every push until it does.
    const v = verdict({ ...healthy, anyTagsExist: false, tagExists: false, releaseExists: false });
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("no release tags exist yet");
  });

  it("fails when the manifest moved but no tag was cut (the v1.0.0 failure)", () => {
    const v = verdict({ ...healthy, tagExists: false, releaseExists: false });
    expect(v.ok).toBe(false);
    // The message has to carry the recovery, because whoever reads it is
    // reading a red build weeks later with no memory of the abort.
    expect(v.problems[0]).toContain("v1.1.1 does not exist");
    expect(v.problems[0]).toContain("gh release create v1.1.1");
  });

  it("fails when the tag exists but the GitHub Release was never published", () => {
    const v = verdict({ ...healthy, releaseExists: false });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("no published GitHub Release");
  });

  it("fails on a merged release PR still labelled autorelease: pending", () => {
    // This is the state that makes every FUTURE cut abort, so it must be loud
    // even when the current version looks perfectly fine.
    const v = verdict({ ...healthy, pendingMergedPrs: ["#44 chore(main): release 1.1.1"] });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("#44");
    expect(v.problems[0]).toContain("autorelease: tagged");
  });

  it("does not invent a failure when gh is unavailable", () => {
    // `null` is "unknown", not "broken" — a developer without gh on PATH gets a
    // partial answer, and CI (which always has gh) gets the full one.
    const v = verdict({ ...healthy, releaseExists: null, pendingMergedPrs: null });
    expect(v.ok).toBe(true);
    expect(v.notes).toHaveLength(2);
    expect(v.notes.join(" ")).toContain("gh unavailable");
  });

  it("fails when an open release PR predates an extra-files change", () => {
    // The 2026-08-18 miss. release-please refreshes an open release PR only
    // when the version or notes change, so a new `extra-files` entry never
    // reaches a PR that is already open — and the release ships a file whose
    // version never moved. Nothing else in the pipeline notices until AFTER
    // the merge.
    const v = verdict({
      ...healthy,
      extraFiles: [
        "apps/browser-tab-mcp/package.json",
        "apps/chrome-extension/public/manifest.json",
      ],
      openReleasePr: {
        number: 57,
        files: ["package.json", "CHANGELOG.md", "apps/browser-tab-mcp/package.json"],
      },
    });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("apps/chrome-extension/public/manifest.json");
    expect(v.problems[0]).toContain("delete the branch");
  });

  it("passes when the open release PR touches every extra-file", () => {
    const v = verdict({
      ...healthy,
      extraFiles: ["apps/chrome-extension/public/manifest.json"],
      openReleasePr: {
        number: 58,
        files: ["package.json", "CHANGELOG.md", "apps/chrome-extension/public/manifest.json"],
      },
    });
    expect(v.ok).toBe(true);
  });

  it("says so, rather than passing quietly, when no release PR is open", () => {
    const v = verdict({ ...healthy, extraFiles: ["a/package.json"], openReleasePr: null });
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("no open release PR");
  });

  it("reports every independent problem at once", () => {
    // One run, one fix list — not fix, re-run, discover the next one.
    const v = verdict({
      ...healthy,
      tagExists: false,
      releaseExists: false,
      pendingMergedPrs: ["#44 chore(main): release 1.1.1"],
    });
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(2);
  });

  // --- B21 (partition-vs-iterate, 2026-09-02): a selector that fails EMPTY
  // must not impersonate a selector that matched nothing. Before these facts
  // existed, a failed `git ls-remote` coerced to "" and took the benign
  // "no release tags exist yet" early exit — green over a repo with a dozen
  // releases — and a failed gh query wore the "gh unavailable" note while gh
  // sat right there on PATH.

  it("fails, rather than reporting a never-released repo, when the remote tag list could not be read", () => {
    const v = verdict({ ...healthy, tagsReadable: false });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("ls-remote");
    expect(v.problems[0]).toContain("verifies nothing");
    // The lie this guards against: the never-released note must NOT appear.
    expect(v.notes.join(" ")).not.toContain("no release tags exist yet");
  });

  it("fails when gh is present but the merged-release-PR query failed", () => {
    // Presence of the binary is not the capability to answer. In CI gh always
    // exists, so a null here means the v1.0.0-abort check silently did not run.
    const v = verdict({ ...healthy, pendingMergedPrs: null, ghPresent: true });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toContain("did NOT run");
  });

  it("fails when gh is present but the release lookup failed", () => {
    const v = verdict({ ...healthy, releaseExists: null, ghPresent: true });
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toContain("did NOT run");
  });

  it("notes an open-PR query failure instead of claiming no release PR is open", () => {
    const v = verdict({
      ...healthy,
      extraFiles: ["a/package.json"],
      openReleasePr: null,
      openPrQueryFailed: true,
    });
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("query failed");
    expect(v.notes.join(" ")).not.toContain("no open release PR");
  });
});

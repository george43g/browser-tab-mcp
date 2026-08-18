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
import { verdict } from "../../../scripts/verify-release.mjs";

/** A repo in the healthy steady state: released, tagged, published, nothing pending. */
const healthy = {
  expectedTag: "v1.1.1",
  anyTagsExist: true,
  tagExists: true,
  releaseExists: true,
  pendingMergedPrs: [],
};

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
});

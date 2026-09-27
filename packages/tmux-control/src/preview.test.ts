import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTmuxSnapshot, type TmuxRawSnapshot } from "./adapter/read.js";
import { previewSplitImpact } from "./preview.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/linked-2026-09-27.json", import.meta.url)),
    "utf8",
  ),
) as TmuxRawSnapshot;
const snapshot = parseTmuxSnapshot(fixture);

describe("linked-window split impact preview", () => {
  it("names the other session whose shared window will change", () => {
    const impact = previewSplitImpact(snapshot, "$1:@0");
    expect(impact.windowId).toBe("@0");
    expect(impact.affectedSlots).toEqual([{ sessionName: "sample", index: 0, key: "$0:@0" }]);
    expect(impact.message).toContain("also changes window @0 as seen in session sample");
    expect(impact.message).toContain("same window and panes");
  });

  it("does not imply that an unlinked window affects another session", () => {
    const impact = previewSplitImpact(snapshot, "$1:@1");
    expect(impact.affectedSlots).toEqual([]);
    expect(impact.message).toContain("No other slot links to it");
    expect(impact.message).not.toContain("session sample");
  });

  it("rejects a stale slot key", () => {
    expect(() => previewSplitImpact(snapshot, "$9:@0")).toThrow(/Unknown tmux slot/);
  });
});

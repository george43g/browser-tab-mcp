/**
 * cutTabs — the §9.4 sequence as executable contract: a source closes ONLY
 * after its replacement verifies; an unverified/failed/skipped creation
 * leaves its source open (asserted over the recorded command stream); the
 * all-before-close mode holds EVERY closure when any creation fails; a
 * failed close reports both survivors.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { makeIdempotencyCache } from "./copy.js";
import { cutTabs } from "./cut.js";
import type { JournalStore } from "./journal.js";
import { SelectionStore } from "./selections.js";
import { StateStore } from "./state.js";

function deps(tabOverrides: Array<Record<string, unknown>> = []) {
  const store = new StateStore();
  const tabs = [
    makeContractTab({ tabId: "a", index: 0, url: "https://one.example/x" }),
    makeContractTab({ tabId: "b", index: 1, url: "https://two.example/y" }),
    ...tabOverrides.map((o, i) => makeContractTab({ tabId: `x${i}`, index: 2 + i, ...o })),
  ];
  store.update(
    makeSnapshot({
      browsers: [
        makeBrowserState({
          browser: "chrome",
          extensionConnected: true,
          dataSource: "extension",
          windows: [
            makeContractWindow({ windowId: "w:chrome:x1", tabs }),
            makeContractWindow({
              windowId: "w:chrome:x2",
              focused: false,
              tabs: [makeContractTab({ tabId: "z", index: 0 })],
            }),
          ],
        }),
      ],
    }),
  );
  const journal = {
    temporalSnapshot: () => ({ focused: new Map(), navigated: new Map() }),
    windowMru: () => [],
  } as unknown as JournalStore;
  const commands: Array<Record<string, unknown>> = [];
  let n = 0;
  const runCommand = async (p: Record<string, unknown>) => {
    commands.push(p);
    if (p.kind === "open_tab" || p.kind === "open_window") {
      n += 1;
      return { tabId: `t:chrome:xNEW${n}`, windowId: "w:chrome:xNEWW" };
    }
    return { ok: true };
  };
  return {
    store,
    journal,
    selections: new SelectionStore(),
    idempotency: makeIdempotencyCache(),
    runCommand,
    commands,
  };
}

const inWindow = {
  kind: "members",
  nodes: { kind: "ids", ids: ["w:chrome:x1"] },
  relation: "tabs",
};
const dest = { kind: "window", windowId: "w:chrome:x2" };
const closesOf = (cmds: Array<Record<string, unknown>>) =>
  cmds.filter((c) => c.kind === "close_tab").map((c) => c.tabId);

describe("cutTabs", () => {
  it("after-each-success: create → verify → close, per source, in order", async () => {
    const d = deps();
    const out = await cutTabs(
      { selector: inWindow, destination: dest, confirmDestruction: true },
      d,
    );
    expect(out.status).toBe("success");
    expect(out.items.map((i) => i.status)).toEqual(["transferred", "transferred"]);
    expect(d.commands.map((c) => c.kind)).toEqual([
      "open_tab",
      "close_tab",
      "open_tab",
      "close_tab",
    ]);
    expect(closesOf(d.commands)).toEqual(["a", "b"]);
  });

  it("confirmDestruction is schema-required — no truthy substitute reaches execution", async () => {
    const d = deps();
    await expect(
      cutTabs({ selector: inWindow, destination: dest, confirmDestruction: 1 }, d),
    ).rejects.toThrow();
    await expect(cutTabs({ selector: inWindow, destination: dest }, d)).rejects.toThrow();
    expect(d.commands).toEqual([]);
  });

  it("a failed creation leaves ITS source open; later sources still transfer", async () => {
    const d = deps();
    let opens = 0;
    const flaky = async (p: Record<string, unknown>) => {
      if (p.kind === "open_tab") {
        opens += 1;
        if (opens === 1) throw new Error("destination refused");
      }
      return d.runCommand(p);
    };
    const out = await cutTabs(
      { selector: inWindow, destination: dest, confirmDestruction: true },
      { ...d, runCommand: flaky },
    );
    expect(out.status).toBe("partial");
    expect(out.items.map((i) => i.status)).toEqual(["copy_failed", "transferred"]);
    // Source "a" was NEVER closed — the safety half of §9.4.
    expect(closesOf(d.commands)).toEqual(["b"]);
  });

  it("policy-refused URLs skip with the source left open", async () => {
    const d = deps([{ url: "javascript:alert(1)" }]);
    const out = await cutTabs(
      { selector: inWindow, destination: dest, confirmDestruction: true },
      d,
    );
    expect(out.items[2]?.status).toBe("skipped");
    expect(out.items[2]?.reason).toMatch(/source left open/);
    expect(closesOf(d.commands)).toEqual(["a", "b"]);
  });

  it("all-before-close: one failure holds EVERY closure; copies reported as duplicates", async () => {
    const d = deps();
    let opens = 0;
    const flaky = async (p: Record<string, unknown>) => {
      if (p.kind === "open_tab") {
        opens += 1;
        if (opens === 2) throw new Error("second create failed");
      }
      return d.runCommand(p);
    };
    const out = await cutTabs(
      {
        selector: inWindow,
        destination: dest,
        confirmDestruction: true,
        mode: "all-before-close",
      },
      { ...d, runCommand: flaky },
    );
    expect(closesOf(d.commands)).toEqual([]);
    expect(out.status).toBe("failed");
    expect(out.items.map((i) => i.status).sort()).toEqual(["close_failed", "copy_failed"]);
    expect(out.warnings.join(" ")).toMatch(/held every closure/);
  });

  it("all-before-close with clean creations closes every source at the end", async () => {
    const d = deps();
    const out = await cutTabs(
      {
        selector: inWindow,
        destination: dest,
        confirmDestruction: true,
        mode: "all-before-close",
      },
      d,
    );
    expect(out.status).toBe("success");
    expect(d.commands.map((c) => c.kind)).toEqual([
      "open_tab",
      "open_tab",
      "close_tab",
      "close_tab",
    ]);
  });

  it("a failed close reports BOTH survivors, never silently", async () => {
    const d = deps();
    const stubborn = async (p: Record<string, unknown>) => {
      if (p.kind === "close_tab" && p.tabId === "a") throw new Error("browser refused close");
      return d.runCommand(p);
    };
    const out = await cutTabs(
      { selector: inWindow, destination: dest, confirmDestruction: true },
      { ...d, runCommand: stubborn },
    );
    expect(out.status).toBe("partial");
    expect(out.items[0]?.status).toBe("close_failed");
    expect(out.items[0]?.reason).toMatch(/replacement t:chrome:xNEW1 exists/);
  });
});

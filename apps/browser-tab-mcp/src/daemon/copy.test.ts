/**
 * copyTabs — the additive contract: sources untouched BY CONSTRUCTION
 * (asserted over the recorded command stream: nothing close-shaped may
 * appear), per-item policy skips, one new window per call, pinned intent on
 * the creation itself, and idempotent replay.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { copyTabs, makeIdempotencyCache } from "./copy.js";
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
    n += 1;
    return { tabId: `t:chrome:xNEW${n}`, windowId: "w:chrome:xNEWW" };
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

describe("copyTabs", () => {
  it("copies into an existing window: open_tab per source, unactivated, sources untouched", async () => {
    const d = deps();
    const out = await copyTabs(
      { selector: inWindow, destination: { kind: "window", windowId: "w:chrome:x2" } },
      d,
    );
    expect(out.status).toBe("success");
    expect(out.items.map((i) => i.status)).toEqual(["created", "created"]);
    expect(d.commands.map((c) => c.kind)).toEqual(["open_tab", "open_tab"]);
    expect(d.commands[0]).toMatchObject({
      url: "https://one.example/x",
      windowId: "w:chrome:x2",
      activate: false,
    });
    // The structural safety property: NOTHING close-shaped ever runs.
    expect(d.commands.every((c) => !String(c.kind).includes("close"))).toBe(true);
  });

  it("newWindow destination: open_window once, then open_tab into the reported window", async () => {
    const d = deps();
    const out = await copyTabs(
      { selector: inWindow, destination: { kind: "newWindow", browser: "chrome" } },
      d,
    );
    expect(out.status).toBe("success");
    expect(d.commands.map((c) => c.kind)).toEqual(["open_window", "open_tab"]);
    expect(d.commands[1]).toMatchObject({ windowId: "w:chrome:xNEWW" });
  });

  it("policy-refused URLs are skipped per-item; the batch continues", async () => {
    const d = deps([{ url: "javascript:alert(1)" }]);
    const out = await copyTabs(
      { selector: inWindow, destination: { kind: "window", windowId: "w:chrome:x2" } },
      d,
    );
    expect(out.items.map((i) => i.status)).toEqual(["created", "created", "skipped"]);
    expect(out.items[2]?.reason).toMatch(/scheme/i);
    expect(out.status).toBe("success"); // skips are not failures
  });

  it("pinned intent rides the creation itself", async () => {
    const d = deps([{ url: "https://three.example/", pinned: true }]);
    await copyTabs(
      { selector: inWindow, destination: { kind: "window", windowId: "w:chrome:x2" } },
      d,
    );
    const pinnedCall = d.commands.find((c) => (c.url as string)?.startsWith("https://three"));
    expect(pinnedCall).toMatchObject({ kind: "open_tab", pinned: true });
  });

  it("grouped sources produce the not-recreated warning", async () => {
    const d = deps([{ url: "https://g.example/", groupId: "g:chrome:x7" }]);
    const out = await copyTabs(
      { selector: inWindow, destination: { kind: "window", windowId: "w:chrome:x2" } },
      d,
    );
    expect(out.warnings.join(" ")).toMatch(/not recreated/);
  });

  it("a mid-batch failure yields partial with per-item reasons; later items still try", async () => {
    const d = deps();
    let calls = 0;
    const flaky = async (p: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) throw new Error("no such window anymore");
      return d.runCommand(p);
    };
    const out = await copyTabs(
      { selector: inWindow, destination: { kind: "window", windowId: "w:chrome:x2" } },
      { ...d, runCommand: flaky },
    );
    expect(out.status).toBe("partial");
    expect(out.items.map((i) => i.status)).toEqual(["failed", "created"]);
    expect(out.items[0]?.reason).toMatch(/no such window/);
  });

  it("idempotencyKey replays the stored outcome without re-creating", async () => {
    const d = deps();
    const args = {
      selector: inWindow,
      destination: { kind: "window", windowId: "w:chrome:x2" },
      idempotencyKey: "k1",
    };
    const first = await copyTabs(args, d);
    const commandsAfterFirst = d.commands.length;
    const second = await copyTabs(args, d);
    expect(second.replayed).toBe(true);
    expect(second.items).toEqual(first.items);
    expect(d.commands.length).toBe(commandsAfterFirst);
  });

  it("an unknown destination window fails BEFORE any creation", async () => {
    const d = deps();
    await expect(
      copyTabs(
        { selector: inWindow, destination: { kind: "window", windowId: "w:chrome:x404" } },
        d,
      ),
    ).rejects.toThrow(/not in the snapshot/);
    expect(d.commands).toEqual([]);
  });

  it("a structural selection errors with the members hint", async () => {
    const d = deps();
    await expect(
      copyTabs(
        {
          selector: { kind: "ids", ids: ["w:chrome:x1"] },
          destination: { kind: "window", windowId: "w:chrome:x2" },
        },
        d,
      ),
    ).rejects.toThrow(/members/);
  });
});

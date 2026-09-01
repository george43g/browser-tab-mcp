/**
 * executeCommand handle-routing guards.
 *
 * Handles are browser-scoped but the numeric id inside them is not globally
 * unique, so a handle from browser B unpacked into a command aimed at browser A
 * hands A a number meaning something else entirely. These tests pin the
 * rejection at every site that accepts a SECOND handle.
 *
 * The guards throw before any I/O, so `ext.sendCommand` doubles as the
 * assertion that nothing was dispatched.
 */

import type { BrowserId } from "@george43g/shared-types";
import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { executeCommand } from "./index.js";
import type { ExtensionServer } from "./ws-server.js";

interface Sent {
  browser: BrowserId;
  kind: string;
  args: Record<string, unknown>;
}

/** An ExtensionServer stand-in that claims every browser is connected. */
function fakeExt(): { ext: ExtensionServer; sent: Sent[] } {
  const sent: Sent[] = [];
  const ext = {
    isConnected: () => true,
    sendCommand: (browser: BrowserId, kind: string, args: Record<string, unknown>) => {
      sent.push({ browser, kind, args });
      return Promise.resolve({});
    },
  } as unknown as ExtensionServer;
  return { ext, sent };
}

const deps = (ext: ExtensionServer) => ({
  refresh: () => Promise.reject(new Error("refresh must not be called")),
  ext,
});

describe("executeCommand rejects cross-browser handles", () => {
  it("move_tab: a safari targetWindowId against a chrome tab", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand(
        { kind: "move_tab", tabId: "t:chrome:x101", targetWindowId: "w:safari:x38" },
        deps(ext),
      ),
      // Regression: this used to pass safari's raw id 38 into chrome.tabs.move,
      // surfacing the leaked internal id as "No window with id: 38".
    ).rejects.toThrow(/targetWindowId .* safari handle but this command targets chrome/);
    expect(sent, "nothing may be dispatched").toEqual([]);
  });

  it("move_tab: a safari targetGroupId against a chrome tab", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand(
        { kind: "move_tab", tabId: "t:chrome:x101", targetGroupId: "g:safari:x7" },
        deps(ext),
      ),
    ).rejects.toThrow(/targetGroupId .* safari handle but this command targets chrome/);
    expect(sent).toEqual([]);
  });

  it("open_tab: a groupId from another browser", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand(
        {
          kind: "open_tab",
          url: "https://example.com/",
          windowId: "w:chrome:x812",
          groupId: "g:safari:x7",
        },
        deps(ext),
      ),
    ).rejects.toThrow(/groupId .* safari handle but this command targets chrome/);
    expect(sent).toEqual([]);
  });

  it("open_tab: an explicit browser that contradicts the windowId", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand(
        {
          kind: "open_tab",
          url: "https://example.com/",
          windowId: "w:chrome:x812",
          browser: "safari",
        },
        deps(ext),
      ),
      // The window handle used to win silently over the caller's `browser`.
    ).rejects.toThrow(/windowId .* chrome handle but this command targets safari/);
    expect(sent).toEqual([]);
  });

  it("group_tabs: a NON-FIRST tabId from another browser", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand(
        {
          kind: "group_tabs",
          action: "create",
          // The browser is inferred from tabIds[0]; the tail element used to be
          // converted unchecked, so chrome could group its own tab #202.
          tabIds: ["t:chrome:x201", "t:safari:x202"],
        },
        deps(ext),
      ),
    ).rejects.toThrow(/tabId .* safari handle but this command targets chrome/);
    expect(sent, "a mixed list must never reach the extension").toEqual([]);
  });

  it("group_tabs: a targetWindowId from another browser", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand(
        {
          kind: "group_tabs",
          action: "move",
          groupId: "g:chrome:x9",
          targetWindowId: "w:safari:x812",
        },
        deps(ext),
      ),
    ).rejects.toThrow(/targetWindowId .* safari handle but this command targets chrome/);
    expect(sent).toEqual([]);
  });
});

describe("executeCommand still accepts same-browser handles", () => {
  it("move_tab passes the numeric ids through when both handles agree", async () => {
    const { ext, sent } = fakeExt();
    await executeCommand(
      { kind: "move_tab", tabId: "t:chrome:x101", targetWindowId: "w:chrome:x812" },
      deps(ext),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.browser).toBe("chrome");
    expect(sent[0]?.args).toMatchObject({ tabId: 101, targetWindowId: 812 });
  });

  it("group_tabs accepts an all-same-browser tabIds list", async () => {
    const { ext, sent } = fakeExt();
    await executeCommand(
      { kind: "group_tabs", action: "create", tabIds: ["t:chrome:x201", "t:chrome:x202"] },
      deps(ext),
    );
    expect(sent[0]?.args.tabIds).toEqual([201, 202]);
  });
});

describe("executeCommand resolves signed/same-window move_tab forms daemon-side", () => {
  // Three tabs in w:chrome:x812 (the anchor tab sits at index 1), one in
  // w:chrome:x900. Resolution runs against this snapshot; the wire must only
  // ever carry the absolute form the deployed extension already speaks.
  const snap = makeSnapshot({
    browsers: [
      makeBrowserState({
        browser: "chrome",
        extensionConnected: true,
        dataSource: "extension",
        windows: [
          makeContractWindow({
            windowId: "w:chrome:x812",
            tabs: [
              makeContractTab({ tabId: "t:chrome:x100", index: 0 }),
              makeContractTab({ tabId: "t:chrome:x101", index: 1 }),
              makeContractTab({ tabId: "t:chrome:x102", index: 2 }),
            ],
          }),
          makeContractWindow({
            windowId: "w:chrome:x900",
            tabs: [makeContractTab({ tabId: "t:chrome:x201", index: 0 })],
          }),
        ],
      }),
    ],
  });
  const resolvingDeps = (ext: ExtensionServer) => ({ refresh: () => Promise.resolve(snap), ext });

  it("bare same-window move fills the tab's own window and appends", async () => {
    const { ext, sent } = fakeExt();
    await executeCommand({ kind: "move_tab", tabId: "t:chrome:x101" }, resolvingDeps(ext));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args).toMatchObject({ tabId: 101, targetWindowId: 812 });
    expect(sent[0]?.args.targetIndex, "append travels as no targetIndex").toBeUndefined();
  });

  it("to: 1 resolves to index 0 in the tab's own window", async () => {
    const { ext, sent } = fakeExt();
    await executeCommand({ kind: "move_tab", tabId: "t:chrome:x101", to: 1 }, resolvingDeps(ext));
    expect(sent[0]?.args).toMatchObject({ tabId: 101, targetWindowId: 812, targetIndex: 0 });
  });

  it("by: -1 resolves relative to the tab's snapshot position", async () => {
    const { ext, sent } = fakeExt();
    await executeCommand({ kind: "move_tab", tabId: "t:chrome:x101", by: -1 }, resolvingDeps(ext));
    expect(sent[0]?.args).toMatchObject({ tabId: 101, targetWindowId: 812, targetIndex: 0 });
  });

  it("cross-window to: -1 appends to the destination window", async () => {
    const { ext, sent } = fakeExt();
    await executeCommand(
      { kind: "move_tab", tabId: "t:chrome:x101", targetWindowId: "w:chrome:x900", to: -1 },
      resolvingDeps(ext),
    );
    expect(sent[0]?.args).toMatchObject({ tabId: 101, targetWindowId: 900 });
    expect(sent[0]?.args.targetIndex).toBeUndefined();
  });

  it("cross-window to: 1 resolves against the destination's slots", async () => {
    const { ext, sent } = fakeExt();
    await executeCommand(
      { kind: "move_tab", tabId: "t:chrome:x101", targetWindowId: "w:chrome:x900", to: 1 },
      resolvingDeps(ext),
    );
    expect(sent[0]?.args).toMatchObject({ tabId: 101, targetWindowId: 900, targetIndex: 0 });
  });

  it("a stale tab handle errors actionably instead of dispatching", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand({ kind: "move_tab", tabId: "t:chrome:x999", to: 1 }, resolvingDeps(ext)),
    ).rejects.toThrow(/not in the current snapshot .* list_tabs/s);
    expect(sent).toEqual([]);
  });

  it("an unknown destination window errors actionably instead of dispatching", async () => {
    const { ext, sent } = fakeExt();
    await expect(
      executeCommand(
        { kind: "move_tab", tabId: "t:chrome:x101", targetWindowId: "w:chrome:x777", to: 1 },
        resolvingDeps(ext),
      ),
    ).rejects.toThrow(/not in the current snapshot/);
    expect(sent).toEqual([]);
  });

  it("explicit absolute moves still skip resolution entirely", async () => {
    const { ext, sent } = fakeExt();
    // deps() rejects refresh with "refresh must not be called" (and the
    // post-command reconcile swallows it) — so this passing proves the
    // legacy form never touches the snapshot.
    await executeCommand(
      { kind: "move_tab", tabId: "t:chrome:x101", targetWindowId: "w:chrome:x812", targetIndex: 2 },
      deps(ext),
    );
    expect(sent[0]?.args).toMatchObject({ tabId: 101, targetWindowId: 812, targetIndex: 2 });
  });
});

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

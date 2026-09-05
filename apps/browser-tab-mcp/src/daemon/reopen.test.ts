/**
 * reopenTab — the distinction the tool exists to make honest.
 *
 * A session-restore and a reconstruction both end with "the tab is back", and
 * only one of them has the history behind it. Every test here is about that
 * difference surviving into the result, plus the one refusal: a whole-window
 * restore is never taken on a request for a single tab.
 */
import { describe, expect, it } from "vitest";
import { ClosedTabStore } from "./closed-tabs.js";
import { reopenTab } from "./reopen.js";

const record = (over: Record<string, unknown> = {}) => ({
  closedTabId: "abc123",
  tabId: "t:chrome:x9",
  browser: "chrome" as const,
  url: "https://example.test/page",
  title: "Page",
  index: 2,
  windowId: "w:chrome:x1",
  windowGone: false,
  pinned: false,
  muted: false,
  closedAt: 1_000,
  ...over,
});

function makeDeps(opts: {
  sessions?: Array<{ sessionId: string; kind: "tab" | "window"; url: string }>;
  rec?: Record<string, unknown>;
  sessionsThrows?: boolean;
}) {
  const closedTabs = new ClosedTabStore({ dir: "/nonexistent", ttlMs: 1e9, now: () => 1_000 });
  closedTabs.record([record(opts.rec ?? {}) as never]);
  const sent: Array<{ kind: string; args: Record<string, unknown> }> = [];
  const commands: Record<string, unknown>[] = [];
  const ext = {
    isConnected: () => true,
    sendCommand: async (_b: string, kind: string, args: Record<string, unknown>) => {
      sent.push({ kind, args });
      if (opts.sessionsThrows) throw new Error("sessions API unavailable in this browser");
      if (args.action === "recent") {
        return { rows: (opts.sessions ?? []).map((r) => ({ ...r, title: "", lastModified: 1 })) };
      }
      return { tabId: 77, windowId: 5 };
    },
  } as never;
  const deps = {
    closedTabs,
    ext,
    runCommand: async (p: Record<string, unknown>) => {
      commands.push(p);
      return { tabId: "t:chrome:x88", windowId: "w:chrome:x1" };
    },
    refresh: async () => undefined,
  };
  return { deps, sent, commands };
}

describe("reopenTab", () => {
  it("restores through the browser's own session and says the history survived", async () => {
    const { deps, sent, commands } = makeDeps({
      sessions: [{ sessionId: "s1", kind: "tab", url: "https://example.test/page" }],
    });
    const out = await reopenTab({ closedTabId: "abc123" }, deps as never);
    expect(out.method).toBe("session-restore");
    expect(out.historyPreserved).toBe(true);
    expect(out.tabId).toBe("t:chrome:x77");
    expect(sent.map((s) => s.args.action)).toEqual(["recent", "restore"]);
    expect(commands, "a real restore never opens a new tab").toEqual([]);
  });

  it("reconstructs when the browser no longer holds the entry, and SAYS so", async () => {
    const { deps, commands } = makeDeps({
      sessions: [{ sessionId: "s9", kind: "tab", url: "https://other.test/" }],
    });
    const out = await reopenTab({ closedTabId: "abc123" }, deps as never);
    expect(out.method).toBe("reconstructed");
    expect(out.historyPreserved, "the whole point of the field").toBe(false);
    expect(out.warnings.join(" ")).toMatch(/back\/forward history could not be restored/);
    expect(commands[0]).toMatchObject({
      kind: "open_tab",
      url: "https://example.test/page",
      windowId: "w:chrome:x1",
    });
  });

  it("refuses to restore a WHOLE WINDOW when one tab was asked for", async () => {
    // Nine tabs is not a more generous answer to a request for one.
    const { deps, commands } = makeDeps({
      sessions: [{ sessionId: "w1", kind: "window", url: "https://example.test/page" }],
    });
    const out = await reopenTab({ closedTabId: "abc123" }, deps as never);
    expect(out.method).toBe("reconstructed");
    expect(out.warnings.join(" ")).toMatch(/WHOLE-WINDOW restore/);
    expect(commands).toHaveLength(1);
  });

  it("opens a NEW window when the old one went with the tab", async () => {
    const { deps, commands } = makeDeps({ rec: { windowGone: true }, sessions: [] });
    await reopenTab({ closedTabId: "abc123" }, deps as never);
    expect(commands[0]).toMatchObject({ newWindow: true });
    expect(commands[0]).not.toHaveProperty("windowId");
  });

  it("degrades to reconstruction when the installed bundle has no sessions permission", async () => {
    // An older extension bundle predates the permission; a reopen that failed
    // outright there would be worse than one that works without the history.
    const { deps, commands } = makeDeps({ sessionsThrows: true });
    const out = await reopenTab({ closedTabId: "abc123" }, deps as never);
    expect(out.method).toBe("reconstructed");
    expect(commands).toHaveLength(1);
  });

  it("refuses an unknown or aged-out id rather than guessing", async () => {
    const { deps } = makeDeps({});
    await expect(reopenTab({ closedTabId: "nope" }, deps as never)).rejects.toThrow(
      /unknown or has aged out/,
    );
  });
});

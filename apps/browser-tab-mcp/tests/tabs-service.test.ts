/**
 * tabs-service degrade contract — the routing layer every CLI/MCP call goes
 * through. With the daemon unreachable (and NOT in fixture mode), the
 * daemon-only reads must degrade to a safe empty result (journal/history) or
 * an actionable error (get_page/annotate/screenshot), and daemon_status must
 * report reachable:false — never hang or throw a bare error.
 *
 * Real degrade, no mocks: point the socket at a path with no daemon so the
 * real DaemonClient throws DaemonUnavailableError. getSnapshot/command fall
 * back to the osascript engine and are exercised by the integration suite,
 * not here (those paths would touch real browsers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as svc from "../src/client/tabs-service.js";

// /tmp exists; the socket file does not → connect() gets ENOENT immediately.
const DEAD_SOCKET = "/tmp/browser-tab-risk-coverage-no-daemon.sock";

describe("tabs-service degrade (daemon down, not fixture mode)", () => {
  beforeEach(() => {
    vi.stubEnv("BROWSER_TAB_SOCKET_PATH", DEAD_SOCKET);
    vi.stubEnv("BROWSER_TAB_FAKE_ADAPTER", "0");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("journal degrades to an empty result (echoing the requested view)", async () => {
    await expect(svc.journal({ view: "windowMru" })).resolves.toEqual({
      view: "windowMru",
      focus: [],
      nav: [],
    });
  });

  it("history degrades to an empty result", async () => {
    // sources is empty rather than "all unavailable": with the daemon down no
    // source was consulted at all, and claiming otherwise would be a lie.
    await expect(svc.history({})).resolves.toEqual({ rows: [], truncated: false, sources: [] });
  });

  it("daemon_status reports reachable:false with a start-it hint", async () => {
    const status = await svc.daemonStatus();
    expect(status.reachable).toBe(false);
    expect(String(status.hint)).toMatch(/daemon run/);
  });

  it("refreshDaemon returns null", async () => {
    await expect(svc.refreshDaemon()).resolves.toBeNull();
  });

  it("get_page throws an actionable daemon-required error", async () => {
    await expect(
      svc.getPage({ tabId: "t:chrome:x1", mode: "metadata", force: false }),
    ).rejects.toThrow(/daemon/i);
  });

  it("annotate throws an actionable daemon-required error", async () => {
    await expect(svc.annotate({ url: "https://x.test/" })).rejects.toThrow(/daemon/i);
  });

  it("screenshot throws an actionable daemon-required error", async () => {
    await expect(
      svc.screenshot({ tabId: "t:chrome:x1", force: false, focus: false }),
    ).rejects.toThrow(/daemon/i);
  });
});

describe("tabs-service in fixture mode", () => {
  beforeEach(() => {
    vi.stubEnv("BROWSER_TAB_FAKE_ADAPTER", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("journal returns empty (daemon-only state, no error)", async () => {
    await expect(svc.journal({ view: "recent" })).resolves.toEqual({
      view: "recent",
      focus: [],
      nav: [],
    });
  });

  it("get_page / annotate / screenshot surface a fixture-mode error", async () => {
    await expect(
      svc.getPage({ tabId: "t:chrome:x1", mode: "metadata", force: false }),
    ).rejects.toThrow(/fixture mode/i);
    await expect(svc.annotate({ url: "https://x.test/" })).rejects.toThrow(/fixture mode/i);
    await expect(
      svc.screenshot({ tabId: "t:chrome:x1", force: false, focus: false }),
    ).rejects.toThrow(/fixture mode/i);
  });
});

describe("tabs-service input validation", () => {
  beforeEach(() => {
    vi.stubEnv("BROWSER_TAB_FAKE_ADAPTER", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("tab_action navigate without a url rejects before dispatch", async () => {
    await expect(svc.tabAction({ tabId: "t:chrome:x1", action: "navigate" })).rejects.toThrow(
      /navigate.*url/i,
    );
  });

  it("group_tabs has no AppleScript fallback — rejects, citing the extension", async () => {
    await expect(svc.groupTabs({ action: "create", tabIds: ["t:chrome:x1"] })).rejects.toThrow(
      /extension/i,
    );
  });
});

/**
 * The off-macOS adapter must be HONEST, not merely quiet.
 *
 * The failure this prevents: `makeAdapter` returning a macOS adapter on Windows
 * and every read surfacing `spawn osascript ENOENT` — an errno, at the point of
 * use, with nothing to tell the reader that the platform is the reason.
 */

import { afterEach, describe, expect, it } from "vitest";
import { makeAdapter, specFor } from "../engine.js";
import { makeUnavailableAdapter } from "./unavailable.js";

const savedPlatform = process.env.BROWSER_TAB_PLATFORM;
const savedFake = process.env.BROWSER_TAB_FAKE_ADAPTER;
afterEach(() => {
  if (savedPlatform === undefined) delete process.env.BROWSER_TAB_PLATFORM;
  else process.env.BROWSER_TAB_PLATFORM = savedPlatform;
  if (savedFake === undefined) delete process.env.BROWSER_TAB_FAKE_ADAPTER;
  else process.env.BROWSER_TAB_FAKE_ADAPTER = savedFake;
});

describe("makeAdapter off macOS", () => {
  it("returns the unavailable adapter rather than one that shells out", async () => {
    process.env.BROWSER_TAB_PLATFORM = "win32";
    delete process.env.BROWSER_TAB_FAKE_ADAPTER;
    const state = await makeAdapter("chrome").readState();
    expect(state.running).toBe(false);
    expect(state.error).toMatch(/No AppleScript on windows/);
    expect(state.windows).toEqual([]);
  });

  it("still honours the fake adapter, which must work on every platform", () => {
    // The fake adapter backs CI and the stress harness; a platform gate that
    // swallowed it would make those untestable off macOS.
    process.env.BROWSER_TAB_PLATFORM = "win32";
    process.env.BROWSER_TAB_FAKE_ADAPTER = "1";
    expect(makeAdapter("chrome").spec.browser).toBe("chrome");
  });
});

describe("unavailable adapter commands", () => {
  const adapter = makeUnavailableAdapter(specFor("chrome"));

  it("probes as not-running instead of guessing", async () => {
    await expect(adapter.probe()).resolves.toEqual({ running: false, pid: null });
  });

  it.each([
    ["focusTab", () => adapter.focusTab("t:chrome:1")],
    ["closeTab", () => adapter.closeTab("t:chrome:1")],
    ["openTab", () => adapter.openTab({ url: "https://e.com", pinned: false, activate: true })],
    ["tabAction", () => adapter.tabAction({ tabId: "t:chrome:1", action: "reload" })],
    ["closeWindow", () => adapter.closeWindow({ windowId: "w:chrome:1" })],
  ])("%s refuses with a sentence, not an errno", async (_name, call) => {
    // Each message must name the platform AND the fix; "ENOENT" teaches nothing.
    await expect(call()).rejects.toThrow(/connector extension/);
  });
});

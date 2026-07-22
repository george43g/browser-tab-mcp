/**
 * Capture-on-blur throttle/guard logic — the settle delay, cancel-on-refocus,
 * per-tab cooldown, and skip rules. Pure logic: the clock, tab lookup, and
 * injection are all injected, so no chrome/DOM is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlurCapturer, type StateCaptureFrame } from "./capture.js";

interface FakeTab {
  url?: string;
  discarded?: boolean;
  incognito?: boolean;
}

function setup(opts: { getTab?: (id: number) => Promise<FakeTab | undefined> } = {}) {
  let clock = 0;
  const emitted: StateCaptureFrame[] = [];
  const getTab = opts.getTab ?? (async (id: number) => ({ url: `https://ex.com/${id}` }));
  const inject = vi.fn(async () => ({ state: { dirtyForms: 1 } }));
  const cap = new BlurCapturer(
    (f) => emitted.push(f),
    () => clock,
    getTab,
    inject,
  );
  return {
    cap,
    emitted,
    inject,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

describe("BlurCapturer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("captures the tab the user left, after the settle delay", async () => {
    const { cap, emitted, inject } = setup();
    cap.setEnabled(true);
    cap.onActivated({ tabId: 1, windowId: 10 });
    cap.onActivated({ tabId: 2, windowId: 10 }); // leaving tab 1
    expect(emitted).toHaveLength(0); // settle still pending
    await vi.advanceTimersByTimeAsync(300);
    expect(inject).toHaveBeenCalledWith(1, "state");
    expect(emitted).toEqual([{ kind: "stateCapture", tabId: 1, state: { dirtyForms: 1 } }]);
  });

  it("cancels a pending capture when the tab is re-activated (alt-tab churn)", async () => {
    const { cap, emitted } = setup();
    cap.setEnabled(true);
    cap.onActivated({ tabId: 1, windowId: 10 });
    cap.onActivated({ tabId: 2, windowId: 10 }); // schedule capture(1)
    await vi.advanceTimersByTimeAsync(100);
    cap.onActivated({ tabId: 1, windowId: 10 }); // back within settle → cancel(1), schedule(2)
    await vi.advanceTimersByTimeAsync(300);
    expect(emitted.map((f) => f.tabId)).toEqual([2]);
  });

  it("honors the per-tab cooldown", async () => {
    const { cap, emitted, advanceClock } = setup();
    cap.setEnabled(true);
    const captures1 = () => emitted.filter((f) => f.tabId === 1).length;

    cap.onActivated({ tabId: 1, windowId: 10 });
    cap.onActivated({ tabId: 2, windowId: 10 });
    await vi.advanceTimersByTimeAsync(300);
    expect(captures1()).toBe(1);

    cap.onActivated({ tabId: 1, windowId: 10 });
    cap.onActivated({ tabId: 2, windowId: 10 }); // re-leaving 1 within cooldown
    await vi.advanceTimersByTimeAsync(300);
    expect(captures1()).toBe(1); // cooldown blocked the re-capture

    advanceClock(6000);
    cap.onActivated({ tabId: 1, windowId: 10 });
    cap.onActivated({ tabId: 2, windowId: 10 });
    await vi.advanceTimersByTimeAsync(300);
    expect(captures1()).toBe(2); // cooldown expired
  });

  it("skips non-http, discarded, and incognito tabs", async () => {
    for (const tab of [
      { url: "about:blank" },
      { url: "https://x/", discarded: true },
      { url: "https://x/", incognito: true },
    ] satisfies FakeTab[]) {
      const { cap, emitted } = setup({ getTab: async () => tab });
      cap.setEnabled(true);
      cap.onActivated({ tabId: 1, windowId: 10 });
      cap.onActivated({ tabId: 2, windowId: 10 });
      await vi.advanceTimersByTimeAsync(300);
      expect(emitted).toHaveLength(0);
    }
  });

  it("does nothing while disabled but still tracks prev-active", async () => {
    const { cap, emitted } = setup();
    cap.onActivated({ tabId: 1, windowId: 10 });
    cap.onActivated({ tabId: 2, windowId: 10 });
    await vi.advanceTimersByTimeAsync(300);
    expect(emitted).toHaveLength(0);

    cap.setEnabled(true);
    cap.onActivated({ tabId: 3, windowId: 10 }); // leaving tab 2, tracked while disabled
    await vi.advanceTimersByTimeAsync(300);
    expect(emitted.map((f) => f.tabId)).toEqual([2]);
  });
});

/**
 * wireEvents unit test — every relevant tab/window event must be wired to the
 * single onChange callback (the socket layer replies with a fresh snapshot).
 */

import { type FakeChrome, installFakeChrome } from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireEvents } from "./events.js";

const EVENTS = [
  "tabs.onCreated",
  "tabs.onRemoved",
  "tabs.onUpdated",
  "tabs.onMoved",
  "tabs.onActivated",
  "tabs.onAttached",
  "tabs.onDetached",
  "tabs.onReplaced",
  "windows.onCreated",
  "windows.onRemoved",
  "windows.onFocusChanged",
];

let fc: FakeChrome;
beforeEach(() => {
  fc = installFakeChrome();
});
afterEach(() => fc.restore());

describe("wireEvents", () => {
  it("registers a listener on all 11 tab/window events", () => {
    wireEvents(() => {});
    for (const e of EVENTS) expect(fc.listenerCount(e), e).toBe(1);
  });

  it("funnels every event into the onChange callback", () => {
    const onChange = vi.fn();
    wireEvents(onChange);
    for (const e of EVENTS) fc.emit(e);
    expect(onChange).toHaveBeenCalledTimes(EVENTS.length);
  });
});

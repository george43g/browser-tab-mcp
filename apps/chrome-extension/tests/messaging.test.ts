/**
 * Cross-browser messaging regression. The background `onMessage` listener must
 * reply in the style each namespace expects — Chrome via `sendResponse` +
 * `return true`; Safari/Firefox by RETURNING a promise. Getting this wrong is
 * the exact "background worker isn't responding" bug the Safari settings hit.
 *
 * `USES_PROMISE_MESSAGING` in background.ts is frozen at import, so each branch
 * re-imports the module with the matching global installed first.
 */

import { type FakeChrome, installFakeChrome } from "@george43g/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

type OnMessage = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

let fc: FakeChrome | null = null;

afterEach(() => {
  fc?.restore();
  fc = null;
  vi.resetModules();
});

async function loadBackgroundListener(namespace: "chrome" | "browser"): Promise<OnMessage> {
  vi.resetModules();
  fc = installFakeChrome({ namespace });
  // main() registers the onMessage listener at import time — globals first.
  await import("../src/background.js");
  const listener = fc.listener("runtime.onMessage");
  if (!listener) throw new Error("background registered no runtime.onMessage listener");
  return listener as OnMessage;
}

const isConnectorStatus = (v: unknown): boolean =>
  typeof v === "object" && v !== null && "phase" in v && "browser" in v;

describe("background messaging — Chrome (sendResponse) style", () => {
  it("returns true and answers via sendResponse with a ConnectorStatus", async () => {
    const onMessage = await loadBackgroundListener("chrome");
    const sendResponse = vi.fn();
    const ret = onMessage({ type: "getStatus" }, {}, sendResponse);
    expect(ret).toBe(true); // keep the channel open for the async reply
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(isConnectorStatus(sendResponse.mock.calls[0]?.[0])).toBe(true);
  });

  it("ignores unrelated message types", async () => {
    const onMessage = await loadBackgroundListener("chrome");
    expect(onMessage({ type: "somethingElse" }, {}, vi.fn())).toBeUndefined();
  });
});

describe("background messaging — Safari/Firefox (promise) style", () => {
  it("RETURNS a promise resolving to a ConnectorStatus", async () => {
    const onMessage = await loadBackgroundListener("browser");
    const ret = onMessage({ type: "getStatus" }, {}, vi.fn());
    expect(ret).toBeInstanceOf(Promise);
    expect(isConnectorStatus(await (ret as Promise<unknown>))).toBe(true);
  });
});

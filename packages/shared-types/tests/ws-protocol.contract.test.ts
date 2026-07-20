/**
 * WS protocol contract. Every extension↔daemon message must round-trip
 * (serialize → parse) and each discriminated union must reject an unknown
 * `type`. This pins the wire at its source-of-truth (src/index.ts) so a schema
 * edit the daemon or extension-core doesn't follow fails here.
 *
 * Deliberately kept free of `@george43g/test-kit` factories: the factories are
 * derived FROM these schemas, so validating with inline literals keeps the
 * test honest (and avoids a shared-types ⇄ test-kit dependency cycle).
 */

import { describe, expect, it } from "vitest";
import {
  type ExtClientMessage,
  ExtClientMessageSchema,
  type ExtServerMessage,
  ExtServerMessageSchema,
} from "../src/index.js";

const clientMessages: ExtClientMessage[] = [
  { type: "hello", browser: "chrome", extVersion: "1.2.3", token: "secret" },
  {
    type: "snapshot",
    windows: [
      {
        id: 1,
        focused: true,
        incognito: false,
        bounds: null,
        tabs: [
          {
            id: 2,
            windowId: 1,
            index: 0,
            url: "https://x/",
            title: "x",
            active: true,
            pinned: false,
            audible: false,
            discarded: false,
          },
        ],
      },
    ],
  },
  { type: "commandResult", requestId: 7, ok: true, result: { windowId: 9 } },
  { type: "commandResult", requestId: 8, ok: false, error: "nope" },
  { type: "pong", ts: 123 },
];

const serverMessages: ExtServerMessage[] = [
  { type: "helloAck" },
  { type: "command", requestId: 1, kind: "move_tab", args: { tabId: 4 } },
  { type: "ping", ts: 456 },
];

describe("WS client→daemon messages", () => {
  it.each(clientMessages.map((m) => [m.type, m] as const))("round-trips %s", (_type, msg) => {
    expect(ExtClientMessageSchema.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });

  it("rejects an unknown type", () => {
    expect(ExtClientMessageSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });
});

describe("WS daemon→client messages", () => {
  it.each(serverMessages.map((m) => [m.type, m] as const))("round-trips %s", (_type, msg) => {
    expect(ExtServerMessageSchema.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });

  it("rejects an unknown type", () => {
    expect(ExtServerMessageSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });
});

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
  // Legacy hello (no protocolVersion/capabilities) — proves an old extension
  // still parses against the v2 daemon.
  { type: "hello", browser: "chrome", extVersion: "1.2.3", token: "secret" },
  // v2 hello with the capability map + protocol version.
  {
    type: "hello",
    browser: "chrome",
    extVersion: "2.0.0",
    token: "secret",
    protocolVersion: 2,
    capabilities: { tabGroups: true, history: false },
  },
  {
    type: "snapshot",
    groups: [{ id: 5, windowId: 1, title: "Work", color: "blue", collapsed: false }],
    windows: [
      {
        id: 1,
        focused: true,
        incognito: false,
        bounds: null,
        state: "normal",
        tabs: [
          {
            id: 2,
            windowId: 1,
            index: 0,
            url: "https://x/",
            title: "x",
            active: true,
            groupId: 5,
            pinned: false,
            audible: false,
            discarded: false,
            muted: false,
            frozen: false,
          },
        ],
      },
    ],
  },
  { type: "commandResult", requestId: 7, ok: true, result: { windowId: 9 } },
  { type: "commandResult", requestId: 8, ok: false, error: "nope" },
  { type: "event", ts: 111, kind: "focus", windowId: 3, tabId: 9 },
  { type: "event", ts: 222, kind: "nav", tabId: 9, url: "https://x/", transition: "link" },
  {
    type: "event",
    ts: 333,
    kind: "stateCapture",
    tabId: 9,
    state: {
      dirtyForms: 1,
      focusedEditable: false,
      media: [],
      scrollY: 0,
      scrollPct: 0,
      selectionLength: 0,
      wordCount: 42,
    },
  },
  { type: "pong", ts: 123 },
];

const serverMessages: ExtServerMessage[] = [
  { type: "helloAck" },
  { type: "helloAck", protocolVersion: 2 },
  { type: "helloAck", protocolVersion: 2, config: { blurCapture: true } },
  { type: "command", requestId: 1, kind: "move_tab", args: { tabId: 4 } },
  { type: "command", requestId: 2, kind: "extract_content", args: { tabId: 4, mode: "text" } },
  {
    type: "command",
    requestId: 3,
    kind: "capture_tab",
    args: { tabId: 4, windowId: 7, quality: 70 },
  },
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

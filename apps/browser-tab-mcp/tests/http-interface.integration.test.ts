/**
 * The HTTP interface, against a real daemon over a real loopback socket.
 *
 * This is the first surface that accepts connections from anything other than
 * our own extension, so the security properties are tested as behaviour rather
 * than asserted in a comment: the bind address, the token, where the token is
 * accepted from, and the absence of CORS.
 */

import { rmSync } from "node:fs";
import type { Snapshot } from "@george43g/shared-types";
import { makeTmpDir, randomWsPort, withDaemonEnv } from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import { ensureToken } from "../src/daemon/token.js";

let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let port = 0;
let token = "";

const base = () => `http://127.0.0.1:${port}`;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  tmp = makeTmpDir("browser-tab-http-");
  port = randomWsPort();
  env = withDaemonEnv(tmp, { browsers: "chrome" });
  process.env.BROWSER_TAB_HTTP_PORT = String(port);
  token = ensureToken();
  daemon = await startDaemon();
  await daemon.loop.refresh();
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  delete process.env.BROWSER_TAB_HTTP_PORT;
  env?.restore();
  env = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe("opt-in", () => {
  it("starts only because BROWSER_TAB_HTTP_PORT was set", async () => {
    // The whole safety story rests on this being off by default.
    expect(daemon?.http).not.toBeNull();
    const res = await fetch(`${base()}/health`, { headers: auth() });
    expect(res.status).toBe(200);
  });
});

describe("authentication", () => {
  it("refuses every route without a token", async () => {
    for (const path of ["/health", "/snapshot", "/events"]) {
      const res = await fetch(base() + path);
      expect(res.status, path).toBe(401);
    }
  });

  it("refuses a wrong token", async () => {
    const res = await fetch(`${base()}/health`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("does NOT accept the token from a query string", async () => {
    // A token in a URL lands in shell history, proxy logs and `ps` output —
    // and users reach for `?token=` the moment it works.
    const res = await fetch(`${base()}/health?token=${token}`);
    expect(res.status).toBe(401);
  });

  it("gives the same answer for a missing and a wrong token", async () => {
    // A distinct message would be a probing oracle.
    const missing = await (await fetch(`${base()}/health`)).json();
    const wrong = await (
      await fetch(`${base()}/health`, { headers: { authorization: "Bearer x" } })
    ).json();
    expect(missing).toEqual(wrong);
  });
});

describe("reads", () => {
  it("serves the snapshot", async () => {
    const res = await fetch(`${base()}/snapshot`, { headers: auth() });
    const snap = (await res.json()) as Snapshot;
    expect(snap.version).toBe(2);
    expect(snap.browsers.map((b) => b.browser)).toContain("chrome");
  });

  it("sends no CORS header, so a web page cannot READ a response", async () => {
    // The extension already puts us next door to arbitrary pages; a page that
    // could read /snapshot would learn every open tab. CORS is not a request
    // filter, so the token stays the actual control — but there is no reason
    // to hand a browser the response as well.
    const res = await fetch(`${base()}/snapshot`, { headers: auth() });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("marks JSON as non-sniffable", async () => {
    const res = await fetch(`${base()}/health`, { headers: auth() });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("404s an unknown route rather than 401-ing it", async () => {
    // Once authenticated, a wrong path is a client mistake and should say so.
    const res = await fetch(`${base()}/nope`, { headers: auth() });
    expect(res.status).toBe(404);
  });
});

describe("tool dispatch", () => {
  it("runs a tool and returns its structured result", async () => {
    const res = await fetch(`${base()}/tools/list_tabs`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ fields: "core" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tool: string; result: Snapshot };
    expect(body.tool).toBe("list_tabs");
    expect(body.result.browsers).toBeTruthy();
  });

  it("404s an unknown tool, 400s a bad input", async () => {
    // Different mistakes, different codes — a caller scripting against this
    // should be able to tell "I typo'd the name" from "my arguments are wrong".
    const unknown = await fetch(`${base()}/tools/nope`, { method: "POST", headers: auth() });
    expect(unknown.status).toBe(404);

    const bad = await fetch(`${base()}/tools/list_tabs`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ fields: "nonsense" }),
    });
    expect(bad.status).toBe(400);
  });

  it("rejects a non-object body instead of coercing it", async () => {
    const res = await fetch(`${base()}/tools/list_tabs`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(500);
  });
});

describe("event stream", () => {
  it("opens an SSE stream and flushes a frame immediately", async () => {
    // Without the leading comment frame a client cannot tell "connected" from
    // "hung" — the first real event can be minutes away on a quiet desktop.
    const ctrl = new AbortController();
    const res = await fetch(`${base()}/events`, { headers: auth(), signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain(": connected");
    expect(daemon?.http?.streamCount()).toBe(1);
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("forgets a stream when its client disconnects", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base()}/events`, { headers: auth(), signal: ctrl.signal });
    await res.body?.getReader().read();
    expect(daemon?.http?.streamCount()).toBe(1);
    ctrl.abort();
    // A leaked ServerResponse per dropped client is how a long-lived daemon
    // ends up writing to sockets nobody is reading.
    for (let i = 0; i < 40 && daemon?.http?.streamCount() !== 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(daemon?.http?.streamCount()).toBe(0);
  });
});

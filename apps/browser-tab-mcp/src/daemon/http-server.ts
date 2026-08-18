/**
 * HTTP interface — reads, a live event stream, and tool dispatch, over loopback.
 *
 * WHY THIS EXISTS. The rule for this repo is that most features should be
 * reachable from every interface. Until now "every interface" meant a unix
 * socket (NDJSON, our own framing) and a WebSocket reserved for the extension.
 * Both are fine for a process that can link this codebase; neither is reachable
 * from a shell script, a Hammerspoon config, a browser tab, or anything that
 * speaks HTTP and nothing else — which is most of the wm-stack's neighbours.
 *
 * WHY IT IS OFF BY DEFAULT. This is the first surface that accepts connections
 * from anything other than our own extension, and the audit flagged exactly
 * that: it widens the attack surface of a tool that was loopback-and-filesystem
 * only. So it is opt-in (`BROWSER_TAB_HTTP_PORT`), and the decision is recorded
 * in docs/agent-handoff/DECISIONS.md rather than made by a drive-by commit.
 *
 * THE THREE THINGS THAT MAKE IT SAFE TO TURN ON
 *
 *  1. It binds 127.0.0.1 EXPLICITLY. Omitting the host makes Node listen on
 *     every interface, which on a laptop that joins untrusted networks would
 *     expose tab contents and tool dispatch to the LAN. The bind address is not
 *     configurable — an operator who wants remote access should put a reverse
 *     proxy in front and make that decision consciously.
 *  2. Every route requires the daemon token, compared in constant time, and
 *     accepted ONLY from the `Authorization: Bearer` header — never a query
 *     string, which lands in shell history, proxy logs and `ps` output.
 *  3. It sends `Access-Control-Allow-Origin` to nobody. Without CORS a page in
 *     the user's own browser cannot read a response, which matters here more
 *     than usual: the extension gives web pages a same-machine neighbour, and a
 *     malicious page that could read /snapshot would learn every open tab.
 *     Browsers can still SEND requests (CORS is not a request filter), so the
 *     token remains the actual control.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { info, warn } from "@george43g/robustness";
import type { DaemonEvent, StateStore } from "./state.js";
import { tokenMatches } from "./token.js";

/**
 * The HTTP port, or 0 for "off".
 *
 * No default port. A default would mean an upgrade silently starts listening
 * on a machine whose owner never asked for it — the opposite of opt-in.
 */
export function httpPort(): number {
  const raw = Number.parseInt(process.env.BROWSER_TAB_HTTP_PORT ?? "0", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export interface HttpServerOptions {
  port: number;
  token: string;
  store: StateStore;
  /** Dispatch a tool by name. Injected so this module never imports the registry. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Bodies larger than this are refused before being buffered. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * The bearer token from a request, or null.
 *
 * Header only, on purpose: a token in a query string ends up in shell history,
 * server logs and `ps` output, and users WILL reach for `?token=` if it works.
 */
function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // Belt and braces: no route serves HTML, but a sniffed content type is how
    // a JSON endpoint becomes an XSS vector.
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Refuse mid-stream rather than after buffering — the point of a cap is
    // not to hold the bytes in the first place.
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Format one Server-Sent Event. Named so the wire shape is greppable. */
export function sseFrame(event: DaemonEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class HttpServer {
  private server: Server | null = null;
  private readonly streams = new Set<ServerResponse>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: HttpServerOptions) {}

  streamCount(): number {
    return this.streams.size;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        json(res, 500, { error: (err as Error).message });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      // 127.0.0.1 EXPLICITLY — see the header comment. Not configurable.
      this.server?.listen(this.opts.port, "127.0.0.1", () => resolve());
    });
    this.unsubscribe = this.opts.store.onEvent((e) => this.broadcast(e));
    info("http_listening", { port: this.opts.port });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const s of this.streams) s.end();
    this.streams.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  private broadcast(event: DaemonEvent): void {
    const frame = sseFrame(event);
    for (const res of this.streams) {
      // A stalled reader must not stall the daemon. `write` returning false
      // means the socket buffer is full; dropping THAT client's frame is
      // correct — an event stream is a live feed, not a queue, and buffering
      // for a dead reader is how a daemon runs out of memory.
      if (!res.write(frame)) warn("http_sse_backpressure", { port: this.opts.port });
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const provided = bearer(req);
    if (!provided || !tokenMatches(this.opts.token, provided)) {
      // No hint about WHY it failed — a distinct "no token" vs "wrong token"
      // is a probing oracle.
      json(res, 401, {
        error: "unauthorized",
        hint: "Send `Authorization: Bearer <token>` — get it from `browser-tab daemon token`.",
      });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      json(res, 200, { ok: true, streams: this.streams.size });
      return;
    }
    if (req.method === "GET" && path === "/snapshot") {
      json(res, 200, this.opts.store.getSnapshot());
      return;
    }
    if (req.method === "GET" && path === "/events") {
      this.stream(req, res);
      return;
    }
    if (req.method === "POST" && path.startsWith("/tools/")) {
      const name = decodeURIComponent(path.slice("/tools/".length));
      const args = await readBody(req);
      // Errors come back as a 200 with an error body ONLY when the tool itself
      // failed; an unknown tool is a 404 because that is a client mistake.
      try {
        json(res, 200, { tool: name, result: await this.opts.callTool(name, args) });
      } catch (err) {
        const message = (err as Error).message;
        json(res, /unknown tool/i.test(message) ? 404 : 400, { tool: name, error: message });
      }
      return;
    }
    json(res, 404, { error: `no route for ${req.method} ${path}` });
  }

  private stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    // An immediate comment frame flushes headers, so a client knows it is
    // connected before the first real event — which can be minutes away on a
    // quiet desktop.
    res.write(": connected\n\n");
    this.streams.add(res);
    req.on("close", () => {
      this.streams.delete(res);
    });
  }
}

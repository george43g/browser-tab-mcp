/**
 * A real HTTP origin for the e2e sweep to drive.
 *
 * WHY NOT `data:`. The roundtrip spec gets away with a `data:` URL because all
 * it needs is a tall body. Almost nothing else in the sweep can:
 *   - `chrome.scripting` is blocked on `data:`, so `get_page` cannot extract;
 *   - `chrome.history` does not record `data:` visits, so `history` has
 *     nothing to find;
 *   - back/forward needs gesture-marked history entries, which need a real
 *     origin to navigate between.
 * One server, started per spec file, covers all three.
 *
 * PORT: 0 — the OS assigns it, deliberately OUTSIDE `ports.ts`'s band scheme.
 * The bands exist because a lost daemon WS bind is SWALLOWED (`ws_disabled`)
 * and has to be predictable to be checked. A plain `http.Server` has no such
 * failure mode: `listen(0)` cannot collide, and nothing outside the spec that
 * started it needs to guess the number.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LocalServer {
  /** e.g. "http://127.0.0.1:53412" — no trailing slash. */
  origin: string;
  /** Absolute URL for a path this server serves. */
  url(path: string): string;
  close(): Promise<void>;
}

/** Marker string every page carries, so a Playwright Page can be found by content. */
export const PAGE_MARKER = "BTMARK";

const html = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body>${PAGE_MARKER}${body}</body></html>`;

/**
 * Routes, and what each exists for:
 *   /a        — links to /b; the origin half of a back/forward gesture pair
 *   /b        — the destination half
 *   /article  — enough prose for reader-mode extraction to have something to do
 *   /tall     — 4000px of body, so scroll position is observable
 *   /u/<any>  — a unique URL per request path, for URL-keyed caches
 *               (annotate) and for finding one specific visit in history
 * Anything else is a 404 with a body, never a hang — a hanging fixture reads
 * as a product timeout.
 */
function render(path: string): { status: number; body: string } {
  if (path === "/a") {
    return { status: 200, body: html("A", '<h1>A</h1><a id="to-b" href="/b">to B</a>') };
  }
  if (path === "/b") return { status: 200, body: html("B", "<h1>B</h1>") };
  if (path === "/tall") {
    return {
      status: 200,
      body: html("Tall", '<div style="height:4000px">tall</div>'),
    };
  }
  if (path === "/article") {
    const para = "<p>" + "Readable sentences make a readable article. ".repeat(20) + "</p>";
    return {
      status: 200,
      body: html("Article", `<article><h1>An Article</h1>${para.repeat(6)}</article>`),
    };
  }
  if (path.startsWith("/u/")) {
    return { status: 200, body: html(`U ${path.slice(3)}`, `<h1>${path.slice(3)}</h1>`) };
  }
  return { status: 404, body: html("404", "<h1>not here</h1>") };
}

export async function startLocalServer(): Promise<LocalServer> {
  const server: Server = createServer((req, res) => {
    const { status, body } = render(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      // No caching: a reload must actually re-fetch, or `tab_action reload`
      // proves nothing in PR 7.
      "cache-control": "no-store",
    });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: (path) => `${origin}${path.startsWith("/") ? path : `/${path}`}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

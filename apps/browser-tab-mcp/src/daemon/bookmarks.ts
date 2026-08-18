/**
 * bookmarks — CRUD over the browser's own bookmark store.
 *
 * EXTENSION-ONLY BY CONSTRUCTION. There is no AppleScript surface for
 * bookmarks in any supported browser, and the on-disk stores (Chrome's
 * `Bookmarks` JSON, Safari's `Bookmarks.plist`) are held open and rewritten by
 * a running browser — the same reason the SurfingKeys research killed the
 * LevelDB route. So this routes through the connected extension or it errors
 * with a reason; it never half-works against a file.
 *
 * TARGETING. Unlike `history`, this does NOT merge across browsers. History is
 * a read whose union is meaningful; bookmarks are a WRITE surface where "create
 * this in every connected browser" is almost never what someone meant, and a
 * merged `remove` would be actively destructive. So: one browser per call,
 * inferred when exactly one is connected and required when more are.
 */

import type { BookmarksOutput, BrowserId } from "@george43g/shared-types";
import type { ExtensionServer } from "./ws-server.js";

export interface BookmarksDeps {
  ext: ExtensionServer | null;
  /** Browsers with a live extension feed, for inference and error messages. */
  connected: () => BrowserId[];
}

interface ExtPayload {
  nodes?: unknown[];
  removed?: string;
  truncated?: boolean;
}

/**
 * Which browser this call is for.
 *
 * Inferring only when there is exactly ONE candidate is deliberate: picking the
 * first of several would make `remove` delete from whichever browser happened
 * to connect first, which is not a default anyone can reason about.
 */
export function resolveTarget(explicit: BrowserId | undefined, connected: BrowserId[]): BrowserId {
  if (explicit) {
    if (!connected.includes(explicit)) {
      throw new Error(
        `${explicit} has no connected extension, and bookmarks are extension-only ` +
          `(no AppleScript surface exists for them). Connected: ` +
          `${connected.length ? connected.join(", ") : "none"}.`,
      );
    }
    return explicit;
  }
  if (connected.length === 1) return connected[0] as BrowserId;
  if (connected.length === 0) {
    throw new Error(
      "No browser has a connected extension. Bookmarks are extension-only — load the " +
        "connector extension and check `browser-tab daemon status`.",
    );
  }
  throw new Error(
    `More than one browser is connected (${connected.join(", ")}); pass browser to say ` +
      `which one. Bookmarks are per-browser and never merged — a merged remove would ` +
      `delete from all of them.`,
  );
}

export async function bookmarks(
  params: Record<string, unknown>,
  deps: BookmarksDeps,
): Promise<BookmarksOutput> {
  const browser = resolveTarget(params.browser as BrowserId | undefined, deps.connected());
  if (!deps.ext) throw new Error("The daemon has no extension server — bookmarks are unavailable.");

  const action = (params.action as string) ?? "search";
  const raw = (await deps.ext.sendCommand(browser, "bookmarks", {
    action,
    ...(params.query !== undefined ? { query: params.query } : {}),
    ...(params.folderId !== undefined ? { folderId: params.folderId } : {}),
    ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
    ...(params.id !== undefined ? { id: params.id } : {}),
    ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.url !== undefined ? { url: params.url } : {}),
    ...(params.index !== undefined ? { index: params.index } : {}),
    maxResults: typeof params.maxResults === "number" ? params.maxResults : 100,
  })) as { payload?: ExtPayload } | undefined;

  const payload = raw?.payload ?? {};
  return {
    action,
    browser,
    nodes: normalizeNodes(payload.nodes),
    ...(payload.removed !== undefined ? { removed: payload.removed } : {}),
    truncated: payload.truncated === true,
  };
}

/**
 * Coerce the extension's rows into the contract shape.
 *
 * The extension is our own code, but it is code running in a BROWSER we do not
 * control the version of — an older bundle can send a shape this daemon has
 * never seen. Dropping unknown rows beats trusting them into a typed result.
 */
function normalizeNodes(rows: unknown): BookmarksOutput["nodes"] {
  if (!Array.isArray(rows)) return [];
  const out: BookmarksOutput["nodes"] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    out.push({
      id: r.id,
      ...(typeof r.parentId === "string" ? { parentId: r.parentId } : {}),
      title: typeof r.title === "string" ? r.title : "",
      ...(typeof r.url === "string" ? { url: r.url } : {}),
      ...(typeof r.dateAdded === "number" ? { dateAdded: r.dateAdded } : {}),
      ...(typeof r.index === "number" ? { index: r.index } : {}),
    });
  }
  return out;
}

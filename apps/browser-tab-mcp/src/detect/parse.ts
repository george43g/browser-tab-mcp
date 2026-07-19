/**
 * Parser for the RS-delimited record format emitted by the AppleScript
 * sources in the adapters (ported from wm-stack's browser_tabs.sh).
 *
 * Format: one record per line. Fields separated by ASCII 0x1E (record
 * separator — cannot appear in URLs and is vanishingly rare in titles).
 *
 *   W <RS> nativeWindowId <RS> left <RS> top <RS> right <RS> bottom <RS> activeTabIndex1 <RS> mode <RS> title
 *   T <RS> nativeTabId    <RS> url  <RS> title
 *
 * Tab titles can legally contain linefeeds; a line that doesn't start with
 * a W/T record marker is treated as a continuation of the previous
 * record's title field.
 */

import type { WindowBounds } from "@george43g/shared-types";

export const RS = "\x1e";

export interface RawTab {
  nativeId: string;
  url: string;
  title: string;
}

export interface RawWindow {
  nativeId: string;
  bounds: WindowBounds | null;
  /** 1-based, as AppleScript reports it. 0 when unknown. */
  activeTabIndex1: number;
  /** "normal" | "incognito" (chromium `mode of w`); adapters may pass other labels. */
  mode: string;
  title: string;
  tabs: RawTab[];
}

function toBounds(l: string, t: string, r: string, b: string): WindowBounds | null {
  const left = Number.parseFloat(l);
  const top = Number.parseFloat(t);
  const right = Number.parseFloat(r);
  const bottom = Number.parseFloat(b);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function parseRecordOutput(raw: string): RawWindow[] {
  const windows: RawWindow[] = [];
  let currentWindow: RawWindow | null = null;
  let lastRecord: { kind: "W" | "T"; obj: RawWindow | RawTab } | null = null;

  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const fields = line.split(RS);
    const marker = fields[0];

    if (marker === "W" && fields.length >= 9) {
      currentWindow = {
        nativeId: fields[1] ?? "",
        bounds: toBounds(fields[2] ?? "", fields[3] ?? "", fields[4] ?? "", fields[5] ?? ""),
        activeTabIndex1: Number.parseInt(fields[6] ?? "0", 10) || 0,
        mode: fields[7] ?? "normal",
        // Title may itself contain RS-free text; re-join in case it contained RS.
        title: fields.slice(8).join(" "),
        tabs: [],
      };
      windows.push(currentWindow);
      lastRecord = { kind: "W", obj: currentWindow };
    } else if (marker === "T" && fields.length >= 4 && currentWindow) {
      const tab: RawTab = {
        nativeId: fields[1] ?? "",
        url: fields[2] ?? "",
        title: fields.slice(3).join(" "),
      };
      currentWindow.tabs.push(tab);
      lastRecord = { kind: "T", obj: tab };
    } else if (lastRecord) {
      // Continuation of a title containing a raw linefeed.
      lastRecord.obj.title = `${lastRecord.obj.title} ${line}`.trim();
    }
    // Lines before the first valid record are dropped.
  }
  return windows;
}

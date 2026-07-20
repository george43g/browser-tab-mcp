/**
 * Connector status — the observable state the background worker exposes to
 * the popup and options pages (and logs), plus a pure presenter that turns
 * it into a design-system status readout (colored dot + lowercase word).
 *
 * Kept free of any WebExtension API so it unit-tests without a browser and
 * so both pages render identically from one source of truth.
 */

import type { BrowserName } from "./runtime.js";

/** Connection lifecycle as the UI cares about it. */
export type ConnectionPhase = "connected" | "connecting" | "error" | "unconfigured";

export interface SnapshotSummary {
  windows: number;
  tabs: number;
  /** ms epoch of the last snapshot the extension pushed. */
  at: number;
}

/** Everything the popup/options pages need to render, in one message. */
export interface ConnectorStatus {
  phase: ConnectionPhase;
  browser: BrowserName;
  port: number;
  extVersion: string;
  hasToken: boolean;
  connectedAt: number | null;
  lastSnapshot: SnapshotSummary | null;
  lastError: string | null;
  reconnectAttempts: number;
}

/** Raw liveness fields the socket tracks; the worker composes the rest. */
export interface SocketState {
  connected: boolean;
  connectedAt: number | null;
  lastSnapshot: SnapshotSummary | null;
  lastError: string | null;
  reconnectAttempts: number;
}

/** Message protocol between the pages and the background worker. */
export type PageMessage = { type: "getStatus" } | { type: "reconnect" };

export const STATUS_TONES = ["ok", "warn", "bad", "muted"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export interface StatusDescription {
  tone: StatusTone;
  /** lowercase status word — instrument-panel voice, never an emoji. */
  word: string;
  /** short caption under the word. */
  detail: string;
}

/** Derive the phase from raw socket state + whether a token is configured. */
export function derivePhase(socket: SocketState, hasToken: boolean): ConnectionPhase {
  if (!hasToken) return "unconfigured";
  if (socket.connected) return "connected";
  if (socket.lastError) return "error";
  return "connecting";
}

/** Pure presenter: ConnectorStatus → colored-dot + word + caption. */
export function describeStatus(s: ConnectorStatus): StatusDescription {
  if (!s.hasToken) {
    return { tone: "muted", word: "not configured", detail: "paste the daemon token to connect" };
  }
  switch (s.phase) {
    case "connected":
      return { tone: "ok", word: "connected", detail: `127.0.0.1:${s.port}` };
    case "connecting":
      return {
        tone: "warn",
        word: "connecting",
        detail: s.reconnectAttempts > 0 ? `retry ${s.reconnectAttempts}` : "reaching daemon",
      };
    default:
      return {
        tone: "bad",
        word: "can't reach daemon",
        detail: s.lastError ?? "connection failed",
      };
  }
}

/** "just now" / "42s ago" / "6m ago" — compact relative time for captions. */
export function relativeTime(then: number | null, now: number): string {
  if (then === null) return "—";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 3) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

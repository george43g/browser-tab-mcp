/**
 * Shared status rendering for the popup and options pages. Both fetch the
 * ConnectorStatus from the background worker over runtime messaging and paint
 * the same set of well-known elements, so the two surfaces never drift.
 */

import {
  api,
  type ConnectorStatus,
  describeStatus,
  logError,
  type PageMessage,
  relativeTime,
  type StatusTone,
} from "@george43g/extension-core";

/** The real reason the last worker request failed (surfaced on the page so a
 *  broken background is diagnosable without opening DevTools). */
let lastAskError: string | null = null;

async function ask(message: PageMessage): Promise<ConnectorStatus | null> {
  try {
    const res = (await api.runtime.sendMessage(message)) as ConnectorStatus | undefined;
    lastAskError = res ? null : "worker returned no status";
    return res ?? null;
  } catch (err) {
    lastAskError = (err as Error).message;
    logError("status request failed:", lastAskError);
    return null; // worker asleep/gone — the page shows a "no worker" state
  }
}

export const fetchStatus = (): Promise<ConnectorStatus | null> => ask({ type: "getStatus" });
export const requestReconnect = (): Promise<ConnectorStatus | null> => ask({ type: "reconnect" });

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setDot(tone: StatusTone): void {
  const dot = byId("st-dot");
  if (dot) dot.className = `wm-dot ${tone}`;
}

function setText(id: string, value: string): void {
  const node = byId(id);
  if (node) node.textContent = value;
}

/** Paint the shared STATUS + STATS + error elements from a status (or null). */
export function renderStatus(status: ConnectorStatus | null): void {
  const err = byId("st-err");
  if (!status) {
    setDot("muted");
    setText("st-word", "no worker");
    setText("st-detail", "background not responding");
    for (const id of ["st-windows", "st-tabs", "st-event", "st-browser", "st-version"]) {
      setText(id, "—");
    }
    if (err) {
      err.textContent = lastAskError
        ? `background worker unreachable — ${lastAskError}`
        : "background worker isn't responding — reload the extension";
      err.classList.remove("hidden");
    }
    return;
  }

  const d = describeStatus(status);
  setDot(d.tone);
  setText("st-word", d.word);
  setText("st-detail", d.detail);
  setText("st-windows", status.lastSnapshot ? String(status.lastSnapshot.windows) : "—");
  setText("st-tabs", status.lastSnapshot ? String(status.lastSnapshot.tabs) : "—");
  setText("st-event", relativeTime(status.lastSnapshot?.at ?? null, Date.now()));
  setText("st-browser", status.browser);
  setText("st-version", `v${status.extVersion}`);

  if (err) {
    if (status.phase === "error" && status.lastError) {
      err.textContent = status.lastError;
      err.classList.remove("hidden");
    } else {
      err.classList.add("hidden");
    }
  }
}

/** Poll status into the shared elements every `ms`; returns a stop fn. */
export function startStatusPolling(ms = 1000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    renderStatus(await fetchStatus());
  };
  void tick();
  const timer = setInterval(() => void tick(), ms);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Last-resort error boundary so a page can never render fully blank. */
export function showFatal(message: string): void {
  logError("page fatal:", message);
  const host = byId("st-err") ?? document.body;
  if (host === document.body) {
    const div = document.createElement("div");
    div.className = "wm-err";
    div.textContent = `page error: ${message}`;
    document.body.prepend(div);
  } else {
    host.textContent = `page error: ${message}`;
    host.classList.remove("hidden");
  }
}

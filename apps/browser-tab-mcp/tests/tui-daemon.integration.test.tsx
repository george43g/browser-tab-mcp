/**
 * TUI ↔ daemon, end to end — the layer nothing else covers.
 *
 * `src/tui/App.test.tsx` mocks `useSnapshot` outright (it is a layout test), and
 * `daemon-reconnect.integration.test.ts` drives `DaemonClient` with no render.
 * So the wiring in between — daemon → unix socket → DaemonClient → useSnapshot →
 * React state → the frame a user actually reads — had no test at all. That gap
 * is where the known regression lived: a daemon that died mid-session left the
 * TUI frozen on stale data **while still captioning itself "daemon stream"**.
 * The lie is a rendered string, so only a render test can pin it.
 *
 * Real daemon on a temp socket (fake adapter), real client, real Ink render —
 * no mocks. Lives in `tests/` per AGENTS.md's taxonomy (crosses a socket
 * boundary, wires 2+ real components) and is `.tsx` because it renders JSX.
 */

import { rmSync } from "node:fs";
import { makeTmpDir, withDaemonEnv } from "@george43g/test-kit";
import { ThemeProvider } from "@george43g/tui-kit";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import { App } from "../src/tui/App.js";

/** A tab title only the fake adapter produces — proves the feed reached the frame. */
const FAKE_TAB_TITLE = "Inbox (3) - Gmail";

let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;
let unmount: (() => void) | null = null;

beforeEach(() => {
  tmp = makeTmpDir("browser-tab-tui-");
  env = withDaemonEnv(tmp, { browsers: "chrome" });
});

afterEach(async () => {
  unmount?.();
  unmount = null;
  await daemon?.stop();
  daemon = null;
  env?.restore();
  env = null;
  rmSync(tmp, { recursive: true, force: true });
});

async function startTestDaemon(): Promise<DaemonHandle> {
  daemon = await startDaemon();
  await daemon.loop.refresh();
  return daemon;
}

/** Mount the real tree; the caller drives it purely through the rendered frame. */
function mount(): { frame: () => string } {
  const inst = render(
    <ThemeProvider preset="safe" accent="#1982FC">
      <App />
    </ThemeProvider>,
  );
  unmount = inst.unmount;
  return { frame: () => inst.lastFrame() ?? "" };
}

/**
 * Poll the frame until `predicate` holds. The feed is genuinely async (socket
 * connect → subscribe → setState → re-render), so there is no deterministic
 * tick to await; on timeout the last frame is included so a failure is legible.
 */
async function waitForFrame(
  frame: () => string,
  predicate: (f: string) => boolean,
  what: string,
  ms = 5_000,
): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const current = frame();
    if (predicate(current)) return current;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms}ms waiting for ${what}. Last frame:\n${current}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("TUI over the daemon feed", () => {
  it("renders daemon-fed tabs and reports the live stream", async () => {
    await startTestDaemon();
    const { frame } = mount();

    const live = await waitForFrame(
      frame,
      (f) => f.includes("daemon stream"),
      'the header to report "daemon stream"',
    );
    // The subscription is up, so the header must NOT still claim polling.
    expect(live, "header must not advertise both feeds").not.toContain("osascript polling");

    const withTabs = await waitForFrame(
      frame,
      (f) => f.includes(FAKE_TAB_TITLE),
      "a daemon-fed tab row",
    );
    // Browser row + both fake windows + the tab: the tree really rendered.
    expect(withTabs).toContain("chrome");
    expect(withTabs).toContain("Apple Developer");
  });

  it("flips the header to polling when the daemon dies mid-session", async () => {
    await startTestDaemon();
    const { frame } = mount();
    await waitForFrame(frame, (f) => f.includes("daemon stream"), "the live feed");

    await daemon?.stop();
    daemon = null;

    // The regression this pins: the caption stayed "daemon stream" over frozen
    // data. It must degrade honestly instead.
    const degraded = await waitForFrame(
      frame,
      (f) => f.includes("osascript polling"),
      "the header to degrade to polling",
    );
    expect(degraded, "stale live caption survived the daemon dying").not.toContain("daemon stream");
    // Degraded is not dead: polling still paints tabs via the direct adapter.
    expect(degraded).toContain(FAKE_TAB_TITLE);
  });

  it("still renders when the daemon was never up", async () => {
    const { frame } = mount();

    const polled = await waitForFrame(
      frame,
      (f) => f.includes(FAKE_TAB_TITLE),
      "tabs from the direct (no-daemon) path",
    );
    expect(polled, "no daemon, so the header must say polling").toContain("osascript polling");
  });
});

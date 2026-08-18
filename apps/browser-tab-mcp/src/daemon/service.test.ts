/**
 * Service-manager selection and the Windows argv.
 *
 * `schtasks /Create` is the one step in the Windows path that fails SILENTLY
 * when it is wrong: a mis-quoted `/TR` produces a task that is created, reports
 * success, and never runs. So the argv is a pure function with a test, rather
 * than a template literal discovered on someone's laptop.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildSchtasksCreateArgs, serviceManager, WINDOWS_TASK_NAME } from "./service.js";

const saved = process.env.BROWSER_TAB_PLATFORM;
afterEach(() => {
  if (saved === undefined) delete process.env.BROWSER_TAB_PLATFORM;
  else process.env.BROWSER_TAB_PLATFORM = saved;
});
const as = (p: string) => {
  process.env.BROWSER_TAB_PLATFORM = p;
};

describe("serviceManager selection", () => {
  it("uses launchd on macOS", () => {
    as("darwin");
    expect(serviceManager().kind).toContain("launchd");
  });

  it("uses Task Scheduler on Windows", () => {
    as("win32");
    expect(serviceManager().kind).toContain("Task Scheduler");
  });

  it("refuses to guess elsewhere, and says what to do instead", () => {
    as("linux");
    expect(serviceManager().kind).toContain("unsupported");
  });

  it("still ANSWERS status on an unsupported platform", async () => {
    // `daemon status` must not throw just because startup is unmanaged —
    // "nothing manages it" is a true and useful answer.
    as("linux");
    await expect(serviceManager().status()).resolves.toMatchObject({ loaded: false });
  });

  it("throws an instruction, not an errno, for install on an unsupported platform", async () => {
    as("linux");
    await expect(serviceManager().install()).rejects.toThrow(/daemon run/);
  });
});

describe("schtasks argv", () => {
  const args = () =>
    buildSchtasksCreateArgs(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\tools\\browser-tab\\cli.js",
    );

  it("quotes both paths inside the single /TR command string", () => {
    // Windows program paths contain spaces; an unquoted one is parsed as two
    // arguments and the task runs `C:\Program` — which fails at logon, hours
    // after the install that reported success.
    const tr = args()[args().indexOf("/TR") + 1];
    expect(tr).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\tools\\browser-tab\\cli.js" daemon run',
    );
  });

  it("triggers at logon, in the user's session", () => {
    // A real Windows Service runs in session 0 and cannot see the user's
    // browser at all, so this must stay a per-user scheduled task.
    expect(args()).toContain("ONLOGON");
    expect(args()).toContain("LIMITED");
  });

  it("is idempotent — /F replaces an existing definition", () => {
    // Matches `launchctl bootout && bootstrap` on macOS: re-installing must not
    // fail because a previous install exists.
    expect(args()).toContain("/F");
  });

  it("names the task consistently", () => {
    expect(args()[args().indexOf("/TN") + 1]).toBe(WINDOWS_TASK_NAME);
  });
});

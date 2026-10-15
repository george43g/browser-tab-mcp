import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appBundleName,
  findPaneProcesses,
  findTerminalApp,
  matchOsWindow,
  type OsWindowCandidate,
  parseArgsTable,
  parseProcessTable,
} from "./terminal-map.js";

/**
 * Shaped like `ps -A -o pid=,ppid=,pgid=,tpgid=,comm=` on gmac (2026-10-09 and
 * 2026-10-15): kitty 2035 → zsh 2070 → tmux client 7059; pane %1's shell 8272
 * with claude 39402 in the foreground and gitstatusd in a background group;
 * a crash-sentinel control-mode client that no terminal started.
 */
const PS_FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/ps-gmac-2026-10-15.txt", import.meta.url)),
  "utf8",
);
const table = parseProcessTable(PS_FIXTURE);

describe("ps parsing", () => {
  it("keeps comm intact when it contains spaces", () => {
    expect(table.get(5001)?.comm).toBe(
      "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
    );
    expect(table.get(39402)).toEqual({
      pid: 39402,
      ppid: 8272,
      pgid: 39402,
      tpgid: 39402,
      comm: "claude",
    });
  });

  it("parses args rows", () => {
    expect(parseArgsTable("39402 claude --resume x\n 6001 sleep 60\n")).toEqual(
      new Map([
        [39402, "claude --resume x"],
        [6001, "sleep 60"],
      ]),
    );
  });

  it("names only top-level app bundles", () => {
    expect(appBundleName("/Applications/kitty.app/Contents/MacOS/kitty")).toBe("kitty");
    expect(appBundleName("/Applications/Ghostty.app/Contents/MacOS/ghostty")).toBe("Ghostty");
    expect(appBundleName(table.get(5001)?.comm ?? "")).toBeNull();
    expect(appBundleName("/opt/homebrew/bin/tmux")).toBeNull();
  });
});

describe("terminal app ancestry", () => {
  it("walks tmux → shell → kitty (the measured chain)", () => {
    expect(findTerminalApp(7059, table)).toEqual({ terminal: { app: "kitty", pid: 2035 } });
  });

  it("skips a nested helper bundle and reaches the app that owns the windows", () => {
    expect(findTerminalApp(5003, table)).toEqual({
      terminal: { app: "Visual Studio Code", pid: 5000 },
    });
  });

  it("returns null with the chain when no GUI app is an ancestor", () => {
    const result = findTerminalApp(71954, table);
    expect(result.terminal).toBeNull();
    expect(result.reason).toContain("tmux 71954 → crash-sentinel 71947");
  });

  it("returns null when the client process is gone", () => {
    expect(findTerminalApp(99999, table)).toEqual({
      terminal: null,
      reason: "tmux client process 99999 was not found by ps",
    });
  });
});

describe("pane foreground", () => {
  it("is null for an idle shell", () => {
    expect(findPaneProcesses(8355, table)).toEqual({
      shell: { pid: 8355, command: "-zsh" },
      foreground: null,
    });
  });

  it("is the TUI's group leader, not the shell, a child, or a background helper", () => {
    expect(findPaneProcesses(8272, table)).toEqual({
      shell: { pid: 8272, command: "-zsh" },
      foreground: { pid: 39402, pgid: 39402, command: "claude" },
    });
  });

  it("ignores a background group even when it is the only other group", () => {
    const quiet = parseProcessTable(` 8272  7066  8272  8272 -zsh
 8300  8272  8300  8272 gitstatusd-darwin-arm64
`);
    expect(findPaneProcesses(8272, quiet).foreground).toBeNull();
  });

  it("names the oldest member when the group leader has exited", () => {
    expect(findPaneProcesses(8400, table).foreground).toEqual({
      pid: 6001,
      pgid: 6000,
      command: "sleep",
    });
  });

  it("is all null when the pane's process is gone", () => {
    expect(findPaneProcesses(424242, table)).toEqual({ shell: null, foreground: null });
  });
});

const kitty = { app: "kitty", pid: 2035 };
const window = (windowId: number, title?: string, w = 1996, h = 1269): OsWindowCandidate => ({
  windowId,
  ownerPid: 2035,
  w,
  h,
  layer: 0,
  ...(title === undefined ? {} : { title }),
});
/** The non-terminal kitty windows measured on gmac 2026-10-15. */
const noise: OsWindowCandidate[] = [
  window(157773, "", 1920, 24),
  window(157757, "", 2056, 43),
  window(6206, "", 54, 54),
  window(6184, undefined, 0, 0),
  window(6181, "temp", 0, 0),
  { ...window(9999, "tooltip"), layer: 3 },
  { ...window(8888, "other app"), ownerPid: 1234 },
];
const rendered = { setTitles: true, title: "Georges-MacBook-Pro ❐ claude ● 1 dotfiles" };

describe("option A window matching", () => {
  it("control: one terminal window joins on pid alone, with or without titles", () => {
    expect(matchOsWindow(kitty, [...noise, window(6183, rendered.title)], undefined)).toEqual({
      osWindow: { cgWindowId: 6183, title: rendered.title },
      byTitle: false,
    });
    expect(matchOsWindow(kitty, [window(6183), window(6184, undefined, 0, 0)], undefined)).toEqual({
      osWindow: { cgWindowId: 6183, title: null },
      byTitle: false,
    });
  });

  it("several windows: a unique exact title picks one", () => {
    const result = matchOsWindow(
      kitty,
      [...noise, window(6183, rendered.title), window(7000, "Georges-MacBook-Pro ❐ work ● 2 x")],
      rendered,
    );
    expect(result).toEqual({
      osWindow: { cgWindowId: 6183, title: rendered.title },
      byTitle: true,
    });
  });

  it("several windows with the same title: null with the reason, never a guess", () => {
    const result = matchOsWindow(
      kitty,
      [window(6183, rendered.title), window(7000, rendered.title)],
      rendered,
    );
    expect(result.osWindow).toBeNull();
    expect(result.reason).toBe(
      `2 kitty windows share pid 2035 and the title ${JSON.stringify(rendered.title)}`,
    );
  });

  it("several windows and no matching title: null", () => {
    const result = matchOsWindow(kitty, [window(6183, "a"), window(7000, "b")], rendered);
    expect(result.osWindow).toBeNull();
    expect(result.reason).toContain("none has this client's title");
  });

  it("several windows with set-titles off: null", () => {
    const result = matchOsWindow(kitty, [window(6183, "a"), window(7000, "b")], {
      setTitles: false,
      title: "a",
    });
    expect(result.reason).toContain("set-titles is off");
  });

  it("several windows without Screen Recording consent: null", () => {
    const result = matchOsWindow(kitty, [window(6183), window(7000)], rendered);
    expect(result.reason).toContain("titles are unreadable");
  });

  it("no native module: null with the reason", () => {
    expect(matchOsWindow(kitty, null, rendered, "rust-accel is not built")).toEqual({
      osWindow: null,
      byTitle: false,
      reason: "rust-accel is not built",
    });
  });

  it("no normal window at all: null", () => {
    expect(matchOsWindow(kitty, noise, rendered).reason).toBe(
      "kitty (pid 2035) owns no normal window",
    );
  });
});

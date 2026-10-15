/** A read-only snapshot. A slot is one session's occurrence of a window. */
export interface TmuxServer {
  kind: "server";
  key: string;
  pid: number;
  startTime: number;
}

export interface TmuxSession {
  kind: "session";
  key: string;
  id: string;
  name: string;
  windowCount: number;
  attached: boolean;
}

export interface TmuxSlot {
  kind: "slot";
  key: string;
  sessionId: string;
  windowId: string;
  index: number;
  active: boolean;
}

export interface TmuxWindow {
  kind: "window";
  key: string;
  id: string;
  name: string;
  layout: string;
  width: number;
  height: number;
}

export interface TmuxPane {
  kind: "pane";
  key: string;
  id: string;
  windowId: string;
  index: number;
  title: string;
  command: string;
  path: string;
  pid: number;
  width: number;
  height: number;
  project?: string;
}

export interface TmuxClient {
  kind: "client";
  key: string;
  tty: string;
  name: string;
  pid: number;
  sessionId: string;
  width?: number;
  height?: number;
}

export type TmuxRef = TmuxServer | TmuxSession | TmuxSlot | TmuxWindow | TmuxPane | TmuxClient;

export interface TmuxSnapshot {
  server: TmuxServer;
  sessions: readonly TmuxSession[];
  slots: readonly TmuxSlot[];
  windows: readonly TmuxWindow[];
  panes: readonly TmuxPane[];
  clients: readonly TmuxClient[];
}

/** The GUI app a tmux client runs in: the nearest macOS app-bundle ancestor. */
export interface TmuxTerminalApp {
  /** Bundle name without `.app`, e.g. `kitty`. */
  app: string;
  pid: number;
}

/** A CoreGraphics window. `cgWindowId` equals yabai's window `id`. */
export interface TmuxOsWindow {
  cgWindowId: number;
  /** kCGWindowName; null when this process lacks Screen Recording consent. */
  title: string | null;
}

/** Where one tmux client is shown. Keyed by the snapshot client's `key`. */
export interface TmuxClientPlacement {
  clientKey: string;
  terminal: TmuxTerminalApp | null;
  osWindow: TmuxOsWindow | null;
  /** Present exactly when `osWindow` is null: why no single window was named. */
  ambiguous?: string;
}

export interface TmuxProcess {
  pid: number;
  command: string;
}

/** The leader of the tty's foreground process group, when it is not the shell. */
export interface TmuxForegroundProcess {
  pid: number;
  pgid: number;
  command: string;
  args: string;
}

/** What one pane runs. Keyed by pane id. */
export interface TmuxPaneProcesses {
  paneId: string;
  /** The pane's own process (`#{pane_pid}`); null if it exited mid-read. */
  shell: TmuxProcess | null;
  /** Null when the shell itself is in the foreground (an idle prompt). */
  foreground: TmuxForegroundProcess | null;
}

export interface TmuxTerminalMap {
  clients: TmuxClientPlacement[];
  panes: TmuxPaneProcesses[];
}

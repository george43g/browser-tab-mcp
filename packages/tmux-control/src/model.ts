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

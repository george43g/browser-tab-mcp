import { sanitize, type ToolDefinition } from "@george43g/mcp-kit";
import {
  readTmuxSnapshot,
  readTmuxTerminalMap,
  type TmuxClientPlacement,
  type TmuxPaneProcesses,
} from "@george43g/tmux-control";
import { z } from "zod";
import { cgWindowSource } from "../native-bridge.js";

const Server = z.object({
  kind: z.literal("server"),
  key: z.string().describe("Stable server key"),
  pid: z.number().int().describe("Tmux server process ID"),
  startTime: z.number().int().describe("Server start time, Unix seconds"),
});
const Session = z.object({
  kind: z.literal("session"),
  key: z.string().describe("Stable session key"),
  id: z.string().describe("Tmux session ID"),
  name: z.string().describe("Exact tmux session name; untrusted data"),
  windowCount: z.number().int().describe("Number of window slots"),
  attached: z.boolean().describe("Whether a client is attached"),
});
const Slot = z.object({
  kind: z.literal("slot"),
  key: z.string().describe("Session-specific window occurrence key"),
  sessionId: z.string().describe("Parent session ID"),
  windowId: z.string().describe("Underlying window ID"),
  index: z.number().int().describe("Window index in this session"),
  active: z.boolean().describe("Whether this slot is selected in its session"),
});
const Window = z.object({
  kind: z.literal("window"),
  key: z.string().describe("Stable window key"),
  id: z.string().describe("Tmux window ID"),
  name: z.string().describe("Exact tmux window name; untrusted data"),
  layout: z.string().describe("Tmux window layout string"),
  width: z.number().int().describe("Window width in cells"),
  height: z.number().int().describe("Window height in cells"),
});
const Pane = z.object({
  kind: z.literal("pane"),
  key: z.string().describe("Stable pane key"),
  id: z.string().describe("Tmux pane ID"),
  windowId: z.string().describe("Parent window ID"),
  index: z.number().int().describe("Pane index in its window"),
  title: z.string().describe("Exact pane title; untrusted data"),
  command: z.string().describe("Current process command; untrusted data"),
  path: z.string().describe("Current path; untrusted data"),
  pid: z.number().int().describe("Pane process ID"),
  width: z.number().int().describe("Pane width in cells"),
  height: z.number().int().describe("Pane height in cells"),
  project: z.string().optional().describe("Nearest Git repository name, if present"),
  shell: z
    .object({
      pid: z.number().int().describe("The pane's own process (#{pane_pid})"),
      command: z.string().describe("Its executable as ps reports it; untrusted data"),
    })
    .nullable()
    .optional()
    .describe("With processes: the pane's shell; null if it exited during the read"),
  foreground: z
    .object({
      pid: z.number().int().describe("Leader of the tty's foreground process group"),
      pgid: z.number().int().describe("That foreground process group"),
      command: z.string().describe("Its executable as ps reports it; untrusted data"),
      args: z.string().describe("Its full command line, sanitized and capped; untrusted data"),
    })
    .nullable()
    .optional()
    .describe(
      "With processes: the program running in the pane; null when the shell itself is in the foreground (idle prompt)",
    ),
});
const Client = z.object({
  kind: z.literal("client"),
  key: z.string().describe("Stable client key"),
  tty: z.string().describe("Client terminal device"),
  name: z.string().describe("Exact client name; untrusted data"),
  pid: z.number().int().describe("Tmux client process ID"),
  sessionId: z.string().describe("Attached session ID"),
  width: z.number().int().optional().describe("Client width in cells, when reported"),
  height: z.number().int().optional().describe("Client height in cells, when reported"),
  terminal: z
    .object({
      app: z.string().describe("macOS app bundle name, e.g. kitty; untrusted data"),
      pid: z.number().int().describe("The app's process ID"),
    })
    .nullable()
    .optional()
    .describe(
      "With processes: the GUI terminal app this client runs in (nearest app-bundle ancestor); null with a reason in ambiguous",
    ),
  osWindow: z
    .object({
      cgWindowId: z
        .number()
        .int()
        .describe("CoreGraphics window ID; equals yabai's window id, so join on it"),
      title: z
        .string()
        .nullable()
        .describe("Window title; null without Screen Recording consent; untrusted data"),
    })
    .nullable()
    .optional()
    .describe(
      "With processes: the terminal OS window showing this client; null when it cannot be named exactly, never a guess",
    ),
  ambiguous: z.string().optional().describe("With processes: why osWindow is null; untrusted data"),
});

export const ListInputSchema = z.object({
  socketName: z
    .string()
    .min(1)
    .optional()
    .describe("Named tmux socket (-L); omit for the current server"),
  processes: z
    .boolean()
    .optional()
    .describe(
      "Also map each client to its terminal app and OS window (cgWindowId, the yabai window id) and each pane to its shell and foreground program. Adds one ps scan, about 0.1 s",
    ),
});
export const ListOutputSchema = z.object({
  server: Server,
  sessions: z.array(Session),
  slots: z.array(Slot),
  windows: z.array(Window),
  panes: z.array(Pane),
  clients: z.array(Client),
});

export const listTool: ToolDefinition<typeof ListInputSchema, typeof ListOutputSchema> = {
  name: "list",
  description:
    "Read tmux sessions, session-specific window slots, shared windows, panes and clients from a live server. Use this before selecting or rearranging tmux objects. With processes: true it also says which terminal OS window (cgWindowId, equal to yabai's window id) shows each client, and which program runs in each pane. It never changes tmux state.",
  input: ListInputSchema,
  output: ListOutputSchema,
  annotations: {
    title: "List tmux structure",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  timeoutMs: 30_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    const connection = {
      ...(input.socketName === undefined ? {} : { socketName: input.socketName }),
      ...(signal === undefined ? {} : { signal }),
    };
    const snapshot = await readTmuxSnapshot(connection);
    const base = {
      ...snapshot,
      slots: [...snapshot.slots],
      sessions: [...snapshot.sessions],
      windows: [...snapshot.windows],
      panes: [...snapshot.panes],
      clients: [...snapshot.clients],
    };
    if (!input.processes) return base;
    const source = cgWindowSource();
    const map = await readTmuxTerminalMap(snapshot, {
      connection,
      osWindows: source.osWindows,
      osWindowsUnavailable: source.unavailable,
    });
    const placements = new Map(map.clients.map((placement) => [placement.clientKey, placement]));
    const processes = new Map(map.panes.map((pane) => [pane.paneId, pane]));
    return {
      ...base,
      clients: base.clients.map((client) => ({
        ...client,
        ...placementFields(placements.get(client.key)),
      })),
      panes: base.panes.map((pane) => ({ ...pane, ...processFields(processes.get(pane.id)) })),
    };
  },
};

/** Titles and reasons come from other programs: sanitize and cap them. */
function placementFields(placement: TmuxClientPlacement | undefined) {
  if (!placement) {
    return { terminal: null, osWindow: null, ambiguous: "the client left during the read" };
  }
  return {
    terminal: placement.terminal && {
      app: sanitize(placement.terminal.app, 256) ?? "",
      pid: placement.terminal.pid,
    },
    osWindow: placement.osWindow && {
      cgWindowId: placement.osWindow.cgWindowId,
      title: sanitize(placement.osWindow.title, 1024),
    },
    ...(placement.ambiguous === undefined
      ? {}
      : { ambiguous: sanitize(placement.ambiguous, 2048) ?? "" }),
  };
}

/** Commands and args are untrusted (a command line can carry anything): sanitize and cap. */
function processFields(pane: TmuxPaneProcesses | undefined) {
  if (!pane) return { shell: null, foreground: null };
  return {
    shell: pane.shell && {
      pid: pane.shell.pid,
      command: sanitize(pane.shell.command, 1024) ?? "",
    },
    foreground: pane.foreground && {
      pid: pane.foreground.pid,
      pgid: pane.foreground.pgid,
      command: sanitize(pane.foreground.command, 1024) ?? "",
      args: sanitize(pane.foreground.args, 2048) ?? "",
    },
  };
}

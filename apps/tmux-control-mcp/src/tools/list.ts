import type { ToolDefinition } from "@george43g/mcp-kit";
import { readTmuxSnapshot } from "@george43g/tmux-control";
import { z } from "zod";

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
});

export const ListInputSchema = z.object({
  socketName: z
    .string()
    .min(1)
    .optional()
    .describe("Named tmux socket (-L); omit for the current server"),
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
    "Read tmux sessions, session-specific window slots, shared windows, panes and clients from a live server. Use this before selecting or rearranging tmux objects. It never changes tmux state.",
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
    const snapshot = await readTmuxSnapshot({
      ...(input.socketName === undefined ? {} : { socketName: input.socketName }),
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      ...snapshot,
      slots: [...snapshot.slots],
      sessions: [...snapshot.sessions],
      windows: [...snapshot.windows],
      panes: [...snapshot.panes],
      clients: [...snapshot.clients],
    };
  },
};

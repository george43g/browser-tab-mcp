import type { FieldType, SelectionDomain } from "@george43g/control-language";
import type { TmuxRef, TmuxSnapshot } from "./model.js";

const SCOPES = new Map([
  ["server", "server"],
  ["sessions", "session"],
  ["slots", "slot"],
  ["windows", "window"],
  ["panes", "pane"],
  ["clients", "client"],
]);

const RELATIONS = new Map([
  ["sessions", "session"],
  ["clients", "client"],
  ["slots", "slot"],
  ["window", "window"],
  ["panes", "pane"],
]);

const FIELDS = new Map<string, FieldType>([
  ["name", "string"],
  ["title", "string"],
  ["command", "string"],
  ["path", "string"],
  ["project", "string"],
  ["layout", "string"],
  ["tty", "string"],
  ["index", "number"],
  ["pid", "number"],
  ["width", "number"],
  ["height", "number"],
  ["active", "boolean"],
  ["attached", "boolean"],
]);

/** Bind the immutable read model to the unchanged control-language resolver. */
export function makeTmuxDomain(snapshot: TmuxSnapshot): SelectionDomain<TmuxRef> {
  const refs: TmuxRef[] = [
    snapshot.server,
    ...snapshot.sessions,
    ...snapshot.slots,
    ...snapshot.windows,
    ...snapshot.panes,
    ...snapshot.clients,
  ];
  const byKey = new Map(refs.map((ref) => [ref.key, ref]));
  if (byKey.size !== refs.length) throw new Error("Duplicate tmux stable key in snapshot");

  const slotsFor = (sessionId: string) =>
    snapshot.slots.filter((slot) => slot.sessionId === sessionId).sort((a, b) => a.index - b.index);
  const panesFor = (windowId: string) =>
    snapshot.panes.filter((pane) => pane.windowId === windowId).sort((a, b) => a.index - b.index);

  return {
    kindOf: (ref) => ref.kind,
    stableKey: (ref) => ref.key,
    byKey: (key) => byKey.get(key),
    scopes: () => SCOPES,
    scopeMembers: (name) => {
      switch (name) {
        case "server":
          return [snapshot.server];
        case "sessions":
          return snapshot.sessions;
        case "slots":
          return snapshot.sessions.flatMap((session) => slotsFor(session.id));
        case "windows":
          return snapshot.windows;
        case "panes":
          return snapshot.windows.flatMap((window) => panesFor(window.id));
        case "clients":
          return snapshot.clients;
        default:
          return [];
      }
    },
    relations: () => RELATIONS,
    orderedMembers: (parent, relation) => {
      if (parent.kind === "server") {
        if (relation === "sessions") return snapshot.sessions;
        if (relation === "clients") return snapshot.clients;
      }
      if (parent.kind === "session" && relation === "slots") return slotsFor(parent.id);
      if (parent.kind === "slot" && relation === "window") {
        const window = snapshot.windows.find((candidate) => candidate.id === parent.windowId);
        return window ? [window] : [];
      }
      if (parent.kind === "window" && relation === "panes") return panesFor(parent.id);
      return undefined;
    },
    parentOf: () => {
      throw new Error("Tmux sibling-dependent selection awaits the linked-window M3 experiment.");
    },
    siblingsOf: () => {
      throw new Error("Tmux sibling-dependent selection awaits the linked-window M3 experiment.");
    },
    fields: () => FIELDS,
    readField: (ref, field) => {
      switch (field) {
        case "name":
          return ref.kind === "session" || ref.kind === "window" || ref.kind === "client"
            ? ref.name
            : undefined;
        case "title":
          return ref.kind === "pane" ? ref.title : undefined;
        case "command":
          return ref.kind === "pane" ? ref.command : undefined;
        case "path":
          return ref.kind === "pane" ? ref.path : undefined;
        case "project":
          return ref.kind === "pane" ? ref.project : undefined;
        case "layout":
          return ref.kind === "window" ? ref.layout : undefined;
        case "tty":
          return ref.kind === "client" ? ref.tty : undefined;
        case "index":
          return ref.kind === "slot" || ref.kind === "pane" ? ref.index : undefined;
        case "pid":
          return ref.kind === "server" || ref.kind === "pane" || ref.kind === "client"
            ? ref.pid
            : undefined;
        case "width":
          return ref.kind === "window" || ref.kind === "pane" || ref.kind === "client"
            ? ref.width
            : undefined;
        case "height":
          return ref.kind === "window" || ref.kind === "pane" || ref.kind === "client"
            ? ref.height
            : undefined;
        case "active":
          return ref.kind === "slot" ? ref.active : undefined;
        case "attached":
          return ref.kind === "session" ? ref.attached : undefined;
        default:
          return undefined;
      }
    },
  };
}

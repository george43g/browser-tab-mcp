/**
 * Command executors — the daemon's command messages mapped onto the
 * chrome.tabs / chrome.windows APIs. This is where true state-preserving
 * moves happen (tabs.move keeps scroll/forms/JS; AppleScript cannot).
 */

import { api } from "./runtime.js";

export interface CommandArgs {
  tabId?: number;
  windowId?: number;
  targetWindowId?: number;
  targetIndex?: number;
  newWindow?: boolean;
  url?: string;
  activate?: boolean;
}

export interface CommandOutcome {
  tabId?: number;
  windowId?: number;
  index?: number;
}

function requireTab(args: CommandArgs): number {
  if (typeof args.tabId !== "number") throw new Error("missing tabId");
  return args.tabId;
}

export async function executeCommand(kind: string, args: CommandArgs): Promise<CommandOutcome> {
  switch (kind) {
    case "focus_tab": {
      const tabId = requireTab(args);
      const tab = await api.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) {
        await api.windows.update(tab.windowId, { focused: true });
      }
      return {
        tabId,
        ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(tab?.index !== undefined ? { index: tab.index } : {}),
      };
    }
    case "close_tab": {
      const tabId = requireTab(args);
      await api.tabs.remove(tabId);
      return { tabId };
    }
    case "move_tab": {
      const tabId = requireTab(args);
      if (args.newWindow) {
        const win = await api.windows.create({ tabId });
        return {
          tabId,
          ...(win?.id !== undefined ? { windowId: win.id } : {}),
          index: 0,
        };
      }
      if (typeof args.targetWindowId !== "number") {
        throw new Error("move_tab needs targetWindowId or newWindow:true");
      }
      const moved = await api.tabs.move(tabId, {
        windowId: args.targetWindowId,
        index: args.targetIndex ?? -1,
      });
      const tab = Array.isArray(moved) ? moved[0] : moved;
      return {
        tabId,
        windowId: args.targetWindowId,
        ...(tab?.index !== undefined ? { index: tab.index } : {}),
      };
    }
    case "open_tab": {
      if (!args.url) throw new Error("missing url");
      const tab = await api.tabs.create({
        url: args.url,
        active: args.activate ?? true,
        ...(typeof args.windowId === "number" ? { windowId: args.windowId } : {}),
      });
      if ((args.activate ?? true) && tab?.windowId !== undefined) {
        await api.windows.update(tab.windowId, { focused: true });
      }
      return {
        ...(tab?.id !== undefined ? { tabId: tab.id } : {}),
        ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(tab?.index !== undefined ? { index: tab.index } : {}),
      };
    }
    default:
      throw new Error(`unknown command kind "${kind}"`);
  }
}

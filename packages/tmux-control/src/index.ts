export {
  type CommandRunner,
  readTmuxTerminalMap,
  runPs,
  type TerminalMapOptions,
} from "./adapter/processes.js";
export {
  probeTmuxBinary,
  readTmuxSnapshot,
  type TmuxConnection,
  TmuxUnavailableError,
} from "./adapter/read.js";
export { makeTmuxDomain } from "./binding.js";
export type {
  TmuxClient,
  TmuxClientPlacement,
  TmuxForegroundProcess,
  TmuxOsWindow,
  TmuxPane,
  TmuxPaneProcesses,
  TmuxProcess,
  TmuxRef,
  TmuxServer,
  TmuxSession,
  TmuxSlot,
  TmuxSnapshot,
  TmuxTerminalApp,
  TmuxTerminalMap,
  TmuxWindow,
} from "./model.js";
export { previewSplitImpact, type SharedSlotImpact } from "./preview.js";
export {
  MIN_WINDOW_SIDE,
  type OsWindowCandidate,
} from "./terminal-map.js";

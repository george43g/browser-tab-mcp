export {
  probeTmuxBinary,
  readTmuxSnapshot,
  type TmuxConnection,
  TmuxUnavailableError,
} from "./adapter/read.js";
export { makeTmuxDomain } from "./binding.js";
export type {
  TmuxClient,
  TmuxPane,
  TmuxRef,
  TmuxServer,
  TmuxSession,
  TmuxSlot,
  TmuxSnapshot,
  TmuxWindow,
} from "./model.js";
export { previewSplitImpact, type SharedSlotImpact } from "./preview.js";

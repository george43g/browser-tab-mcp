export { color, disableColors } from "./color.js";
export type { BinderOptions, EnvFlagBinding } from "./env-flag-binder.js";
export { applyEnvFromFlags, bindEnvFlags } from "./env-flag-binder.js";
export type { OutputFlags, OutputMode, TableSpec } from "./output.js";
export { printAuto, printJson, printTable, resolveOutputMode } from "./output.js";
export type { ProgramOptions } from "./program.js";
export { buildProgram } from "./program.js";
export type {
  ReplDispatcher,
  ReplShortcut,
  RunReplOptions,
  ToolCallResult,
  ToolDescriptor,
} from "./repl.js";
export { runRepl } from "./repl.js";
export { colorEnabled, isCI, isInteractive, isStderrTTY, isStdinTTY, isStdoutTTY } from "./tty.js";

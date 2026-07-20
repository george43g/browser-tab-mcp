/**
 * Tiny prefixed console logger. Every line is tagged `[browser-tab]` so it
 * filters cleanly in Chrome's service-worker console and Safari's Web
 * Inspector / Console.app — the only observability the extension side has.
 */

const PREFIX = "[browser-tab]";

export function log(...args: unknown[]): void {
  console.log(PREFIX, ...args);
}

export function logWarn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function logError(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}

/**
 * Picocolors wrapper that becomes a no-op when colors are disabled.
 *
 * Always import from this module rather than picocolors directly so
 * `--no-color`, `NO_COLOR=1`, and non-TTY stdout are honored uniformly.
 */

import pc from "picocolors";
import { colorEnabled } from "./tty.js";

type ColorFn = (s: string) => string;

function passthrough(s: string): string {
  return s;
}

function pick(fn: ColorFn): ColorFn {
  return (s: string) => (colorEnabled() ? fn(s) : passthrough(s));
}

export const color = {
  dim: pick(pc.dim),
  bold: pick(pc.bold),
  italic: pick(pc.italic),
  underline: pick(pc.underline),
  black: pick(pc.black),
  red: pick(pc.red),
  green: pick(pc.green),
  yellow: pick(pc.yellow),
  blue: pick(pc.blue),
  magenta: pick(pc.magenta),
  cyan: pick(pc.cyan),
  white: pick(pc.white),
  gray: pick(pc.gray),
};

/** Force-disable colors regardless of TTY (used by `--no-color` flag handler). */
export function disableColors(): void {
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
}

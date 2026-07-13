/**
 * File source: load a JSON or plain-text secret from the local config dir.
 *
 * Resolved path priority (first existing wins):
 *   1. `{TOOL_PREFIX}_{NAME}_PATH` env var (explicit override)
 *   2. `~/.{toolPrefix}/{name}.json`
 *   3. `~/.{toolPrefix}/{name}` (no extension — plain text token)
 *
 * Returns the raw file contents as a string. Callers decide whether the
 * payload is JSON-structured (parse it) or a plain token (use as-is).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SecretRef, SecretSource } from "./types.js";

function envKey(ref: SecretRef): string {
  return `${ref.toolPrefix.toUpperCase().replace(/-/g, "_")}_${ref.name.toUpperCase()}_PATH`;
}

function defaultPaths(ref: SecretRef): string[] {
  const base = join(homedir(), `.${ref.toolPrefix}`);
  return [join(base, `${ref.name}.json`), join(base, ref.name)];
}

export const fileSource: SecretSource = {
  name: "file",
  async resolve(ref: SecretRef): Promise<string | null> {
    const explicit = process.env[envKey(ref)];
    const candidates = explicit && explicit.length > 0 ? [explicit] : defaultPaths(ref);
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf8").trim();
        if (content.length === 0) continue;
        return content;
      } catch {
        // unreadable — skip and try next candidate
      }
    }
    return null;
  },
};

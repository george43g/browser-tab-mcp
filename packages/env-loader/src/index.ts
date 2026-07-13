/**
 * Vite-style .env precedence loader in plain Node.
 *
 * Use this when you need to read env vars *before* spawning a subprocess
 * (e.g. the dev MCP proxy decides which command to spawn based on env).
 *
 * The Node-native `--env-file-if-exists` flag is preferred for production
 * because it's zero-overhead and well-tested, but it loads at process start
 * and you can't introspect what was loaded. This loader is for runtime
 * introspection and pre-subprocess overrides.
 *
 * Precedence (later overrides earlier):
 *   .env  →  .env.local  →  .env.[mode]  →  .env.[mode].local
 *
 * Parsing is intentionally minimal — no variable interpolation, no quote
 * stripping beyond single trim. If you need that, use dotenv-flow. The
 * starter template stays dep-free here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LoadEnvOptions {
  /** Directory containing the .env files. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Mode name, e.g. "production", "test", "ai". Defaults to `NODE_ENV` or `"development"`. */
  mode?: string;
  /** If true, merge loaded values into `process.env`. Defaults to false (pure read). */
  apply?: boolean;
  /** If true, don't override values already set in process.env (cli flags take precedence). */
  preserveExisting?: boolean;
}

export interface LoadedEnv {
  /** Final merged env after precedence resolution. */
  env: Record<string, string>;
  /** Which files were loaded, in order. */
  files: string[];
}

/**
 * Parse a single `.env` file. Returns object of KEY=value.
 * - Ignores blank lines and lines starting with `#`.
 * - Strips matching single or double quotes around the value.
 * - Does NOT do variable interpolation.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load env files using Vite-style precedence.
 *
 * Returns the final merged env + the list of files actually read. Pure by
 * default; pass `apply: true` to mutate `process.env`.
 */
export function loadEnv(opts: LoadEnvOptions = {}): LoadedEnv {
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? process.env.NODE_ENV ?? "development";

  const candidates = [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];

  const env: Record<string, string> = {};
  const files: string[] = [];

  for (const name of candidates) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = parseEnvFile(readFileSync(path, "utf8"));
      Object.assign(env, parsed);
      files.push(name);
    } catch {
      // Skip unreadable files silently.
    }
  }

  if (opts.apply) {
    for (const [k, v] of Object.entries(env)) {
      if (opts.preserveExisting && k in process.env) continue;
      process.env[k] = v;
    }
  }

  return { env, files };
}

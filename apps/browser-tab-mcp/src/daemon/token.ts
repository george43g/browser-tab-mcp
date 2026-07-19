/**
 * Extension auth token — generated on first daemon start, stored 0600 in
 * ~/.browser-tab/extension-token. The user pastes it once into each
 * extension's options page (`browser-tab daemon token` prints it).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokenPath } from "./paths.js";

export function ensureToken(): string {
  const path = tokenPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Constant-time comparison — never leak token bytes via timing. */
export function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

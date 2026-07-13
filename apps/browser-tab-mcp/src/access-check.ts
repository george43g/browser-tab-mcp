/**
 * Doctor / preflight checks.
 *
 * Generic shape lifted from imsg-mcp/src/access-check.ts: produce a list
 * of AccessCheckItems each tool-specific repo can extend. The base set
 * checks Node version, native module availability, and config-dir
 * readability.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "./meta.js";
import { hasNativeModule } from "./native-bridge.js";

export type CheckStatus = "ok" | "warn" | "error" | "info";

export interface AccessCheckItem {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface AccessReport {
  ok: boolean;
  items: AccessCheckItem[];
}

const REQUIRED_NODE_MAJOR = 24;

function checkNode(): AccessCheckItem {
  const match = /^v(\d+)/.exec(process.version);
  const major = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
  if (major >= REQUIRED_NODE_MAJOR) {
    return {
      key: "node",
      label: `Node ${process.version}`,
      status: "ok",
      detail: `>= ${REQUIRED_NODE_MAJOR} required`,
    };
  }
  return {
    key: "node",
    label: `Node ${process.version}`,
    status: "error",
    detail: `Need Node >= ${REQUIRED_NODE_MAJOR}. Install with: nvm install ${REQUIRED_NODE_MAJOR}`,
  };
}

function checkNative(): AccessCheckItem {
  if (hasNativeModule()) {
    return {
      key: "native",
      label: "Rust accelerator",
      status: "ok",
      detail: "loaded — using accelerated path",
    };
  }
  return {
    key: "native",
    label: "Rust accelerator",
    status: "info",
    detail:
      "not loaded — using TypeScript fallback. " +
      "Run `pnpm --filter @george43g/rust-accel build` to enable, or set MCP_DISABLE_NATIVE=1 to silence.",
  };
}

function checkConfigDir(): AccessCheckItem {
  // Generic check — tools may use ~/.{toolName}/ for credentials, logs, etc.
  const slug = APP_NAME.replace(/^@[^/]+\//, "").replace(/-mcp$/, "");
  const dir = join(homedir(), `.${slug}`);
  if (!existsSync(dir)) {
    return {
      key: "configDir",
      label: `Config dir ${dir}`,
      status: "info",
      detail: "does not exist (will be created on first secrets read).",
    };
  }
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      return {
        key: "configDir",
        label: `Config dir ${dir}`,
        status: "error",
        detail: "exists but is not a directory.",
      };
    }
    return {
      key: "configDir",
      label: `Config dir ${dir}`,
      status: "ok",
      detail: "readable.",
    };
  } catch (err) {
    return {
      key: "configDir",
      label: `Config dir ${dir}`,
      status: "error",
      detail: (err as Error).message,
    };
  }
}

export async function checkLocalAccess(): Promise<AccessReport> {
  const items = [checkNode(), checkNative(), checkConfigDir()];
  const ok = items.every((i) => i.status !== "error");
  return { ok, items };
}

export function formatAccessReport(report: AccessReport): string {
  const glyph: Record<CheckStatus, string> = {
    ok: "✓",
    warn: "⚠",
    error: "✗",
    info: "ℹ",
  };
  const lines = report.items.map((i) => `  ${glyph[i.status]}  ${i.label} — ${i.detail}`);
  lines.unshift(report.ok ? "Doctor: all clear." : "Doctor: issues found.");
  return lines.join("\n");
}

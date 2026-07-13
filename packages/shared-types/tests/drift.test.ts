/**
 * Drift-check: parse apps/rust-accel/src/types.rs and assert each
 * MIRRORED_SCHEMA's expected fields appear in the Rust struct.
 *
 * Conservative parser — uses regex, not a full Rust grammar. Fields are
 * matched by name (camelCase in TS, snake_case in Rust with `#[serde(rename
 * = "<camel>")]` OR matching identifier — we accept both). Order is
 * irrelevant; extras in Rust are allowed (e.g. internal-only fields), but
 * every TS-declared field MUST be present in Rust.
 *
 * Skip the test if the Rust file doesn't exist (running standalone tests
 * outside the full monorepo). CI runs the full workspace, so drift will
 * always be caught there.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIRRORED_SCHEMAS } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUST_TYPES_PATH = join(__dirname, "..", "..", "..", "apps", "rust-accel", "src", "types.rs");

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function extractStruct(rust: string, name: string): string | null {
  // Match `pub struct Name { ... }` or `pub struct Name {\n ... }` non-greedy.
  const re = new RegExp(`pub\\s+struct\\s+${name}\\s*\\{([^}]*)\\}`, "m");
  const match = re.exec(rust);
  return match?.[1] ?? null;
}

function structHasField(body: string, fieldCamel: string): boolean {
  const snake = camelToSnake(fieldCamel);
  // Match `pub camel:` or `pub snake:` or a serde rename to the camel form.
  const direct = new RegExp(`\\bpub\\s+(${fieldCamel}|${snake})\\s*:`, "m");
  if (direct.test(body)) return true;
  const renamed = new RegExp(
    `#\\[serde\\([^\\]]*rename\\s*=\\s*"${fieldCamel}"[^\\]]*\\)\\][\\s\\S]{0,80}?pub\\s+\\w+\\s*:`,
    "m",
  );
  return renamed.test(body);
}

describe("Rust ↔ Zod drift check", () => {
  it.skipIf(!existsSync(RUST_TYPES_PATH))(
    "every mirrored TS schema has a matching Rust struct with all declared fields",
    () => {
      const rust = readFileSync(RUST_TYPES_PATH, "utf8");
      for (const spec of MIRRORED_SCHEMAS) {
        const body = extractStruct(rust, spec.rustName);
        expect(body, `Rust struct ${spec.rustName} not found in types.rs`).not.toBeNull();
        if (!body) continue;
        for (const field of spec.fields) {
          expect(
            structHasField(body, field),
            `Rust struct ${spec.rustName} missing field "${field}" (or snake-cased / serde-renamed equivalent)`,
          ).toBe(true);
        }
      }
    },
  );
});

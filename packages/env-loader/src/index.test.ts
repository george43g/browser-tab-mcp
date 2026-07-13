import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, parseEnvFile } from "./index.js";

describe("parseEnvFile", () => {
  it("parses basic KEY=value lines", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores blank lines and comments", () => {
    expect(
      parseEnvFile(`
# top comment
FOO=bar

# mid
BAZ=qux
`),
    ).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matching quotes", () => {
    expect(parseEnvFile("NAME=\"George\"\nPATH='/usr/bin'")).toEqual({
      NAME: "George",
      PATH: "/usr/bin",
    });
  });

  it("preserves mismatched quotes", () => {
    expect(parseEnvFile(`MIX="trailing'`)).toEqual({ MIX: "\"trailing'" });
  });

  it("does not interpolate variables", () => {
    expect(parseEnvFile("FOO=$BAR\nBAZ=${ZED}")).toEqual({ FOO: "$BAR", BAZ: "${ZED}" });
  });

  it("skips malformed lines (no =)", () => {
    expect(parseEnvFile("not-an-assignment\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});

describe("loadEnv precedence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-loader-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty env when no files exist", () => {
    const { env, files } = loadEnv({ cwd: dir, mode: "test" });
    expect(env).toEqual({});
    expect(files).toEqual([]);
  });

  it("loads .env baseline", () => {
    writeFileSync(join(dir, ".env"), "FOO=base");
    const { env, files } = loadEnv({ cwd: dir, mode: "test" });
    expect(env).toEqual({ FOO: "base" });
    expect(files).toEqual([".env"]);
  });

  it("applies precedence: .env → .env.local → .env.[mode] → .env.[mode].local", () => {
    writeFileSync(join(dir, ".env"), "TIER=1\nA=env");
    writeFileSync(join(dir, ".env.local"), "TIER=2\nB=local");
    writeFileSync(join(dir, ".env.test"), "TIER=3\nC=mode");
    writeFileSync(join(dir, ".env.test.local"), "TIER=4\nD=mode-local");
    const { env, files } = loadEnv({ cwd: dir, mode: "test" });
    expect(env).toEqual({ TIER: "4", A: "env", B: "local", C: "mode", D: "mode-local" });
    expect(files).toEqual([".env", ".env.local", ".env.test", ".env.test.local"]);
  });

  it("apply=false does not mutate process.env", () => {
    writeFileSync(join(dir, ".env"), "ENVLOADER_TEST_KEY=should_not_leak");
    delete process.env.ENVLOADER_TEST_KEY;
    loadEnv({ cwd: dir, mode: "test" });
    expect(process.env.ENVLOADER_TEST_KEY).toBeUndefined();
  });

  it("apply=true mutates process.env", () => {
    writeFileSync(join(dir, ".env"), "ENVLOADER_TEST_KEY=applied");
    delete process.env.ENVLOADER_TEST_KEY;
    loadEnv({ cwd: dir, mode: "test", apply: true });
    expect(process.env.ENVLOADER_TEST_KEY).toBe("applied");
    delete process.env.ENVLOADER_TEST_KEY;
  });

  it("preserveExisting=true respects existing process.env values", () => {
    writeFileSync(join(dir, ".env"), "ENVLOADER_TEST_KEY=from_file");
    process.env.ENVLOADER_TEST_KEY = "from_shell";
    loadEnv({ cwd: dir, mode: "test", apply: true, preserveExisting: true });
    expect(process.env.ENVLOADER_TEST_KEY).toBe("from_shell");
    delete process.env.ENVLOADER_TEST_KEY;
  });
});

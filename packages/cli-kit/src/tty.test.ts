import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { colorEnabled, isCI } from "./tty.js";

const ENV_KEYS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "NO_COLOR",
  "FORCE_COLOR",
];

let original: Record<string, string | undefined>;

beforeEach(() => {
  original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("isCI", () => {
  it("returns false when no CI env var set", () => {
    expect(isCI()).toBe(false);
  });

  it.each([
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "TRAVIS",
    "BUILDKITE",
  ])("returns true when %s set", (key) => {
    process.env[key] = "true";
    expect(isCI()).toBe(true);
  });
});

describe("colorEnabled", () => {
  it("respects NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    expect(colorEnabled()).toBe(false);
  });

  it("respects FORCE_COLOR over TTY", () => {
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(true);
  });

  it("NO_COLOR wins when both set", () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(false);
  });
});

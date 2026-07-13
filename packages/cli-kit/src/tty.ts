/**
 * TTY / environment detection helpers.
 *
 * Used by CLI output helpers to switch between human-readable (tables,
 * colors) and machine-readable (JSON) output. Detect CI explicitly because
 * many CI systems set TERM=dumb but still want colors.
 */

export function isStdoutTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function isStderrTTY(): boolean {
  return Boolean(process.stderr.isTTY);
}

export function isStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

export function isInteractive(): boolean {
  return isStdoutTTY() && isStdinTTY();
}

export function isCI(): boolean {
  // Standard CI env vars set by GitHub Actions, GitLab, CircleCI, Travis, etc.
  return Boolean(
    process.env.CI ||
      process.env.CONTINUOUS_INTEGRATION ||
      process.env.GITHUB_ACTIONS ||
      process.env.GITLAB_CI ||
      process.env.CIRCLECI ||
      process.env.TRAVIS ||
      process.env.BUILDKITE,
  );
}

/** Respect NO_COLOR (https://no-color.org) and FORCE_COLOR conventions. */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return isStdoutTTY();
}

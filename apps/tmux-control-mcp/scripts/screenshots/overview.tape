# VHS tape — `tmux-control` CLI overview.
#
# Produces docs/screenshots/overview.gif, which the README embeds. GIFs are the
# committed artifact; `docs/screenshots/*.png` is gitignored, so do not add a
# `Screenshot` line expecting CI to keep the result.
#
# RUN IT FROM THIS DIRECTORY. vhs resolves `Output` and `Screenshot` paths
# against the process working directory, NOT the tape's location, so the
# `../../../../` prefixes below are only correct when cwd is this folder:
#
#     cd apps/tmux-control-mcp/scripts/screenshots && vhs overview.tape
#
# `pnpm screenshots` and .github/workflows/screenshots.yml both do that for
# you. Running `vhs apps/.../overview.tape` from the repo root instead writes
# four levels ABOVE the root — and vhs still exits 0, so nothing tells you.

Set FontSize 14
Set Width 1200
Set Height 800
Set TypingSpeed 50ms

Output ../../../../docs/screenshots/tmux-control-overview.gif

# Hidden setup, kept out of the captured frames.
#
# The bin is not on PATH: pnpm does not link workspace package bins into
# node_modules/.bin, so `tmux-control` resolves to nothing in a bare shell.
# A shell function shadows it with the built entrypoint, which keeps the
# visible commands honest (`tmux-control health`, exactly what a user types)
# without depending on a global install.
#
# HOME is redirected so captures do not vary with whatever config happens to
# exist on the machine running them.
Hide
Type 'export HOME="$(mktemp -d)"'
Enter
Type 'tmux-control() { node ../../dist/cli.js "$@"; }'
Enter
Type "clear"
Enter
Show

# Every command asserts on a string from its OUTPUT, never one echoed in the
# command line itself. `Wait+Screen` is what makes a tape fail: vhs exits 0
# on a command that does not exist, so without these the capture would be a
# screenshot of `command not found` and CI would stay green.
Type "tmux-control health"
Enter
Wait+Screen@15s /uptimeS/
Sleep 1s

Type "tmux-control noop --input 'Hello from the starter template'"
Enter
Wait+Screen@15s /durationMicros/
Sleep 1s

Type "tmux-control --help"
Enter
Wait+Screen@15s /display help for command/
Sleep 1s

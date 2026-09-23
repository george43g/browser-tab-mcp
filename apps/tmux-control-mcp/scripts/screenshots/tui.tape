# VHS tape — the Ink TUI.
#
# Produces docs/screenshots/tui.gif, which the README embeds. GIFs are the
# committed artifact; `docs/screenshots/*.png` is gitignored.
#
# RUN IT FROM THIS DIRECTORY — see the note in overview.tape; vhs resolves
# output paths against the process working directory, not the tape's.
#
# This tape exists to keep the CI-detection path covered. The CLI tapes never
# launch the TUI, so nothing else in this repo exercises ink's renderer.

Set FontSize 14
Set Width 1200
Set Height 800
Set TypingSpeed 50ms

Output ../../../../docs/screenshots/tui.gif

Hide
Type 'export HOME="$(mktemp -d)"'
Enter
Type "clear"
Enter
Show

# CI=false AND CONTINUOUS_INTEGRATION=false are both load-bearing.
#
# ink refuses to mount an interactive tree when `is-in-ci` reports true, and
# every CI runner sets CI=1. The module is three lines:
#
#   const check = key => key in env && env[key] !== '0' && env[key] !== 'false';
#   const isInCi = check('CI') || check('CONTINUOUS_INTEGRATION');
#
# so CI=false alone is enough today — unless something also sets
# CONTINUOUS_INTEGRATION, which some runners do. Both cost nothing and this
# tracks whichever version of is-in-ci ink happens to resolve.
#
# Setting them per-command rather than in the workflow is deliberate: the tape
# stays correct when run by hand on a developer machine that has CI exported,
# and `CI=true vhs tui.tape` is the regression test for exactly this.
Type "CI=false CONTINUOUS_INTEGRATION=false node ../../dist/cli.js tui"
Enter

# Without this Wait the CI trap is invisible: ink renders nothing, vhs still
# exits 0, and the committed screenshot is a blank terminal. The Wait turns a
# blank render into a non-zero exit.
Wait+Screen@30s /Item 1/
Sleep 2s

# Leave the TUI so the recording ends on a clean shell rather than a killed pty.
Type "q"
Sleep 500ms

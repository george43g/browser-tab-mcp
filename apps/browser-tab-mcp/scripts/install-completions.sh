#!/usr/bin/env bash
# Install shell completions for the browser-tab CLI.
#
# Detects $SHELL, regenerates the matching completion via usage(1) if
# missing, and copies it into the well-known location for that shell.
# Idempotent — safe to re-run after updating .usage.kdl.
#
# Requires: usage(1) installed (mise install).

set -euo pipefail

# Resolve repo-relative paths regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
USAGE_KDL="$APP_DIR/.usage.kdl"
COMPLETIONS_DIR="$APP_DIR/completions"
BIN_NAME="browser-tab"

if [[ ! -f "$USAGE_KDL" ]]; then
  echo "✗ Expected $USAGE_KDL — bail." >&2
  exit 1
fi

if ! command -v usage >/dev/null 2>&1; then
  echo "✗ usage(1) not on PATH. Install via 'mise install' or 'cargo install usage-cli'." >&2
  exit 1
fi

# Detect target shell. SHELL is the user's login shell, not necessarily
# the current shell — that's what we want for "where will completions
# live next time you open a terminal".
USER_SHELL="$(basename "${SHELL:-bash}")"

regen() {
  local shell="$1" out="$2"
  mkdir -p "$COMPLETIONS_DIR"
  usage g completion "$shell" "$BIN_NAME" -f "$USAGE_KDL" > "$out"
}

install_bash() {
  local src="$COMPLETIONS_DIR/$BIN_NAME.bash"
  regen bash "$src"
  local dest
  if [[ -d "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions" ]]; then
    dest="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/$BIN_NAME"
  elif [[ -d "/usr/local/etc/bash_completion.d" ]]; then
    dest="/usr/local/etc/bash_completion.d/$BIN_NAME"
  elif [[ -d "/etc/bash_completion.d" ]]; then
    dest="/etc/bash_completion.d/$BIN_NAME"
  else
    mkdir -p "$HOME/.bash_completion.d"
    dest="$HOME/.bash_completion.d/$BIN_NAME"
    echo "✓ Created $HOME/.bash_completion.d/ — add 'for f in ~/.bash_completion.d/*; do . \"\$f\"; done' to your .bashrc"
  fi
  cp -f "$src" "$dest"
  echo "✓ bash completion installed → $dest"
}

install_zsh() {
  local src="$COMPLETIONS_DIR/_$BIN_NAME"
  regen zsh "$src"
  local dest
  if [[ -n "${ZDOTDIR:-}" && -d "$ZDOTDIR/completion" ]]; then
    dest="$ZDOTDIR/completion/_$BIN_NAME"
  elif [[ -d "$HOME/.zsh/completion" ]]; then
    dest="$HOME/.zsh/completion/_$BIN_NAME"
  else
    mkdir -p "$HOME/.zsh/completion"
    dest="$HOME/.zsh/completion/_$BIN_NAME"
    echo "✓ Created ~/.zsh/completion/ — add 'fpath=(~/.zsh/completion \$fpath); autoload -U compinit; compinit' to your .zshrc"
  fi
  cp -f "$src" "$dest"
  echo "✓ zsh completion installed → $dest"
}

install_fish() {
  local src="$COMPLETIONS_DIR/$BIN_NAME.fish"
  regen fish "$src"
  local dest_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"
  mkdir -p "$dest_dir"
  local dest="$dest_dir/$BIN_NAME.fish"
  cp -f "$src" "$dest"
  echo "✓ fish completion installed → $dest"
}

case "$USER_SHELL" in
  bash) install_bash ;;
  zsh)  install_zsh ;;
  fish) install_fish ;;
  *)
    echo "⚠ Unrecognized shell '$USER_SHELL'. Generating all three; install manually:" >&2
    install_bash
    install_zsh
    install_fish
    ;;
esac

echo ""
echo "Restart your shell or 'source' the relevant rc file to activate."

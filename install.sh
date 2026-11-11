#!/bin/sh
# freebuff supervisor — one-command installer
#
# From the folder you downloaded:
#
#     sh install.sh
#
# Or with nothing downloaded at all:
#
#     curl -fsSL https://raw.githubusercontent.com/Axagt40/Freebuff-Supervisor/main/install.sh | sh
#
# One run does the whole setup: pulls the latest release when there is no
# package next to it, checks Node, installs the optional dependency, puts
# `sfreebuff` on PATH (and keeps it there in your shell's startup file),
# installs freebuff itself when it is missing, and signs in one account.
#
# Flags:
#   --no-login    stop before the browser sign-in
#   --yes / -y    answer yes to every prompt (also FREEBUFFS_YES=1)
#
# Environment:
#   FREEBUFFS_HOME   where supervisor data lives (default ~/.freebuffs)

set -e

REPO="Axagt40/Freebuff-Supervisor"
RELEASE_API="https://api.github.com/repos/$REPO/releases/latest"
BIN_DIR="$HOME/.local/bin"
# Where a downloaded copy is kept, so the command keeps working without the repo.
PKG_DIR=${FREEBUFFS_PKG_DIR:-$HOME/.local/share/freebuff-supervisor}

ASSUME_YES=0
LOGIN=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-login) LOGIN=0 ;;
  esac
done
[ "${FREEBUFFS_YES:-}" = "1" ] && ASSUME_YES=1

say () { printf '%s\n' "$*"; }
warn () { printf 'warning: %s\n' "$*" >&2; }
fail () { printf 'error: %s\n' "$*" >&2; exit 1; }

# A terminal to ask on. Piped from `curl | sh`, stdin is the script itself, so
# prompts and sign-in have to come from /dev/tty instead.
tty_input () {
  if [ -t 0 ]; then
    printf ''
  elif ( : < /dev/tty ) 2>/dev/null; then
    printf '/dev/tty'
  else
    return 1
  fi
}

# Yes by default, but only when someone is there to answer.
confirm () {
  [ "$ASSUME_YES" = "1" ] && return 0
  src=$(tty_input) || return 1
  printf '%s [Y/n] ' "$1"
  if [ -n "$src" ]; then
    read -r answer < "$src" || return 1
  else
    read -r answer || return 1
  fi
  case "$answer" in
    ''|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Node -------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed. Get Node 18 or newer from https://nodejs.org and run this again."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "node $(node -v) is too old; this needs 18 or newer."
fi
say "node $(node -v) ok"

# --- Fetching a release -----------------------------------------------------
fetch () { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    return 1
  fi
}

fetch_stdout () { # url
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    return 1
  fi
}

# Prints the folder holding the freshly unpacked package.
download_release () {
  url=$(fetch_stdout "$RELEASE_API" 2>/dev/null |
    grep -o '"browser_download_url"[^,}]*\.tgz"' |
    head -n 1 |
    sed 's/.*"\([^"]*\)"$/\1/') || return 1
  [ -n "$url" ] || return 1

  say "downloading $url" >&2
  # Unpack beside the current copy and swap only once it is whole, so a failed
  # upgrade never removes a working install.
  tmp="$PKG_DIR.new"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  if ! fetch "$url" "$tmp/release.tgz" >&2; then
    rm -rf "$tmp"
    return 1
  fi
  if ! tar -xzf "$tmp/release.tgz" -C "$tmp" >&2; then
    rm -rf "$tmp"
    return 1
  fi
  rm -f "$tmp/release.tgz"
  if [ ! -f "$tmp/package/bin/sfreebuff.js" ]; then
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$PKG_DIR.old"
  if [ -d "$PKG_DIR" ]; then
    mv "$PKG_DIR" "$PKG_DIR.old"
  fi
  mv "$tmp" "$PKG_DIR"
  rm -rf "$PKG_DIR.old"
  printf '%s\n' "$PKG_DIR/package"
}

# --- Where the program comes from -------------------------------------------
# Running from an unpacked folder uses that copy; running piped from GitHub has
# no files beside it, so the latest release is downloaded instead.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || DIR=""
if [ -n "$DIR" ] && [ -f "$DIR/bin/sfreebuff.js" ] && [ -f "$DIR/src/cli.js" ]; then
  SRC=$DIR
  say "installing from $SRC"
else
  SRC=$(download_release) || fail "could not download the latest release. Get the .tgz from https://github.com/$REPO/releases and run 'sh install.sh' inside the unpacked folder."
  say "installing from $SRC"
fi

chmod +x "$SRC/bin/sfreebuff.js" 2>/dev/null || true

# --- Optional dependency ----------------------------------------------------
# node-pty powers `--pty` (auto-answering dialogs). It is optional: if it cannot
# be built here, everything else still installs and runs.
if command -v npm >/dev/null 2>&1; then
  say "installing dependencies (optional; needed for --pty)"
  if ! (cd "$SRC" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1); then
    warn "dependencies did not install — everything works except --pty"
  fi
else
  warn "npm not found — everything works except --pty"
fi

# npm 12 and newer block dependency install scripts by default, so node-pty's
# native module can be missing even after a successful `npm install`. Build it
# here when a compiler is available; without it everything still works, minus
# --pty (dialog auto-answering and typing a task into a restarted session).
if [ -d "$SRC/node_modules/node-pty" ] &&
   ! (cd "$SRC" && node -e "require('node-pty')" >/dev/null 2>&1); then
  say "building node-pty for node $(node -v)"
  if command -v node-gyp >/dev/null 2>&1 &&
     (cd "$SRC/node_modules/node-pty" && node-gyp rebuild --release >/dev/null 2>&1); then
    say "node-pty built"
  else
    warn "node-pty did not build — everything works except --pty"
  fi
fi

# --- Put the command on PATH ------------------------------------------------
say "installing the sfreebuff command"
node "$SRC/bin/sfreebuff.js" install

# `install` only links the launcher; a new terminal also needs ~/.local/bin on
# PATH, so record that once in whichever startup file this shell reads.
add_to_path_file () {
  case "${SHELL:-}" in
    *zsh) rc="$HOME/.zshrc" ;;
    *bash) rc="$HOME/.bashrc"; [ -f "$rc" ] || rc="$HOME/.profile" ;;
    *) rc="$HOME/.profile" ;;
  esac
  mkdir -p "$(dirname "$rc")"
  if [ -f "$rc" ] && grep -q 'freebuffs PATH' "$rc" 2>/dev/null; then
    return 0
  fi
  {
    printf '\n# freebuffs PATH\n'
    printf 'case ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' \
      "$BIN_DIR" "$BIN_DIR"
  } >> "$rc"
  say "  added $BIN_DIR to PATH in $rc — open a new terminal to pick it up"
}

case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) add_to_path_file ;;
esac

# --- freebuff itself --------------------------------------------------------
# The supervisor launches freebuff's binary; it does not bundle it.
FREEBUFF_BIN="${FREEBUFFS_DEFAULT_CONFIG_DIR:-$HOME/.config/manicode}/freebuff"
if [ -x "$FREEBUFF_BIN" ] || command -v freebuff >/dev/null 2>&1; then
  say "freebuff ok"
else
  say "freebuff is not installed yet — the supervisor launches it, it does not bundle it"
  if command -v npm >/dev/null 2>&1 && confirm "install freebuff now with npm install -g freebuff?"; then
    if npm install -g freebuff --no-audit --no-fund --loglevel=error >/dev/null 2>&1; then
      say "freebuff installed; fetching its binary (~137 MB, once)"
      freebuff --version >/dev/null 2>&1 ||
        warn "run 'freebuff --version' once to finish the download"
    else
      warn "npm install -g freebuff failed — run it yourself, then 'freebuff --version' once"
    fi
  else
    say "  install it later with:  npm install -g freebuff && freebuff --version"
  fi
fi

# --- Sign in ----------------------------------------------------------------
sign_in () {
  node "$SRC/bin/sfreebuff.js" setup --accounts 1
}

if [ "$LOGIN" = "1" ]; then
  say "signing in an account (freebuff's own browser sign-in)"
  if [ -t 0 ]; then
    sign_in || warn "sign-in did not finish — run 'sfreebuff login' when you are ready"
  elif src=$(tty_input); then
    sign_in < "$src" || warn "sign-in did not finish — run 'sfreebuff login' when you are ready"
  else
    say "  no terminal to sign in from — run 'sfreebuff login' when you are ready"
  fi
fi

# --- Done -------------------------------------------------------------------
say ""
say "Setup complete."
say ""
say "  sfreebuff            open the dashboard"
say "  sfreebuff run        keep a session alive in this folder"
say "  sfreebuff status     accounts, credits, live sessions"
say "  sfreebuff doctor     check that everything is healthy"
say ""
say "Discord reports:  sfreebuff notify <webhook-url>"

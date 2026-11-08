#!/bin/sh
# freebuff supervisor — installer
#
# Run this from the folder you downloaded:
#
#     sh install.sh
#
# It checks for Node, installs the one optional dependency, and puts the
# `sfreebuff` command on your PATH. Nothing is started and no account is signed
# in until you ask for it.

set -e

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

say () { printf '%s\n' "$*"; }
fail () { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Node -------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed. Get Node 18 or newer from https://nodejs.org and run this again."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "node $(node -v) is too old; this needs 18 or newer."
fi
say "node $(node -v) ok"

# --- Files ------------------------------------------------------------------
[ -f "$DIR/bin/sfreebuff.js" ] || fail "bin/sfreebuff.js is missing — run this from the folder you downloaded."
[ -f "$DIR/src/cli.js" ] || fail "src/ is missing — run this from the folder you downloaded."
chmod +x "$DIR/bin/sfreebuff.js" 2>/dev/null || true

# --- Optional dependency ----------------------------------------------------
# node-pty powers `--pty` (auto-answering dialogs). It is optional: if it cannot
# be built here, everything else still installs and runs.
if command -v npm >/dev/null 2>&1; then
  say "installing dependencies (optional; needed for --pty)"
  if ! (cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1); then
    say "warning: dependencies did not install — everything works except --pty"
  fi
else
  say "warning: npm not found — everything works except --pty"
fi

# npm 12 and newer block dependency install scripts by default, so node-pty's
# native module can be missing even after a successful `npm install`. Build it
# here when a compiler is available; without it everything still works, minus
# --pty (dialog auto-answering and typing a task into a restarted session).
if [ -d "$DIR/node_modules/node-pty" ] &&
   ! (cd "$DIR" && node -e "require('node-pty')" >/dev/null 2>&1); then
  say "building node-pty for node $(node -v)"
  if command -v node-gyp >/dev/null 2>&1 &&
     (cd "$DIR/node_modules/node-pty" && node-gyp rebuild --release >/dev/null 2>&1); then
    say "node-pty built"
  else
    say "warning: node-pty did not build — everything works except --pty"
  fi
fi

# --- Put the command on PATH ------------------------------------------------
say "installing the sfreebuff command"
node "$DIR/bin/sfreebuff.js" install

# --- Done -------------------------------------------------------------------
say ""
say "Installed. Next:"
say ""
say "  1. sign in an account      sfreebuff login"
say "  2. open the dashboard      sfreebuff"
say "  3. start a session here    sfreebuff run"
say "  4. check on it any time    sfreebuff status"
say ""
say "To add a Discord channel for reports:  sfreebuff notify <webhook-url>"

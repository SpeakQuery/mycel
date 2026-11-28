#!/bin/sh
# Mycel installer for macOS and Linux.
#   curl -fsSL https://mycel.speakquery.ai/install.sh | sh
#
# What it does, without sudo and without touching system folders:
#   1. Uses your Node.js 20+ if you have one; otherwise downloads the official Node.js 22 build from nodejs.org,
#      checks its SHA-256 against nodejs.org's SHASUMS256.txt and unpacks it into ~/.mycel/node.
#   2. Installs @speakquery/mycel into ~/.mycel/app (a private copy, so apps never depend on a temporary npx cache).
#   3. Starts the setup wizard. It shows what it will change and asks before doing anything; `mycel undo` reverts.
# Remove everything later with: rm -rf ~/.mycel   (after `mycel undo` if you want your old app settings back)
set -eu

# True when a keyboard is attached (also when this script is piped from curl in a terminal).
has_tty() { (exec </dev/tty) 2>/dev/null; }

MYCEL_DIR="${MYCEL_HOME:-$HOME/.mycel}"
NODE_DIR="$MYCEL_DIR/node"
APP_DIR="$MYCEL_DIR/app"

say() { printf '  %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

printf '\n  Mycel installer\n\n'

node_ok() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

NODE=""
PACKAGE="${MYCEL_PACKAGE:-@speakquery/mycel@latest}"
if [ "${MYCEL_FORCE_NODE_DOWNLOAD:-}" != "1" ] && command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
  say "✓ Node.js $("$NODE" -v) found"
elif [ "${MYCEL_FORCE_NODE_DOWNLOAD:-}" != "1" ] && [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  NODE="$NODE_DIR/bin/node"
  say "✓ Node.js $("$NODE" -v) found in $NODE_DIR"
else
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) fail "unsupported system $(uname -s); install Node.js 20+ from https://nodejs.org and run: npx -y @speakquery/mycel setup" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) ARCH=arm64 ;;
    x86_64 | amd64) ARCH=x64 ;;
    *) fail "unsupported CPU $(uname -m); install Node.js 20+ from https://nodejs.org and run: npx -y @speakquery/mycel setup" ;;
  esac
  command -v curl >/dev/null 2>&1 || fail "curl is needed to download Node.js"
  say "Node.js 20+ was not found. Downloading the official Node.js 22 for $OS-$ARCH (about 30 MB)…"
  BASE="https://nodejs.org/dist/latest-v22.x"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || fail "could not reach nodejs.org"
  FILE="$(grep -o "node-v[0-9.]*-$OS-$ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n 1)"
  [ -n "$FILE" ] || fail "no Node.js build for $OS-$ARCH"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE" || fail "download failed"
  WANT="$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | cut -d ' ' -f 1)"
  if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$TMP/$FILE" | cut -d ' ' -f 1)"; else GOT="$(sha256sum "$TMP/$FILE" | cut -d ' ' -f 1)"; fi
  [ "$WANT" = "$GOT" ] || fail "checksum mismatch for $FILE; nothing was installed"
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$FILE" -C "$NODE_DIR" --strip-components 1
  NODE="$NODE_DIR/bin/node"
  say "✓ Node.js $("$NODE" -v) installed in $NODE_DIR (checksum verified)"
fi

NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || fail "npm was not found next to Node.js"
say "Installing Mycel into $APP_DIR…"
mkdir -p "$APP_DIR"
PATH="$(dirname "$NODE"):$PATH" "$NPM" install --prefix "$APP_DIR" --no-fund --no-audit --loglevel=error "$PACKAGE" >/dev/null || fail "npm install failed"
CLI="$APP_DIR/node_modules/@speakquery/mycel/dist/cli.js"
[ -f "$CLI" ] || fail "Mycel was not installed correctly"
say "✓ Mycel $("$NODE" "$CLI" --version) installed"

# A `mycel` command for later (mycel stats, mycel undo, mycel doctor) that works even without Node on PATH.
BIN_DIR="$MYCEL_DIR/bin"
mkdir -p "$BIN_DIR"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$CLI" >"$BIN_DIR/mycel"
chmod 755 "$BIN_DIR/mycel"
if ! command -v mycel >/dev/null 2>&1; then
  case "${SHELL:-}" in
    */zsh) RC="$HOME/.zshrc" ;;
    */bash) if [ "$(uname -s)" = Darwin ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
    *) RC="$HOME/.profile" ;;
  esac
  LINE="export PATH=\"$BIN_DIR:\$PATH\""
  if ! grep -qsF "$BIN_DIR" "$RC"; then
    ANSWER=y
    if has_tty; then
      printf '  Add the mycel command to your terminal (one line in %s)? [Y/n] ' "$RC"
      read -r ANSWER </dev/tty || ANSWER=y
    fi
    case "$ANSWER" in
      n | N | no | NO | hayir | hayır) say "OK. You can always run: $BIN_DIR/mycel" ;;
      *) printf '\n# Mycel\n%s\n' "$LINE" >>"$RC" && say "✓ mycel command added (new terminal windows will have it)" ;;
    esac
  fi
fi

# The wizard needs a keyboard; when piped from curl, read answers from the terminal.
if has_tty; then
  MYCEL_ENTRY_ABSOLUTE=1 "$NODE" "$CLI" setup "$@" </dev/tty
else
  MYCEL_ENTRY_ABSOLUTE=1 "$NODE" "$CLI" setup "$@"
fi

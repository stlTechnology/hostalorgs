#!/usr/bin/env bash
# QWTF :: Emscripten SDK installer
#
# Installs the official emsdk into $HOME/.emsdk (or $EMSDK) and prints the
# line you need to source. Safe to re-run: if a working emcc is already on
# PATH the script exits successfully without downloading anything.
set -euo pipefail

EMSDK_ROOT="${EMSDK:-$HOME/.emsdk}"

log() { printf '\033[36m[emsdk]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[emsdk]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[emsdk]\033[0m %s\n' "$*" >&2; }

if command -v emcc >/dev/null 2>&1 && emcc --version >/dev/null 2>&1; then
  ok "emcc already available: $(command -v emcc)"
  emcc --version | head -1
  exit 0
fi

for dep in git curl tar xz python3; do
  command -v "$dep" >/dev/null 2>&1 || { err "missing prerequisite: $dep"; exit 1; }
done

if [ ! -d "$EMSDK_ROOT/emsdk" ]; then
  log "cloning emsdk -> $EMSDK_ROOT"
  rm -rf "$EMSDK_ROOT"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_ROOT"
else
  log "reusing existing clone at $EMSDK_ROOT"
fi

log "downloading + unpacking latest wasm toolchain (~1.5 GiB)..."
( cd "$EMSDK_ROOT" && ./emsdk install latest && ./emsdk activate latest )

# shellcheck disable=SC1090
set +u; source "$EMSDK_ROOT/emsdk_env.sh" >/dev/null 2>&1; set -u

if ! command -v emcc >/dev/null 2>&1; then
  err "activation failed -- add to ~/.bash_profile:"
  err "  echo 'source \"$EMSDK_ROOT/emsdk_env.sh\" >> \$HOME/.bash_profile"
  exit 1
fi

ok "installed: $(emcc --version | head -1)"
echo
echo "Add this to your shell profile to make emcc persistent:"
echo "  echo 'source \"$EMSDK_ROOT/emsdk_env.sh\" >> \$HOME/.bash_profile\""

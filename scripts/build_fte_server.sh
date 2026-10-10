#!/usr/bin/env bash
# Build the FTEQW dedicated server (native, not emscripten) into build/.
#
# The web client is built with Emscripten (scripts/build_fte_web.sh); the
# dedicated server has to be a normal Linux binary, so this uses the host
# compiler rather than emcc.  FTE's Makefile picks the compiler from FTE_TARGET:
# with FTE_TARGET unset it uses gcc/clang and links a plain executable.
#
# Output: build/fteqw-sv (FTE's own name for the target is fte-<target>-sv).
# M2 runs it with web/id1 as the gamedir, which supplies qwprogs.dat,
# models.pak and the compiled map.
#
# NOTE: we deliberately do NOT use `make sv-rel` alone. That target depends on
# reldir, which was populated by the emscripten build with .o files compiled for
# wasm32; make would consider them up to date and try to link wasm objects into
# a native binary. Build into a separate object directory instead.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FTE="$ROOT/third_party/fteqw"
OUT="$ROOT/build"
JOBS="$(nproc)"

[ -d "$FTE" ] || { echo "FATAL: $FTE missing. Run scripts/fetch_third_party.sh" >&2; exit 1; }
command -v make >/dev/null 2>&1 || { echo "FATAL: make not found" >&2; exit 1; }
command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1 \
  || { echo "FATAL: no gcc or clang" >&2; exit 1; }

echo "cc:    $(command -v gcc || command -v clang)"
echo "jobs:  $JOBS"

mkdir -p "$OUT"

# The emscripten run left EMSCRIPTEN/CC overrides out of the environment here;
# make sure we are not inheriting an emcc-based CC.
unset EMSDK EMSCRIPTENPATH EMSCRIPTENROOT 2>/dev/null || true

cd "$FTE/engine"
# OBJDIR keeps the native objects away from the wasm ones in reldir.
make sv-rel -j"$JOBS" OBJDIR="$OUT/obj"

SV=""
for cand in "$FTE/engine/release/fteqw-sv" "$FTE/engine/release/fte-linux-sv" \
            "$FTE/engine/release/fte-sv"; do
  [ -f "$cand" ] && { SV="$cand"; break; }
done
if [ -z "$SV" ]; then
  # Last resort: anything in release/ that looks like a native server binary
  # and is not the web client.
  SV="$(find "$FTE/engine/release" -maxdepth 1 -type f -name '*sv*' \
          ! -name '*.db' ! -name '*.js' ! -name '*.html' 2>/dev/null | head -1 || true)"
fi
[ -n "$SV" ] && [ -f "$SV" ] || {
  echo "FATAL: no dedicated server binary produced" >&2
  ls -la "$FTE/engine/release" >&2
  exit 1
}

cp "$SV" "$OUT/fteqw-sv"
chmod +x "$OUT/fteqw-sv"

echo
echo "built -> $OUT/fteqw-sv"
"$OUT/fteqw-sv" --version 2>&1 | head -3 || true
echo
echo "Next: run it with -basedir web/id1, e.g."
echo "  build/fteqw-sv -basedir \$PWD/web/id1 +set dedicated 1 +map corridor"
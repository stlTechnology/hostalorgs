#!/usr/bin/env bash
# Build the FTEQW web client (Emscripten) into web/.
#
# Output: web/ftewebgl.{html,js,wasm} plus .gz of each.
#
# Two things this script does that a plain `make web-rel` does not, both because
# the upstream target fails silently:
#
#   1. It calls `gl-rel`, not `web-rel`. web-rel's last three lines are
#      `gzip -kf` on its own output, and `gzip -kf X` rewrites X as it
#      compresses: the .js and .wasm came out truncated (5808793 -> 9225 bytes)
#      with exit status 0. We compress afterwards ourselves, keeping the
#      originals, and then verify with `zcat X.gz | cmp - X`.
#
#   2. It passes the link flags FTE's web glue needs but does not request, and
#      then asserts the symbols are actually in the output.
#
# See the comment on WEB_EXTRA_LDFLAGS below for the flags and why each is
# needed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FTE="$ROOT/third_party/fteqw"
OUT="$ROOT/web"
REL="$FTE/engine/release"

[ -d "$FTE" ] || { echo "FATAL: $FTE missing. Run scripts/fetch_third_party.sh" >&2; exit 1; }

# emsdk provides emcc. FTE's Makefile expects EMSCRIPTENPATH/EMCC on PATH.
if ! command -v emcc >/dev/null 2>&1; then
  if [ -f "$HOME/.emsdk/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.emsdk/emsdk_env.sh" >/dev/null 2>&1
  fi
fi
command -v emcc >/dev/null 2>&1 || {
  echo "FATAL: emcc not found. Install emsdk (expected at ~/.emsdk)." >&2; exit 1; }
command -v make >/dev/null 2>&1 || { echo "FATAL: make not found" >&2; exit 1; }

echo "emcc:  $(command -v emcc)"
echo "jobs:  $(nproc)"

# ---------------------------------------------------------------------------
# Link flags.
#
# FTE's Makefile never assigns LDFLAGS and gl-tmp forwards it onto the link
# line, so this is the supported way in without patching the vendored tree.
# Fallback, if a future emscripten removes more of FTE's glue surface: install
# the version FTE's CI uses (emsdk 2.0.12, .github/workflows/main.yml) SIDE BY
# SIDE, e.g. ~/emsdk-2.0.12, rather than over ~/.emsdk.
#
# addRunDependency / removeRunDependency
#   Emscripten >= 3.1.58 only emits these when something asks, and --pre-js
#   code does NOT count as asking. engine/web/prejs.js calls them in its
#   Module['files'] loaders. Without the flag they are called but undefined and
#   every file fetch throws ReferenceError at startup.
#
# _main / _malloc / _free
#   FTE's clipboard code and the Emscripten OpenAL shim call _malloc and _free
#   ("_free is not defined" at AudioContext.successcb once a sound actually
#   decodes). EXPORTED_RUNTIME_METHODS does not accept them ("undefined exported
#   symbol: malloc"), so they go in EXPORTED_FUNCTIONS.
#
#   _main must be listed explicitly, and that is the subtle part. FTE's Makefile
#   sets no EXPORTED_FUNCTIONS at all, so emcc's default applies -- and that
#   default is exactly [_main], the program entry point. Passing
#   -sEXPORTED_FUNCTIONS REPLACES the list rather than extending it, so omitting
#   _main removed the only root that kept the engine alive and the linker
#   dead-stripped nearly everything: a 5808793-byte wasm came out at 9225 bytes
#   with exit status 0. Keep _main in this list.
# ---------------------------------------------------------------------------
WEB_EXTRA_LDFLAGS="-sEXPORTED_RUNTIME_METHODS=addRunDependency,removeRunDependency \
                  -sEXPORTED_FUNCTIONS=_main,_malloc,_free"

# ---------------------------------------------------------------------------
# -Oz for size (0480c, owner decision via reviewer 0480): the web target's link
# flags are FTE's RELEASE_LDFLAGS="-O3 ...", and the <= 8 MB wire row wants the
# size-optimal link instead. Passing -Oz through our LDFLAGS does NOT do it:
# gl-tmp expands LDFLAGS="$(GL_LDFLAGS) $(LDFLAGS) $(CLIENTLDDEPS)" and the
# release rule orders "BASELDFLAGS $(LDFLAGS) $(RELEASE_LDFLAGS)" -- emcc takes
# the LAST -O it is given, so the -O3 at the end would win and the -Oz would be
# silent. The vendored tree is re-fetched at a pinned commit, so the one-line
# change is applied here, idempotently, before every build -- and asserted,
# because a silent no-op would produce a wasm that is only ordinary.
sed -i 's/^\(\tRELEASE_LDFLAGS=\)-O3\t/\1-Oz\t/' "$FTE/engine/Makefile"
grep -q $'^\tRELEASE_LDFLAGS=-Oz\t' "$FTE/engine/Makefile" || {
  echo "FATAL: the -Oz change to the vendored Makefile did not apply" >&2
  echo "       (expected one '\tRELEASE_LDFLAGS=-O3\t' line; re-check the pin)." >&2
  exit 1
}
echo "link optimization: -Oz (0480c; export flags and the gz verification unchanged)"

# Clear the link targets. FTE's rule keys off ftewebgl.js existing and nothing
# depends on the link flags, so a flag change alone leaves a stale artefact and
# make reports success without relinking. The .db intermediate goes too: it is
# the other make target that can satisfy the rule.
rm -f "$REL/ftewebgl.js" "$REL/ftewebgl.wasm" "$REL/ftewebgl.js.db" \
      "$REL"/gl_web/ftewebgl* 2>/dev/null || true

cd "$FTE/engine"
make makelibs FTE_TARGET=web CC=emcc
make gl-rel -j"$(nproc)" FTE_TARGET=web CC=emcc LDFLAGS="$WEB_EXTRA_LDFLAGS"

# web-rel also copies the shell page; we do that ourselves for the same reason
# we avoid its gzip step.
cp "$FTE/engine/web/fteshell.html" "$REL/ftewebgl.html"

for f in ftewebgl.html ftewebgl.js ftewebgl.wasm; do
  [ -f "$REL/$f" ] || { echo "FATAL: expected $REL/$f was not produced" >&2; exit 1; }
done

# --- sanity checks, before anything is copied out --------------------------
# A truncated engine is exactly what the upstream gzip bug produced, silently,
# so assert real sizes.
for f in ftewebgl.js ftewebgl.wasm; do
  sz=$(wc -c < "$REL/$f")
  [ "$sz" -gt 100000 ] || {
    echo "FATAL: $REL/$f is only $sz bytes; the link did not produce a real" >&2
    echo "       engine (expected several MB). Check the make output above." >&2
    exit 1
  }
done

# The link flags are the whole point; assert the symbols really made it in.
# Emscripten minifies the export table, so C symbols appear as e.g.
#   _free=Module["_free"]=wasmExports["d"];
for sym in _malloc _free _main; do
  grep -qF "${sym}=Module[\"${sym}\"]" "$REL/ftewebgl.js" || {
    echo "FATAL: $sym is not exported from ftewebgl.js but FTE's audio," >&2
    echo "       clipboard and startup code call it. Check" >&2
    echo "       WEB_EXTRA_LDFLAGS in scripts/build_fte_web.sh." >&2
    exit 1
  }
done
echo "checked: _main, _malloc and _free are exported from ftewebgl.js"

for fn in addRunDependency removeRunDependency; do
  grep -qE "(function|var|let|const) $fn[ (=]" "$REL/ftewebgl.js" || {
    echo "FATAL: $fn is called by FTE's web glue but is not defined in" >&2
    echo "       ftewebgl.js. Check WEB_EXTRA_LDFLAGS." >&2
    exit 1
  }
done
echo "checked: addRunDependency and removeRunDependency are defined in ftewebgl.js"

# --- compress for transport, keeping the plain files -----------------------
# Always regenerate: the .gz files are committed, and a stale one left over from
# a truncated build is a dead engine for any server that prefers precompressed
# files. The cmp below is what catches that case.
for f in ftewebgl.html ftewebgl.js ftewebgl.wasm; do
  gzip -9 -c "$REL/$f" > "$REL/$f.gz"
  if ! zcat "$REL/$f.gz" | cmp -s - "$REL/$f"; then
    echo "FATAL: $f.gz does not decompress to $f" >&2
    exit 1
  fi
done
echo "checked: every .gz decompresses byte-identically to its source"

mkdir -p "$OUT"
cp "$REL"/ftewebgl.* "$OUT"/

# Verify the copies too, not just the build directory.
for f in ftewebgl.html ftewebgl.js ftewebgl.wasm; do
  zcat "$OUT/$f.gz" | cmp -s - "$OUT/$f" || {
    echo "FATAL: web/$f.gz does not match web/$f after copying" >&2
    exit 1
  }
done
echo "checked: web/*.gz match web/* after copying"

# Everything else in web/ (content, page, licences) gets its transport .gz from
# the shared script; this build owns the engine trio's .gz only (above).
bash "$ROOT/scripts/precompress_web.sh"

echo
echo "built -> $OUT"
for f in ftewebgl.html ftewebgl.js ftewebgl.wasm; do
  printf '  %-16s %9s\n' "$f" "$(du -h "$OUT/$f" | cut -f1)"
done
echo
echo "Next: web/id1 must contain game content (scripts/build_maps.sh,"
echo "scripts/build_progs.sh, scripts/build_models_wad.sh, scripts/build_sounds.sh)."
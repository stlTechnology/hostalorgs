#!/usr/bin/env bash
# Precompress web/ for transport: a .gz sibling per content file.
#
#   scripts/precompress_web.sh [<dir>]     # default $ROOT/web
#
# WHY: the M6 download-size row is "gzipped download size <= 8 MB", and until
# 0484 the two static servers (tools/serve.js, server/gate.js) served raw
# bytes while verified .gz files sat next to them unused -- the loadtime
# "wire" was exactly the raw byte count. With siblings served, the measured
# first load drops from 10.72 MB to ~4.2 MB, with no change to what ships.
#
# The FTE build (scripts/build_fte_web.sh) makes and verifies .gz for the
# engine trio itself; this script handles everything else and does not touch
# those three. Regeneration is staleness-driven, so any content builder can
# call it and only what changed is redone.
#
# Every .gz is verified to decompress byte-identically before it is kept,
# because the failure that motivated the verification is silent: FTE's
# upstream `gzip -kf` once shipped a truncated .wasm.gz with exit status 0.
# A stale or missing .gz is not an error -- the servers fall back to raw.
#
# gzip -n: no timestamp or original name in the header, so re-running this on
# unchanged content is byte-stable and does not churn the committed .gz files.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-$ROOT/web}"

[ -d "$DIR" ] || { echo "FATAL: $DIR is not a directory" >&2; exit 1; }

# Files whose .gz is owned by another build step, never touched here.
is_engine_owned() {
  case "$(basename "$1")" in
    ftewebgl.html|ftewebgl.js|ftewebgl.wasm) return 0 ;;
    *) return 1 ;;
  esac
}

COMPRESS='\.html$|\.js$|\.wasm$|\.pak$|\.wad$|\.bsp$|\.json$|\.css$|\.txt$|\.md$|\.rc$|\.dat$|\.cfg$'

total_raw=0 total_gz=0 n=0
while IFS= read -r -d '' f; do
  is_engine_owned "$f" && continue
  gz="$f.gz"
  src_age=$(stat -c %Y "$f")
  if [ -f "$gz" ] && [ "$(stat -c %Y "$gz")" -ge "$src_age" ]; then
    continue    # fresh sibling: nothing to do
  fi
  raw=$(wc -c < "$f")
  gzip -9 -n -c "$f" > "$gz.tmp"
  if ! zcat "$gz.tmp" | cmp -s - "$f"; then
    rm -f "$gz.tmp"
    echo "FATAL: $(basename "$gz").tmp does not decompress to $(basename "$f")" >&2
    exit 1
  fi
  mv "$gz.tmp" "$gz"
  gzn=$(wc -c < "$gz")
  if [ "$gzn" -ge "$raw" ]; then
    rm -f "$gz"      # gzip is not free: tiny files grow, keep them raw
    continue
  fi
  total_raw=$((total_raw + raw)); total_gz=$((total_gz + gzn)); n=$((n + 1))
  printf '  %s: %s -> %s\n' "${f#"$DIR"/}" "$raw" "$gzn"
done < <(find "$DIR" -type f -regextype posix-extended -regex ".*($COMPRESS)" \
           ! -name '*.gz' -print0 | sort -z)

if [ "$n" -eq 0 ]; then
  echo "precompress: everything in ${DIR#"$ROOT"/} already has a fresh .gz"
else
  printf 'precompress: %d file(s) compressed, %s -> %s bytes\n' \
    "$n" "$total_raw" "$total_gz"
fi

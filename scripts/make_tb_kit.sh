#!/usr/bin/env bash
# Build the owner's TrenchBroom kit zip: /data/quake-maps/qwtf-trenchbroom-kit.zip
#
# Contents (per reviewer 0483):
#   qwtf-kit/
#     README-WINDOWS.md      the owner's guide for the zip (Windows flow)
#     qwtf.fgd               our entities and only ours
#     scale-references.map   the generated template (the 30-degree ramp lives here)
#     id1/                   OUR content: our.wad, gfx.wad, models.pak, sounds.pak
#
# The point of the kit is that the owner points TrenchBroom at THIS id1/, never at
# their original Quake folder -- PROJECT.md keeps id's assets offline and out of git.
# The worldspawn "wad" key is the relative "our.wad" in both our maps and the template,
# so the same .map resolves here (qbsp -wadpath <id1>) and in TrenchBroom (the kit's
# id1/ is the Quake Path's id1).
#
# Every build carries its own proof: the zip is unzipped somewhere fresh and the
# template inside it must compile with qbsp against the id1/ INSIDE THE ZIP, or the
# script fails. A kit that ships without compiling is not a kit.
#
# Maps the owner finishes go to /data/quake-maps/incoming/<name>.map (created here if
# missing); compiling them is OUR job (scripts/build_maps.sh --map), not the owner's.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$ROOT/tools/trenchbroom"
ID1="$ROOT/web/id1"
EW="$ROOT/third_party/ericw-tools/build-linux"
OUT_DIR=/data/quake-maps
OUT="$OUT_DIR/qwtf-trenchbroom-kit.zip"

[ -x "$EW/qbsp/qbsp" ] || { echo "FATAL: qbsp missing. Build ericw-tools first." >&2; exit 1; }
for f in "$KIT/qwtf.fgd" "$KIT/scale-references.map" "$KIT/README-WINDOWS.md" \
         "$ID1/our.wad" "$ID1/gfx.wad" "$ID1/models.pak" "$ID1/sounds.pak"; do
  [ -f "$f" ] || { echo "FATAL: missing $f" >&2; exit 1; }
done

# The template committed in the repo must be the one the generator writes -- a stale
# template would zip a stale number.
python3 "$KIT/make_scale_references.py" --check

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- stage the kit tree -----------------------------------------------------
STAGE="$WORK/qwtf-kit"
mkdir -p "$STAGE/id1"
cp "$KIT/qwtf.fgd" "$KIT/scale-references.map" "$KIT/README-WINDOWS.md" "$STAGE/"
cp "$ID1/our.wad" "$ID1/gfx.wad" "$ID1/models.pak" "$ID1/sounds.pak" "$STAGE/id1/"
# The game's own map, for the owner to edit (2026-10-09). Its wad key names id1/our.wad
# here because TrenchBroom looks a wad up next to the map and under the Game Path, both
# of which are this folder; the game build's "our.wad" is found by qbsp's -wadpath.
sed 's|^"wad" "our.wad"$|"wad" "id1/our.wad"|' "$ROOT/maps/forts.map" > "$STAGE/forts.map"
grep -q '^"wad" "id1/our.wad"$' "$STAGE/forts.map" || { echo "FATAL: forts.map wad key not rewritten" >&2; exit 1; }

# ---- proof: fresh unzip of the real zip, template compiles against the zip's id1
mkdir -p "$OUT_DIR/incoming"
rm -f "$OUT"
(cd "$WORK" && zip -qr "$OUT" qwtf-kit)

UNZIP="$WORK/unzipped"
mkdir -p "$UNZIP"
(cd "$UNZIP" && unzip -q "$OUT")
[ -f "$UNZIP/qwtf-kit/id1/our.wad" ] || { echo "FATAL: the zip has no id1/our.wad" >&2; exit 1; }

echo "== compile proof: qbsp on the zip's own template, wadpath = the zip's own id1 =="
"$EW/qbsp/qbsp" -wadpath "$UNZIP/qwtf-kit/id1" \
  "$UNZIP/qwtf-kit/scale-references.map" "$WORK/proof.bsp"
[ -f "$WORK/proof.bsp" ] || { echo "FATAL: qbsp produced no .bsp" >&2; exit 1; }
echo "proof: $(wc -c < "$WORK/proof.bsp") bytes of .bsp from the zip's template"

echo "== kit built =="
ls -l "$OUT"
echo "owner drop folder: $OUT_DIR/incoming/ (owner maps land here as <name>.map; we compile)"
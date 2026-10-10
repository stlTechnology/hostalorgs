#!/usr/bin/env bash
# Compile maps/*.map into standard Quake BSPs with ericw-tools, then assemble
# web/id1 (our WAD + maps) so the FTE web client has content to load.
#
# Pipeline: qbsp -> vis -> light.  All three binaries come from
# third_party/ericw-tools/build-linux (see scripts/fetch_third_party.sh and the
# submodule note there).  `light` needs libembree4.so.4 and libtbb.so.12, which
# sit next to it in the build tree, so it is run from there.
#
# Textures: our own small WAD (scripts/mkwad.py) built from LibreQuake PNGs,
# which are BSD-3-Clause. Nothing from id/Valve or Team Fortress.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --map NAME is parsed FIRST, before anything is generated, so a one-map build does not
# depend on the others generating cleanly. It used to be parsed after the generation
# step, which meant `build_maps.sh --map forts` ran gen_map --ctf first and died on it --
# and the CTF drift is pre-existing and documented, so the forts BSP could not be rebuilt
# at all without also fixing a map the owner does not play. A build that cannot rebuild
# the map you are working on is worse than one that builds a stale one, because the stale
# one at least exists.
#
# It also fixes the thing this script's own comment warns about: "Building forts by hand,
# because CTF's vis failed, is how a STALE BSP ships."
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --map) ONLY="$2"; shift 2 ;;
    *) echo "FATAL: unknown argument '$1' (only --map NAME)" >&2; exit 1 ;;
  esac
done
want() { [ -z "$ONLY" ] || [ "$1" = "$ONLY" ]; }
EW="$ROOT/third_party/ericw-tools/build-linux"
LQ="$ROOT/third_party/LibreQuake/texture-wads"
WEB="$ROOT/web"

[ -x "$EW/qbsp/qbsp" ] || { echo "FATAL: qbsp missing. Build ericw-tools first." >&2; exit 1; }

# ---- texture source: name -> LibreQuake png -------------------------------
# Kept explicit so the WAD contents are auditable (PROJECT.md licensing).
# `skip` is not on any brush here: qbsp looks it up unconditionally to build the
# NODRAW texinfo used for clip/skip surfaces (qbsp.cc MakeSkipTexinfo), and
# warns "unable to find texture skip" if it is absent.
TEX_WALL=lq_tech/tek_wall4_1.png
TEX_FLOOR=lq_conc/conc1_1.png
TEX_CEIL=lq_utility/light_fbr.png
TEX_SKIP=lq_dev_legacy/skip.png
# Castle brick for the CTF bases. One source texture, duotoned red and blue by
# scripts/mktinted.py, so a screenshot says which base you are in without any
# new art: the pixels are LibreQuake's, only the channels are remapped.
TEX_BRICK=lq_medieval/med_dbrick2.png

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== generating map sources =="
# Regenerate before compiling: maps/*.map are build products of the generators,
# and a stale .map silently ships whatever geometry the generator last produced.
# (This happened: info_player_deathmatch spawns were added to gen_map.py but the
# committed .map still lacked them, so players spawned at the world origin.)
# corridor.map is the movement/render fixture; duel.map is the combat fixture
# used only by tests/mp_combat.js. Both are generated, so both are regenerated.
if want corridor; then
  python3 "$ROOT/scripts/gen_map.py" -o "$ROOT/maps/corridor.map" | sed 's/^/  /'
fi
if want duel; then
  python3 "$ROOT/scripts/gen_map.py" --duel -o "$ROOT/maps/duel.map" | sed 's/^/  /'
fi 
# ctf.map is the M4a two-base map (GAME-DESIGN.md Map 1).
#
# This note used to say the map LEAKED and had to be opted into with QWTF_CTF=1.
# It no longer does: shell_geometry() lays a real vertical stack (bottom slab,
# solid fill under the ground floor cut open only at the tunnel mouths, then the
# floor above), which took the BSP from 119136 nodes to ~9700, and
# tests/test_ctf_map.py asserts both that qbsp writes a .prt rather than a
# .leak.prt and that the map is walkable.
if want ctf; then
  python3 "$ROOT/scripts/gen_map.py" --ctf -o "$ROOT/maps/ctf.map" | sed 's/^/  /'
fi
# maps/forts.map was NOT generated here, which is why the hook watches maps/* and the
# build's own comment ("maps/*.map are build products of the generators") was not true
# of the map everything else here is about. It is generated now, under the same guard, so
# a build cannot compile a .map that the generator would not produce.
if want forts; then
  python3 "$ROOT/scripts/gen_map.py" --forts -o "$ROOT/maps/forts.map" | sed 's/^/  /'
fi

# --- the qbsp time budget: the backstop, not the protection -------------------
#
# The real protection is the overlap guard (tests/test_ctf_map.py and the
# generation-time check in gen_map.py): no two solid brushes may share volume,
# because overlap is what qbsp resolves with splits. The reviewer measured a
# deliberately trivial control -- a sky box, a floor and two forts -- at 0.035 s,
# so a budget anywhere near that would fail good maps and make the guard noisy
# (reviewer 0135). This is a ceiling for a 10x regression, not a target.
#
# What a broken map does instead: the sky attempt on the old --ctf layout ran
# 2m00s of wall and 4m of CPU and never finished (maps/SKY-ATTEMPT.md). Anything
# in that neighbourhood fails here in seconds.
QBSP_BUDGET_S="${QWTF_QBSP_BUDGET:-10}"
# 90, raised from 60 on 0284: the forts map at FORTS_SCALE 2.0 bakes in 62s. The
# likely reason is surface area -- the map is twice the size in every direction at
# 2.0, so there are about four times as many lightmap texels -- and the one short
# look the reviewer allowed did not find a single pathological face: vis is 0.1s
# and qbsp is 7.0s, so it is all in light's own sampling, spread evenly.
VISLIGHT_BUDGET_S="${QWTF_VISLIGHT_BUDGET:-90}"

echo "== packing textures =="
mkdir -p "$WEB/id1"
for t in "$TEX_WALL" "$TEX_FLOOR" "$TEX_CEIL" "$TEX_SKIP" "$TEX_BRICK"; do
  [ -f "$LQ/$t" ] || { echo "FATAL: missing texture source $LQ/$t" >&2; exit 1; }
  cp "$LQ/$t" "$WORK/"
done
# The sky. Its name starts with "sky", which is what makes a brush sky rather than
# a surface to light and draw: renderers scroll it to the camera's angle. From
# LibreQuake's texture-wads/lq_liquidsky, BSD-3 like the rest. The forts map is
# open to the sky, so without this it renders void.
cp "$LQ/lq_liquidsky/sky5_blu.png" "$WORK/"
# The water surface. qbsp decides a brush is WATER from a texture name starting
# with '*', and '*' cannot be in a file name, so LibreQuake ships it as
# star_water1.png and scripts/mkwad.py maps the star_ prefix back to '*'. Without
# this lump qbsp warns "unable to find texture *water1" and the channel is solid
# rather than swimmable.
cp "$LQ/lq_liquidsky/star_water1.png" "$WORK/"

# Team-tinted variants, named to match TEX_RED/TEX_BLUE in gen_map.py. WAD2 lump
# names hold 15 characters plus a NUL, so these have to stay short.
python3 "$ROOT/scripts/mktinted.py" "$WORK/$(basename "$TEX_BRICK")" "$WORK/ctf_red_brick.png" \
  --tint 255,70,60 | sed 's/^/  /'
python3 "$ROOT/scripts/mktinted.py" "$WORK/$(basename "$TEX_BRICK")" "$WORK/ctf_blue_brick.png" \
  --tint 70,110,255 | sed 's/^/  /'
python3 "$ROOT/scripts/mk_textures.py" "$WORK"
python3 "$ROOT/scripts/mkwad.py" -o "$WEB/id1/our.wad" "$WORK"/*.png
python3 "$ROOT/tests/test_wad.py" --wad "$WEB/id1/our.wad" \
  || { echo "FATAL: web/id1/our.wad failed the independent WAD2 reader" >&2; exit 1; }

# Sprites/pickups/models/etc. come from LibreQuake's prebuilt gfx.wad (BSD-3).
if [ -f "$ROOT/third_party/LibreQuake/lq1/gfx.wad" ]; then
  cp "$ROOT/third_party/LibreQuake/lq1/gfx.wad" "$WEB/id1/gfx.wad"
  echo "  gfx.wad $(du -h "$WEB/id1/gfx.wad" | cut -f1)"
fi

# BSD-3-Clause requires the notice to accompany every redistributed copy, and
# some LibreQuake assets derive from Freedoom and Blasphemer, which carry their
# own BSD-3 notices.  Ship them next to the assets they cover (see
# ASSETS-CREDITS.md).
LQDOCS="$ROOT/third_party/LibreQuake/docs"
mkdir -p "$WEB/licences"
copy_notice() { [ -f "$LQDOCS/$1" ] || { echo "FATAL: missing licence notice $LQDOCS/$1" >&2; exit 1; }
                cp "$LQDOCS/$1" "$WEB/licences/$2"; }
copy_notice COPYING                             LibreQuake-COPYING.txt
copy_notice CREDITS                             LibreQuake-CREDITS.txt
copy_notice misc-docs/COPYING                   QuakeC-GPL2-COPYING.txt
copy_notice freedoom-docs/COPYING.adoc           freedoom-COPYING.adoc
copy_notice freedoom-docs/CREDITS               freedoom-CREDITS.txt
copy_notice blasphemer-docs/COPYING.md          blasphemer-COPYING.md
copy_notice blasphemer-docs/CREDITS.md          blasphemer-CREDITS.md
echo "  licences: $(ls "$WEB/licences" | wc -l) notices in web/licences/"

echo "== compiling maps =="
mkdir -p "$WEB/id1/maps"
# Timings are printed so a regression is visible in the build output and not only
# as a failure.
# --map NAME builds only that map. Building forts by hand, because CTF's vis failed,
# is how a STALE BSP ships: the build that failed is not the build that ran. This is
# also what makes the reviewer's "rebuild forts.bsp" a thing I can do in one command
# and paste.
for map in "$ROOT"/maps/*.map; do
  [ -e "$map" ] || { echo "  (no maps yet)"; break; }
  name="$(basename "$map" .map)"
  [ -n "$ONLY" ] && [ "$name" != "$ONLY" ] && continue
  # 0479 (reviewer, owner decision): ctf, corridor and duel are NOT the
  # deployed map -- the service runs forts. Their BSPs ship with the TESTS
  # (tests/fixtures/maps/), not with the page: the browser manifest lives
  # off web/id1 only, so a BSP here is never fetched pre-engine by anyone.
  # forts stays in web/id1/maps because it is what the server runs.
  case " ctf corridor duel " in
    *" $name "*) OUT="$ROOT/tests/fixtures/maps";;
    *)           OUT="$WEB/id1/maps";;
  esac
  mkdir -p "$OUT"
  echo "  $name -> ${OUT#$ROOT/}"
  cp "$map" "$WORK/"
  t0=$(date +%s)
  # The budget is a backstop, not the protection: overlapping solid brushes are,
  # and the guard that catches them lives in gen_map.py (at generation time) and
  # tests/test_ctf_map.py. What a broken map does instead of finishing is the
  # sky attempt on the old --ctf layout: 2m00s of wall, 4m of CPU, never done
  # (maps/SKY-ATTEMPT.md). That fails here in seconds rather than in ten minutes.
  timeout "$QBSP_BUDGET_S" "$EW/qbsp/qbsp" -wadpath "$WEB/id1" \
    "$WORK/$name.map" "$WORK/$name.bsp" >"$WORK/qbsp.log" 2>&1 \
    || { rc=$?
         if [ "$rc" -eq 124 ]; then
           echo "FATAL: $name: qbsp did not finish inside ${QBSP_BUDGET_S}s." >&2
           echo "       Overlapping solid brushes are the usual cause; see" >&2
           echo "       maps/SKY-ATTEMPT.md and the overlap guard." >&2
         else
           echo "FATAL: qbsp failed for $name"; tail -20 "$WORK/qbsp.log" >&2
         fi
         exit 1; }
  # A silently-missing texture is the failure mode this pipeline is prone to:
  # qbsp still writes a BSP, just with a zero-size texture.  Fail on the warning
  # instead, and report what did get embedded.
  if grep -q "unable to find texture" "$WORK/qbsp.log"; then
    echo "FATAL: qbsp could not read textures from $WEB/id1:" >&2
    grep "unable to find texture" "$WORK/qbsp.log" >&2
    exit 1
  fi
  grep -E "texture frames added|Writing .* as Quake BSP" "$WORK/qbsp.log" | sed 's/^/  /'
  ( cd "$EW/vis"  && timeout "$VISLIGHT_BUDGET_S" ./vis -level 4 -fast "$WORK/$name.bsp" ) \
    >"$WORK/vis.log" 2>&1 \
    || { echo "FATAL: vis failed for $name (or exceeded ${VISLIGHT_BUDGET_S}s)"; \
         tail -20 "$WORK/vis.log"; exit 1; }
  ( cd "$EW/light" && timeout "$VISLIGHT_BUDGET_S" ./light -bounce 4 "$WORK/$name.bsp" ) \
    >"$WORK/light.log" 2>&1 \
    || { echo "FATAL: light failed for $name (or exceeded ${VISLIGHT_BUDGET_S}s)"; \
         tail -20 "$WORK/light.log"; exit 1; }
  t1=$(date +%s)
  # Copy only the .bsp. ericw-tools leaves .json/.log/.prt byproducts next to
  # its output, and web/id1/maps/ is served to every visitor.
  rm -f "$OUT/$name".json "$OUT/$name".log \
        "$OUT/$name".prt "$OUT/$name".lit
  cp "$WORK/$name.bsp" "$OUT/"
  printf '    %s.bsp %s, qbsp+vis+light in %ss (budget %ss/%ss)\n' \
    "$name" "$(du -h "$OUT/$name.bsp" | cut -f1)" "$((t1 - t0))" \
    "$QBSP_BUDGET_S" "$VISLIGHT_BUDGET_S"
done

echo
# FTE's manifest must list exactly what we produced.
python3 "$ROOT/scripts/gen_manifest.py"

# and every content file gets a fresh transport .gz (0484; idempotent)
bash "$ROOT/scripts/precompress_web.sh"

echo
echo "web/id1 now contains:"
find "$WEB/id1" -type f | sed "s|$WEB/||" | sort
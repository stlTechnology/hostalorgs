#!/usr/bin/env bash
# Compile LibreQuake's QuakeC into progs.dat / qwprogs.dat for web/id1.
#
# The QuakeC is id's original deathmatch progs (GPL v2, see
# third_party/LibreQuake/docs/misc-docs/COPYING), shipped as source in
# third_party/LibreQuake/qcsrc and compiled by LibreQuake's own build.py with
# fteqcc.  We do exactly the same, so the result is a GPL v2 progs.dat.
#
# We need one of these for the client to spawn a player at all: FTE reads
# info_player_start's origin out of the QuakeC entity (sv_user.c SV_SpawnClient),
# so with no progs loaded nothing spawns and the free camera sits at the world
# origin looking at the outside of the map.
#
# Both variants are built because FTE looks for progs.dat or qwprogs.dat
# depending on the mod; shipping both costs ~300 KB and removes the guesswork.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LQ="$ROOT/third_party/LibreQuake"
FTEQCC="$ROOT/third_party/fteqw/engine/release/fteqcc"
WEB="$ROOT/web"

[ -x "$FTEQCC" ] || { echo "FATAL: $FTEQCC missing. Run: make -C third_party/fteqw/engine qcc-rel" >&2; exit 1; }
[ -f "$LQ/qcsrc/progs.src" ] || { echo "FATAL: $LQ/qcsrc missing. Run scripts/fetch_third_party.sh" >&2; exit 1; }

mkdir -p "$WEB/id1"

# Our own QuakeC lives in qwtf/ and is appended to LibreQuake's #includelist.
#
# third_party/ is gitignored, so editing progs.src in place would be lost on the
# next fetch of the sources and would never be reviewed. Instead the tree is
# copied to a work directory, our file is added to the END of the includelist,
# and fteqcc runs there.
#
# The POSITION matters, and both wrong guesses were measured: an overlay listed
# first has no self/dprint/ftos (defs.qc not read yet), and one listed before the
# #ifdef blocks has no findchain. It goes immediately before #endlist.
# LibreQuake also has no strcat, so the overlay avoids it.
# OFF by default. The overlay mechanism works -- it is staged into a copy of
# qcsrc and appended before #endlist, which is the only unambiguous end of the
# include list -- but qwtf/probe.qc does not compile yet, and a broken progs build
# is worse than no probe. Two of the three things it needs are simply absent from
# LibreQuake's QuakeC:
#
#   findchain   -> "Unknown value findchain"
#   edict_num   -> "Unknown value edict_num"
#
# (LibreQuake's QuakeC is not FTE's, so FTE's entity-walking builtins are not
# there. It also has no strcat.) So the next attempt has to find another way to
# enumerate players from inside QuakeC -- or the position source has to come from
# the engine side instead, which means a patch to our own FTE build rather than to
# a gitignored third-party tree.
#
#   QWTF_QC_OVERLAY=1 bash scripts/build_progs.sh    # try it
QWTF_QC="$ROOT/qwtf"
# ON by default. The probe is what reports QWTFPOS, and without it the whole
# in-engine test harness is blind: the position, waterlevel and health the tests
# assert on simply do not exist. The old default of 0 still built a "successful"
# progs.dat with no probe in it, which reads as a working build until you ask the
# server a question and get nothing back.
#
# The variable is still honoured, so a clean LibreQuake-only build is still one
# env var away.
OVERLAY="${QWTF_QC_OVERLAY:-1}"
if [ "$OVERLAY" = "1" ] && [ ! -d "$QWTF_QC" ]; then
  echo "FATAL: QWTF_QC_OVERLAY=1 but $QWTF_QC is missing" >&2; exit 1
fi
if [ "$OVERLAY" = "1" ] && [ ! -f "$QWTF_QC/bots_nav.qc" ]; then
  echo "FATAL: $QWTF_QC/bots_nav.qc missing. Run scripts/build_nav.py" >&2; exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

stage_qc() {
  rm -rf "$WORK/qcsrc"
  cp -r "$LQ/qcsrc" "$WORK/qcsrc"
  [ "$OVERLAY" = "1" ] || return 0
  cp -r "$QWTF_QC" "$WORK/qcsrc/qwtf"
  # Insert immediately before #endlist, i.e. after EVERY other include.
  #
  # Both ends of that range fail if you guess wrong, and both were tried here:
  # first straight after #includelist, which is before defs.qc and so has no
  # self/dprint/ftos; then just before the first #ifdef block, which is before
  # findchain. #endlist is the only unambiguous end.
  #
  # ORDER MATTERS: qwtf/ctf.qc (the game rules) FIRST, then qwtf/probe.qc (the
  # test hooks). The probe prints ctf.qc's fields, so the reverse order is
  # "Unknown field qwtf_team" on five lines.
  #
  # ORDER MATTERS: qwtf/ctf.qc (the game rules) FIRST, then qwtf/bots.qc,
  # then the GENERATED qwtf/bots_nav.qc, then qwtf/classes.qc (which uses
  # forceinfokey from bots.qc, so it must come after), then qwtf/drown.qc (the
  # other game rule, which exempts bots by reading bots.qc's qwtf_isbot, so it
  # has to come after bots.qc), and LAST of ours qwtf/probe.qc (the test hooks).
# bots.qc reads ctf.qc's constants and fields (the
   # reverse order is "Unknown field qwtf_team" on five lines), and
   # forward-declares the route table that bots_nav.qc calls, so bots_nav must
   # come after bots. classes.qc defines SV_ParseClientCommand and wraps the
   # spawn/attack/impulse hooks; the probe prints ctf.qc's fields, so it comes
   # after ctf.qc too. sniper.qc comes after classes.qc because it WRAPS
   # classes.qc's W_Attack, PlayerPreThink, QWTF_class_apply and T_Damage (a
   # wrap wraps the previous definition of the same name), and reads its
   # QWTF_CLASS_* constants. heavy.qc comes after sniper.qc for the same
   # reason: it wraps sniper.qc's W_Attack and PlayerPreThink (its wrap runs
   # FIRST and hands every non-heavy attack down through prior()). lobby.qc
   # comes right after classes.qc because it WRAPS classes.qc's
   # QWTF_class_apply and command handler (the waiter skips the class apply),
   # and ctf.qc's team assign must still run inside its PlayerPreThink
   # prior() -- the lobby takes an un-picked team back after it. drown.qc reads ctf.qc's event printers and bots.qc's
  # qwtf_isbot, so it comes after both; the bot exemption lives THERE rather than
  # in bots.qc for the same reason -- the rule owns the fields it has to clear.
  #
  # QWTF_EXTRA_QC: extra QuakeC files, space separated, compiled AFTER all of
  # ours (so a probe can call a function classes.qc defines -- that is the
  # point: it measures the shipped comparison, not a private copy of it).
  # Test-only: tests/test_stringeq.js is the only caller, and it sets
  # QWTF_PROGS_OUT as well so a probe build never touches the shipped progs.
  local extras="" f
  for f in ${QWTF_EXTRA_QC:-}; do
    [ -f "$QWTF_QC/$(basename "$f")" ] || {
      echo "FATAL: QWTF_EXTRA_QC=$f is not in $QWTF_QC" >&2; exit 1; }
    extras="$extras qwtf/$(basename "$f")"
  done
  # If QWTF_NO_EGGS is defined, do NOT include eggs.qc in the build.
  if [ "${QWTF_NO_EGGS:-0}" = "1" ]; then
    awk -v extra="$extras" '
      /^[[:space:]]*#endlist/ { print "qwtf/ctf.qc"; print "qwtf/bots.qc"; print "qwtf/bots_nav.qc"; print "qwtf/classes.qc"; print "qwtf/lobby.qc"; print "qwtf/sniper.qc"; print "qwtf/heavy.qc"; print "qwtf/drown.qc";
                               n = split(extra, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") print a[i]; print; next }
      { print }
    ' "$LQ/qcsrc/progs.src" > "$WORK/qcsrc/progs.src"
  else
    awk -v extra="$extras" '
      /^[[:space:]]*#endlist/ { print "qwtf/ctf.qc"; print "qwtf/eggs.qc"; print "qwtf/bots.qc"; print "qwtf/bots_nav.qc"; print "qwtf/classes.qc"; print "qwtf/lobby.qc"; print "qwtf/sniper.qc"; print "qwtf/heavy.qc"; print "qwtf/drown.qc"; print "qwtf/probe.qc";
                               n = split(extra, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") print a[i]; print; next }
      { print }
    ' "$LQ/qcsrc/progs.src" > "$WORK/qcsrc/progs.src"
  fi
  # QWTF_QC_SKIP: leave named files OUT of the build, e.g.
  #   QWTF_QC_SKIP=drown.qc QWTF_PROGS_OUT=/tmp/x bash scripts/build_progs.sh
  # Same standing as QWTF_NO_EGGS (the easter-egg switch) and for the same
  # reason: tests/drown.js runs the WHOLE server against a build without the
  # drowning rule to show its checks go red without it, because a check that
  # passes on a progs with no rule in it is reading nothing. Only whole include
  # LINES are dropped, and a name that is not in qwtf/ is a loud failure rather
  # than a silently smaller build.
  if [ -n "${QWTF_QC_SKIP:-}" ]; then
    local pats=()
    for f in ${QWTF_QC_SKIP}; do
      [ -f "$QWTF_QC/$f" ] || { echo "FATAL: QWTF_QC_SKIP=$f is not in $QWTF_QC" >&2; exit 1; }
      pats+=("qwtf/$f")
    done
    local joined
    joined="$(IFS='|'; echo "${pats[*]}")"
    awk -v re="^(${joined})$" '$0 !~ re' "$WORK/qcsrc/progs.src" > "$WORK/qcsrc/progs.src.tmp"
    mv "$WORK/qcsrc/progs.src.tmp" "$WORK/qcsrc/progs.src"
  fi
}

# Where the compiled progs land. QWTF_PROGS_OUT lets a probe build write
# somewhere else, so a test never has to trust that the shipped tree came back.
OUTDIR="$WEB/id1"
if [ -n "${QWTF_PROGS_OUT:-}" ]; then
  mkdir -p "$QWTF_PROGS_OUT"
  OUTDIR="$QWTF_PROGS_OUT"
fi

# progs.src uses #pragma progs_dat "../lq1/<name>.dat", relative to the qc
# directory, and resolves its #includelist against the current directory, so
# run fteqcc from inside the staged tree and override the output path.
build() {
  local define="$1" out="$2" name="$3"
  echo "  fteqcc $name ($define)"
  stage_qc
  ( cd "$WORK/qcsrc" && "$FTEQCC" progs.src -D__LIBREQUAKE__ $define -O2 -o "$out" ) \
    || { echo "FATAL: fteqcc failed for $name" >&2; exit 1; }
  [ -s "$out" ] || { echo "FATAL: $out is empty" >&2; exit 1; }
  printf '    %-14s %s\n' "$name" "$(du -h "$out" | cut -f1)"
}

echo "== compiling QuakeC (GPL v2) =="
[ "$OVERLAY" = "1" ] || echo "  WARNING: qwtf/ctf.qc + qwtf/probe.qc NOT injected: no game"
echo "           rules and no QWTFPOS, so the in-engine tests cannot see anything."
build ""          "$OUTDIR/progs.dat"   "progs.dat"
build "-D__QW__"  "$OUTDIR/qwprogs.dat" "qwprogs.dat"
echo "== built into $OUTDIR =="
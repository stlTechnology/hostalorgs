#!/usr/bin/env bash
# Every static map check, in ONE table, with a non-zero exit on any red. (0400)
#
#   tests/check_all.sh              # everything
#   tests/check_all.sh --fast       # the pre-commit subset (see below)
#   QWTF_CHECK_ALL_OUT=/tmp/x tests/check_all.sh    # keep the full output
#
# WHY THIS EXISTS
# ---------------
# `doors` was RED for several commits and nobody noticed, including me: I had reported it
# green, moved on to counting engine legs, and stopped running it. It went red underneath
# me while I was looking at something else. That is the third time in this project the
# thing that broke was the thing I stopped running -- the first two were a hand-built BSP
# because scripts/build_maps.sh failed on another map, and two colliding test suites.
#
# So the checks are no longer something you remember to run. This runs all of them, says
# which are red, and exits non-zero, and it is wired as a pre-commit hook so a commit that
# touches the map cannot go in with a red check that nobody ran.
#
# The rows are the checks' OWN lines. Nothing here decides whether a check passed; it runs
# them, reads what they printed, and prints the table. A check that prints nothing is
# counted as MISSING, which is a failure -- silence is not a pass.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1
OUT="${QWTF_CHECK_ALL_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/check-all-XXXXXX")}"
trap '[ -n "${QWTF_CHECK_ALL_OUT:-}" ] || rm -rf "$OUT"' EXIT

say() { printf '%s\n' "$*"; }

# --------------------------------------------------------------- run the checks
# The forts suite runs as ONE process (its sections share state and it takes minutes in
# the route subprocesses); the ctf suite and the static route checks are separate.
say "== check_all: running the static map checks"
say "   (full output under $OUT)"

python3 -u tests/test_forts_map.py >"$OUT/forts.log" 2>&1
FORTS_RC=$?
# doors and traps get their OWN runs, because the full suite did not reach them -- two
# rows read MISSING, and MISSING is how a check goes quiet without anyone noticing.
python3 -u tests/test_forts_map.py doors >"$OUT/doors.log" 2>&1
DOORS_RC=$?
python3 -u tests/test_forts_map.py traps >"$OUT/traps.log" 2>&1
TRAPS_RC=$?
python3 -u tests/test_ctf_map.py >"$OUT/ctf.log" 2>&1
CTF_RC=$?
node tests/walk_routes.js --static >"$OUT/sweep.log" 2>&1
SWEEP_RC=$?
python3 tools/trenchbroom/make_scale_references.py --check >"$OUT/kit.log" 2>&1 || true
python3 tests/test_report.py >"$OUT/report.log" 2>&1 || true
# 0484: the servers serve precompressed .gz siblings; every shipped file must
# have a fresh, byte-verified one or the download row silently loses its win.
python3 tests/test_precompress.py >"$OUT/gz.log" 2>&1 || true
# The M6 container image (PLAN.md): the entrypoint's process tree as a plain
# process -- the secret requirement, the landing page, the refused upgrade, the
# real handshake through to FTE, and docker stop taking both listeners down.
# The image build itself only runs where a docker daemon answers; without one
# the row's own verdict line says exactly what was and was not proven.
bash tests/test_container.sh >"$OUT/container.log" 2>&1 || true
# M7: the bots' route table is GENERATED from maps/forts.map by build_nav.py
# (qwtf/bots_nav.qc, compiled into qwprogs.dat). A stale table sends the bots
# along geometry that no longer exists, so the same staleness rule the manifest
# and the tb-kit sit under applies here: regenerate or the row is red.
python3 scripts/build_nav.py --check >"$OUT/nav.log" 2>&1 || true
# 1008: no test browser outlived its test. On the day this was added the queued
# browser suites came back with reds that only made sense on a starved box -- a
# headless Chrome of mine was 10 hours old at 1162% CPU -- and every browser
# result on the machine was measured underneath it. Cheap, and it names the PIDs.
bash tests/test_browser_leaks.sh >"$OUT/leaks.log" 2>&1 || true
# 1008: the drowning rule (GAME-DESIGN.md owner playtest item 3). Only its STATIC
# half: that the rule is on WaterMove, never reads qwtf_trace, still breathes for
# the design's 15 s, and names samples that are really in the pak the client loads.
# A browser row would be a 50 s row in the standing table; the engine half of the
# same file is the queued suite.
node tests/drown.js --static-only >"$OUT/drown.log" 2>&1 || true

# The rows, by name. Each is the check's own "ok"/"FAIL" line, matched by what it says it
# is checking -- so renaming a check in the test shows up here as MISSING, which is the
# point: a check that cannot be found cannot be reported green.
row_for() {           # row_for <log> <regex> <what it is>
  local log="$1" re="$2" label="$3" line bad
  # A FAIL anywhere in the matching lines WINS. Taking the first match reported the
  # bridge door's ok line for the passage door's FAIL -- a table that flatters itself is
  # worse than no table.
  bad="$(grep -E "$re" "$log" 2>/dev/null | grep -m1 'FAIL')"
  line="${bad:-$(grep -E "$re" "$log" 2>/dev/null | head -1)}"
  if [ -z "$line" ]; then
    printf '%-16s %-8s %s\n' "$label" "MISSING" "no line in ${log##*/} -- a check that prints nothing has not passed"
    return 1
  fi
  # A SUITE THAT ABORTED IS NOT A PASS. This row used to key on the bare word 'CTF',
  # and the only line in ctf.log containing it was "FATAL: CTF geometry is not
  # symmetric about x" -- which contains no 'FAIL', so row_for called it ok and the
  # table said "ctf-map ok" on a suite that had aborted two dozen lines earlier. A
  # table that flatters itself is worse than no table, and this one did.
  if [[ "$line" == *"FATAL"* ]]; then
    printf '%-16s %-8s %s\n' "$label" "FATAL" "$(echo "$line" | sed 's/^ *//' | cut -c1-90)"
    return 1
  fi
  if [[ "$line" == *"FAIL"* ]]; then
    printf '%-16s %-8s %s\n' "$label" "FAIL" "$(echo "$line" | sed 's/^ *FAIL *//' | cut -c1-90)"
    return 1
  fi
  printf '%-16s %-8s %s\n' "$label" "ok" "$label"
  return 0
}

say ""
printf '%-16s %-8s %s\n' CHECK RESULT DETAIL
printf '%-16s %-8s %s\n' ---------------- -------- --------------------------------------------
worst=0
: >"$OUT/table.txt"
row_one() { row_for "$@" | tee -a "$OUT/table.txt"; }
row_one "$OUT/forts.log" 'side A plus mirror_half'          'mirror'    || worst=1
row_one "$OUT/forts.log" 'looking at the map'              'overlap'   || worst=1
row_one "$OUT/traps.log" 'also leave on foot'              'traps'     || worst=1
row_one "$OUT/doors.log" 'gap x1 .*floor on BOTH'          'doors'     || worst=1
row_one "$OUT/doors.log" 'gap x1 .*continuous walk'       'doors-2'   || worst=1
row_one "$OUT/forts.log" 'solid floor in front'            'spawns'    || worst=1
row_one "$OUT/forts.log" 'of clear width the whole way'    'corridors' || worst=1
row_one "$OUT/forts.log" 'roof is reachable on foot'       'roof'      || worst=1
row_one "$OUT/forts.log" 'reports its flights'             'flights'   || worst=1
row_one "$OUT/sweep.log" 'corner pair'                     'sweep'     || worst=1
row_one "$OUT/sweep.log" 'own half of the map'             'legs-half' || worst=1
# The TrenchBroom template is GENERATED (tools/trenchbroom/make_scale_references.py)
# and this row is what stops the committed copy drifting from the code that emits it.
# It is here rather than in a test file because that is where "did the generated
# artefacts stay true" lives, and because a stale reference sheet is worse than none:
# the owner measures a doorway against it.
row_one "$OUT/kit.log"      'ok: [0-9]+ brushes'               'tb-kit'    || worst=1
# The failure report the owner reads (0308). It is tested rather than trusted because a
# reporter that invents a location is worse than no reporter: it looks authoritative.
row_one "$OUT/report.log"   'report: all checks passed'         'report'    || worst=1
# 0484: the precompressed .gz siblings the servers prefer (tools/serve.js and
# server/gate.js) exist, are fresh, and decompress byte-identically.
row_one "$OUT/gz.log"       '^gz: '                             'gz'        || worst=1
row_one "$OUT/container.log" '^container: '                      'container' || worst=1
# M7: the bots' generated route table is fresh against maps/forts.map.
row_one "$OUT/nav.log"       '^nav: '                            'nav'       || worst=1
row_one "$OUT/leaks.log"     '^leaks: '                          'leaks'     || worst=1
row_one "$OUT/drown.log"     'the rule is on WaterMove'          'drown'     || worst=1

# The suite's OWN verdict line, not the bare word 'CTF': test_ctf_map.py prints
# "CTF: PASS" or "CTF: FAIL: N checks did not hold", so the row cannot be satisfied
# by some unrelated line that happens to mention the map.
row_one "$OUT/ctf.log"   '^CTF: '                          'ctf-map'   || worst=1

say ""
say "forts:  $(grep -cE '^  ok' "$OUT/forts.log") ok, $(grep -cE '^  FAIL' "$OUT/forts.log") FAIL"
say "sweep:   $(grep -cE '^  ok' "$OUT/sweep.log") ok, $(grep -cE '^  FAIL' "$OUT/sweep.log") FAIL"
say "ctf:     $(grep -cE '^  ok' "$OUT/ctf.log") ok, $(grep -cE '^  FAIL' "$OUT/ctf.log") FAIL"
# $OUT/table.txt is the machine-readable form, built row by row above, and the
# pre-commit hook diffs it against tests/check_all.baseline.
say ""
if [ "$worst" -eq 0 ] && [ "$FORTS_RC" -eq 0 ] && [ "$DOORS_RC" -eq 0 ] && \
   [ "$TRAPS_RC" -eq 0 ] && [ "$CTF_RC" -eq 0 ] && [ "$SWEEP_RC" -eq 0 ]; then
  say "PASS: every static map check"
  exit 0
fi
say "FAIL: at least one static map check is red. Full output:"
say "      $OUT   (re-run one with, e.g., python3 -u tests/test_forts_map.py doors)"
if [ "$FAST" -eq 1 ]; then
  say "      (this was the --fast subset; the full set is tests/check_all.sh)"
fi
exit 1
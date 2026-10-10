#!/usr/bin/env bash
# Every walk_routes leg, one process each, in parallel, in one table. (0345)
#
#   tests/walk_all.sh              # every leg, both teams
#   tests/walk_all.sh a c          # only those legs
#   QWTF_LEG_TIMEOUT=300 tests/walk_all.sh
#
# WHY A WRAPPER AND NOT A LONGER RUN
# ---------------------------------
# One process for all the legs meant a leg that hangs cost the whole run: the run hit
# its limit, the legs after the hang never executed, and the result read as "those legs
# did not fail" rather than "those legs never ran". That is how a cut-off run has looked
# like a pass more than once in this thread. Here every leg is its own process with its
# own timeout, so:
#
#   * a leg that hangs says TIMEOUT, in the table, under its own name;
#   * a leg that never starts cannot be mistaken for a leg that passed;
#   * the legs run in parallel, so the wall clock is the slowest leg, not the sum.
#
# Per-run ports and per-run artefact directories are already keyed on the pid
# (tests/walk_routes.js), so parallel processes do not collide.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TIMEOUT="${QWTF_LEG_TIMEOUT:-120}"

# ------------------------------------------------------------ machine-wide lock
# Two walk_routes SUITES cannot run at once (0374). The reviewer's suite and mine were
# both running at load 24, and the results were nonsense in both directions:
#
#   mine: a red PASS 21 | a blue PASS 24 | b red PASS 22 | b blue PASS 25
#   theirs: a red FAIL "no walker joined" | a blue TIMEOUT | b red PASS 22
#                                  | b blue FAIL "no walker joined"
#
# "walker joined" is the CLIENT not connecting. Under contention it does not, and the
# failure looks exactly like a broken map -- it is what sent me looking at `across` for a
# geometry bug that was not there. One suite at a time, on the whole machine, waiting
# out loud rather than failing.
LOCK="${QWTF_WALK_LOCK:-/tmp/qwtf-walk.lock}"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another walk_routes suite holds $LOCK -- waiting for it to finish."
  echo "  (two suites at once make every result meaningless; this is 0374)"
  flock 9
  echo "lock acquired."
fi
# 2, not 8 (0355). At 8 the machine cannot give each leg its own engine and they time
# out -- measured: `across` PASSes on both teams at JOBS=1 and TIMES OUT at JOBS=4, which
# read as a broken map and was contention. Each leg wants a whole server and a whole
# browser; two at a time is what the box actually has.
JOBS="${QWTF_LEG_JOBS:-2}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/walk-all-XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

# Every leg in 0246 -- a, b, c and the mirror -- plus parapet and the drop. A leg that is
# not in this list is a leg that does not exist, and 0355 is right that by this script's
# own rule that is a failure, so the list is the whole suite and nothing is optional.
LEGS=("$@")
if [ ${#LEGS[@]} -eq 0 ]; then
  LEGS=(a b c across parapet drop doortokey)
fi
# 0393's done-when names the water steps leg "c2"; here it is "steps", because c is c1
# plus the old end-to-end water walk. Both names run the same thing.
for i in "${!LEGS[@]}"; do
  [ "${LEGS[$i]}" = "c2" ] && LEGS[$i]="steps"
done
TEAMS=(red blue)

echo "== walk_routes: ${#LEGS[@]} legs x ${#TEAMS[@]} teams, ${TIMEOUT}s each, ${JOBS} at a time"
echo

# Legs a and b walk the whole loop -- spawn -> the vault -> back up -> the bridge -> the
# other fort -- and c swims the channel and climbs out, so they need longer than a leg
# that only crosses the hall. 0355: a/red timing out at the default said nothing about a.
#
# `c2` is the climb OUT of the water and `drop` is a fall that ends in the water, so they
# were in the same class and were not in this list: they got the 120s default and timed
# out 0/3 with zero waypoints sent, killed inside CLIENT STARTUP, which is how the four
# TIMEOUTs in 0415's run were really harness timeouts and not map failures. Anything
# whose route touches the water gets the long timeout. To be explicit rather than clever,
# every leg name is listed and an unlisted one is an error, so adding a leg cannot
# silently inherit the short timeout.
leg_timeout() {
  case "$1" in
    a|b|c|c1|c2|steps|swim|drop|parapet|across|doortokey) \
       echo "${QWTF_LONG_LEG_TIMEOUT:-300}" ;;
    up|down|escort|rescue) echo "$TIMEOUT" ;;
    *)     echo "unknown leg '$1' -- add it to leg_timeout() in tests/walk_all.sh" >&2
           return 1 ;;
  esac
}

# REPEAT (0393): a leg that passes SOMETIMES IS RED. One run is one sample, and this
# suite has produced different answers on the same leg an hour apart -- `a/red` passed at 21
# checks and failed at corner 8/9 in the same afternoon, and both were true. So every leg
# is run REPEAT times and only N/N is a pass; the table reports "2/3", which is not a pass.
REPEAT="${QWTF_REPEAT:-1}"

run_one() {
  local leg="$1" team="$2"
  local log="$OUT/$leg-$team.log"
  local tmo; tmo="$(leg_timeout "$leg")"
  # A cut-off leg must be able to say so, so it is killed and marked TIMEOUT here --
  # never left to look like a run that simply produced no output.
  local pass=0 n=0 rc=0 verdict=FAIL
  local i=0
  while [ "$i" -lt "$REPEAT" ]; do
    i=$((i + 1))
    # The leg's own pid, so the reap below can be SCOPED to what this repeat
    # spawned. Its fteqw-sv and serve.js both carry the run dir in their command
    # line (`-basedir .../run-walk-<pid>/gamedir`, `--root .../run-walk-<pid>/gamedir`),
    # and nothing else's does. The pid is read from the log, not from $!:
    # `timeout` forks the node process, so $! is timeout's pid and the run dir
    # is keyed on node's.
    timeout --kill-after=10 "$tmo" \
         node tests/walk_routes.js --leg "$leg" --team "$team" >>"$log" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      pass=$((pass + 1))
    else
      if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then verdict=TIMEOUT; else verdict=FAIL; fi
    fi
    # Reaped after EVERY run, not after the leg -- but SCOPED to this repeat's own
    # processes (0466). The old reap here was `pkill -f 'tools/serve[.]js --port'`,
    # which matches EVERY leg's static server on the machine: at JOBS=2 the leg
    # finishing a repeat killed its still-running neighbour's serve.js mid-startup,
    # and the neighbour reported "no canvas on the page" or "the static server
    # started on its port" -- with ss showing NO holder and its serve.log showing
    # the listen line, because the socket had been open and then closed by a
    # SIGTERM from over here. Intermittent at exactly the rate the client-start
    # window overlaps the neighbour's repeat boundary. A SIGKILLed repeat runs no
    # handler, so this belt is still needed; it just must not reach past this leg.
    # The run dir line is printed at STARTUP since 0466, so even a SIGKILLed
    # repeat leaves it. The old `fteqw-sv --basedir` pattern matched nothing at
    # all (fte is spawned with a single-dash -basedir), and correcting it
    # unscoped would match the owner's LIVE server -- it is -basedir too. The
    # run dir is what separates a test leg from the live service.
    rundir="$(grep -oE 'run-walk-[0-9]+' "$log" | tail -1)"
    if [ -n "$rundir" ]; then pkill -f "$rundir" 2>/dev/null || true; fi
  done
  # N/N is PASS. Anything less is reported as the count it is.
  if [ "$pass" -eq "$REPEAT" ]; then
    echo "PASS $leg $team $pass/$REPEAT" >"$OUT/$leg-$team.status"
  else
    echo "$verdict $leg $team $pass/$REPEAT" >"$OUT/$leg-$team.status"
  fi
}

pids=()
for leg in "${LEGS[@]}"; do
  for team in "${TEAMS[@]}"; do
    while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n 2>/dev/null || sleep 0.2; done
    run_one "$leg" "$team" &
    pids+=($!)
  done
done
for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done

# Reap what a KILLED leg left (0374). walk_routes reaps its own process GROUP on every
# exit path it can, but `timeout --kill-after` escalates to SIGKILL, and SIGKILL runs no
# handler at all -- so a cut-off leg leaves its server and its static server behind. The
# reviewer found exactly that: `tools/serve.js --port 22195, run-walk-3942194`.
#
# Under the lock above, ANY run-walk gamedir process alive at this point is a leak from
# this run: nothing else is allowed to be running.
reap_orphans() {
  local n
  # Scoped to the walk suite's own run dirs (0466). The old pattern
  # 'fteqw-sv --basedir' never matched anything -- fte is spawned with a
  # single-dash -basedir -- and the OBVIOUS correction, `pkill -f
  # 'fteqw-sv -basedir'`, would kill the owner's LIVE server, which is
  # `fteqw-sv -basedir .../build/deploy/.../web` and shares the pattern.
  # Every test process carries its run-walk-<pid> dir; the live server does not.
  n="$(pgrep -f 'run-walk-[0-9]+' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${n:-0}" -gt 0 ]; then
    pkill -f 'run-walk-[0-9]+' 2>/dev/null || true
    sleep 1
  fi
}
reap_orphans

# ---------------------------------------------------------------- the table
printf '%-10s %-6s %-9s %s\n' LEG TEAM RESULT DETAIL
printf '%-10s %-6s %-9s %s\n' ---------- ------ --------- ------
worst=0
for leg in "${LEGS[@]}"; do
  for team in "${TEAMS[@]}"; do
    st="$OUT/$leg-$team.status"
    log="$OUT/$leg-$team.log"
    if [ ! -f "$st" ]; then
      printf '%-10s %-6s %-9s %s\n' "$leg" "$team" "MISSING" "no status: the leg never ran"
      worst=1
      continue
    fi
    read -r verdict who _ count <"$st"
    case "$verdict" in
      PASS) detail="$(grep -cE '^  ok' "$log" 2>/dev/null || echo 0) checks over $count" ;;
      TIMEOUT)
        detail="cut off at $(leg_timeout "$leg")s -- not a pass ($count)"
        worst=1
        ;;
      *)
        detail="$count -- $(grep -E '^  FAIL' -A 1 "$log" 2>/dev/null | tr '\n' ' ' | cut -c1-80)"
        worst=1
        ;;
    esac
    printf '%-10s %-6s %-9s %s\n' "$leg" "$team" "$verdict" "$detail"
  done
done

# ---------------------------------------------------------------- survivors
# The harness spawns a server, a static server and a browser per leg. Killing them is the
# harness's job and it now does it on every exit path, but a leak here silently slows
# every run after it -- 107 survivors and load 85 during the reviewer's run (0359) -- and
# that reads as a map or a timing problem rather than as the mess it is. So it is CHECKED,
# and a survivor is a failure of this script, not of any leg.
#
# Counted by run dir (0466): the old pattern never matched fteqw-sv (single-dash
# -basedir in the real command line), so a leaked server was invisible here --
# and the corrected process-name pattern would match the owner's LIVE server,
# which must never be signalled or counted as a leak. `run-walk-<pid>` is
# carried only by test processes.
SURV="$(pgrep -f 'run-walk-[0-9]+' 2>/dev/null | wc -l | tr -d ' ')"
if [ "${SURV:-0}" -gt 0 ]; then
  echo "SURVIVORS: $SURV processes from an earlier or this run are still alive:"
  pgrep -af 'run-walk-[0-9]+' 2>/dev/null | head -5 | sed 's/^/  /'
  echo "  Every run after this one is slower than the one before it, and that reads as a"
  echo "  timing problem rather than as a leak. Kill them with:"
  echo "    pkill -f 'run-walk-[0-9]+'"
  worst=1
else
  echo "survivors: none -- every process this run spawned was reaped"
fi

echo
if [ "$worst" -eq 0 ]; then
  echo "PASS: every leg on every team"
  exit 0
fi
# A red run keeps its logs (0466 follow-up): a 2/3 leg whose evidence is
# deleted with the temp dir cannot be diagnosed afterwards, and the run that
# failed is exactly the one whose evidence matters. A green run still cleans up
# (the trap fires on exit 0 above).
trap - EXIT
echo "FAIL: at least one leg did not pass; logs are under $OUT (kept because the run is red)."
echo "      Re-run one leg on its own to see it:  node tests/walk_routes.js --leg a --team red"
exit 1

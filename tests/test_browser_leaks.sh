#!/usr/bin/env bash
# tests/test_browser_leaks.sh -- no test browser outlived its test.
#
# WHY THIS IS A CHECK AND NOT A NOTE
# ----------------------------------
# On 2026-10-08 the queued tests/test_classes.js run came back with two reds
# that made no sense against the code: a menu click whose command the server
# never saw, and a duel client that connected and was dropped before spawning.
# The box was at load average 24 on 24 cores, and the top of `ps` was a
# headless Chrome from one of my own scratch experiments -- `--user-data-dir=
# /tmp/exp-alpha-PfhMiL`, debug port 9333 -- running for 10 hours with its GPU
# process at 1162% CPU, plus two build/fteqw-sv instances fighting over the
# same port at 100% each. Every browser-driven result on that box was measured
# under a starvation nobody had mentioned, which is exactly the kind of thing
# that turns a real bug into a mystery (and a mystery into a wrong fix).
#
# So the leak is checked, not remembered. The rule is deliberately narrow:
#
#   - headless Chrome (the test shape) whose --user-data-dir is one of the
#     prefixes the repo's own tests and scratch experiments use,
#   - older than 10 minutes, so a browser that is RIGHT NOW serving a running
#     suite is never counted,
#   - and a PID whose command line we can actually read.
#
# The owner's browser is not headless and its profile is not under /tmp, so it
# can never match. The reviewer's and the owner's game servers are reported
# below the verdict as information only: they are legitimate processes, and the
# check says nothing about them.
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_AGE=${QWTF_LEAK_MIN_AGE:-600}

leaks=""
for d in /proc/[0-9]*; do
  pid="${d#/proc/}"
  [ "$pid" = "$$" ] && continue
  cmd="$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null)" || continue
  case "$cmd" in
    *--headless*) ;;
    *) continue ;;
  esac
  case "$cmd" in
    *--user-data-dir=/tmp/qwtf-*|*--user-data-dir=/tmp/exp-*|\
    *--user-data-dir=/tmp/probe-*|*--user-data-dir=/tmp/classes-*)
      ;;
    *) continue ;;
  esac
  # age in seconds, from /proc/PID/stat field 22 (starttime) vs btime/uptime
  age="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ -n "$age" ] || continue
  [ "$age" -gt "$MIN_AGE" ] || continue
  prof="$(printf '%s' "$cmd" | sed -n 's/.*--user-data-dir=\([^ ]*\).*/\1/p')"
  leaks="$leaks  pid $pid, ${age}s old, profile $prof\n"
done

# The game servers are listed for information, never judged: :27510 and :8210
# are the reviewer's and the owner's, and a server someone started on purpose
# is not a leak. What matters is that they are VISIBLE.
servers="$(ps -eo pid,etimes,args 2>/dev/null | grep '[f]teqw-sv' |
  sed 's/^\( *[0-9]* *[0-9]*\).*+set \(sv_port [0-9]*\).*/\1 port \2/' |
  cut -c1-70)"

if [ -n "$leaks" ]; then
  printf 'leaks: FAIL: %s test browser(s) outlived their test (older than %ss)\n' \
    "$(printf '%b' "$leaks" | grep -c 'pid ')" "$MIN_AGE"
  printf '%b' "$leaks" | sed 's/^/  /'
  printf '  These hold CPU (one was measured at 1162%%) and every browser-driven\n'
  printf '  result on the box is measured underneath them. Kill the process group\n'
  printf '  of the browser in question; pkill -f matches its own shell, so name the\n'
  printf '  PID or use a self-excluding pattern.\n'
  exit 1
fi

printf 'leaks: ok: no test browser older than %ss; fteqw-sv processes: %s\n' \
  "$MIN_AGE" "$(printf '%s' "$servers" | grep -c port || true)"
[ -n "$servers" ] && printf '%s\n' "$servers" | sed 's/^/  /'
exit 0
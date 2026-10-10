#!/usr/bin/env bash
# M6 requirement row, run like walk_all (which this deliberately mirrors):
#
#   tests/load16.sh                     the whole thing, ~6-10 min
#   tests/load16.sh --clients 8         smaller sweep
#
# The flock is 0374: two chrome-heavy suites at once make both meaningless, so
# this waits out loud on the same machine-wide lock the walk suite holds, and
# the same QWTF_WALK_LOCK override moves it.
LOCK="${QWTF_WALK_LOCK:-/tmp/qwtf-walk.lock}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another walk/load suite holds $LOCK -- waiting for it to finish."
  echo "  (two suites at once make every result meaningless; this is 0374)"
  flock 9
  echo "lock acquired."
fi
exec node "$DIR/load16.js" "$@"
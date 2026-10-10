#!/usr/bin/env bash
# M7 bots test (PLAN.md M7: one bot per team, takes and captures the key, a
# human joining is placed with one bot on each side).
#
#   tests/test_bots.sh
#
# The bots live behind the qwtf_bots cvar (qwtf/bots.qc) so no other suite's
# server changes behaviour. The capture budget is minutes on purpose: the
# bots' routes are deliberately asymmetric (scripts/build_nav.py) so they meet
# and fight in the underwater passage, and every fight hands the key to
# somebody -- a capture is minutes of play, not seconds.
#
# The walk-suite flock, because this suite runs a dedicated server and reads
# the same artifacts tree the walk suites do (0374's rule).

LOCK="${QWTF_WALK_LOCK:-/tmp/qwtf-walk.lock}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another walk/load suite holds $LOCK -- waiting for it to finish."
  flock 9
fi
exec node "$DIR/test_bots.js"

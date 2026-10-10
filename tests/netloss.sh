#!/usr/bin/env bash
# M6 network row (tests/netloss.js): playability under tc netem, scoped to
# the test's own port. Same machine-wide flock as the other heavy suites.
LOCK="${QWTF_WALK_LOCK:-/tmp/qwtf-walk.lock}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another walk/load suite holds $LOCK -- waiting for it to finish."
  echo "  (two suites at once make every result meaningless; this is 0374)"
  flock 9
  echo "lock acquired."
fi
exec node "$DIR/netloss.js" "$@"
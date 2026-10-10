#!/usr/bin/env bash
# M6 time-to-play / download-size measurement (tests/loadtime.js), under the
# same machine-wide flock as the other chrome-heavy suites (0374).
LOCK="${QWTF_WALK_LOCK:-/tmp/qwtf-walk.lock}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another walk/load suite holds $LOCK -- waiting for it to finish."
  echo "  (two suites at once make every result meaningless; this is 0374)"
  flock 9
  echo "lock acquired."
fi
exec node "$DIR/loadtime.js" "$@"
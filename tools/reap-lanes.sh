#!/usr/bin/env bash
# Kill test processes that lane workers leaked: fteqw-sv servers and headless
# Chrome started under /data/quake-lanes (or /tmp test profiles) that are older
# than MAX_AGE seconds (default 2700 = 45 min; the longest test, test_bots, is
# about 15 min). Never touches the live service, which runs from build/deploy.
#   tools/reap-lanes.sh            one pass
#   tools/reap-lanes.sh --loop     a pass every 10 minutes
MAX_AGE="${MAX_AGE:-2700}"
pass() {
  ps -eo pid=,etimes=,args= | awk -v max="$MAX_AGE" '
    $2 > max && $0 !~ /build\/deploy\// &&
    (($3 ~ /fteqw-sv$/ && $0 ~ /\/data\/quake-lanes\//) ||
     ($3 ~ /chrome$/ && $0 ~ /--headless/ && $0 ~ /--user-data-dir=\/tmp\//)) {print $1}' |
  while read -r p; do kill -9 "$p" 2>/dev/null && echo "$(date '+%F %T') reaped $p"; done
}
if [ "${1:-}" = "--loop" ]; then while :; do pass; sleep 600; done; else pass; fi

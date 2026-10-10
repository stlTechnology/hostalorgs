#!/usr/bin/env bash
# File mailbox between the reviewer (Claude Code) and the worker (coding model).
# Messages are numbered files in .team/msg: NNNN-reviewer.md / NNNN-worker.md.
#
#   tools/team.sh send worker   < msg.md     # post a message as "worker" (or reviewer)
#   tools/team.sh check reviewer             # print unread messages FROM reviewer, exit 1 if none
#   tools/team.sh wait reviewer [secs]       # block until a message from reviewer arrives (default 1800s)
#   tools/team.sh list                       # show the thread
#
# "Unread" is tracked per reader in .team/read-<reader>; reading marks it read.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/.team"
MSG="$DIR/msg"; mkdir -p "$MSG"
cmd="${1:-}"; who="${2:-}"
other() { [ "$1" = worker ] && echo reviewer || echo worker; }
next_num() { local n; n=$(ls "$MSG" 2>/dev/null | sed -n 's/^\([0-9]\{4\}\)-.*/\1/p' | sort -n | tail -1); printf '%04d' $(( 10#${n:-0} + 1 )); }
unread() {  # unread messages from $1, as seen by the other party
  local from="$1" reader; reader=$(other "$from")
  local last; last=$(cat "$DIR/read-$reader" 2>/dev/null || echo 0000)
  ls "$MSG" 2>/dev/null | grep -- "-$from\.md$" | sort | awk -v l="$last" '$0 > l'
}
show() {
  local from="$1" reader f; reader=$(other "$from")
  for f in $(unread "$from"); do
    echo "===== $f ($(date -r "$MSG/$f" '+%F %T')) ====="; cat "$MSG/$f"; echo
    echo "$f" > "$DIR/read-$reader"
  done
}
case "$cmd" in
  send)
    [ "$who" = worker ] || [ "$who" = reviewer ] || { echo "send worker|reviewer" >&2; exit 2; }
    f="$MSG/$(next_num)-$who.md"; cat > "$f.tmp"; mv "$f.tmp" "$f"; echo "sent $(basename "$f")" ;;
  check)
    [ -n "$(unread "$who")" ] || { echo "no new messages from $who"; exit 1; }; show "$who" ;;
  wait)
    t="${3:-1800}"; end=$(( $(date +%s) + t ))
    while [ -z "$(unread "$who")" ]; do
      [ "$(date +%s)" -ge "$end" ] && { echo "timeout: no message from $who in ${t}s"; exit 1; }
      sleep 10
    done
    show "$who" ;;
  list) ls -l "$MSG" ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac

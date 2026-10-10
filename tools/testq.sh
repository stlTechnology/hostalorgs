#!/usr/bin/env bash
# A test queue run by the LOOP, not the model, so a model never pays tokens to wait.
#
#   tools/testq.sh submit <name> -- <command ...>   # worker: queue a long test, then END your run
#   tools/testq.sh run                              # loop: run everything queued (no model involved)
#   tools/testq.sh summaries                        # loop: print new results for the next prompt
#
# Full logs: .team/tests/done/<id>.log. Summaries (the last 40 lines): .team/tests/done/<id>.sum
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; Q="$ROOT/.team/tests"; mkdir -p "$Q/pending" "$Q/done"
case "${1:-}" in
  submit)
    name="$2"; shift 2; [ "${1:-}" = "--" ] && shift
    id="$(date +%m%d-%H%M%S)-$name"
    printf '%q ' "$@" > "$Q/pending/$id.cmd"
    echo "queued $id: the loop will run it after this run ends and put the result in your next prompt. End your run now (update STATE.md and commit first)." ;;
  run)
    for f in "$Q"/pending/*.cmd; do
      [ -e "$f" ] || continue
      id="$(basename "$f" .cmd)"; cmd="$(cat "$f")"
      start=$(date +%s)
      (cd "$ROOT" && timeout "${TEST_TIMEOUT:-7200}" bash -c "$cmd") > "$Q/done/$id.log" 2>&1; rc=$?
      { echo "## test $id  (exit $rc, $(( ($(date +%s) - start) / 60 )) min)"; echo "\$ $cmd"; echo '```'; tail -40 "$Q/done/$id.log"; echo '```'; echo "Full log: .team/tests/done/$id.log"; } > "$Q/done/$id.sum"
      rm -f "$f"
    done ;;
  summaries)
    for s in "$Q"/done/*.sum; do [ -e "$s" ] || continue; [ -e "$s.shown" ] && continue; cat "$s"; echo; touch "$s.shown"; done ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac

#!/usr/bin/env bash
# Keep the main-lane worker going without the owner relaying anything.
#
#   MODEL=provider/model tools/worker-loop.sh [max_runs]   # default 200; stop early: touch .team/STOP
#
# MODEL is required: the system default model can change under us.
# Guards (from /data/agent-loop, see docs/04-failure-modes.md there):
#   - unread reviewer messages are pasted INTO the prompt, so they can't be skipped;
#   - each run is a fresh session with a time limit (RUN_TIMEOUT, default 90 min)
#     and a watchdog that kills a run whose output repeats (tools/loop-lib.sh);
#   - 3 runs with no commit and no message: the loop stops and escalates;
#   - a lock, so two loops can't run at once.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
LANE="$ROOT/.team"; MAIN_REPO="$ROOT"
. "$ROOT/tools/loop-lib.sh"
MAX="${1:-200}"; LOG="$LANE/worker-loop.log"; NP_MAX="${NO_PROGRESS_MAX:-3}"
[ -n "${MODEL:-}" ] || { echo "set MODEL=provider/model (e.g. MODEL=openrouter/z-ai/glm-5.3-flash)" >&2; exit 2; }
exec 9>"$LANE/worker.lock"; flock -n 9 || { echo "a worker loop is already running" >&2; exit 1; }
BASE_PROMPT='Resume. Follow AGENTS.md exactly and continue .team/PLAN.md and the latest reviewer instructions. Before you stop: update .team/STATE.md, commit, and send your status with tools/team.sh send worker.'
rm -f "$LANE/STOP" "$LANE/or-start"; np=0
for i in $(seq 1 "$MAX"); do
  g=$(spend_gate) || { echo "$g" | tee -a "$LOG"; escalate "spend gate stopped the loop ($MODEL)" "$g"; break; }
  [ -n "$g" ] && echo "$g" >> "$LOG"
  [ -f "$LANE/STOP" ] && { echo "STOP file found" | tee -a "$LOG"; break; }
  # Long tests the worker queued last run: run them here, with no model involved.
  if ls .team/tests/pending/*.cmd >/dev/null 2>&1; then
    echo "--- running queued tests (no model) $(date '+%T')" | tee -a "$LOG"; tools/testq.sh run
  fi
  results=$(tools/testq.sh summaries 2>/dev/null)
  unread=$(tools/team.sh check reviewer 2>/dev/null || true)
  prompt="$BASE_PROMPT

For any test or command that takes more than about 3 minutes (walk_all.sh, the full ctf_rules.js, check_all.sh, loadtime and load tests), DON'T run it yourself and DON'T poll or sleep. Queue it with: tools/testq.sh submit <name> -- <command>. Then update STATE.md, commit, and END your run. The loop runs it for free and gives you the result next run."
  [ -n "$results" ] && prompt="$prompt

RESULTS OF THE TESTS YOU QUEUED:

$results"
  [ -n "$unread" ] && prompt="$prompt

NEW MESSAGES FROM THE REVIEWER. Act on these FIRST:

$unread"
  before=$(progress_mark)
  echo "=== run $i/$MAX $(date '+%F %T') model=$MODEL unread=$([ -n "$unread" ] && echo yes || echo no) ===" | tee -a "$LOG"
  run_model "$LOG" "$MODEL" "$prompt"; rc=$?
  echo "--- run $i exited $rc $(date '+%T')" | tee -a "$LOG"
  if [ "$(progress_mark)" = "$before" ] && ! ls .team/tests/pending/*.cmd >/dev/null 2>&1; then np=$((np + 1)); else np=0; fi
  if [ "$np" -ge "$NP_MAX" ]; then
    echo "no progress in $np runs; stopping" | tee -a "$LOG"
    escalate "main lane worker made no progress in $np runs" "Loop stopped. Last log lines:
$(tail -15 "$LOG")"
    break
  fi
  last=$(ls .team/msg | grep -- '-worker\.md$' | sort | tail -1)
  if [ -n "$last" ] && grep -qE '^# *(BLOCKED|DECISION)' ".team/msg/$last"; then
    echo "worker is waiting on the reviewer ($last)" | tee -a "$LOG"
    cursor=$(cat .team/read-worker 2>/dev/null || echo 0000)
    tools/team.sh wait reviewer 7200 >/dev/null || { echo "no reviewer reply in 2h; stopping" | tee -a "$LOG"; break; }
    echo "$cursor" > .team/read-worker
  fi
  sleep 5
done

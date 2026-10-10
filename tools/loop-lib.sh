# Shared helpers for worker-loop.sh and lead-loop.sh (sourced, not run).
#
# run_model LOG MODEL PROMPT [extra opencode args...]
#   Runs one OpenCode session with two guards:
#   - a hard time limit (RUN_TIMEOUT seconds, default 5400);
#   - a repetition watchdog: every 60 s it looks at the newest 40 non-empty
#     log lines. If there are no more than 4 distinct ones, the model is
#     repeating itself ("the task is complete, I will stop responding..."),
#     so the run is killed and 99 is returned.
run_model() {
  local log="$1" model="$2" prompt="$3"; shift 3
  setsid timeout --kill-after=60 "${RUN_TIMEOUT:-5400}" \
    opencode run --thinking "$@" -m "$model" --dir "$ROOT" "$prompt" >>"$log" 2>&1 &
  local pid=$! seen bad=0
  seen=$(wc -l < "$log")
  while kill -0 "$pid" 2>/dev/null; do
    sleep 60
    # Judge only the lines written since the last check. Need 40+ new lines
    # with no more than 4 distinct ones on TWO checks in a row, so one burst of
    # repetitive tool output (a test printing the same position 40 times) isn't
    # mistaken for a model stuck in a loop.
    local now new; now=$(wc -l < "$log")
    new=$(sed -n "$((seen + 1)),${now}p" "$log" | grep -v '^\s*$'); seen=$now
    if [ "$(printf '%s\n' "$new" | grep -c .)" -ge 40 ] && \
       [ "$(printf '%s\n' "$new" | sort -u | wc -l)" -le 4 ]; then bad=$((bad + 1)); else bad=0; fi
    if [ "$bad" -ge 2 ]; then
      echo "!!! watchdog: output has been repeating for 2 minutes; killing the run" >> "$log"
      kill -- -"$pid" 2>/dev/null; sleep 5; kill -9 -- -"$pid" 2>/dev/null
      wait "$pid" 2>/dev/null; return 99
    fi
  done
  wait "$pid"
}

# progress_mark: a fingerprint of git HEAD plus the number of mailbox files.
# It changes whenever the agent committed or sent anything.
progress_mark() { echo "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)-$(ls "$LANE/msg" 2>/dev/null | wc -l)"; }

# escalate TITLE BODY: tell the manager through the main project's mailbox, if one is set.
escalate() {
  [ -n "${MAIN_REPO:-}" ] && [ -x "$MAIN_REPO/tools/team.sh" ] || return 0
  printf '# ESCALATE: %s\n\n%s\n' "$1" "$2" | "$MAIN_REPO/tools/team.sh" send worker >/dev/null 2>&1 || true
}

# Spend gate for paid OpenRouter models. Free (":free") and non-OpenRouter models pass.
# A paid model must be started with OR_BUDGET=<usd this loop may spend>; the loop reads the
# key's usage at its first run ($LANE/or-start) and stops (with ESCALATE) once usage passes start + budget.
# One run can overshoot by its own cost (GLM: ~$0.2-1.1 per run).
spend_gate() {
  case "$MODEL" in openrouter/*:free) return 0 ;; openrouter/*) ;; *) return 0 ;; esac
  [ -n "${OR_BUDGET:-}" ] || { echo "spend gate: paid model $MODEL needs OR_BUDGET=<usd>"; return 1; }
  local spend="$MAIN_REPO/tools/or-spend.sh" now
  now=$("$spend" | cut -d' ' -f1) || { echo "spend gate: cannot read OpenRouter usage"; return 1; }
  # Kept in a file because the gate runs in a subshell; the loop removes it when it starts.
  # OpenRouter usage is account-wide, so lanes running together must share ONE budget:
  # OR_POOL=<file> makes every lane that names it use the same baseline (the first lane
  # to start writes it; delete the file to start a new pool).
  local base="${OR_POOL:-$LANE/or-start}"
  [ -s "$base" ] || echo "$now" > "$base"
  local OR_START; OR_START=$(cat "$base")
  python3 -c 'import sys;sys.exit(0 if float(sys.argv[1])<float(sys.argv[2])+float(sys.argv[3]) else 1)' \
    "$now" "$OR_START" "$OR_BUDGET" \
    || { echo "spend gate: spent \$$(python3 -c "print('%.2f'%($now-$OR_START))") of \$$OR_BUDGET"; return 1; }
  echo "spend gate: \$$(python3 -c "print('%.2f'%($now-$OR_START))") of \$$OR_BUDGET used"
}

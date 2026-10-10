#!/usr/bin/env bash
# Container entrypoint: one image, one process namespace, one published port.
#
#   docker run -e GATE_SECRET=... -p 8080:8080 qwtf
#
# Starts the FTE dedicated server on the container's loopback (FTE_PORT, default
# 27500), waits for its TCP listener, then brings the gate up on GATE_PORT
# (default 8080). Only the gate's port is published, which is PROJECT.md's
# "single origin, single port": FTE binds 0.0.0.0 inside the container (the
# plain-port form, run_server.sh --host is only a log label), but the container
# boundary is the namespace that keeps the game port unreachable from outside --
# the same shape the systemd units get from the source-based firewall rules.
#
# Environment:
#   GATE_SECRET   REQUIRED. The HMAC secret for session tokens. Fails before
#                 anything starts if unset -- the gate's dev-secret warning is
#                 not an acceptable default outside the dev box.
#   GATE_PORT     the port the gate listens on      (default 8080)
#   FTE_PORT      the game port, container-internal (default 27500)
#   QWTF_MAP      the map the server loads          (default forts: the only
#                   BSP the served snapshot ships, since 0479)
#   QWTF_APP_DIR  where the app lives               (default /app; host tests
#                 of this script override it to the repo root)
#   QWTF_GAMEDIR  the server's --gamedir            (default $APP_DIR/web; host
#                 tests stage their own so nothing writes into the served tree)
#   GATE_ENV      set "production" only in front of TLS termination: the gate
#                 then marks the session cookie Secure, which plain-HTTP
#                 localhost browsers refuse to store. Left unset by default
#                 so `docker run -p 8080:8080` works as documented in PLAN.md.
#
# Both processes log to the container's stdout/stderr, so `docker logs` is the
# server log -- the same bytes the units write to their log files.

set -euo pipefail

APP_DIR="${QWTF_APP_DIR:-/app}"
cd "$APP_DIR"

: "${GATE_SECRET:?FATAL: GATE_SECRET is required (docker run -e GATE_SECRET=...)}"

FTE_PORT="${FTE_PORT:-27500}"
GATE_PORT="${GATE_PORT:-8080}"
QWTF_MAP="${QWTF_MAP:-forts}"
GAMEDIR="${QWTF_GAMEDIR:-$APP_DIR/web}"

# The gate reads a snapshot directory; in the image that is the web/ copied at
# build time (the frozen layer). Override with GATE_ROOT if you mount your own.
GATE_ROOT="${GATE_ROOT:-$APP_DIR/web}"
export GATE_ROOT
[ -f "$GATE_ROOT/index.html" ] || {
  echo "FATAL: GATE_ROOT=$GATE_ROOT has no index.html (the served snapshot)" >&2; exit 1; }
[ -f "$GATE_ROOT/id1/qwprogs.dat" ] || {
  echo "FATAL: GATE_ROOT=$GATE_ROOT has no id1/qwprogs.dat (the game content)" >&2; exit 1; }

bash scripts/run_server.sh --port "$FTE_PORT" --host 127.0.0.1 \
     --gamedir "$GAMEDIR" --map "$QWTF_MAP" &
SV_PID=$!

# The gate proxies WebSocket upgrades to the game server's TCP listener, so
# wait for it before starting the gate: bash's /dev/tcp connect is the probe
# install_service.sh's self-check uses for the same purpose.
up=0
for _ in $(seq 1 150); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$FTE_PORT") 2>/dev/null; then up=1; break; fi
  sleep 0.1
done
if [ "$up" != 1 ]; then
  echo "FATAL: game server did not listen on 127.0.0.1:$FTE_PORT within 15 s" >&2
  kill "$SV_PID" 2>/dev/null || true
  exit 1
fi
echo "container: game server up on 127.0.0.1:$FTE_PORT (pid $SV_PID), starting the gate on :$GATE_PORT"

node server/gate.js &
GATE_PID=$!

# TERM (docker stop) or INT (Ctrl-C on docker run): take both down, cleanly.
# shellcheck disable=SC2317  # reached by signal, not by control flow
term() {
  trap - TERM INT
  kill -TERM "$GATE_PID" "$SV_PID" 2>/dev/null || true
  wait "$GATE_PID" "$SV_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT

# If EITHER half dies the container is no good to anyone: take the other down
# and exit non-zero, so a Restart=always orchestrator restarts the pair.
set +e
wait -n "$GATE_PID" "$SV_PID"
rc=$?
set -e
echo "container: a process exited (rc=$rc); stopping the other" >&2
kill -TERM "$GATE_PID" "$SV_PID" 2>/dev/null || true
wait || true
exit "$rc"

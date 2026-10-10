#!/usr/bin/env bash
# M6 container image (PLAN.md): "one container image (Dockerfile: gate + FTE +
# web snapshot) that runs locally with `docker run -p 8080:8080`. The secret
# comes from an environment variable."
#
# Two layers of verification, in one verdict line:
#
#   1. ALWAYS -- the ENTRY LOGIC as a plain process on this host. The exact
#      process tree the container runs: the entrypoint starts fteqw-sv on the
#      loopback game port, waits for its TCP listener, brings the gate up, and
#      takes both down on SIGTERM. Asserted:
#        a. no GATE_SECRET -> refuses before anything starts (the dev-secret
#           fallback is not an acceptable container default);
#        b. the landing page answers through the gate;
#        c. the WebSocket upgrade is refused without a session (403, not a
#           proxy pass-through);
#        d. WITH a session the gate reaches the game server and FTE itself
#           answers the upgrade (101 Switching Protocols) -- this is the
#           gate-to-FTE port wiring, which only a real handshake proves;
#        e. SIGTERM to the entrypoint (docker stop) closes BOTH listeners and
#           exits 0 -- a stop that leaks the game server is a port-eating bug.
#
#   2. IF a docker daemon answers -- the IMAGE itself: docker build, docker
#      run -p <port>:8080, and the same HTTP checks through the published port.
#      This box has docker.service MASKED (the owner disabled the system
#      daemon), so here layer 2 is skipped with that stated, never silently:
#      the verdict line names what was proven and what was not.
#
# Host-mode demo discipline (0374): the server's --gamedir is a staged copy
# (symlinks to web/id1 plus its own demos dir), so nothing this test runs
# writes into web/. The GATE_ROOT stays web/, which it serves read-only.
#
# Output for tests/check_all.sh's `container` row: the single line
#   container: PASS (...)   or   container: FAIL (...)
# plus per-check ok/FAIL lines with reasons.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ART="$ROOT/tests/artifacts/container"
mkdir -p "$ART"
LOG="$ART/run.log"
: >"$LOG"

RC=0
ok()   { printf '  ok   %s\n' "$1" | tee -a "$LOG"; }
fail() { printf '  FAIL %s\n' "$1" | tee -a "$LOG"; RC=1; }
note() { printf '  --   %s\n' "$1" | tee -a "$LOG"; }

# ------------------------------------------------------------------ two ports
claim_ports() {
  node -e '
    const net = require("net");
    const got = [];
    let waiting = 2;
    const srv = () => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        got.push(s.address().port);
        if (got.length === waiting) { s.close(); got.forEach(p => console.log(p)); }
        else s.close(() => {});
      });
    };
    srv(); srv();
  ' 2>/dev/null
}

# A raw HTTP request over bash /dev/tcp; prints the first status line.
# HTTP/1.1 wants CRLF: the caller's request uses plain LF between lines and
# gets each one promoted here. (Bare LF made llhttp drop the Upgrade header and
# the gate answered its plain-GET 400 -- the suite's own rawUpgrade uses \r\n.)
raw_status() {  # raw_status <port> <request>
  local port="$1" req="$2" line=""
  if ! exec 3<>"/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    echo "CONN-REFUSED"; return
  fi
  printf '%s\r\n\r\n' "${req//$'\n'/$'\r\n'}" >&3
  IFS= read -r -t 5 line <&3 || true
  exec 3<&- 3>&-
  printf '%s\n' "${line:-NO-RESPONSE}"
}

wait_for() {  # wait_for <port> <seconds> -> 0 when the port accepts
  local port="$1" n="$2"
  for _ in $(seq 1 $((n * 5))); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3<&- 3>&-; return 0; fi
    sleep 0.2
  done
  return 1
}

gone_by() {  # gone_by <port> <seconds> -> 0 when nothing listens there
  local port="$1" n="$2"
  for _ in $(seq 1 $((n * 5))); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then return 0; fi
    exec 3<&- 3>&-
    sleep 0.2
  done
  return 1
}

# ----------------------------------------------------------- static preflight
if [ -x "$ROOT/third_party/shellcheck/shellcheck-v0.10.0/shellcheck" ]; then
  if "$ROOT/third_party/shellcheck/shellcheck-v0.10.0/shellcheck" "$ROOT/docker/entrypoint.sh" \
      >>"$LOG" 2>&1; then
    ok "entrypoint passes shellcheck"
  else
    fail "entrypoint fails shellcheck (see $LOG)"
  fi
else
  note "shellcheck not present, skipped"
fi

if bash -n "$ROOT/docker/entrypoint.sh" && bash -n "$ROOT/scripts/run_server.sh"; then
  ok "entrypoint and run_server.sh parse"
else
  fail "bash -n fails on the entrypoint or run_server.sh"
fi

# Every path the Dockerfile copies must exist, or the build dies mid-way.
# Stage-internal sources (COPY --from=build) are the build stage's own outputs,
# not repo files: only plain COPY sources are checked.
miss=""
while IFS= read -r p; do
  [ -e "$ROOT/$p" ] || miss="$miss $p"
done < <(sed -n 's/^COPY \([^ ]*\) .*/\1/p' "$ROOT/Dockerfile" | grep -v '^--')
if [ -z "$miss" ]; then
  ok "every COPY source in the Dockerfile exists"
else
  fail "Dockerfile COPY sources missing:$miss"
fi

if grep -q '^third_party$' "$ROOT/.dockerignore"; then
  ok ".dockerignore keeps third_party out of the build context"
else
  fail ".dockerignore does not exclude third_party (the context would carry it)"
fi

if grep -q 'QWTF_FETCH_ONLY=fteqw' "$ROOT/Dockerfile"; then
  ok "the image build fetches fteqw only (one pin list, no asset clones)"
else
  fail "the image build does not narrow the third-party fetch"
fi

# ---------------------------------------------------- a) secret is required
out="$(env -u GATE_SECRET QWTF_APP_DIR="$ROOT" timeout 10 \
      bash "$ROOT/docker/entrypoint.sh" 2>&1)"
src=$?
if [ "$src" -ne 0 ] && printf '%s' "$out" | grep -q 'GATE_SECRET'; then
  ok "no GATE_SECRET -> the entrypoint refuses before starting anything (rc=$src)"
else
  fail "no GATE_SECRET: expected a fast refusal naming GATE_SECRET, got rc=$src"
fi

# ------------------------------------------- b,c,d) the real process tree
PORTS="$(claim_ports)"
FTE_PORT="$(printf '%s\n' "$PORTS" | sed -n 1p)"
GATE_PORT="$(printf '%s\n' "$PORTS" | sed -n 2p)"
if [ -n "$FTE_PORT" ] && [ -n "$GATE_PORT" ] && [ "$FTE_PORT" != "$GATE_PORT" ]; then :; else
  fail "could not claim two free ports"; exit 1
fi

# The staged gamedir: symlinks to web/id1's content, its own maps and demos.
STAGE="$ART/gamedir"
rm -rf "$STAGE"
mkdir -p "$STAGE/id1/maps" "$STAGE/fte/demos"
for e in "$ROOT"/web/id1/*; do
  [ "$(basename "$e")" = maps ] && continue
  ln -s "$e" "$STAGE/id1/$(basename "$e")"
done
for e in "$ROOT"/web/id1/maps/*; do ln -s "$e" "$STAGE/id1/maps/$(basename "$e")"; done

ep_log="$ART/entrypoint.log"
: >"$ep_log"
QWTF_APP_DIR="$ROOT" QWTF_GAMEDIR="$STAGE" \
GATE_SECRET="container-test-secret" FTE_PORT="$FTE_PORT" GATE_PORT="$GATE_PORT" \
  bash "$ROOT/docker/entrypoint.sh" >"$ep_log" 2>&1 &
EP=$!

if wait_for "$GATE_PORT" 30; then
  ok "entrypoint brought the gate up (landing port :$GATE_PORT, game :$FTE_PORT)"
else
  fail "the gate never came up on :$GATE_PORT"
  tail -20 "$ep_log" | tee -a "$LOG" >/dev/null
fi

landing="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$GATE_PORT/" 2>>"$LOG")"
if [ "$landing" = 200 ]; then
  ok "the landing page answers through the gate (200)"
else
  fail "landing page through the gate: $landing (want 200)"
fi

refused="$(raw_status "$GATE_PORT" \
  "GET /play/ws HTTP/1.1
Host: 127.0.0.1:$GATE_PORT
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: fteqw")"
if printf '%s' "$refused" | grep -q ' 403 '; then
  ok "the WebSocket upgrade is refused without a session (403, FTE untouched)"
else
  fail "ws upgrade without a session: '$refused' (want 403)"
fi

cookie_jar="$ART/cookies.txt"
ses="$(curl -s -c "$cookie_jar" -X POST --max-time 5 \
       "http://127.0.0.1:$GATE_PORT/api/session" 2>>"$LOG")"
token="$(grep -oP 'qwtf\t\K\S+' "$cookie_jar" 2>/dev/null | head -1)"
if [ -n "$token" ]; then
  ok "a session issues (POST /api/session)"
else
  fail "no session cookie: '$ses'"
fi

handshake="$(raw_status "$GATE_PORT" \
  "GET /play/ws HTTP/1.1
Host: 127.0.0.1:$GATE_PORT
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: fteqw
Cookie: qwtf=$token")"
if printf '%s' "$handshake" | grep -q ' 101 '; then
  ok "with a session FTE answers the upgrade itself (101 -- gate-to-game wiring proven)"
else
  fail "ws upgrade with a session: '$handshake' (want 101 from the game server)"
fi

# ------------------------------------------- e) docker stop takes both down
kill -TERM "$EP" 2>/dev/null
term_rc=0
wait "$EP" 2>/dev/null || term_rc=$?
if [ "$term_rc" = 0 ]; then
  ok "SIGTERM to the entrypoint exits 0"
else
  fail "SIGTERM to the entrypoint: rc=$term_rc (want 0)"
fi
if gone_by "$GATE_PORT" 5 && gone_by "$FTE_PORT" 5; then
  ok "docker stop closes both listeners (gate and game)"
else
  fail "something still listens after SIGTERM (gate :$GATE_PORT, game :$FTE_PORT)"
fi

# ------------------------------------------------------------ 2) the image
if docker info >/dev/null 2>&1; then
  note "a docker daemon answered -- building and running the image"
  img="qwtf-test-$$"
  if docker build -q -t "$img" "$ROOT" >>"$LOG" 2>&1; then
    ok "docker build succeeded"
    cid="$(docker run -d -e GATE_SECRET=image-test -p "$GATE_PORT":8080 "$img" 2>>"$LOG")"
    if [ -n "$cid" ] && wait_for "$GATE_PORT" 60; then
      landing="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$GATE_PORT/")"
      if [ "$landing" = 200 ]; then
        ok "the image serves the landing page through the published port"
      else
        fail "image landing through the published port: $landing"
      fi
      dock_handshake="$(raw_status "$GATE_PORT" \
        "GET /play/ws HTTP/1.1
Host: 127.0.0.1:$GATE_PORT
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: fteqw")"
      if printf '%s' "$dock_handshake" | grep -q ' 403 '; then
        ok "the image refuses an unauthenticated upgrade through the published port"
      else
        fail "image ws refusal: '$dock_handshake' (want 403)"
      fi
    else
      fail "docker run did not serve through the published port"
    fi
    docker rm -f "$cid" >/dev/null 2>&1 || true
    docker rmi "$img" >/dev/null 2>&1 || true
  else
    fail "docker build failed (see $LOG)"
  fi
else
  note "no docker daemon answered (docker.service is masked on this box): the image itself is NOT verified here; the entry logic above is the container's real process tree"
fi

# ----------------------------------------------------------------- verdict
if [ "$RC" = 0 ]; then
  echo "container: PASS (entry logic; image layer: $(docker info >/dev/null 2>&1 && echo 'built and served' || echo 'daemon unavailable, entry logic only'))"
else
  echo "container: FAIL ($LOG)"
fi
exit "$RC"

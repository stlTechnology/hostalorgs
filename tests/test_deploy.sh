#!/usr/bin/env bash
# The deploy must give the page and the server the SAME bytes.
#
# Reviewer 0054: the owner's first play-test failed with "Host_EndGame: Server
# disconnected - map model file does not match (maps/corridor.bsp)". The page
# served a freshly rebuilt corridor.bsp while the server still held the old one.
# So the property worth testing is not "the deploy exists" but "what the page
# serves and what the server reads are the same file".
#
# Checks:
#   1. scripts/deploy_snapshot.sh produces web/index.html and DEPLOYED_COMMIT.
#   2. The commit recorded matches the commit asked for.
#   3. The map served over HTTP has the same md5 as the map in the deploy dir
#      the server is pointed at.
#   4. install_service.sh points BOTH units at that one directory, so a rebuild
#      of the working tree cannot reach a running play-test.
#   5. The snapshot does not change when the working tree is modified -- the
#      property that actually fixes the owner's disconnect.
#
# No root and no systemd: this exercises the deploy, the page server and the
# unit templates, which is where the bug was.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
FAILED=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=$((FAILED+1)); }

COMMIT="$(git rev-parse HEAD)"

# Its own deploy base, not the shared build/deploy.
#
# deploy_snapshot.sh re-extracts into build/deploy/<commit> on every run, and that
# is where a real `sudo install_service.sh --deploy` puts the live snapshot. When
# one of those has been installed the directory is root-owned, so this test --
# which runs as a normal user -- failed on "Permission denied" for every file in
# it and then asserted against an empty path. Measured after the owner's install:
#   md5sum: /web/id1/maps/corridor.bsp: No such file or directory
#   FAIL: 3 checks
# The test is about the deploy mechanism, not about the live deployment, so it
# gets its own directory and cannot fight one.
DEPLOY_TMP="$(mktemp -d /tmp/qwtf-deploy-XXXXXX)"
export QWTF_DEPLOY_BASE="$DEPLOY_TMP"
trap 'rm -rf "$DEPLOY_TMP"; rm -f /tmp/qwtf_corridor.map.bak' EXIT

# 1 + 2: the snapshot exists and says what it is.
DIR="$(bash scripts/deploy_snapshot.sh "$COMMIT")"
[ -f "$DIR/web/index.html" ] \
  && ok "snapshot has web/index.html ($DIR)" \
  || fail "snapshot has no web/index.html ($DIR)"

RECORDED="$(cat "$DIR/DEPLOYED_COMMIT" 2>/dev/null || echo none)"
[ "$RECORDED" = "$COMMIT" ] \
  && ok "DEPLOYED_COMMIT records the deployed commit ($RECORDED)" \
  || fail "DEPLOYED_COMMIT is '$RECORDED', expected '$COMMIT'"

# 3: what the page serves == what the server reads.
# 0479: corridor.bsp ships with the tests now (tests/fixtures/maps/); the map
# the deployment actually serves and the server reads is forts.bsp, so the
# same-bytes check is made against THAT.
SRV_MD5="$(md5sum "$DIR/web/id1/maps/forts.bsp" | cut -d' ' -f1)"
node tools/serve.js --port "$PORT" --root "$DIR/web" >/dev/null 2>&1 &
SRV_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null && break
  sleep 0.2
done
HTTP_MD5="$(curl -fsS "http://127.0.0.1:$PORT/id1/maps/forts.bsp" | md5sum | cut -d' ' -f1)"
kill "$SRV_PID" 2>/dev/null
wait "$SRV_PID" 2>/dev/null

[ "$SRV_MD5" = "$HTTP_MD5" ] \
  && ok "served forts.bsp md5 equals the deploy dir the server reads ($SRV_MD5)" \
  || fail "page serves $HTTP_MD5 but the server reads $SRV_MD5"

# 4: both units point at ONE deploy dir.
#
# The page is no longer tools/serve.js -- it is the gate (M3b), which takes its
# root from the environment rather than a command-line flag. So this checks the
# server's --gamedir and the gate's GATE_ROOT both expand to $WEBROOT.
SV_GAMEDIR="$(grep -E '^ExecStart=.*--gamedir' scripts/install_service.sh | grep -oE '\-\-gamedir [^ ]+' | head -1 | awk '{print $2}')"
WEB_ROOT="$(grep -E '^Environment=GATE_ROOT=' scripts/install_service.sh | head -1 | sed 's/^Environment=GATE_ROOT=//')"
if [ "$SV_GAMEDIR" = '$WEBROOT' ] && [ "$WEB_ROOT" = '$WEBROOT' ]; then
  ok "both units use the same \$WEBROOT variable"
else
  fail "units disagree: server '--gamedir $SV_GAMEDIR', gate 'GATE_ROOT=$WEB_ROOT'"
fi

# And the deployed unit must be the gate, never tools/serve.js: serve.js has an
# /api/upload that spawns a process per request and a /recordings/ listing.
if grep -qE '^ExecStart=.*tools/serve\.js' scripts/install_service.sh; then
  fail "the deployed unit still runs tools/serve.js instead of the gate"
else
  ok "the deployed page unit is the gate, not tools/serve.js"
fi

# 5: rebuilding the working tree must not touch the snapshot.
cp maps/corridor.map /tmp/qwtf_corridor.map.bak 2>/dev/null || true
printf '\n// deployed-snapshot test edit\n' >> maps/corridor.map
AFTER="$(md5sum "$DIR/web/id1/maps/corridor.bsp" | cut -d' ' -f1)"
cp /tmp/qwtf_corridor.map.bak maps/corridor.map 2>/dev/null || true
[ "$SRV_MD5" = "$AFTER" ] \
  && ok "editing the working tree leaves the snapshot untouched" \
  || fail "the snapshot changed when the working tree was edited"

echo
if [ "$FAILED" -eq 0 ]; then echo "PASS"; else echo "FAIL: $FAILED checks"; fi
exit $((FAILED > 0))
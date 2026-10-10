#!/usr/bin/env bash
# The installer has to be RUN to be trusted, and the last version had two bugs
# that only a run could have found (reviewer 0082):
#
#   1. `while [ $# -gt 0; do` is missing the ]. `[` exits 2 on every call, so
#      the loop body never ran: --deploy and --uninstall were silently
#      IGNORED. `sudo install_service.sh --uninstall` would have INSTALLED.
#   2. Under `set -u`, `[ -n "$DEPLOY_COMMIT_EXPLICIT" ]` aborted with
#      "unbound variable" whenever --deploy had not been parsed -- which is
#      every plain install -- AFTER the units were written and daemon-reload
#      had run, so the units existed and had never been started.
#
# Neither shows up in `bash -n`, and neither shows up in shellcheck at the time
# (shellcheck does catch #1 now; it did not catch #2 because the variable was
# assigned in a branch it could not prove unreachable). So this test runs the
# script, as a normal user, with stub systemctl/iptables on PATH and a temp unit
# directory.
#
# Checks:
#   A  install          writes both units with the right ExecStart and ports
#   B  the secret       is NOT in the unit text, and IS in a 0600 file
#   C  no live probe    the self-check does not run in a test install
#   D  --deploy         parses, snapshots the commit, and restarts BOTH units
#   E  --uninstall      removes both units and the secret, and does NOT install
#   F  busy port        refuses, and writes NOTHING (units written last, not first)
#   G  dry run          prints and changes nothing
#   H  bad arguments    fail loudly instead of being ignored
#   I  --dry-run        does not need root and does not touch the unitdir
#
# The unit directory is a temp dir, which is what makes root unnecessary: the
# script only demands root when it would write into /etc/systemd/system.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d /tmp/qwtf-inst-XXXXXX)"
trap 'rm -rf "$TMP"; rm -f "$TMP/../qwtf-deploy-INSTALLCOMMIT" 2>/dev/null' EXIT
FAILED=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=$((FAILED+1)); }

# A stub systemctl: records every call, and reports both units as active, so the
# installer's own "are they up" logic cannot fail the test for a reason that has
# nothing to do with the installer.
STUB="$TMP/bin"; mkdir -p "$STUB"
cat > "$STUB/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
case "$1" in
  status) echo "stub status: $*"; exit 0 ;;
  is-active) exit 0 ;;
  show)
    # `show -p <prop> --value <unit>`. QWTF_STUB_MAINPID_<unit> and
    # QWTF_STUB_CGROUP_<unit> let a test say "this unit is running with that pid".
    prop=""; unit=""
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        -p) prop="$2"; shift 2 ;;
        --value) shift ;;
        -*) shift ;;
        *) unit="$1"; shift ;;
      esac
    done
    key="$(printf '%s' "$unit" | tr -c 'A-Za-z0-9' '_')"
    case "$prop" in
      MainPID) eval "printf '%s' \"\${QWTF_STUB_MAINPID_$key:-0}\"" ;;
      ControlGroup) eval "printf '%s' \"\${QWTF_STUB_CGROUP_$key:-}\"" ;;
      *) : ;;
    esac
    exit 0 ;;
esac
exit 0
EOF
chmod +x "$STUB/systemctl"

# Two free ports, so the busy check has nothing to find.
read -r SV_PORT WEB_PORT <<<"$(python3 -c '
import socket
socks = []
ports = []
for _ in range(2):
    sk = socket.socket()
    sk.bind(("127.0.0.1", 0))
    ports.append(sk.getsockname()[1])
    socks.append(sk)
print(*ports)
for sk in socks:
    sk.close()')"

run_installer() {
  # run_installer <unitdir> <args...>; PATH carries the stub systemctl
  local unitdir="$1"; shift
  PATH="$STUB:$PATH" \
  STUB_LOG="$TMP/systemctl.log" \
  QWTF_UNITDIR="$unitdir" \
  QWTF_SECRETDIR="$unitdir/etc" \
  QWTF_SYSTEMCTL="$STUB/systemctl" \
  QWTF_SV_PORT="$SV_PORT" \
  QWTF_WEB_PORT="$WEB_PORT" \
  QWTF_DEPLOY_BASE="${DEPLOY_BASE_OVERRIDE:-$TMP/deploy}" \
  QWTF_USER="$(id -un)" \
  QWTF_SELFCHECK=0 \
  QWTF_STUB_MAINPID_qwtf_server_service="${OWN_SV_PID:-0}" \
  QWTF_STUB_MAINPID_qwtf_web_service="${OWN_WEB_PID:-0}" \
    bash scripts/install_service.sh "$@" 2>&1
}

COMMIT="$(git rev-parse HEAD)"
: > "$TMP/systemctl.log"

# ---------------------------------------------------------------- A: install
echo
echo "== A: plain install, as a normal user"
UD1="$TMP/units1"; out="$(run_installer "$UD1")"; rc=$?
[ "$rc" -eq 0 ] && ok "install exits 0" || fail "install exited $rc: $out"
[ -f "$UD1/qwtf-server.service" ] && ok "qwtf-server.service was written" \
  || fail "no qwtf-server.service in $UD1"
[ -f "$UD1/qwtf-web.service" ] && ok "qwtf-web.service was written" \
  || fail "no qwtf-web.service in $UD1"
grep -q "^ExecStart=$ROOT/scripts/run_server.sh --port $SV_PORT --host 127.0.0.1" \
  "$UD1/qwtf-server.service" \
  && ok "the server unit runs run_server.sh on $SV_PORT, loopback only" \
  || fail "wrong ExecStart: $(grep '^ExecStart' "$UD1/qwtf-server.service")"
grep -q "^ExecStart=/usr/bin/node $ROOT/server/gate.js" "$UD1/qwtf-web.service" \
  && ok "the page unit runs the gate" \
  || fail "wrong ExecStart: $(grep '^ExecStart' "$UD1/qwtf-web.service")"
grep -qE '^ExecStart=.*tools/serve\.js' "$UD1/qwtf-web.service" \
  && fail "the page unit still runs tools/serve.js (it has /api/upload)" \
  || ok "the page unit is the gate, not tools/serve.js"
grep -q "^Environment=GATE_PORT=$WEB_PORT" "$UD1/qwtf-web.service" \
  && ok "the gate is told the page port $WEB_PORT" || fail "no GATE_PORT in the unit"
# The map is explicit in the unit, so `systemctl cat qwtf-server` answers which
# map is live. forts is the default since 0479: only forts.bsp ships in the
# served tree (the alt BSPs moved to tests/fixtures/maps), so the old ctf
# default failed the installer's own snapshot guard on every fresh install.
grep -q -- "--map forts" "$UD1/qwtf-server.service" \
  && ok "the server unit loads forts by default" \
  || fail "no --map forts in the unit: $(grep '^ExecStart=' "$UD1/qwtf-server.service")"
grep -q -- "--map corridor" "$UD1/qwtf-server.service" \
  && fail "the unit still starts corridor, the M1 movement fixture" \
  || ok "corridor is no longer what the service starts"
out_map="$(run_installer "$TMP/units-map" --map corridor --deploy "$COMMIT")"
rc_map=$?
if [ "$rc_map" -ne 0 ] && printf '%s' "$out_map" | grep -q "no map 'corridor'"; then
  ok "--map of a map the snapshot does not ship is a loud FATAL (no silent fallback)"
else
  fail "--map corridor: expected a fatal naming the missing map, got rc=$rc_map"
fi
# An unknown map must be refused, not deployed: the server would load nothing and
# the player would look at the void.
out_badmap="$(run_installer "$TMP/units-badmap" --map nosuchmap --deploy "$COMMIT")"; rc_badmap=$?
[ "$rc_badmap" -ne 0 ] && ok "--map nosuchmap is refused (exit $rc_badmap)" \
  || fail "--map nosuchmap was accepted"
grep -q "no map 'nosuchmap'" <<< "$out_badmap" \
  && ok "and it says which maps there are" || fail "unhelpful: $out_badmap"
[ -f "$TMP/units-badmap/qwtf-server.service" ] \
  && fail "a refused map still wrote units" || ok "a refused map writes no units"
grep -q "gameport_firewall.sh add $SV_PORT" "$UD1/qwtf-server.service" \
  && ok "the firewall rule is in the server unit (ExecStartPre)" \
  || fail "no ExecStartPre firewall rule: the port would reopen on reboot"
grep -q "gameport_firewall.sh del $SV_PORT" "$UD1/qwtf-server.service" \
  && ok "and it is removed on stop (ExecStopPost)" || fail "no ExecStopPost"

# ---------------------------------------------------------------- B: the secret
echo
echo "== B: the session secret"
SECRET="$UD1/etc/gate.env"
if [ -f "$SECRET" ]; then
  ok "the secret is in a separate env file ($SECRET)"
  mode=$(stat -c '%a' "$SECRET")
  [ "$mode" = "600" ] && ok "that file is mode 0600" || fail "the secret file is mode $mode"
  grep -q "^GATE_SECRET=." "$SECRET" && ok "it holds a secret" || fail "no secret in the file"
  grep -q "^EnvironmentFile=$SECRET$" "$UD1/qwtf-web.service" \
    && ok "the unit points at it with EnvironmentFile=" \
    || fail "no EnvironmentFile line in the gate unit"
  # The whole point of reviewer 0082 item 4: a unit file is world-readable.
  if grep -qE "^Environment=GATE_SECRET=" "$UD1/qwtf-web.service"; then
    fail "the secret is IN the unit file, readable by every local user"
  else
    ok "the secret is NOT in the unit file"
  fi
  # And it must not be readable by "other" even if the mode were wrong.
  perm=$(stat -c '%a' "$SECRET")
  [ "${perm: -1}" = "0" ] && ok "no world/other access on the secret file" \
    || fail "the secret file grants other access (mode $perm)"
else
  fail "no secret file at $SECRET"
fi

# ---------------------------------------------------------------- C: no live probe
echo
echo "== C: the self-check does not run in a test install"
if grep -q 'self-check from the non-loopback address' <<< "$out"; then
  fail "install ran the network self-check against a real IP"
else
  ok "no network self-check during a test install"
fi

# ---------------------------------------------------------------- D: --deploy
echo
echo "== D: --deploy <commit>"
UD2="$TMP/units2"; : > "$TMP/systemctl.log"
out2="$(run_installer "$UD2" --deploy "$COMMIT")"; rc2=$?
[ "$rc2" -eq 0 ] && ok "--deploy exits 0" || fail "--deploy exited $rc2: $out2"
grep -q "systemctl daemon-reload" "$TMP/systemctl.log" \
  && ok "daemon-reload ran" || fail "no daemon-reload (the units would be unknown)"
# Both, never one: that is how the page and the server end up on different
# commits (reviewer 0054).
if grep -qE '^systemctl restart qwtf-server.service qwtf-web.service$' "$TMP/systemctl.log"; then
  ok "--deploy restarts BOTH units in one call"
else
  fail "--deploy did not restart both units: $(grep restart "$TMP/systemctl.log" | tr '\n' '|')"
fi
grep -q "deploying $COMMIT" <<< "$out2" && ok "it snapshotted $COMMIT" \
  || fail "the commit is not in the output"
[ -d "$TMP/deploy/$COMMIT/web" ] && ok "the snapshot exists on disk" \
  || fail "no snapshot at $TMP/deploy/$COMMIT/web"
grep -q -- "--gamedir $TMP/deploy/$COMMIT/web" "$UD2/qwtf-server.service" \
  && ok "the server reads the snapshot, not the working tree" \
  || fail "the server unit does not point at the snapshot"
grep -q "Environment=GATE_ROOT=$TMP/deploy/$COMMIT/web" "$UD2/qwtf-web.service" \
  && ok "the gate serves the same snapshot" || fail "the gate and server disagree"
# The stamp is written INTO the snapshot (0469): the menu footer fetches
# build.json, so the live page must show the DEPLOYED commit, and build.json
# is gitignored so git archive never ships one.
STAMP="$TMP/deploy/$COMMIT/web/build.json"
if [ -f "$STAMP" ]; then
  ok "the snapshot has a build stamp"
  STAMP_SHA=$(python3 -c "import json;print(json.load(open('$STAMP'))['sha'])")
  [ "$STAMP_SHA" = "${COMMIT:0:7}" ] \
    && ok "the stamp names the deployed commit (${COMMIT:0:7})" \
    || fail "stamped sha '$STAMP_SHA' is not the deployed ${COMMIT:0:7}"
else
  fail "no build.json in the snapshot; the live footer would say 'build unknown'"
fi
# A dry run writes nothing, and a stamp inside the snapshot it did not create
# would be exactly the kind of silent write dry runs exist to forbid.
rm -rf "$TMP/deploy-dry"
DEPLOY_BASE_OVERRIDE="$TMP/deploy-dry" \
  run_installer "$TMP/units-dry" --deploy "$COMMIT" --dry-run >/dev/null
[ ! -e "$TMP/deploy-dry" ] && ok "--dry-run still writes nothing" \
  || fail "--dry-run created $TMP/deploy-dry"
# The secret survives a redeploy of the SAME install, or the owner's cookie
# breaks on every deploy. Compared within one unit directory on purpose: two
# different directories are two different installs and should differ.
BEFORE=$(sed -n 's/^GATE_SECRET=//p' "$UD2/etc/gate.env")
run_installer "$UD2" --deploy "$COMMIT" >/dev/null
AFTER=$(sed -n 's/^GATE_SECRET=//p' "$UD2/etc/gate.env")
[ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ] \
  && ok "the secret is reused across a redeploy (cookies stay valid)" \
  || fail "the secret was regenerated on redeploy: '$BEFORE' then '$AFTER'"
# And it must differ between two separate installs.
[ "$BEFORE" != "$(sed -n 's/^GATE_SECRET=//p' "$SECRET")" ] \
  && ok "a separate install gets its own secret" || fail "two installs share a secret"

# ---------------------------------------------------------------- E: --uninstall
echo
echo "== E: --uninstall (this used to INSTALL instead)"
UD3="$TMP/units3"
# Install once, then uninstall, and check what is left.
run_installer "$UD3" >/dev/null
[ -f "$UD3/qwtf-server.service" ] || fail "the fixture install did not write units"
: > "$TMP/systemctl.log"
out3="$(run_installer "$UD3" --uninstall)"; rc3=$?
[ "$rc3" -eq 0 ] && ok "--uninstall exits 0" || fail "--uninstall exited $rc3: $out3"
[ -f "$UD3/qwtf-server.service" ] && fail "--uninstall left qwtf-server.service behind" \
  || ok "--uninstall removed qwtf-server.service"
[ -f "$UD3/qwtf-web.service" ] && fail "--uninstall left qwtf-web.service behind" \
  || ok "--uninstall removed qwtf-web.service"
[ -f "$UD3/etc/gate.env" ] && fail "--uninstall left the secret file behind" \
  || ok "--uninstall removed the secret file"
grep -qE '^systemctl disable --now qwtf-server.service qwtf-web.service' "$TMP/systemctl.log" \
  && ok "it stopped both units first" || fail "the units were not stopped"
# The bug in one assertion: uninstall must not have written anything back.
if grep -qE 'enable --now' "$TMP/systemctl.log"; then
  fail "--uninstall enabled the units -- it INSTALLED instead"
else
  ok "--uninstall did not enable anything (the [ \$# -gt 0; bug)"
fi
# And uninstalling again must not fail.
run_installer "$UD3" --uninstall >/dev/null; rc3b=$?
[ "$rc3b" -eq 0 ] && ok "--uninstall is idempotent" || fail "the second --uninstall exited $rc3b"

# ---------------------------------------------------------------- F: busy port
echo
echo "== F: a busy port refuses and writes nothing"
UD4="$TMP/units4"
# Hold the page port for real, then install.
python3 -c '
import socket, sys, time
sk = socket.socket()
sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sk.bind(("0.0.0.0", int(sys.argv[1])))
sk.listen(1)
time.sleep(20)' "$WEB_PORT" &
HOLDER=$!
sleep 1
out4="$(run_installer "$UD4")"; rc4=$?
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
[ "$rc4" -ne 0 ] && ok "install refuses while $WEB_PORT is held (exit $rc4)" \
  || fail "install claimed success with a busy port"
grep -q "REFUSING to install" <<< "$out4" && ok "it says which port and who holds it" \
  || fail "no REFUSING line: $out4"
# 0107: it must name the PROCESS, not print the whole ss line. The owner's box
# printed "pid 3214750, LISTEN 0 2 *:27510 ... users:((" -- the process name is in
# the users:(("...")) group.
if grep -qE 'held by: +pid [0-9]+ \([A-Za-z0-9_.:-]+\)' <<< "$out4"; then
  ok "the busy-port message names the process: $(grep -oE 'held by:.*' <<< "$out4")"
else
  fail "the busy-port message is not 'pid N (name)': $(grep 'held by' <<< "$out4")"
fi
# Reviewer 0082 item 5: the units used to be written BEFORE this check.
if [ -f "$UD4/qwtf-server.service" ] || [ -f "$UD4/qwtf-web.service" ]; then
  fail "a refused install left unit files behind"
else
  ok "a refused install leaves no unit files behind"
fi
[ -d "$UD4/etc" ] && { fail "a refused install wrote the secret"; } \
  || ok "a refused install writes no secret"

# ------------------------------------------- F2: our own units holding the ports
echo
echo "== F2: a redeploy must proceed when OUR OWN units hold the ports"
# Reviewer 0099: the owner's `sudo install_service.sh --deploy HEAD` was REFUSED
# by fteqw-sv and node -- which were qwtf-server and qwtf-web, the units the
# installer had just written. --deploy exists to restart them, so refusing there
# makes it useless for its own purpose. Refuse only for FOREIGN holders.
UDO="$TMP/units-own"
# Hold the page port with a real process, and tell the installer it is our unit's
# MainPID.
python3 -c '
import socket, sys, time
sk = socket.socket(); sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sk.bind(("0.0.0.0", int(sys.argv[1]))); sk.listen(1); time.sleep(25)' "$WEB_PORT" &
OWNER_PID=$!
sleep 1
out_own="$(OWN_WEB_PID=$OWNER_PID run_installer "$UDO" --deploy "$COMMIT")"; rc_own=$?
kill "$OWNER_PID" 2>/dev/null; wait "$OWNER_PID" 2>/dev/null
if [ "$rc_own" -eq 0 ]; then
  ok "--deploy proceeds when our own unit holds the port"
else
  fail "--deploy refused our own unit (exit $rc_own): $out_own"
fi
grep -q "OUR OWN unit" <<< "$out_own" \
  && ok "and it says which holder it accepted" || fail "no explanation: $out_own"
# A foreign holder must still be refused, or the check is useless.
python3 -c '
import socket, sys, time
sk = socket.socket(); sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sk.bind(("0.0.0.0", int(sys.argv[1]))); sk.listen(1); time.sleep(20)' "$WEB_PORT" &
FOREIGN_PID=$!
sleep 1
out_for="$(OWN_WEB_PID=0 run_installer "$TMP/units-for")"; rc_for=$?
kill "$FOREIGN_PID" 2>/dev/null; wait "$FOREIGN_PID" 2>/dev/null
[ "$rc_for" -ne 0 ] && ok "a FOREIGN holder is still refused (exit $rc_for)" \
  || fail "a foreign holder was accepted"
# Only one of the two units being ours must be enough: the game port belongs to
# qwtf-server and the page port to qwtf-web, and either may be up on its own.
python3 -c '
import socket, sys, time
sk = socket.socket(); sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sk.bind(("0.0.0.0", int(sys.argv[1]))); sk.listen(1); time.sleep(20)' "$WEB_PORT" &
ONE_PID=$!
sleep 1
out_one="$(OWN_WEB_PID=$ONE_PID run_installer "$TMP/units-one" --deploy "$COMMIT")"; rc_one=$?
kill "$ONE_PID" 2>/dev/null; wait "$ONE_PID" 2>/dev/null
[ "$rc_one" -eq 0 ] \
  && ok "only one of our units holding a port is enough to proceed" \
  || fail "refused although only our own unit held a port (exit $rc_one)"

# ------------------------------------------------------------- F3: the SHA
echo
echo "== F3: --deploy resolves a commit reference to a full SHA"
# Reviewer 0100: `--deploy HEAD` used HEAD as the directory name and as
# DEPLOYED_COMMIT, so nobody could tell what was live and every later
# `--deploy HEAD` re-extracted into the directory the running server reads.
UDH="$TMP/units-head"
out_head="$(DEPLOY_BASE_OVERRIDE=$TMP/deploy-head run_installer "$UDH" --deploy HEAD)"
short="$(git rev-parse --short HEAD)"
if [ -d "$TMP/deploy-head/$(git rev-parse HEAD)/web" ]; then
  ok "--deploy HEAD creates build/deploy/<full sha>/"
else
  fail "--deploy HEAD did not resolve: $(ls "$TMP/deploy-head" 2>/dev/null | tr '\n' ' ')"
fi
ls "$TMP/deploy-head" 2>/dev/null | grep -qx HEAD \
  && fail "the directory is still named HEAD" || ok "no directory named HEAD"
grep -q "$(git rev-parse HEAD)" <<< "$out_head" \
  && ok "and the full SHA is printed" || fail "the full SHA is not in the output: $out_head"
# A short SHA still works, because that is what a person copies.
out_short="$(DEPLOY_BASE_OVERRIDE=$TMP/deploy-short run_installer "$TMP/units-short" --deploy "$short")"
if [ -d "$TMP/deploy-short/$(git rev-parse HEAD)/web" ]; then
  ok "a short SHA resolves to the same full-SHA directory"
else
  fail "a short SHA did not resolve: $(ls "$TMP/deploy-short" 2>/dev/null | tr '\n' ' ')"
fi
# DEPLOYED_COMMIT must record the SHA, not the reference.
recorded="$(cat "$TMP/deploy-short/$(git rev-parse HEAD)/DEPLOYED_COMMIT" 2>/dev/null)"
if [ "$recorded" = "$(git rev-parse HEAD)" ]; then
  ok "DEPLOYED_COMMIT records the full SHA"
else
  fail "DEPLOYED_COMMIT is '$recorded', expected $(git rev-parse HEAD)"
fi
# Something that is not a commit must be refused, not deployed.
out_bad="$(QWTF_DEPLOY_BASE=$TMP/deploy-fail run_installer "$TMP/units-bad" --deploy nosuchthing)"
[ ! -d "$TMP/deploy-bad/nosuchthing" ] \
  && ok "--deploy nosuchthing creates nothing" || fail "--deploy nosuchthing deployed something"

# ---------------------------------------------------------------- G: dry run
echo
echo "== G: --dry-run"
UD5="$TMP/units5"
out5="$(run_installer "$UD5" --dry-run)"; rc5=$?
[ "$rc5" -eq 0 ] && ok "--dry-run exits 0" || fail "--dry-run exited $rc5: $out5"

# Reviewer 0088: --dry-run as a normal user with NO overrides at all. A dry run
# writes nothing, so needing sudo for it was pointless -- and it meant the one
# mode that can be run without an account on the box could not be run at all.
dry_out="$(PATH="$PATH" bash scripts/install_service.sh --dry-run 2>&1)"; dry_rc=$?
[ "$dry_rc" -eq 0 ] && ok "--dry-run works as a normal user with no overrides" \
  || fail "--dry-run needs root: exit $dry_rc: $(head -2 <<< "$dry_out")"
grep -q "run with sudo" <<< "$dry_out" \
  && fail "--dry-run still demands sudo" || ok "--dry-run does not demand sudo"
# And a dry run must not write, including not extracting a snapshot.
DEPLOY_DIR="$TMP/drydeploy"
before_count=$(find "$DEPLOY_DIR" -type f 2>/dev/null | wc -l)
PATH="$PATH" QWTF_DEPLOY_BASE="$DEPLOY_DIR" bash scripts/install_service.sh --dry-run >/dev/null 2>&1
after_count=$(find "$DEPLOY_DIR" -type f 2>/dev/null | wc -l)
[ "$before_count" -eq "$after_count" ] \
  && ok "--dry-run writes no snapshot ($after_count files in the deploy base)" \
  || fail "--dry-run extracted $((after_count - before_count)) files into the deploy base"
# And it must not print the secret, not even a freshly generated one: this output
# ends up in tickets and chat.
if grep -qE 'GATE_SECRET=[0-9a-f]{32,}' <<< "$out5"; then
  fail "--dry-run printed the secret value"
else
  ok "--dry-run prints no secret value, only a redacted marker"
fi
grep -q "qwtf-server.service" <<< "$out5" && ok "it prints the server unit" \
  || fail "the dry run printed no unit"
grep -q "ExecStart=/usr/bin/node" <<< "$out5" && ok "with its ExecStart" \
  || fail "the printed unit has no ExecStart"
[ -f "$UD5/qwtf-server.service" ] && fail "--dry-run wrote a unit file" \
  || ok "--dry-run wrote nothing"
grep -q 'GATE_SECRET=<redacted' <<< "$out5" && ok "the secret is redacted in the output" \
  || fail "--dry-run printed the secret: $(grep -c 'GATE_SECRET=' <<< "$out5") GATE_SECRET lines"
[ -f "$UD5/etc/gate.env" ] && fail "--dry-run wrote the secret file" \
  || ok "--dry-run wrote no secret file"

# ---------------------------------------------------------------- H: fail arguments
echo
echo "== H: arguments are parsed, not ignored"
out6="$(run_installer "$TMP/units6" --deploy)"; rc6=$?
[ "$rc6" -ne 0 ] && ok "--deploy with no commit is an error (exit $rc6)" \
  || fail "--deploy with no commit was accepted"
grep -q "needs a commit" <<< "$out6" && ok "with a message that says why" \
  || fail "no explanation: $out6"
out7="$(run_installer "$TMP/units7" --frobnicate)"; rc7=$?
[ "$rc7" -ne 0 ] && ok "an unknown flag is an error (exit $rc7)" \
  || fail "an unknown flag was silently ignored"
out8="$(run_installer "$TMP/units8" --dry-run --uninstall)"; rc8=$?
[ "$rc8" -ne 0 ] && ok "--dry-run --uninstall is refused rather than guessed at" \
  || fail "--dry-run --uninstall was accepted"
# No units anywhere from the failed runs.
[ -d "$TMP/units6" ] && [ -n "$(ls -A "$TMP/units6" 2>/dev/null)" ] \
  && fail "a failed argument check still wrote something" \
  || ok "no failed run wrote anything"

# ---------------------------------------------------------------- I: idempotency
echo
echo "== I: installing twice is not an error"
UD9="$TMP/units9"
run_installer "$UD9" >/dev/null; r1=$?
run_installer "$UD9" >/dev/null; r2=$?
[ "$r1" -eq 0 ] && [ "$r2" -eq 0 ] && ok "two installs in a row both exit 0" \
  || fail "the second install exited $r2"

echo
if [ "$FAILED" -eq 0 ]; then echo "PASS"; else echo "FAIL: $FAILED checks"; fi
exit $((FAILED > 0))
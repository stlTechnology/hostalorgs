#!/usr/bin/env bash
# Install the play-test services: the dedicated game server and the front-door
# gate, both under systemd, both with auto-restart.
#
#   sudo scripts/install_service.sh                     # install and start
#   sudo scripts/install_service.sh --deploy <commit>   # (re)deploy and restart both
#   sudo scripts/install_service.sh --uninstall         # remove
#   scripts/install_service.sh --dry-run                # print, change nothing
#
# Deploying a SNAPSHOT, not the working tree (reviewer 0054): both units serve
# build/deploy/<commit>/web, produced by scripts/deploy_snapshot.sh with
# `git archive`. They used to point at the live web/ tree, so rebuilding a map
# mid-play-test desynced the page from the server and every client got "map
# model file does not match". --deploy restarts BOTH units together, so the
# server and the page can never be on different commits.
#
# Why a service: M3 ends with an owner play-test, which means the server has to
# outlive a terminal. M6 wants auto-restart, a log file and a per-IP connection
# limit, and this is that plumbing in place early rather than at the end.
#
# The server binds 27510 and the page is served on 8200, matching PLAN.md's
# handoff URLs (ws://<host>:27510 and http://<host>:8200/). Players connect to
# the gate's /play/ws on the page's own origin, never to a game port.
#
# ---------------------------------------------------------------------------
# TESTABILITY (reviewer 0082)
#
# This script is owner-facing and runs as root, and the last version had two
# bugs -- "[ $# -gt 0; do" instead of "[ $# -gt 0 ]; do", and an unset variable
# under `set -u` -- that made `--uninstall` silently INSTALL. Neither was caught,
# because the script had never been run by anything except a human with sudo.
#
# So the whole thing is exercisable without root:
#
#   QWTF_UNITDIR     where the unit files are written   (default /etc/systemd/system)
#   QWTF_SECRETDIR   where the secret env file is written (default /etc/qwtf)
#   QWTF_SYSTEMCTL   the systemctl to call              (default systemctl)
#   QWTF_SV_PORT     the game port                      (default 27510)
#   QWTF_WEB_PORT    the page port                      (default 8200)
#   QWTF_DEPLOY_BASE where snapshots go                 (default build/deploy)
#   QWTF_SELFCHECK    0 = skip the network self-check    (default 1; tests only)
#   --dry-run         print the units and stop, writing nothing
#
# Root is REQUIRED only when the units would go into the real system directory.
# Point QWTF_UNITDIR somewhere else and this runs as a normal user, which is
# what tests/test_install_service.sh does. There is no "skip the root check"
# switch, because a switch like that would also be a way to install an
# unauthenticated page service on the real box.
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SV_PORT="${QWTF_SV_PORT:-27510}"
WEB_PORT="${QWTF_WEB_PORT:-8200}"
UNITDIR="${QWTF_UNITDIR:-/etc/systemd/system}"
SECRETDIR="${QWTF_SECRETDIR:-/etc/qwtf}"
SYSTEMCTL="${QWTF_SYSTEMCTL:-systemctl}"
DEPLOY_BASE="${QWTF_DEPLOY_BASE:-$ROOT/build/deploy}"
SECRET_FILE="$SECRETDIR/gate.env"

SV_UNIT="qwtf-server.service"
WEB_UNIT="qwtf-web.service"

SERVER_EXTRA=""
DRY_RUN=0
UNINSTALL=0
# Which map the game server loads. forts is the default since 0479 moved the
# alt BSPs out of the served tree (only forts.bsp ships in web/id1, because the
# page's manifest must not pre-fetch maps the server is not loading): a ctf
# default would fail the snapshot guard below on every fresh install. The
# non-default maps still install with an explicit --map, and the guard makes a
# map that is missing from the snapshot fatal rather than a broken install.
MAP=forts
# Every variable the loop can set is initialised here. Under `set -u`,
# referencing one that was never assigned aborts the script -- which is exactly
# what happened to --deploy, after the units were already on disk and
# daemon-reload had already run, so the enable/restart never happened.
DEPLOY_COMMIT=""
DEPLOY_COMMIT_EXPLICIT=0

usage() {
  cat >&2 <<'EOF'
usage: install_service.sh [--deploy <commit>] [--uninstall] [--dry-run]

  (no arguments)   install both units and start them
  --deploy <c>     snapshot commit <c>, write the units, restart both
  --uninstall      stop and remove both units, the secret and the firewall rule
  --map <name>     the map the game server loads (default ctf)
  --bots           run the defender bots (+set qwtf_bots 1), as the Azure server does
  --dry-run        print what would be written, change nothing
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deploy)
      # Checked rather than `shift 2 || true`: `shift 2` fails when only one
      # argument is left, and `|| true` swallowed that failure and then read
      # "${2:-}" as the commit anyway.
      [ $# -ge 2 ] || { echo "FATAL: --deploy needs a commit" >&2; usage; exit 2; }
      DEPLOY_COMMIT="$2"
      DEPLOY_COMMIT_EXPLICIT=1
      shift 2
      ;;
    --uninstall) UNINSTALL=1; shift ;;
    --map) MAP="$2"; shift 2 ;;
    --bots) SERVER_EXTRA="+set qwtf_bots 1"; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "FATAL: unknown argument '$1'" >&2; usage; exit 2 ;;
  esac
done

if [ "$DRY_RUN" -eq 1 ] && [ "$UNINSTALL" -eq 1 ]; then
  echo "FATAL: --dry-run and --uninstall are mutually exclusive" >&2
  exit 2
fi

# Root, but only when something real is going to be written to the system.
#
# Both units run as the invoking user, so a root install needs the log
# directories and the secret file to be writable by that user too.
RUNUSER="${QWTF_USER:-$(logname 2>/dev/null || echo "${SUDO_USER:-root}")}"

if [ "$UNITDIR" = "/etc/systemd/system" ] && [ "$DRY_RUN" -eq 0 ]; then
  # A dry run writes nothing: it prints the units and exits before the mkdir,
  # the secret file and systemctl. So it needs no root, and refusing it was
  # pointless (reviewer 0088) -- it also meant the one mode that can be run
  # without an account on the box was the one that could not be run at all.
  [ "$(id -u)" = "0" ] || { echo "FATAL: run with sudo" >&2; exit 1; }
  [ -n "${SUDO_USER:-}" ] || [ -n "${QWTF_USER:-}" ] || {
    echo "FATAL: root with no SUDO_USER: cannot tell who the units should run as." >&2
    echo "       Re-run with sudo, or set QWTF_USER explicitly." >&2
    exit 1; }
fi

# --- uninstall -----------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 0 ]; then
    $SYSTEMCTL disable --now "$SV_UNIT" "$WEB_UNIT" 2>/dev/null || true
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would remove $UNITDIR/$SV_UNIT $UNITDIR/$WEB_UNIT"
  else
    rm -f "$UNITDIR/$SV_UNIT" "$UNITDIR/$WEB_UNIT" "$SECRET_FILE"
    echo "removed $SV_UNIT, $WEB_UNIT and $SECRET_FILE"
    $SYSTEMCTL daemon-reload || true
    # Take the firewall rule back out with the services, or the port stays
    # blocked for something else that legitimately wants it later. This calls
    # the same script the unit uses, so both address families and the nft
    # fallback are handled here too; the old inline `iptables -D` did neither.
    bash "$ROOT/scripts/gameport_firewall.sh" del "$SV_PORT" || \
      echo "(firewall rule already gone, or this host has no firewall tool)"
  fi
  exit 0
fi

# --- preconditions -------------------------------------------------------------
[ -x "$ROOT/build/fteqw-sv" ] || {
  echo "FATAL: build/fteqw-sv missing. Run scripts/build_fte_server.sh" >&2; exit 1; }
[ -f "$ROOT/web/index.html" ] || {
  echo "FATAL: web/index.html missing. Run scripts/build_fte_web.sh and" >&2
  echo "       scripts/build_maps.sh" >&2; exit 1; }
[ -x "$ROOT/scripts/port_probe.js" ] || {
  echo "FATAL: scripts/port_probe.js missing or not executable" >&2; exit 1; }
# Everything the units name in ExecStart must be executable, because systemd
# refuses to start a unit whose ExecStart is not. scripts/run_server.sh was
# committed mode 644, so `systemd-analyze verify` said "not executable" and the
# server unit would have failed at boot with no useful message. Caught here
# instead.
for exe in "$ROOT/scripts/run_server.sh" "$ROOT/scripts/gameport_firewall.sh"; do
  [ -x "$exe" ] || {
    echo "FATAL: $exe is not executable; the unit that runs it would refuse to start." >&2
    echo "       Fix with: chmod +x $exe" >&2
    exit 1; }
done
[ -r "$ROOT/server/gate.js" ] || {
  echo "FATAL: server/gate.js missing" >&2; exit 1; }

# --- the busy-port check, BEFORE anything is written ----------------------------
#
# Both units use Restart=always, so installing on top of a manual server does
# not fail loudly: systemd starts the unit, the bind fails with EADDRINUSE, and
# the unit crash-loops forever while the page still works from the manual
# process. The reviewer hit exactly this on :8200 (reviewer 0051). So check
# first, and name the PIDs to stop, because `pkill -f` would also match the
# shell running this script.
#
# This runs before the units are written, so a refused install leaves nothing
# behind. Previously the units were written first, and a refusal left two unit
# files in /etc/systemd/system pointing at a service that was never started.
# Whose PID is this? A redeploy has to succeed when OUR OWN units hold the ports,
# because --deploy exists to restart them (reviewer 0099). The owner's first
# redeploy was refused by fteqw-sv and node -- which were qwtf-server and
# qwtf-web, the units the installer had just written.
#
# A PID counts as ours if it is a unit's MainPID, or if its cgroup contains the
# unit's ControlGroup, which also covers a child the unit spawned.
own_pid() {
  local pid="$1" u mp cg
  for u in "$SV_UNIT" "$WEB_UNIT"; do
    mp="$($SYSTEMCTL show -p MainPID --value "$u" 2>/dev/null || true)"
    [ -n "$mp" ] && [ "$mp" != "0" ] && [ "$mp" = "$pid" ] && return 0
    cg="$($SYSTEMCTL show -p ControlGroup --value "$u" 2>/dev/null || true)"
    if [ -n "$cg" ] && [ -r "/proc/$pid/cgroup" ] && grep -qF -- "$cg" "/proc/$pid/cgroup"; then
      return 0
    fi
  done
  return 1
}

busy=0            # a FOREIGN holder: refuse
busy_own=0        # our own unit: fine, we are about to restart it
for p in "$SV_PORT" "$WEB_PORT"; do
  for fam in tcp udp; do
    flag="-ltnp"; [ "$fam" = udp ] && flag="-lunp"
    # The `|| true` is required, not defensive: with `set -e -o pipefail` a grep
    # that matches nothing makes the pipeline fail, and inside a command
    # substitution that failure kills the script. A port being free -- the
    # normal case -- is exactly the "no match" case, so this aborted the
    # installer on every clean machine.
    line=$(ss "$flag" 2>/dev/null | grep -E "[:.]${p}[[:space:]]" | head -1 || true)
    [ -n "$line" ] || continue
    pid=$(printf '%s' "$line" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
    # Just the process name. Taking it from the users:(("...")) group rather than
    # stripping the prefix off the whole line is deliberate: on the owner's box
    # that printed "pid 3214750, LISTEN 0 2 *:27510 ... users:((" -- the process
    # name is in the parentheses (reviewer 0107).
    who=$(printf '%s' "$line" | sed -nE 's/.*users:\(\("([^"]*)".*/\1/p')
    if [ -n "$pid" ] && own_pid "$pid"; then
      busy_own=1
      echo "port $p/$fam is held by OUR OWN unit (pid $pid, $who): continuing, we are about to restart it"
      continue
    fi
    # A dry run still reports it, but does not refuse: it writes nothing, so
    # there is nothing to protect, and a preview that refuses is useless.
    [ "$DRY_RUN" -eq 1 ] || busy=1
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "would REFUSE to install: port $p/$fam is already in use." >&2
    else
      echo "REFUSING to install: port $p/$fam is already in use." >&2
    fi
    echo "  listener: $line" >&2
    [ -n "$pid" ] && echo "  held by:   pid $pid ($who)" >&2
    echo >&2
  done
done
if [ "$busy_own" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "continuing: the holders above are our own units and --deploy restarts them"
fi
if [ "$busy" -eq 1 ]; then
  cat >&2 <<EOF
  Nothing has been written to $UNITDIR. The manual play-test servers must be
  stopped first, or these units will crash-loop on EADDRINUSE:

    sudo systemctl stop $SV_UNIT $WEB_UNIT   # if a previous install left units
    kill <pid>                               # the pids listed above

  The page and the game server are each held by exactly one process; the units
  take over both once the manual ones are gone.
EOF
  exit 1
fi

# --- the snapshot ---------------------------------------------------------------
DEPLOY_COMMIT="${DEPLOY_COMMIT:-$(git -C "$ROOT" rev-parse HEAD)}"
# Resolve to a full SHA, and refuse anything that is not a commit.
#
# `--deploy HEAD` used to be taken literally: the directory was named HEAD and
# DEPLOYED_COMMIT said HEAD, so the operator could not tell what was live, and
# every later `--deploy HEAD` re-extracted INTO the directory the running server
# was reading -- the 0054 map-mismatch class of failure again, where the page and
# the server can end up on different bytes.
#
# A short SHA is fine as input and still resolves to a full one, so
# `--deploy 485f1f9` keeps working and lands in a directory named for the commit.
DEPLOY_RESOLVED="$(git -C "$ROOT" rev-parse --verify --quiet "$DEPLOY_COMMIT^{commit}" || true)"
[ -n "$DEPLOY_RESOLVED" ] || {
  echo "FATAL: '$DEPLOY_COMMIT' is not a commit in $ROOT" >&2
  echo "       Try a SHA, or: git -C $ROOT rev-parse HEAD" >&2
  exit 1; }
if [ "$DEPLOY_RESOLVED" != "$DEPLOY_COMMIT" ]; then
  echo "resolved $DEPLOY_COMMIT -> $DEPLOY_RESOLVED"
fi
DEPLOY_COMMIT="$DEPLOY_RESOLVED"
DEPLOY_DIR="$DEPLOY_BASE/$DEPLOY_COMMIT"
WEBROOT="$DEPLOY_DIR/web"
# A dry run must not write anything, and the snapshot is several MB of files.
if [ "$DRY_RUN" -eq 1 ]; then
  [ -d "$WEBROOT" ] && echo "(the snapshot for $DEPLOY_COMMIT already exists)"
  echo "would snapshot $DEPLOY_COMMIT into $WEBROOT"
else
  QWTF_DEPLOY_BASE="$DEPLOY_BASE" bash "$ROOT/scripts/deploy_snapshot.sh" "$DEPLOY_COMMIT" >/dev/null
  # Stamp the SNAPSHOT (0469): the menu footer fetches build.json, so it has to
  # say what is deployed, not what happens to be checked out in the working
  # tree. build.json is gitignored, so git archive never carries one; without
  # this the footer would show "build unknown" on every deploy.
  bash "$ROOT/scripts/build_stamp.sh" "$WEBROOT" "${DEPLOY_COMMIT:0:7}"
fi

# The map must exist in the snapshot that was just deployed, not in the working
# tree: the server reads the snapshot, so a map that is only in web/id1 would load
# nothing and leave the player looking at the void.
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$WEBROOT/id1/maps/$MAP.bsp" ]; then
  echo "FATAL: no map '$MAP' in the snapshot at $WEBROOT/id1/maps" >&2
  echo "       have: $(for f in "$WEBROOT"/id1/maps/*.bsp; do [ -e "$f" ] && printf '%s ' "$(basename "$f" .bsp)"; done)" >&2
  exit 2
fi

# --- the session-token secret ---------------------------------------------------
#
# Reviewer 0082, item 4: the secret used to be written into the unit as
# `Environment=GATE_SECRET=...`. A unit file is mode 0644 under
# /etc/systemd/system, so every local user could read it, and `systemctl show`
# printed it. It now lives in a root-owned 0600 file named by EnvironmentFile=,
# which systemd reads and does not expose in the unit or in `systemctl show`.
#
# Reused across installs so a redeploy does not invalidate the owner's cookie.
GATE_SECRET="${GATE_SECRET:-}"
if [ -z "$GATE_SECRET" ] && [ "$DRY_RUN" -eq 0 ] && [ -f "$SECRET_FILE" ]; then
  GATE_SECRET="$(sed -n 's/^GATE_SECRET=//p' "$SECRET_FILE" | head -1)"
fi
if [ -z "$GATE_SECRET" ]; then
  # hex, so it needs no quoting in an EnvironmentFile line
  GATE_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [ "$DRY_RUN" -eq 1 ] || echo "generated a new gate secret"
fi
POW_BITS="${POW_BITS:-0}"

echo "deploying $DEPLOY_COMMIT -> $WEBROOT"

# --- the units ------------------------------------------------------------------
SV_UNIT_TEXT="$(cat <<EOF
[Unit]
Description=QWTF dedicated server
After=network.target

[Service]
Type=simple
User=$RUNUSER
WorkingDirectory=$ROOT
# --gamedir is the snapshot, not the live web/ tree: the server must read the
# same corridor.bsp the page serves (reviewer 0054).
# Loopback only, and deliberately NOT --host 0.0.0.0: the game port is internal
# (PROJECT.md "Single origin, single port"). The gate is the only listener
# reachable from outside, and it pipes to this port on 127.0.0.1.
# --map is explicit rather than left to run_server.sh's default, so
# "systemctl cat qwtf-server" answers "which map is live".
ExecStart=$ROOT/scripts/run_server.sh --port $SV_PORT --host 127.0.0.1 --gamedir $WEBROOT --map $MAP${SERVER_EXTRA:+ $SERVER_EXTRA}
# Keep the game port off the network on every start, and take the rule back out
# on every stop, so it survives a reboot (reviewer 0074). A rule added once by
# the installer would not.
#
# The leading "+" is required, and it means "run with full privileges": these
# lines run as root even though User= is $RUNUSER, which the firewall script
# insists on. It does NOT mean "run even if the unit failed" -- that is what
# "-" means, and it is not what is wanted here: if the rule cannot be applied
# the server must not start, rather than run with its port exposed.
ExecStartPre=+$ROOT/scripts/gameport_firewall.sh add $SV_PORT
ExecStopPost=+$ROOT/scripts/gameport_firewall.sh del $SV_PORT
Restart=always
RestartSec=3
PrivateTmp=true
NoNewPrivileges=true
StandardOutput=append:$ROOT/build/playtest/server.log
StandardError=append:$ROOT/build/playtest/server.log

[Install]
WantedBy=multi-user.target
EOF
)"

WEB_UNIT_TEXT="$(cat <<EOF
[Unit]
Description=QWTF front door (gate): landing page, gated assets, WebSocket to the game
After=network.target $SV_UNIT

[Service]
Type=simple
User=$RUNUSER
WorkingDirectory=$ROOT
# This is the gate, NOT tools/serve.js. tools/serve.js is a dev tool with an
# /api/upload endpoint that spawns a process per request and a /recordings/
# listing; deploying it would hand a scanner both (reviewer 0056). The gate
# serves the landing page, gates /play/* behind a session cookie, and pipes
# /play/ws to the game server -- one origin, one port.
ExecStart=/usr/bin/node $ROOT/server/gate.js
Restart=always
RestartSec=3
# Config from the environment so M6's container needs no code change.
Environment=GATE_PORT=$WEB_PORT
Environment=GATE_ROOT=$WEBROOT
Environment=GATE_HOST=0.0.0.0
Environment=FTE_HOST=127.0.0.1
Environment=FTE_PORT=$SV_PORT
Environment=GATE_POW_BITS=$POW_BITS
# The session secret is NOT here: a unit file is world-readable and
# "systemctl show" prints it. This file is root-owned and mode 0600.
EnvironmentFile=$SECRET_FILE
# Which commit this unit serves, so \`systemctl cat qwtf-web\` answers it.
Environment=QWTF_DEPLOY=$DEPLOY_DIR
PrivateTmp=true
NoNewPrivileges=true
StandardOutput=append:$ROOT/build/playtest/gate.log
StandardError=append:$ROOT/build/playtest/gate.log

[Install]
WantedBy=multi-user.target
EOF
)"

SECRET_TEXT="GATE_SECRET=$GATE_SECRET"

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$busy" -eq 1 ]; then
    echo
    echo "The ports above are in use, so a real run would refuse and write nothing."
  fi
  echo "--- dry run: $UNITDIR/$SV_UNIT ---"
  printf '%s\n' "$SV_UNIT_TEXT"
  echo "--- dry run: $UNITDIR/$WEB_UNIT ---"
  printf '%s\n' "$WEB_UNIT_TEXT"
  # Never the value, even a freshly generated one: this output goes into tickets
  # and chat, and a line that says "redacted" and then prints the secret is worse
  # than one that says nothing.
  echo "--- dry run: $SECRET_FILE (0600, root:root) ---"
  echo "GATE_SECRET=<redacted: this run generates or reuses it, and prints nothing>"
  echo "--- dry run: would $SYSTEMCTL enable --now $SV_UNIT $WEB_UNIT ---"
  exit 0
fi

mkdir -p "$UNITDIR" "$SECRETDIR" "$ROOT/build/playtest"
# The log files belong to the user the units run as, or the services cannot
# open them.
install -o "$RUNUSER" -g "$(id -gn "$RUNUSER" 2>/dev/null || echo "$RUNUSER")" \
  -m 0644 /dev/null "$ROOT/build/playtest/server.log" 2>/dev/null || true
install -o "$RUNUSER" -g "$(id -gn "$RUNUSER" 2>/dev/null || echo "$RUNUSER")" \
  -m 0644 /dev/null "$ROOT/build/playtest/gate.log" 2>/dev/null || true

umask 077
printf '%s\n' "$SECRET_TEXT" > "$SECRET_FILE"
chmod 0600 "$SECRET_FILE"
# Root ownership, so only root can read it. Fails in a non-root test, where the
# file is owned by the test user and the mode is what matters.
chown root:root "$SECRET_FILE" 2>/dev/null || true
umask 022

printf '%s\n' "$SV_UNIT_TEXT" > "$UNITDIR/$SV_UNIT"
printf '%s\n' "$WEB_UNIT_TEXT" > "$UNITDIR/$WEB_UNIT"
chmod 0644 "$UNITDIR/$SV_UNIT" "$UNITDIR/$WEB_UNIT"

$SYSTEMCTL daemon-reload
if [ "$DEPLOY_COMMIT_EXPLICIT" -eq 1 ]; then
  # A redeploy must move BOTH units together. Restarting only one is how the
  # server and the page end up on different commits (reviewer 0054), so this is
  # a restart of both, never a start of one.
  $SYSTEMCTL restart "$SV_UNIT" "$WEB_UNIT"
else
  $SYSTEMCTL enable --now "$SV_UNIT" "$WEB_UNIT"
fi
sleep 2
$SYSTEMCTL --no-pager --lines=3 status "$SV_UNIT" "$WEB_UNIT" || true

# --- self-check: prove the isolation, from the LAN address ----------------------
#
# Checked over the LAN IP on purpose: 127.0.0.1 would pass even with no firewall
# rule at all, which is the whole mistake this guards against.
#
# Every probe is a REAL packet, through scripts/port_probe.js:
#   tcp  a real connect(2)
#   udp  a real connectionless QuakeWorld query, ff ff ff ff "status", which a
#        Quake server answers with its player list
# The previous version ran /dev/tcp in both cases, so the line it printed,
# "the game port refuses on $IP:$SV_PORT over udp", was a TCP result printed
# twice. It also probed "[$IPV6]" over /dev/tcp, which bash cannot resolve at
# all ("Name or service not known"), so every IPv6 line was a false pass.
IP=$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1 || true)

echo
if [ "${QWTF_SELFCHECK:-1}" != "1" ]; then
  # Only the test harness turns this off: the probes below need a gate and a
  # game server actually listening, and in a test install nothing is.
  echo "self-check skipped (QWTF_SELFCHECK=${QWTF_SELFCHECK:-1})"
  echo
  echo "installed. Play at:"
  echo "  deployed commit: $DEPLOY_COMMIT"
  echo "  snapshot:        $WEBROOT"
  echo "  page:    http://$IP:$WEB_PORT/"
  exit 0
fi
echo "self-check from the non-loopback address (not 127.0.0.1):"
probe_failures=0
probe() {
  # probe <tcp|udp> <host> <port> <expect: ok|refuse> <what>
  local proto="$1" host="$2" port="$3" expect="$4" what="$5" out rc verdict
  out=$(node "$ROOT/scripts/port_probe.js" "$proto" "$host" "$port" 2500 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then verdict="reachable"; else verdict="not reachable"; fi
  if { [ "$expect" = ok ] && [ "$rc" -eq 0 ]; } || { [ "$expect" = refuse ] && [ "$rc" -ne 0 ]; }; then
    echo "  ok   $what ($verdict)"
  else
    if [ "$expect" = ok ]; then echo "  FAIL $what should answer but did not"; else
      echo "  FAIL $what should refuse but answered"; fi
    probe_failures=$((probe_failures + 1))
  fi
  echo "         $out"
}

if [ -n "$IP" ]; then
  probe tcp "$IP" "$WEB_PORT" ok    "the gate answers on $IP:$WEB_PORT"
  probe tcp "$IP" "$SV_PORT"  refuse "the game port is refused on $IP:$SV_PORT"
  probe udp "$IP" "$SV_PORT"  refuse "the game port is refused on $IP:$SV_PORT"
else
  echo "  (skipped the IPv4 probes: no non-loopback IPv4 address on this host)"
  probe_failures=$((probe_failures + 1))
fi

# IPv6 too, if this host has a global address. An IPv4-only rule leaves the game
# port wide open over IPv6, which is the same hole in another family. Passed to
# the probe unbracketed, because bash and getaddrinfo disagree about "[::1]".
IPV6=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+' | head -1 || true)
if [ -n "$IPV6" ]; then
  echo "  (also probing the global IPv6 address $IPV6)"
  probe tcp "$IPV6" "$SV_PORT" refuse "the game port is refused on [$IPV6]:$SV_PORT"
  probe udp "$IPV6" "$SV_PORT" refuse "the game port is refused on [$IPV6]:$SV_PORT"
else
  echo "  (no global IPv6 address on this host, so nothing to probe)"
fi

# Loopback must still work, or the gate cannot reach the game at all.
probe tcp 127.0.0.1 "$SV_PORT" ok "the gate can still reach the game on 127.0.0.1:$SV_PORT"
probe udp 127.0.0.1 "$SV_PORT" ok "the game server still answers on 127.0.0.1:$SV_PORT"

echo
echo "installed. Play at:"
echo "  deployed commit: $DEPLOY_COMMIT"
echo "  snapshot:        $WEBROOT"
echo "  page:    http://$IP:$WEB_PORT/"
echo "  logs:    $ROOT/build/playtest/{server,gate}.log"
echo "  stop:    sudo systemctl stop $SV_UNIT $WEB_UNIT"
if [ "$probe_failures" -ne 0 ]; then
  echo
  echo "SELF-CHECK FAILED ($probe_failures probes wrong). The units ARE installed and"
  echo "running; the lines above marked FAIL are what is wrong. The most likely cause"
  echo "is the firewall rule not being applied: check"
  echo "  sudo iptables -S INPUT | grep $SV_PORT"
  exit 1
fi
#!/usr/bin/env bash
# Run the FTEQW dedicated server on our map, with web/id1 as the gamedir.
#
#   scripts/run_server.sh [--port 27500] [--host 0.0.0.0] [--map forts] [extra +sets]
#
# UDP and WebSocket are both served on PORT: sv_port for UDP, sv_port_tcp plus
# net_enable_websockets 1 for TCP. That is what lets the browser in web/
# connect straight to this server with no relay.
#
# -basedir is the directory CONTAINING id1, i.e. web/, not web/id1.  FTE treats
# -basedir as the game root and looks for id1 beneath it; passing web/id1 makes
# it search web/id1/id1 and fail with "unable to determine correct game/basedir".
#
# We deliberately keep this off the public master servers.  The defaults are
# baked into net_master.c as CVAR_NOSAVE entries pointing at quakeservers.net
# and frag-net.com, and the server will happily heartbeat to them and report
# our address, which is not something a local test server should do.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SV="$ROOT/build/fteqw-sv"
WEB="$ROOT/web"

# Game root for the server.
#
# FTE's -basedir is the directory CONTAINING id1. We normally point it straight
# at web/, but that is the directory every visitor is served from, and the server
# writes demos under it (<basedir>/<sv_demoDir>). sv_mvd.c's SV_DemoDir_Callback
# rejects absolute paths and anything containing "..", so the demo directory
# cannot be moved out of the basedir from the outside.
#
# So for a normal run the basedir IS web/ and demos land in web/<sv_demoDir>.
# Tests that must not write into the served tree pass --gamedir instead, which
# points at a staging root holding a symlink to web/id1 plus its own demos dir.
GAMEDIR="$WEB"
DEMOSUBDIR="demos"   # FTE prefixes the recording path with "fte/" itself

# INTERNAL ONLY by default. PROJECT.md "Single origin, single port": the gate is
# the only thing reachable from outside, so FTE must not listen on a routable
# address. --host 127.0.0.1 keeps the TCP/WebSocket listener on loopback; UDP is
# bound to the same loopback address, so a LAN scan finds nothing.
PORT=27500
HOST=127.0.0.1
# Which map to load. forts is the default since 0479 moved the alt BSPs out of
# the served tree: only forts.bsp ships in web/id1 (the page's manifest must not
# pre-fetch maps the server is not loading), so a ctf default would refuse to
# start on the tree the page actually ships. The other maps load with an
# explicit --map (the tests that need corridor or duel pass it; the fixtures'
# BSPs live in tests/fixtures/maps).
MAP=forts
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    --host) HOST="$2"; shift 2;;
    --gamedir) GAMEDIR="$2"; shift 2;;          # staging root, see above
    --demo-subdir) DEMOSUBDIR="$2"; shift 2;;  # where demos go under the gamedir
    --map) MAP="$2"; shift 2;;
    *)      EXTRA+=("$1"); shift;;
  esac
done

[ -x "$SV" ] || { echo "FATAL: $SV missing. Run scripts/build_fte_server.sh" >&2; exit 1; }
[ -f "$WEB/id1/qwprogs.dat" ] || {
  echo "FATAL: web/id1/qwprogs.dat missing. Run scripts/build_progs.sh" >&2; exit 1; }

# Port specification for the listening sockets.
#
# NOT "IP:PORT". sv_port and sv_port_tcp claim to accept an address prefix and
# bind that interface, and they do -- for UDP. Measured with this build:
#
#   sv_port=127.0.0.1:PORT       UDP on 127.0.0.1:PORT *and* :PORT+1, and the
#                                TCP listener never comes up at all
#   sv_port=PORT (plain)         TCP and UDP both on :PORT, on 0.0.0.0
#
# So the address form trades a reachable game port for a broken one, which is
# strictly worse. Plain ports it is, and --host stays a log-line label.
#
# This leaves the game server bound to 0.0.0.0, which is NOT what M3b wants
# ("the game port listens on 127.0.0.1 only"). Isolation therefore has to come
# from outside FTE -- a network namespace shared with the gate -- rather than
# from a cvar. Raised with the reviewer; do not paper over it here.
BIND="$PORT"

# Local only.  Set sv_public 0 as well: sv_master1 empty alone is not enough to
# stop the A2A heartbeats if any default list is still populated.
args=(
  -basedir "$GAMEDIR"
  +set sv_demoDir "$DEMOSUBDIR"
  +set dedicated 1
  +set sv_progs qwprogs.dat
  +set net_master1 ""
  +set net_master2 ""
  +set net_masterextra1 ""
  +set net_ice_broker ""
  +set sv_public 0
  +set sv_maxrate 0
  +set hostname "Hostalorgs"
  +set sv_port "$BIND"
  +set sv_port_tcp "$BIND"
  +set net_enable_websockets 1
  # The QuakeC VM's memory. Its default is sized for 131072 entities and the
  # one block it reserves at startup is refused on a 1 GB machine with no swap
  # ("Fatal error: Out of memory", the Azure B1s, 2026-10-10). The game uses
  # well under 1 MB of QC memory and about 700 entities on forts2.
  +set pr_ssqc_memsize 64m
  +set pr_maxedicts 8192
  # EXTRA goes BEFORE +map, not after: FTE's own help for maxclients says a new
  # value "takes effect on the next map", because SV_SpawnServer sizes the
  # client table from it (and MAX_CLIENTS clamps it). A `+set maxclients 16`
  # appended after `+map` is therefore silently too late -- every +set here has
  # to be readable before the map loads. Nothing today passes EXTRA, so moving
  # it breaks nobody; tests/load16.js is the first caller.
  ${EXTRA[@]+"${EXTRA[@]}"}
  +map "$MAP"
)


# A typo in a map name loads nothing and leaves the player looking at the void,
# so it is a startup error rather than a silent fallback.
[ -f "$GAMEDIR/id1/maps/$MAP.bsp" ] || {
  echo "FATAL: no map '$MAP' in $GAMEDIR/id1/maps" >&2
  echo "       have: $(for f in "$GAMEDIR"/id1/maps/*.bsp; do [ -e "$f" ] && printf '%s ' "$(basename "$f" .bsp)"; done)" >&2
  exit 2; }

echo "starting $SV on $HOST:$PORT (basedir $GAMEDIR, map $MAP, demos in $DEMOSUBDIR)"
exec "$SV" "${args[@]}"
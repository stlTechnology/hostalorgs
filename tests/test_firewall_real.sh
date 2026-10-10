#!/usr/bin/env bash
# The firewall rule must actually block traffic -- proved with the real kernel.
#
#   tests/test_firewall_real.sh
#
# tests/test_firewall.sh reads the arguments the script hands to fake binaries,
# which proves what it tries to do. This one proves the effect: two network
# namespaces joined by a veth pair, a real listener on the game port, and
# probes that must change from "answers" to "silenced" the moment the rule is
# added, while loopback keeps working (the gate reaches the game over lo).
#
# Why that matters for reviewer 0081's first complaint: the broken nft branch
# exited 0, printed "added", and never installed anything the kernel evaluates.
# Only traffic proves the difference.
#
# No sudo and nothing outside a throwaway namespace:
#   unshare -r -n        a new user namespace (we are uid 0) and a new network
#                        namespace, so every rule and interface dies with it
#   unshare -n           a SECOND network namespace, reached with nsenter, which
#                        is the "outside world" arriving on a non-loopback
#                        interface. Packets to a local address always arrive on
#                        lo, which the rule exempts, so without a second
#                        namespace this test cannot fail for the right reason.
# Skips cleanly if unprivileged user namespaces are unavailable.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$(id -u)" = 0 ] && ! unshare -n true 2>/dev/null; then
  echo "SKIP: unprivileged network namespaces are unavailable here"
  exit 0
fi
if ! unshare -rn true 2>/dev/null; then
  echo "SKIP: 'unshare -r -n' is unavailable here (no unprivileged user namespaces)"
  exit 0
fi
if ! command -v nft >/dev/null 2>&1 && [ ! -x /usr/sbin/nft ]; then
  echo "SKIP: no nft binary on this host"
  exit 0
fi

FAILED=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=$((FAILED+1)); }

# The whole scenario runs inside one throwaway namespace pair. $CHILD_PID is
# written out so the parent shell can read it.
OUT="$(unshare -rn bash -s -- "$ROOT" <<'INNER'
set -u
ROOT="$1"
FAILED=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=$((FAILED+1)); }

SV_IP=10.9.9.9        # the game "host", in this namespace
CLI_IP=10.9.9.2        # the outside client, in the child namespace
PORT=27510

cleanup() {
  [ -n "${CHILD_PID:-}" ] && kill "$CHILD_PID" 2>/dev/null
  [ -n "${LISTENER_PID:-}" ] && kill "$LISTENER_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

ip link set lo up
ip link add veth0 type veth peer name veth1
unshare -n sleep 120 &
CHILD_PID=$!
sleep 0.3
ip link set veth1 netns "$CHILD_PID" || { echo "FATAL: could not move veth1"; exit 1; }
ip addr add "$SV_IP/24" dev veth0
ip link set veth0 up
nsenter -t "$CHILD_PID" -n ip addr add "$CLI_IP/24" dev veth1
nsenter -t "$CHILD_PID" -n ip link set veth1 up
nsenter -t "$CHILD_PID" -n ip link set lo up

# A real TCP listener plus a real UDP echo, so "reachable" means "answered by a
# server" rather than "the kernel happened not to refuse".
python3 - "$PORT" <<'PY' &
import socket, sys, threading, time
port = int(sys.argv[1])
t = socket.socket(); t.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
t.bind(("0.0.0.0", port)); t.listen(8)
def serve():
    end = time.time() + 100
    while time.time() < end:
        try:
            c, _ = t.accept(); c.close()
        except OSError:
            break
threading.Thread(target=serve, daemon=True).start()
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
u.bind(("0.0.0.0", port))
def echo():
    end = time.time() + 100
    u.settimeout(0.5)
    while time.time() < end:
        try:
            data, addr = u.recvfrom(2048)
        except socket.timeout:
            continue
        u.sendto(b"QWTF" + data[4:], addr)
threading.Thread(target=echo, daemon=True).start()
time.sleep(100)
PY
LISTENER_PID=$!
sleep 0.8

from_outside() {  # from_outside <proto> <host> [port]
  nsenter -t "$CHILD_PID" -n node "$ROOT/scripts/port_probe.js" "$@" >/dev/null 2>&1
}
from_here() {     # from_here <proto> <host> [port]
  node "$ROOT/scripts/port_probe.js" "$@" >/dev/null 2>&1
}

# A PATH holding ONLY the real nft and the coreutils the script needs, so the
# nft branch is the one exercised even though this host has a working iptables.
NFTONLY="$(mktemp -d)"
ln -sf "$(command -v nft || echo /usr/sbin/nft)" "$NFTONLY/nft"
for c in grep basename id sed cat head cut tr rm mkdir bash; do
  real="$(command -v "$c")" && [ -e "$NFTONLY/$c" ] || ln -sf "$real" "$NFTONLY/$c"
done
export FW_STATE="$NFTONLY/state"; mkdir -p "$FW_STATE"

echo "== baseline, no rule at all"
from_outside tcp "$SV_IP" "$PORT" && ok "before the rule, $SV_IP:$PORT answers TCP from outside" \
  || fail "the fixture is broken: $SV_IP:$PORT already refused TCP"
from_outside udp "$SV_IP" "$PORT" && ok "before the rule, $SV_IP:$PORT answers UDP from outside" \
  || fail "the fixture is broken: $SV_IP:$PORT already refused UDP"

echo
echo "== scripts/gameport_firewall.sh add (nft branch, real kernel)"
add_out="$(PATH="$NFTONLY" bash "$ROOT/scripts/gameport_firewall.sh" add "$PORT" 2>&1)"
add_rc=$?
echo "$add_out" | sed 's/^/     /'
[ "$add_rc" -eq 0 ] && ok "add exits 0" || fail "add exited $add_rc"

# Reviewer 0081 item 1, checked against the kernel's own view of the ruleset.
rules="$(nft list table inet qwtf 2>/dev/null)"
grep -q 'hook input' <<< "$rules" \
  && ok "the kernel has a chain hooked into input:" \
  || fail "no input hook in the ruleset -- the kernel would never look at it"
grep -E 'type filter hook input priority' <<< "$rules" | sed 's/^/     /'
# Source-based, and one rule per family: `ip saddr` never matches an IPv6 packet
# even in an inet table, so the IPv6 half needs its own rule.
for fam in "ip saddr != 127.0.0.1" "ip6 saddr != ::1"; do
  for p in tcp udp; do
    grep -q "$p dport $PORT $fam drop" <<< "$rules" \
      && ok "the $p rule exempts the loopback source ($fam)" \
      || fail "no $p rule for $fam: $rules"
  done
done
grep -q "iifname" <<< "$rules" \
  && fail "a rule still exempts by interface" \
  || ok "no rule exempts by interface"

echo
echo "== with the rule in place: the host's OWN address, from inside"
# This is the probe the reviewer's install exposed as missing. A host talking to
# its own non-loopback address routes over lo:
#   $ ip route get 192.168.135.116
#   local 192.168.135.116 dev lo src 192.168.135.116
# so an interface-based rule (! -i lo) can never be seen to work from the machine
# it is installed on -- the owner's install printed
#   FAIL ... 192.168.135.116:27510 tcp reachable / udp answered
# even with the rule in place. A source-based rule drops this, so the installer's
# self-check becomes a real test instead of a tautology.
if from_here tcp "$SV_IP" "$PORT" 1200; then
  fail "TCP to this host's OWN $SV_IP still gets through -- the rule cannot be observed from here"
else
  ok "TCP to this host's own $SV_IP is refused"
fi
if from_here udp "$SV_IP" "$PORT" 1200; then
  fail "UDP to this host's own $SV_IP still answers"
else
  ok "UDP to this host's own $SV_IP is refused"
fi

echo
echo "== with the rule in place"
if from_outside tcp "$SV_IP" "$PORT" 1200; then
  fail "TCP from outside still gets through -- the rule does not block"
else
  ok "TCP from outside is silenced (no SYN-ACK within the timeout)"
fi
if from_outside udp "$SV_IP" "$PORT" 1200; then
  fail "UDP from outside still answers -- the rule does not block"
else
  ok "UDP from outside is silenced (no reply within the timeout)"
fi
from_here tcp 127.0.0.1 "$PORT" 1500 \
  && ok "loopback TCP still works, so the gate can still reach the game" \
  || fail "loopback TCP broke -- the gate could not reach the game"
from_here udp 127.0.0.1 "$PORT" 1500 \
  && ok "loopback UDP still works" || fail "loopback UDP broke"

echo
echo "== idempotency with the rule live"
add2="$(PATH="$NFTONLY" bash "$ROOT/scripts/gameport_firewall.sh" add "$PORT" 2>&1)"; rc2=$?
[ "$rc2" -eq 0 ] && ok "the second add exits 0" || fail "the second add exited $rc2"
n="$(nft list table inet qwtf 2>/dev/null | grep -c 'drop')"
[ "$n" = "4" ] && ok "still exactly 4 rules (2 protos x 2 families), nothing stacked" \
  || fail "$n rules after two adds, expected 4"
from_here tcp 127.0.0.1 "$PORT" 1500 && ok "loopback still fine after the second add" \
  || fail "the second add disturbed loopback"

echo
echo "== del removes it again"
del_out="$(PATH="$NFTONLY" bash "$ROOT/scripts/gameport_firewall.sh" del "$PORT" 2>&1)"; rc3=$?
del2="$(PATH="$NFTONLY" bash "$ROOT/scripts/gameport_firewall.sh" del "$PORT" 2>&1)"; rc4=$?
[ "$rc3" -eq 0 ] && [ "$rc4" -eq 0 ] && ok "del twice exits 0 both times" \
  || fail "del exited $rc3 then $rc4"
from_outside tcp "$SV_IP" "$PORT" 1500 \
  && ok "TCP from outside answers again after del" || fail "TCP did not come back after del"
from_outside udp "$SV_IP" "$PORT" 1500 \
  && ok "UDP from outside answers again after del" || fail "UDP did not come back after del"

rm -rf "$NFTONLY"
echo
echo "INNER_FAILED=$FAILED"
INNER
)"

echo "$OUT"
echo "$OUT" | grep -q 'INNER_FAILED=0' || FAILED=$((FAILED + 1))
echo "$OUT" | grep -q 'FATAL' && FAILED=$((FAILED + 1))

echo
if [ "$FAILED" -eq 0 ]; then echo "PASS"; else echo "FAIL: $FAILED checks"; fi
exit $((FAILED > 0))
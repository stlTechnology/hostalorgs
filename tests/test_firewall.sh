#!/usr/bin/env bash
# The firewall rule must exist, must cover both families, must be idempotent, and
# must actually be evaluated by the kernel.
#
#   tests/test_firewall.sh
#
# Reviewer 0081: the iptables/ip6tables branch was accepted, but the nft
# fallback -- the branch used on a host with no iptables -- silently did
# nothing:
#
#   1. `nft add chain inet qwtf input` creates a REGULAR chain. A regular chain
#      has no hook, so the kernel never evaluates it and no packet is ever
#      compared against it. Every command exits 0, the log says "added", and
#      the port is still open.
#   2. `ip saddr != 127.0.0.1 drop` only matches IPv4 packets, in an inet table
#      that claims to cover both families. IPv6 walked straight past it.
#
# Both are asserted below, by reading the arguments the script actually hands to
# a fake `nft` (and a fake `iptables`), never the real firewall: no root, no
# chance of locking the box out of itself.
#
# Root is faked with `unshare -r` (a user namespace where we are uid 0), because
# the script refuses to run as a normal user and that refusal is correct. Fake
# binaries are found by a PATH that contains ONLY a directory of stubs, so the
# real iptables on this host cannot be used by accident -- and, for the nft
# cases, so that the real iptables cannot hide the nft branch.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$(id -u)" != 0 ]; then
  if command -v unshare >/dev/null 2>&1 && unshare -r true 2>/dev/null; then
    echo "== running as uid 0 inside a user namespace (unshare -r), no real rules touched"
    exec unshare -r -- bash "$0" "$@"
  fi
  echo "SKIP: needs root or a working 'unshare -r' (no sudo in this test)"
  exit 0
fi

TMP="$(mktemp -d /tmp/qwtf-fw-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=$((FAILED+1)); }

# --------------------------------------------------------------- fake binaries
# $1 = bin dir, $2 = state dir. Rules are kept as one line per rule in
# state/rules.<name>; the existence of a chain is state/chain.<name>.
make_stub() {
  local bindir="$1" state="$2"
  mkdir -p "$bindir" "$state"

  cat > "$bindir/iptables" <<'STUB'
#!/usr/bin/env bash
# Fake iptables/ip6tables: records rules, answers -C from what is recorded.
name="$(basename "$0")"
state="$FW_STATE"
log="$state/calls.log"
printf '%s %s\n' "$name" "$*" >> "$log"
rules="$state/rules.$name"
mkdir -p "$state"
[ -f "$rules" ] || : > "$rules"
op=""
for a in "$@"; do
  case "$a" in
    -C|-I|-D) op="$a"; shift;;
  esac
done
# Everything after the operation flag is the rule, in a canonical order.
key="$*"
case "$op" in
  -C) grep -Fxq "$key" "$rules" && exit 0 || exit 1 ;;
  -I) if ! grep -Fxq "$key" "$rules"; then printf '%s\n' "$key" >> "$rules"; fi; exit 0 ;;
  -D) kept="$rules.keep.$$"
      grep -Fxv "$key" "$rules" > "$kept" 2>/dev/null || : > "$kept"
      cat "$kept" > "$rules"; rm -f "$kept"
      grep -Fxq "$key" "$rules" && exit 1 || exit 0 ;;
  *) exit 0 ;;
esac
STUB

  cat > "$bindir/nft" <<'STUB'
#!/usr/bin/env bash
# Fake nft: enough state to tell a base chain from a regular one.
#
# It parses nft's real grammar, which is
#   nft {list|add|flush|delete} {table|chain|rule} <family> <table> [<chain> [expr...]]
# -- the object kind comes right after the command, then the family. Getting
# that order wrong in the stub would make it reject valid calls, which would
# hide the very thing this test looks for.
state="$FW_STATE"
printf '%s\n' "$*" >> "$state/calls.log"
cmd="$1"; shift
obj="$1"; shift
family="$1"; shift
table="$1"; shift
name=""
if [ "$obj" = chain ] || [ "$obj" = rule ]; then
  name="$1"; shift
fi
rules="$state/rules.$family.$table.$name"
case "$cmd $obj" in
  "list table")
    [ -f "$state/table.$family.$table" ] || exit 1
    printf 'table %s %s {\n' "$family" "$table"
    [ -f "$state/chain.$family.$table.$name" ] && cat "$state/chain.$family.$table.$name"
    ;;
  "list chain")
    [ -f "$state/table.$family.$table" ] || exit 1
    [ -f "$state/chain.$family.$table.$name" ] || exit 1
    printf 'table %s %s {\n' "$family" "$table"
    printf ' chain %s {\n' "$name"
    cat "$state/chain.$family.$table.$name"
    # The rules, as the kernel prints them: the rule expression, one per line.
    cat "$rules" 2>/dev/null
    printf ' }\n}\n'
    ;;
  "add table") : > "$state/table.$family.$table" ;;
  "add chain")
    # The hook spec, if any, is the rest of the command line. A chain with no
    # "hook" in it is exactly the bug reviewer 0081 found.
    printf '%s\n' "$*" > "$state/chain.$family.$table.$name"
    : > "$rules"
    ;;
  "add rule") printf '%s\n' "$*" >> "$rules" ;;
  "flush chain")
    [ -f "$rules" ] || exit 1
    : > "$rules" ;;
  "delete chain")
    [ "$name" = input ] || exit 1
    rm -f "$state/chain.$family.$table.$name" "$rules" ;;
  *) exit 1 ;;
esac
exit 0
STUB

  chmod +x "$bindir/iptables" "$bindir/nft"
  cp "$bindir/iptables" "$bindir/ip6tables"
}

# A PATH with nothing but stubs plus the handful of real coreutils the script
# needs (grep, basename, id). With no real iptables visible, `have iptables`
# is false and the nft branch is the one under test.
stub_path() {
  local bindir="$1" fake="$2" path="$1"
  for c in bash sh env grep basename id sed cat head cut tr rm mkdir rmdir; do
    real="$(command -v "$c")" || continue
    [ -e "$bindir/$c" ] || ln -sf "$real" "$bindir/$c"
  done
  mkdir -p "$path"
  printf '%s' "$path"
}

run_fw() {
  # run_fw <bindir> <state> <action> <port>
  FW_STATE="$2" PATH="$1" bash scripts/gameport_firewall.sh "${3:-}" "${4:-}"
}

# ------------------------------------------------- 1: iptables path, both families
echo
echo "== iptables/ip6tables path"
S1="$TMP/s1"; B1="$TMP/b1"; mkdir -p "$S1" "$B1"; make_stub "$B1" "$S1"
PATH1="$(stub_path "$B1" yes)"
out1="$(run_fw "$PATH1" "$S1" add 27510 2>&1)"; rc1=$?
out2="$(run_fw "$PATH1" "$S1" add 27510 2>&1)"; rc2=$?

[ "$rc1" -eq 0 ] && ok "add exits 0" || fail "add exited $rc1: $out1"
[ "$rc2" -eq 0 ] && ok "second add exits 0 (idempotent)" || fail "second add exited $rc2"
for fw in iptables ip6tables; do
  n="$(grep -c . "$S1/rules.$fw")"
  [ "$n" = "2" ] && ok "$fw has exactly 2 rules after two adds (tcp+udp)" \
                || fail "$fw has $n rules, expected 2"
done
grep -q 'already present' <<< "$out2" && ok "the second add reports 'already present'" \
                                  || fail "the second add re-applied the rule: $out2"
# The rule must exempt LOOPBACK BY SOURCE, not by interface (reviewer 0089): a
# host probing its own address goes over lo, so an interface-based rule can never
# be observed to work from the machine it is installed on. That is exactly what
# the owner's install showed: "FAIL ... 27510 tcp reachable".
grep -q '! -s 127.0.0.1/32 -j DROP' "$S1/rules.iptables" \
  && ok "rule is INPUT ! -s 127.0.0.1/32 -j DROP (loopback source exempt)" \
  || fail "rule does not exempt the loopback source: $(cat "$S1/rules.iptables")"
grep -q '! -i lo' "$S1/rules.iptables" \
  && fail "the interface-based rule is still being installed" \
  || ok "no interface-based rule (it cannot block self-traffic)"
grep -q -- '-p tcp --dport 27510' "$S1/rules.iptables" \
  && ok "rule matches tcp/27510" || fail "no tcp rule: $(cat "$S1/rules.iptables")"
grep -q -- '-p udp --dport 27510' "$S1/rules.iptables" \
  && ok "rule matches udp/27510" || fail "no udp rule: $(cat "$S1/rules.iptables")"
# IPv6 has its own loopback address; reusing 127.0.0.1 in ip6tables would leave
# every IPv6 client with an open port.
grep -q '! -s ::1/128 -j DROP' "$S1/rules.ip6tables" \
  && ok "ip6tables exempts ::1/128, not 127.0.0.1" \
  || fail "ip6tables has the wrong exempt source: $(cat "$S1/rules.ip6tables")"
grep -q '127.0.0.1' "$S1/rules.ip6tables" \
  && fail "ip6tables is exempting the IPv4 loopback address" \
  || ok "ip6tables does not mention the IPv4 loopback"

# Pre-seed the interface-based rule that older versions installed, then check
# that a del takes it out as well. Otherwise a redeploy leaves it in place.
FW_STATE="$S1" "$PATH1/iptables" -I INPUT -p tcp --dport 27510 '!' -i lo -j DROP
FW_STATE="$S1" "$PATH1/iptables" -I INPUT -p udp --dport 27510 '!' -i lo -j DROP
n="$(grep -c 'i lo' "$S1/rules.iptables")"
[ "$n" = "2" ] && ok "the old interface-based rule is in place (the fixture)" \
  || fail "the fixture did not seed the old rule ($n of 2)"
out3="$(run_fw "$PATH1" "$S1" del 27510 2>&1)"; rc3=$?
out4="$(run_fw "$PATH1" "$S1" del 27510 2>&1)"; rc4=$?
[ "$rc3" -eq 0 ] && [ "$rc4" -eq 0 ] && ok "del twice exits 0 both times" \
                                    || fail "del exited $rc3 then $rc4"
n="$(grep -c . "$S1/rules.iptables")"
[ "$n" = "0" ] && ok "del leaves no rules behind, old form included" \
  || fail "del left $n rules: $(cat "$S1/rules.iptables")"

# ------------------------------------------------------------- 2: the nft fallback
echo
echo "== nft fallback (no iptables on PATH)"
S2="$TMP/s2"; B2="$TMP/b2"; mkdir -p "$S2" "$B2"; make_stub "$B2" "$S2"
rm -f "$B2/iptables" "$B2/ip6tables"
PATH2="$(stub_path "$B2" no)"

nadd1="$(run_fw "$PATH2" "$S2" add 27510 2>&1)"; nrc1=$?
nadd2="$(run_fw "$PATH2" "$S2" add 27510 2>&1)"; nrc2=$?
[ "$nrc1" -eq 0 ] && ok "nft add exits 0" || fail "nft add exited $nrc1: $nadd1"
[ "$nrc2" -eq 0 ] && ok "nft second add exits 0 (idempotent)" || fail "nft second add exited $nrc2"

chain="$(cat "$S2/chain.inet.qwtf.input" 2>/dev/null)"
if grep -q 'hook input' <<< "$chain"; then
  ok "the chain is a BASE chain: $chain"
else
  fail "the chain has no hook, so the kernel never evaluates it: '${chain:-<none>}'"
fi
grep -q 'policy accept' <<< "$chain" \
  && ok "the chain declares a policy (accept), so only our rule blocks" \
  || fail "no policy in the chain spec: $chain"

rules="$(cat "$S2/rules.inet.qwtf.input")"
# One rule per protocol PER FAMILY: `ip saddr` only ever matches IPv4 packets, even
# in an inet table, so the IPv6 half needs its own rule with `ip6 saddr`.
grep -q 'ip saddr != 127.0.0.1 drop' <<< "$rules" \
  && ok "the IPv4 rule exempts the loopback source" \
  || fail "no IPv4 rule: $rules"
grep -q 'ip6 saddr != ::1 drop' <<< "$rules" \
  && ok "the IPv6 rule exempts ::1 (reviewer 0081/0089: ip saddr alone is not enough)" \
  || fail "no IPv6 rule: $rules"
grep -q 'iifname' <<< "$rules" \
  && fail "the rule still exempts by interface, which self-traffic matches" \
  || ok "no interface-based exemption left"
for p in tcp udp; do
  for fam in "ip saddr != 127.0.0.1" "ip6 saddr != ::1"; do
    grep -q "$p dport 27510 $fam drop" <<< "$rules" \
      && ok "nft rule: $p/27510 from $fam" || fail "missing: $p/27510 $fam"
  done
done
n="$(grep -c . "$S2/rules.inet.qwtf.input")"
[ "$n" = "4" ] && ok "exactly 4 nft rules after two adds (2 protos x 2 families)" \
  || fail "$n nft rules, expected 4: $(cat "$S2/rules.inet.qwtf.input" | tr '\n' '|')"

ndel1="$(run_fw "$PATH2" "$S2" del 27510 2>&1)"; nrc3=$?
ndel2="$(run_fw "$PATH2" "$S2" del 27510 2>&1)"; nrc4=$?
[ "$nrc3" -eq 0 ] && [ "$nrc4" -eq 0 ] && ok "nft del twice exits 0 both times" \
                                      || fail "nft del exited $nrc3 then $nrc4"

# ----------------------------------------------------- 3: no firewall tool at all
echo
echo "== neither iptables nor nft"
S3="$TMP/s3"; B3="$TMP/b3"; mkdir -p "$S3" "$B3"; make_stub "$B3" "$S3"
rm -f "$B3/iptables" "$B3/ip6tables" "$B3/nft"
PATH3="$(stub_path "$B3" no)"
a3="$(run_fw "$PATH3" "$S3" add 27510 2>&1)"; rc3=$?
[ "$rc3" -ne 0 ] && ok "add fails loudly when there is no firewall tool (exit $rc3)" \
  || fail "add claimed success with no firewall tool: $a3"
grep -q 'neither iptables nor nft' <<< "$a3" \
  && ok "the message says why: neither iptables nor nft" || fail "unhelpful message: $a3"

# ------------------------------------------- 4: a bad port and a bad action
echo
echo "== argument handling"
b1="$(run_fw "$PATH1" "$S1" add 2>&1)"; rcb=$?
[ "$rcb" -ne 0 ] && grep -q usage <<< "$b1" && ok "a missing port is a usage error" \
  || fail "a missing port was not rejected (exit $rcb): $b1"
b2="$(run_fw "$PATH1" "$S1" frobnicate 27510 2>&1)"; rcb2=$?
[ "$rcb2" -ne 0 ] && grep -q usage <<< "$b2" && ok "an unknown action is a usage error" \
  || fail "an unknown action was not rejected (exit $rcb2): $b2"

echo
if [ "$FAILED" -eq 0 ]; then echo "PASS"; else echo "FAIL: $FAILED checks"; fi
exit $((FAILED > 0))
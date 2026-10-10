#!/usr/bin/env bash
# Keep the game port off the network, idempotently.
#
#   scripts/gameport_firewall.sh add <port>
#   scripts/gameport_firewall.sh del <port>
#
# Why a firewall and not a bind: FTE cannot be told to listen on 127.0.0.1 only.
# sv_port and sv_port_tcp document an "IP:PORT" form that binds a specific
# interface, and with it the TCP listener never comes up at all -- the game simply
# stops working (measured both ways, on three ports; see scripts/run_server.sh). So
# on a LAN deploy the traffic is stopped instead of the bind.
#
# This is a script rather than inline unit commands because systemd runs
# ExecStartPre and ExecStopPost on every start and stop, including after a reboot,
# and both halves must be idempotent: `add` twice must not stack two rules, and
# `del` on a machine that never had the rule must not fail the stop.
#
# ---------------------------------------------------------------------------
# The rule is SOURCE-based, which is the whole point of this rewrite
# (reviewer 0089).
#
# It used to be `! -i lo -j DROP`: drop anything for the game port that did not
# arrive on the loopback interface. That is the right idea and it does block other
# machines -- but a host probing its OWN address never uses a real interface:
#
#   $ ip route get 192.168.135.116
#   local 192.168.135.116 dev lo src 192.168.135.116
#
# so self-traffic arrives on lo, matches the exemption, and the installer's
# self-check observed the game port reachable on the LAN IP and reported FAIL.
# The rule might well have been correct; "might well have been" is not evidence,
# and my own namespace test could not catch it because it used a veth pair, which
# really is a different machine as far as the kernel is concerned.
#
# So the rule now names the SOURCE instead of the interface:
#
#   iptables  ! -s 127.0.0.1/32 -j DROP
#   ip6tables ! -s ::1/128      -j DROP
#   nft       two rules, ip saddr != 127.0.0.1 and ip6 saddr != ::1
#
# Only the gate may talk to the game, and the gate connects from 127.0.0.1. Traffic
# from anywhere else is dropped, INCLUDING this host's own connections to its LAN
# address, which is what makes the installer's self-check a real test rather than a
# tautology.
#
# `del` removes BOTH this form and the old interface-based one, because the old
# one is already installed on the owner's box and a redeploy has to clean it up.
# ---------------------------------------------------------------------------

set -uo pipefail

ACTION="${1:-}"
PORT="${2:-}"

if [ -z "$ACTION" ] || [ -z "$PORT" ]; then
  echo "usage: $0 {add|del} <port>" >&2
  exit 2
fi
case "$ACTION" in add|del) ;; *) echo "usage: $0 {add|del} <port>" >&2; exit 2 ;; esac
case "$PORT" in ''|*[!0-9]*) echo "FATAL: '$PORT' is not a port number" >&2; exit 2 ;; esac

if [ "$(id -u)" != 0 ]; then
  echo "FATAL: needs root (systemd runs this as root)" >&2
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }

# NOTE on backends: `iptables` may be the nft or the legacy backend (this host:
# v1.8.7 (nf_tables)). Both are fine, because both backends build the whole
# table themselves, hook and all. What does NOT work is hand-rolling a chain
# with nft(8) and forgetting the hook -- see the nft branch below.

# One rule per protocol per family. iptables and ip6tables take the same
# arguments apart from the loopback address, so the rule is described once per
# family and applied by whichever binary is available.
#
# VARIANTS is the loopback source address per family: index 0 is IPv4 and is what
# iptables gets, index 1 is IPv6 and is what ip6tables gets. `add` installs these;
# `del` also tries apply_legacy, which removes the interface-based rule older
# versions installed, so a redeploy cleans that up too.
VARIANTS=(
  "127.0.0.1/32"
  "::1/128"
)
apply() {
  # $1 = add|del, $2 = proto, $3 = firewall binary, $4 = loopback source
  local action=$1 proto=$2 fw=$3 src=$4
  local args=(INPUT -p "$proto" --dport "$PORT" '!' -s "$src" -j DROP)
  local flag=-I
  [ "$action" = del ] && flag=-D

  if [ "$action" = add ]; then
    if "$fw" -C "${args[@]}" >/dev/null 2>&1; then
      echo "  firewall: already present ($fw $proto/$PORT from $src)"
      return 0
    fi
  fi

  if "$fw" "$flag" "${args[@]}" >/dev/null 2>&1; then
    if [ "$action" = add ]; then
      echo "  firewall: added   $fw $flag ${args[*]}"
    else
      echo "  firewall: removed $fw $flag ${args[*]}"
    fi
    return 0
  fi

  if [ "$action" = add ]; then
    echo "  firewall: FAILED to add $fw $flag ${args[*]}" >&2
    return 1
  fi
  # Removing something that was never there must not fail the unit stop.
  echo "  firewall: nothing to remove ($fw $proto/$PORT from $src)"
  return 0
}

apply_legacy() {
  # Remove the pre-0089 interface-based rule, if this host has one.
  # $1 = del, $2 = proto, $3 = firewall binary
  local action=$1 proto=$2 fw=$3
  local flag=-D
  [ "$action" = add ] && flag=-I
  local args=(INPUT -p "$proto" --dport "$PORT" '!' -i lo -j DROP)
  if "$fw" "$flag" "${args[@]}" >/dev/null 2>&1; then
    if [ "$action" = add ]; then
      echo "  firewall: added   $fw $flag ${args[*]}"
    else
      echo "  firewall: removed the old interface-based $fw rule: ${args[*]}"
    fi
    return 0
  fi
  [ "$action" = add ] && return 1
  return 0
}

status=0

if have iptables; then
  ipt_src="${VARIANTS[0]}"
  for proto in tcp udp; do
    apply "$ACTION" "$proto" iptables "$ipt_src" || status=1
  done
  # The old rule may still be installed from before this change; take it out
  # either way, so a redeploy does not leave two overlapping DROP rules behind.
  for proto in tcp udp; do
    apply_legacy del "$proto" iptables || status=1
  done
  if have ip6tables; then
    ip6t_src="${VARIANTS[1]}"
    for proto in tcp udp; do
      apply "$ACTION" "$proto" ip6tables "$ip6t_src" || status=1
    done
    for proto in tcp udp; do
      apply_legacy del "$proto" ip6tables || status=1
    done
  else
    echo "  firewall: WARNING ip6tables not found, IPv6 traffic is not covered" >&2
    status=1
  fi
elif have nft; then
  # One nftables `inet` table covers both families with a single rule set.
  #
  # Two things here are load-bearing and both were wrong before (reviewer 0081):
  #
  # 1. The chain must be a BASE chain, i.e. created with
  #    { type filter hook input priority 0 ; policy accept ; }. A plain
  #    `nft add chain inet qwtf input` makes a regular chain with no hook, which
  #    the kernel never evaluates: every command succeeds, no packet is ever
  #    looked at, and the port stays open while the log says it was added.
  # 2. Two rules per protocol, one per family, because `ip saddr` only ever
  #    matches IPv4 packets even in an inet table. The reviewer's suggested form
  #    is `ip saddr != 127.0.0.1 drop + ip6 saddr != ::1 drop`, and both halves
  #    are needed: with only the IPv4 one, IPv6 walked straight past it, which is
  #    what the first version of this script did.
  TABLE=qwtf
  HOOK='{ type filter hook input priority 0 ; policy accept ; }'
  for proto in tcp udp; do
    if [ "$ACTION" = add ]; then
      nft list table inet "$TABLE" >/dev/null 2>&1 || nft add table inet "$TABLE" 2>/dev/null
      # Read the chain into a variable instead of piping nft into grep -q.
      # With `set -o pipefail` a `grep -q` that matches early closes the pipe,
      # nft dies of SIGPIPE, the pipeline reports failure, and the "does this
      # chain have a hook?" test answers NO for a chain that has one -- which
      # then flushes the chain and deletes the rules just added. Measured: two
      # adds ended with only the udp rule, silently.
      chain_out="$(nft list chain inet "$TABLE" input 2>/dev/null || true)"
      # Re-create the chain when it exists but has no hook: a chain added by an
      # older version of this script is regular, and flush+delete is the only
      # way to give it the hook back.
      if ! grep -q 'hook input' <<< "$chain_out"; then
        nft flush chain inet "$TABLE" input 2>/dev/null || true
        nft delete chain inet "$TABLE" input 2>/dev/null || true
        # shellcheck disable=SC2086  # nft wants the hook spec split into words
        if nft add chain inet "$TABLE" input $HOOK 2>/dev/null; then
          echo "  firewall: created base chain inet $TABLE input (hook input, policy accept)"
        else
          echo "  firewall: FAILED to create base chain inet $TABLE input" >&2
          status=1
          continue
        fi
        chain_out=""
      fi
      # family, and the loopback address that family's clients come from
      for fam in ip ip6; do
        if [ "$fam" = ip ]; then lo=127.0.0.1; else lo="::1"; fi
        # The presence test has to match what the kernel prints, which puts the
        # verdict last: "tcp dport 27510 ip saddr != 127.0.0.1 drop". Testing for
        # "$proto dport $PORT drop" therefore never matched a live rule, so every
        # reboot stacked a duplicate: measured, 4 drop rules after two adds.
        # shellcheck disable=SC2086  # nft wants "!=" as one word
        if grep -Eq "$proto dport $PORT $fam saddr != $lo drop" <<< "$chain_out"; then
          echo "  firewall: already present (nft $proto/$PORT from $lo)"
          continue
        fi
        # shellcheck disable=SC2086  # ditto
        if nft add rule inet "$TABLE" input "$proto" dport "$PORT" \
             "$fam saddr != $lo" drop 2>/dev/null; then
          echo "  firewall: added   nft $proto dport $PORT $fam saddr != $lo drop (inet table, both families)"
          chain_out+="
$proto dport $PORT $fam saddr != $lo drop"
        else
          echo "  firewall: FAILED to add nft rule for $proto/$PORT ($fam)" >&2
          status=1
        fi
      done
    else
      # nft has no "delete by pattern", so flush the chain: it holds only our
      # rules, which is why it is a table of our own. This removes the old
      # interface-based rules too, which is why the nft branch needs no legacy
      # handling of its own.
      if nft flush chain inet "$TABLE" input 2>/dev/null; then
        echo "  firewall: removed nft rules for $proto/$PORT (chain flushed)"
      else
        echo "  firewall: nothing to remove (nft)"
      fi
    fi
  done
else
  echo "FATAL: neither iptables nor nft found, cannot keep the game port internal" >&2
  exit 1
fi

exit $status
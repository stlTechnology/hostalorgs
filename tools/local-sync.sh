#!/usr/bin/env bash
# Keep this machine's game server in step with the live Azure one: every run
# checks GitHub (the public repo, remote "public") and, when main has moved or
# the service is down, deploys that exact commit here with the same map and the
# defender bots on. Run as root by hostalorgs-local-sync.timer (every 5 min).
set -euo pipefail
ROOT=/home/adminuser/quake
OWNER=adminuser
STATE=/var/lib/hostalorgs-local/deployed
exec 9>/run/hostalorgs-local-sync.lock; flock -n 9 || exit 0
# install_service.sh runs git as root on adminuser's repo; allow that one
# directory for this process only (no change to any git config file).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$ROOT"
mkdir -p "$(dirname "$STATE")"
sudo -u "$OWNER" git -C "$ROOT" fetch -q public main
new="$(sudo -u "$OWNER" git -C "$ROOT" rev-parse --short public/main)"
have="$(cat "$STATE" 2>/dev/null || true)"
if [ "$new" = "$have" ] && systemctl is-active --quiet qwtf-server && systemctl is-active --quiet qwtf-web \
   && [ "${FORCE:-0}" != 1 ]; then exit 0; fi
echo "$(date -Is) deploying $new (was ${have:-none})"
QWTF_USER="$OWNER" bash "$ROOT/scripts/install_service.sh" --deploy "$new" --map forts2 --bots
echo "$new" > "$STATE"
echo "$(date -Is) deployed $new"

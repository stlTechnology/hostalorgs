#!/usr/bin/env bash
# The game VM's deploy step, kept in the repo so server changes ship through git
# like everything else. /opt/game/update.sh (written by cloud-init) fetches
# GitHub, checks out the new commit, then runs THIS file from that checkout as
# root, holding its lock. Reads /opt/game/config.env (SITES, SITE_DOMAINS, MAP).
#
# Does: the Caddy config (game on SITES, studio page on SITE_DOMAINS), the image
# build, the container (log-rotated, capped, no privileges), the record of what
# is deployed, and a prune of old images.
set -euo pipefail
NEW="${NEW:?vm-update.sh is run by /opt/game/update.sh}"
cd /opt/game/src
. /opt/game/config.env

# --- Caddy ---------------------------------------------------------------
{
  printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:8080\n}\n' "$SITES"
  if [ -n "${SITE_DOMAINS:-}" ] && [ -d /opt/game/src/site ]; then
    printf '%s {\n\troot * /opt/game/src/site\n\tencode gzip\n\tfile_server\n}\n' "$SITE_DOMAINS"
  fi
} > /etc/caddy/Caddyfile.new
if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
else
  rm -f /etc/caddy/Caddyfile.new
fi

# --- the game container ----------------------------------------------------
docker build -q --build-arg QWTF_SHA="$NEW" -t game:"$NEW" .
docker rm -f game 2>/dev/null || true
docker run -d --name game --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e GATE_SECRET="$(cat /opt/game/gate.secret)" -e QWTF_MAP="$MAP" \
  -e QWTF_SERVER_ARGS="+set qwtf_bots 1" \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 700m --pids-limit 256 \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  game:"$NEW"
echo "$NEW" > /opt/game/deployed
docker image prune -af --filter "until=24h" >/dev/null || true

#!/usr/bin/env bash
# One-shot Azure setup: a small Linux VM that runs the game container behind
# Caddy (automatic HTTPS). Run it in Azure Cloud Shell (already signed in), or
# anywhere `az login` has been done. Nothing secret is passed in or printed:
# the gate's secret is generated on the VM and never leaves it.
#
#   REPO_URL=https://github.com/<you>/<repo>.git bash deploy/azure/setup.sh
#
# Settings (env, all optional except REPO_URL):
#   NAME       resource prefix and DNS label   (default: hostalorgs)
#   LOCATION   Azure region                    (default: eastus)
#   SIZE       VM size                         (default: Standard_B1s, ~US$7.60/mo)
#   ZONE       availability zone, e.g. 1      (default: none; set one when Azure says
#              the size is "not available in location ... or different zone")
#   IMAGE      OS image                        (default: Ubuntu2404; for an Arm size such
#              as Standard_B2pts_v2 use Canonical:ubuntu-24_04-lts:server-arm64:latest)
#   MAP        map the server runs             (default: forts2)
#   BUDGET     monthly budget in USD           (default: 20)
#   EMAIL      budget alert address            (default: your az account's user)
#   SSH_FROM   IP allowed to SSH               (default: this machine's public IP)
#   DOMAIN     your own name too, e.g. hostalorgs.sheebiegame.com: add a DNS CNAME
#              from it to $NAME.$LOCATION.cloudapp.azure.com and HTTPS follows
#   SITE_DOMAINS  names that serve the studio page (repo site/); default: the
#              DOMAIN's parent and its www, e.g. "sheebiegame.com, www.sheebiegame.com".
#              Point those at the VM too (Cloudflare: CNAME @ and www). "" = none.
#   CLOUDFLARE_ONLY=1  ports 80/443 accept Cloudflare's addresses only, and the
#              raw azure name is left out of HTTPS (use with proxied DNS names).
#
# What it creates (all in resource group "$NAME-rg", delete that group to remove
# everything): VM, disk, public IP with DNS name $NAME.$LOCATION.cloudapp.azure.com,
# network security group (80/443 open, 22 from SSH_FROM only), a monthly budget.
#
# The VM deploys new commits by itself (checks GitHub every 5 min). To force it now:
#   az vm run-command invoke -g $NAME-rg -n $NAME-vm --command-id RunShellScript \
#     --scripts "FORCE=1 /opt/game/update.sh"
set -euo pipefail
: "${REPO_URL:?set REPO_URL=https://github.com/<you>/<repo>.git}"
NAME="${NAME:-hostalorgs}"; LOCATION="${LOCATION:-eastus}"; SIZE="${SIZE:-Standard_B1s}"
IMAGE="${IMAGE:-Ubuntu2404}"
ZONE_ARG=(); [ -n "${ZONE:-}" ] && ZONE_ARG=(--zone "$ZONE")
MAP="${MAP:-forts2}"; BUDGET="${BUDGET:-20}"
EMAIL="${EMAIL:-$(az account show --query user.name -o tsv)}"
SSH_FROM="${SSH_FROM:-$(curl -fsS https://api.ipify.org)}"
RG="$NAME-rg"; VM="$NAME-vm"
FQDN="$NAME.$LOCATION.cloudapp.azure.com"
SITES="$FQDN${DOMAIN:+, $DOMAIN}"
if [ "${CLOUDFLARE_ONLY:-0}" = 1 ]; then
  : "${DOMAIN:?CLOUDFLARE_ONLY=1 needs DOMAIN (the raw azure name will not be reachable)}"
  SITES="$DOMAIN"
fi
if [ -z "${SITE_DOMAINS+set}" ] && [ -n "${DOMAIN:-}" ]; then
  SITE_DOMAINS="${DOMAIN#*.}, www.${DOMAIN#*.}"
fi
SITE_DOMAINS="${SITE_DOMAINS:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== resource group $RG in $LOCATION"
az group create -n "$RG" -l "$LOCATION" -o none

echo "== cloud-init for $FQDN (repo $REPO_URL, map $MAP)"
INIT="$(mktemp)"
sed -e "s|@REPO_URL@|$REPO_URL|g" -e "s|@SITES@|$SITES|g" -e "s|@SITE_DOMAINS@|$SITE_DOMAINS|g" -e "s|@MAP@|$MAP|g" \
    "$HERE/cloud-init.yaml" > "$INIT"

echo "== network security group $NAME-nsg (no rules yet)"
# Created explicitly: newer az versions expect --nsg to name an existing group.
az network nsg create -g "$RG" -n "$NAME-nsg" -o none

echo "== VM $VM ($SIZE, Ubuntu 24.04, SSH key only)"
az vm create -g "$RG" -n "$VM" --image "$IMAGE" --size "$SIZE" "${ZONE_ARG[@]}" \
  --admin-username game --generate-ssh-keys --authentication-type ssh \
  --public-ip-sku Standard --public-ip-address-dns-name "$NAME" \
  --nsg "$NAME-nsg" \
  --custom-data "$INIT" -o none
rm -f "$INIT"

WEB_FROM="*"
if [ "${CLOUDFLARE_ONLY:-0}" = 1 ]; then
  WEB_FROM="$(curl -fsS https://www.cloudflare.com/ips-v4 | tr '\n' ' ')"
  [ -n "$WEB_FROM" ] || { echo "FATAL: could not fetch Cloudflare's address list" >&2; exit 1; }
fi
if [ "$WEB_FROM" = "*" ]; then FROM_TXT="anywhere"; else FROM_TXT="Cloudflare only"; fi
echo "== firewall: 80 and 443 from $FROM_TXT, 22 from $SSH_FROM only"
# shellcheck disable=SC2086
az network nsg rule create -g "$RG" --nsg-name "$NAME-nsg" -n web --priority 100 \
  --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 80 443 \
  --source-address-prefixes $WEB_FROM -o none
az network nsg rule create -g "$RG" --nsg-name "$NAME-nsg" -n ssh-owner --priority 110 \
  --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 22 \
  --source-address-prefixes "$SSH_FROM/32" -o none

echo "== monthly budget US\$$BUDGET, alerts to $EMAIL at 80% and 100%"
SUB="$(az account show --query id -o tsv)"
START="$(date -u +%Y-%m-01)"
az rest --method put \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/$NAME-budget?api-version=2023-05-01" \
  --body "{\"properties\":{\"category\":\"Cost\",\"amount\":$BUDGET,\"timeGrain\":\"Monthly\",
    \"timePeriod\":{\"startDate\":\"${START}T00:00:00Z\"},
    \"notifications\":{
      \"at80\":{\"enabled\":true,\"operator\":\"GreaterThan\",\"threshold\":80,\"contactEmails\":[\"$EMAIL\"]},
      \"at100\":{\"enabled\":true,\"operator\":\"GreaterThan\",\"threshold\":100,\"contactEmails\":[\"$EMAIL\"]}}}}" -o none

echo
echo "Done. The VM builds and starts the game on first boot (about 10 minutes)."
echo "Then open: https://$FQDN/"
if [ -n "${DOMAIN:-}" ]; then echo "and, once its CNAME points at $FQDN: https://$DOMAIN/"; fi
if [ -n "$SITE_DOMAINS" ]; then echo "studio page, once those names point at $FQDN: $SITE_DOMAINS"; fi
echo "Remove everything: az group delete -n $RG"

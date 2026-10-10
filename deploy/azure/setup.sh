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
#   MAP        map the server runs             (default: forts2)
#   BUDGET     monthly budget in USD           (default: 20)
#   EMAIL      budget alert address            (default: your az account's user)
#   SSH_FROM   IP allowed to SSH               (default: this machine's public IP)
#
# What it creates (all in resource group "$NAME-rg", delete that group to remove
# everything): VM, disk, public IP with DNS name $NAME.$LOCATION.cloudapp.azure.com,
# network security group (80/443 open, 22 from SSH_FROM only), a monthly budget.
#
# Redeploy a new commit later, without SSH:
#   az vm run-command invoke -g $NAME-rg -n $NAME-vm --command-id RunShellScript \
#     --scripts "/opt/game/update.sh"
set -euo pipefail
: "${REPO_URL:?set REPO_URL=https://github.com/<you>/<repo>.git}"
NAME="${NAME:-hostalorgs}"; LOCATION="${LOCATION:-eastus}"; SIZE="${SIZE:-Standard_B1s}"
MAP="${MAP:-forts2}"; BUDGET="${BUDGET:-20}"
EMAIL="${EMAIL:-$(az account show --query user.name -o tsv)}"
SSH_FROM="${SSH_FROM:-$(curl -fsS https://api.ipify.org)}"
RG="$NAME-rg"; VM="$NAME-vm"
FQDN="$NAME.$LOCATION.cloudapp.azure.com"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== resource group $RG in $LOCATION"
az group create -n "$RG" -l "$LOCATION" -o none

echo "== cloud-init for $FQDN (repo $REPO_URL, map $MAP)"
INIT="$(mktemp)"
sed -e "s|@REPO_URL@|$REPO_URL|g" -e "s|@FQDN@|$FQDN|g" -e "s|@MAP@|$MAP|g" \
    "$HERE/cloud-init.yaml" > "$INIT"

echo "== VM $VM ($SIZE, Ubuntu 24.04, SSH key only)"
az vm create -g "$RG" -n "$VM" --image Ubuntu2404 --size "$SIZE" \
  --admin-username game --generate-ssh-keys --authentication-type ssh \
  --public-ip-sku Standard --public-ip-address-dns-name "$NAME" \
  --nsg "$NAME-nsg" --nsg-rule NONE \
  --custom-data "$INIT" -o none
rm -f "$INIT"

echo "== firewall: 80 and 443 from anywhere, 22 from $SSH_FROM only"
az network nsg rule create -g "$RG" --nsg-name "$NAME-nsg" -n web --priority 100 \
  --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 80 443 -o none
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
echo "Remove everything: az group delete -n $RG"

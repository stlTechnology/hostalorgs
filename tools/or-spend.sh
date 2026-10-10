#!/usr/bin/env bash
# Print OpenRouter spend for the key opencode uses: "<usage_usd> <limit_usd|none> <remaining|none>".
# The key is read from opencode's auth file and only ever sent to openrouter.ai; it is never printed.
# `tools/or-spend.sh gate <max_usd>` exits 1 once usage has reached max_usd (or on a read failure).
set -euo pipefail
AUTH="${OPENCODE_AUTH:-$HOME/.local/share/opencode/auth.json}"
json=$(python3 -c 'import json,sys;print("Authorization: Bearer "+json.load(open(sys.argv[1]))["openrouter"]["key"])' "$AUTH" \
    | curl -sf --max-time 20 -H @- https://openrouter.ai/api/v1/key) || { echo "or-spend: could not read usage" >&2; exit 1; }
read -r usage limit remaining < <(python3 -c 'import json,sys
d=json.loads(sys.argv[1])["data"]
f=lambda v:"none" if v is None else "%.4f"%v
print(f(d.get("usage")),f(d.get("limit")),f(d.get("limit_remaining")))' "$json")
if [ "${1:-}" = gate ]; then
  python3 -c 'import sys;sys.exit(0 if float(sys.argv[1])<float(sys.argv[2]) else 1)' "$usage" "$2" \
    || { echo "or-spend: usage \$$usage reached the gate \$$2" >&2; exit 1; }
fi
echo "$usage $limit $remaining"

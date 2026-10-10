#!/usr/bin/env bash
# Test that build stamp exists and matches current state
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/web"

# Check build.json exists
if [ ! -f "$WEB/build.json" ]; then
    echo "FAIL: web/build.json does not exist"
    exit 1
fi

# Check built date is TODAY in America/Chicago timezone. Only the date, not
# the minute: the stamp is written once, and a test run that lands in the next
# minute would otherwise fail a perfectly fresh stamp.
EXPECTED_BUILT=$(TZ=America/Chicago date '+%F')
ACTUAL_BUILT=$(python3 -c "import json; d=json.load(open('$WEB/build.json')); print(d.get('built','').split()[0])" 2>/dev/null || echo "")

if [ "$ACTUAL_BUILT" != "$EXPECTED_BUILT" ]; then
    echo "FAIL: build date mismatch"
    echo "  expected: $EXPECTED_BUILT"
    echo "  actual:   $ACTUAL_BUILT"
    exit 1
fi

# Check sha matches git rev-parse --short HEAD
EXPECTED_SHA=$(git rev-parse --short HEAD)
ACTUAL_SHA=$(python3 -c "import json; d=json.load(open('$WEB/build.json')); print(d.get('sha',''))" 2>/dev/null || echo "")

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "FAIL: sha mismatch"
    echo "  expected: $EXPECTED_SHA"
    echo "  actual:   $ACTUAL_SHA"
    exit 1
fi

echo "PASS: build stamp is valid"
exit 0
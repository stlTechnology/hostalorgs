#!/usr/bin/env bash
# Test that qwtf/eggs.qc compiles with QWTF_NO_EGGS and the credits string is absent
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Build with QWTF_NO_EGGS defined - the eggs.qc file should be excluded, but ctf.qc and probe.qc kept
QWTF_NO_EGGS=1 bash "$ROOT/scripts/build_progs.sh" 2>&1

# Check that Jason Wolff string is NOT in the compiled progs.dat
if strings "$ROOT/web/id1/qwprogs.dat" | grep -q "Jason Wolff"; then
    echo "FAIL: Jason Wolff string found in qwprogs.dat when QWTF_NO_EGGS is in effect"
    exit 1
fi

# Restore the normal build so the credits string is present in qwprogs.dat again
bash "$ROOT/scripts/build_progs.sh" 2>&1

echo "PASS: Jason Wolff string absent when QWTF_NO_EGGS is defined"
exit 0

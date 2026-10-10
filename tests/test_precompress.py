#!/usr/bin/env python3
"""Every file the page ships has a fresh, verified .gz sibling (0484).

The M6 download row is "gzipped download size <= 8 MB", and 0484 is when the
two static servers (tools/serve.js, server/gate.js) started serving the .gz
siblings that scripts/precompress_web.sh keeps next to every content file.
Until then they served raw bytes and the "wire" was exactly the raw count.

This check asserts the invariant the servers rely on, for EVERY file the
page's manifest pre-fetches plus the engine trio:

  1. the .gz exists,
  2. it is not older than its source (the servers fall back to raw bytes on a
     stale sibling -- which is correct behaviour, but would silently undo the
     size win),
  3. it decompresses byte-identically. The failure this catches is FTE's
     upstream `gzip -kf`, which once shipped a truncated .wasm.gz with exit
     status 0 (see scripts/build_fte_web.sh).

Missing files are FAIL, not skip: the manifest is the shipped page's own
fetch list, so a listed file without a fresh .gz is a row that measures
bytes nobody is saving.

Usage: python3 tests/test_precompress.py
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import gen_manifest  # noqa: E402  (wanted() is the manifest's own source)

WEB = os.path.join(ROOT, "web")
ENGINE = ["ftewebgl.html", "ftewebgl.js", "ftewebgl.wasm"]

ok = fail = 0
files = sorted(set([rel for rel, _ in gen_manifest.wanted()] +
                   ["index.html", "landing/index.html", "menu.js"] + ENGINE))
for rel in files:
    src = os.path.join(WEB, rel)
    gz = src + ".gz"
    if not os.path.exists(src):
        print(f"  FAIL {rel}: the source itself is missing (manifest drift?)")
        fail += 1
        continue
    if not os.path.exists(gz):
        print(f"  FAIL {rel}: no .gz sibling -- raw bytes would be served "
              f"({os.path.getsize(src)} bytes instead of compressed)")
        fail += 1
        continue
    if os.path.getmtime(gz) < os.path.getmtime(src):
        print(f"  FAIL {rel}: .gz is older than the source; the servers would "
              f"fall back to raw bytes")
        fail += 1
        continue
    raw = open(src, "rb").read()
    r = subprocess.run(["zcat", gz], capture_output=True)
    if r.returncode != 0 or r.stdout != raw:
        print(f"  FAIL {rel}: .gz does not decompress byte-identically")
        fail += 1
        continue
    saving = len(raw) - os.path.getsize(gz)
    print(f"  ok {rel}: gz {os.path.getsize(gz)} of {len(raw)} "
          f"({saving * 100 // max(len(raw), 1)}% saved)")
    ok += 1

print()
if fail:
    print(f"gz: FAIL: {fail} of {ok + fail} files")
    sys.exit(1)
print(f"gz: PASS: {ok} files, every one fresh and byte-verified")

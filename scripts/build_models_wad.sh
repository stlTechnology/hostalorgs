#!/usr/bin/env bash
# Pack the player models, sprites and pickups that qwprogs.dat precaches into
# web/id1/models.pak.
#
# Why a pak rather than 49 manifest entries: FTE's client reads
# "progs/player.mdl" out of its virtual filesystem, and the page manifest would
# have to list every such path individually.  A pak gives all of them with one
# entry and one HTTP request.
#
# A pak, not a WAD2: models are addressed by full path, and a WAD2 lump name is
# 16 bytes, so "progs/backpack.mdl" does not fit.  A pak entry name is 56.
#
# The file list is derived from the compiled qwprogs.dat itself (the strings it
# precaches), not hand-written, so it cannot drift from what the code asks for.
# We use qwprogs.dat, LibreQuake's deathmatch build: the single-player progs.dat
# additionally precaches every monster, which is 80 MB of assets a team shooter
# has no use for.
#
# Sounds are deliberately NOT included: 86 MB of .wav is far too much for a web
# client, and missing sounds are a cosmetic gap rather than a failure to load.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LQ="$ROOT/third_party/LibreQuake/lq1"
WEB="$ROOT/web"
PROGS="$WEB/id1/qwprogs.dat"

[ -f "$PROGS" ] || { echo "FATAL: $PROGS missing. Run scripts/build_progs.sh" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== collecting model and sprite lumps precached by qwprogs.dat =="
python3 - "$PROGS" "$LQ" "$WORK" <<'PY'
import os, re, shutil, sys
progs, lq, work = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(progs, 'rb').read()
want = sorted(set(re.findall(rb'progs/[A-Za-z0-9_]+\.(?:mdl|spr)', data)))
n = 0
missing = []
for w in want:
    rel = w.decode()
    src = os.path.join(lq, rel)
    if not os.path.exists(src):
        missing.append(rel)
        continue
    dst = os.path.join(work, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy(src, dst)
    n += 1
print(f'  {n} of {len(want)} precached lumps present')
if missing:
    # Not fatal: a missing pickup model is a cosmetic gap, and FTE reports it
    # as "Unable to load" rather than refusing to start.
    print(f'  {len(missing)} not in the LibreQuake tree: '
          f'{", ".join(missing[:6])}{" ..." if len(missing) > 6 else ""}')
PY

if [ -z "$(find "$WORK" -type f -name '*.mdl' -o -type f -name '*.spr' -print -quit)" ]; then
  echo "FATAL: no lumps collected" >&2; exit 1
fi

python3 "$ROOT/scripts/mkpak.py" -o "$WEB/id1/models.pak" "$WORK"

echo "  models.pak $(du -h "$WEB/id1/models.pak" | cut -f1)"
bash "$ROOT/scripts/precompress_web.sh"
#!/usr/bin/env python3
"""Pack the gameplay sound subset into web/id1 as Ogg Vorbis.

LibreQuake's full sound set is 16 MB of wav, which is not acceptable for a
browser client. GAME-DESIGN.md asks for the gameplay subset converted to Ogg,
about 1 MB.

The file list comes from the compiled qwprogs.dat's precache strings, the same
way scripts/build_models_wad.sh derives its model list, so we ship exactly what
the game code asks for and cannot drift from it. Note the QuakeC precaches
"weapons/rlfire.wav" without the "sound/" root -- FTE prepends that itself --
so the paths here are rebuilt as "sound/<precached path>".

Format: Ogg Vorbis in a pak. A pak rather than a WAD2 because sound paths are
like "sound/weapons/rlfire.wav" and a WAD2 lump name is 16 bytes. The files
keep their .wav names, because the QuakeC precaches those and FTE decodes by
content rather than by extension.

ffmpeg does the encoding: mono 22.05 kHz at q3. These are noisy 8-bit-era
samples, so the extra fidelity is inaudible while the size is not.

Usage: build_sounds.py [--keep-going]
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LQ = os.path.join(ROOT, "third_party/LibreQuake/lq1")
OURS = os.path.join(ROOT, "assets", "sound")
WEB_ID1 = os.path.join(ROOT, "web", "id1")
PROGS = os.path.join(WEB_ID1, "qwprogs.dat")


def precached(progs_path):
    data = open(progs_path, "rb").read()
    # The QuakeC stores "weapons/rlfire.wav", not "sound/weapons/rlfire.wav".
    rels = sorted(set(m.decode() for m in
                      re.findall(rb"[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)*\.wav", data)))
    return rels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default=os.path.join(WEB_ID1, "sounds.pak"))
    args = ap.parse_args()

    if not os.path.exists(PROGS):
        print(f"FATAL: {PROGS} missing. Run scripts/build_progs.sh", file=sys.stderr)
        return 1
    if not shutil.which("ffmpeg"):
        print("FATAL: ffmpeg not found (needed to encode Ogg)", file=sys.stderr)
        return 1

    want = precached(PROGS)
    work = tempfile.mkdtemp(prefix="qwtf-snd-")
    stage = os.path.join(work, "stage")
    oggtmp = os.path.join(work, "ogg")
    os.makedirs(stage)
    os.makedirs(oggtmp)
    try:
        found, missing = [], []
        for rel in want:
            # Our own sounds (scripts/mk_sounds.py) first, then LibreQuake's.
            src = os.path.join(OURS, rel)
            if not os.path.exists(src):
                src = os.path.join(LQ, "sound", rel)
            if not os.path.exists(src):
                missing.append(rel)
                continue
            dst = os.path.join(stage, "sound", rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy(src, dst)
            found.append(rel)

        print(f"  {len(found)} of {len(want)} precached sounds present in LibreQuake")
        if missing:
            # These are single-player monster sounds the deathmatch progs do not
            # use. Reported rather than fatal: a missing sound is cosmetic, and
            # failing the build over it would block everything else.
            print(f"  {len(missing)} not present (monster sounds the DM progs do not "
                  f"use), e.g. {', '.join(missing[:5])}")
        if not found:
            print("FATAL: no sounds collected", file=sys.stderr)
            return 1

        def du(path):
            total = sum(os.path.getsize(os.path.join(r, f))
                        for r, _, fs in os.walk(path) for f in fs)
            return total

        before = du(stage)
        print(f"  source wav: {len(found)} files, {before/1048576:.1f} MiB")

        print("== encoding to Ogg Vorbis ==")
        for i, rel in enumerate(sorted(found), 1):
            src = os.path.join(stage, "sound", rel)
            # ffmpeg picks the muxer from the output extension, so the encoded
            # file must literally end in ".ogg". Encode to a scratch name and
            # move it over the original, keeping the .wav filename the QuakeC
            # precaches.
            tmp = os.path.join(oggtmp, rel.replace("/", "_") + ".ogg")
            r = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-i", src, "-vn", "-ac", "1", "-ar", "22050", "-q:a", "3", tmp],
                capture_output=True, text=True)
            if r.returncode != 0:
                print(f"FATAL: ffmpeg failed on sound/{rel}:\n{r.stderr.strip()}",
                      file=sys.stderr)
                return 1
            shutil.move(tmp, src)
            if i % 25 == 0 or i == len(found):
                print(f"    {i}/{len(found)}")

        after = du(stage)
        print(f"  encoded: {before/1048576:.1f} MiB -> {after/1048576:.1f} MiB")

        print("== packing sounds.pak ==")
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "mkpak.py"),
             "-o", args.out, stage],
            capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FATAL: mkpak failed:\n{r.stderr.strip()}", file=sys.stderr)
            return 1
        print("  " + r.stdout.strip())
        print(f"  sounds.pak {os.path.getsize(args.out)/1048576:.1f} MiB")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    # transport .gz for the fresh pak (0484; idempotent, staleness-driven)
    r = subprocess.run(["bash", os.path.join(ROOT, "scripts", "precompress_web.sh")])
    if r.returncode != 0:
        return r.returncode

    print()
    print("Next: scripts/gen_manifest.py adds it to web/index.html, then set")
    print("cl_downloads back to 1 (or leave it 0 and rely on the pak directly).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
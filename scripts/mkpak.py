#!/usr/bin/env python3
"""Write a Quake PAK file (the container FTE uses for models and sounds).

Format, from FTE's fs_pak.c / common/fs.c pak_archive:

    header : char[4] "PACK", int32 diroffset, int32 dirlen
    dir[]  : char name[56], int32 filepos, int32 filelen      -- 64 bytes
    files  : payload

A pak is keyed by a full path such as "progs/player.mdl", with no 15-character
name limit, which is why models go in a pak and textures go in a WAD2 (whose
lump names are 16 bytes).  We build it here rather than pulling in qpakman:
the format is 64 bytes of directory per file, and LibreQuake only ships
qpakman's helper scripts, not the binary.

Usage: mkpak.py -o web/id1/models.pak root_dir [root_dir ...]
Files are stored at their path relative to each root, so
  mkpak.py -o p.pak /tmp/stage
with /tmp/stage/progs/player.mdl produces the entry "progs/player.mdl".
"""

import argparse
import os
import struct
import sys

PAK_MAGIC = b"PACK"
ENTRY_SIZE = 64
NAME_SIZE = 56


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("roots", nargs="+")
    args = ap.parse_args()

    files = []
    for root in args.roots:
        for dirpath, _dirs, names in os.walk(root):
            for n in sorted(names):
                full = os.path.join(dirpath, n)
                if not os.path.isfile(full) or os.path.islink(full):
                    continue
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                if len(rel) >= NAME_SIZE:
                    print(f"  skip {rel}: {len(rel)} chars, pak holds "
                          f"{NAME_SIZE - 1} plus a NUL", file=sys.stderr)
                    continue
                files.append((rel, full))
    if not files:
        raise SystemExit("no files found")

    # Keep the tree order stable so the output is reproducible.
    files.sort(key=lambda t: t[0].lower())

    out = bytearray()
    out += struct.pack("<4sii", PAK_MAGIC, 0, len(files) * ENTRY_SIZE)
    entries = []
    for rel, full in files:
        with open(full, "rb") as f:
            data = f.read()
        pos = len(out)
        out += data
        raw = rel.lower().encode("latin1")
        entries.append(raw + b"\0" * (NAME_SIZE - len(raw)) +
                       struct.pack("<ii", pos, len(data)))

    for e in entries:
        assert len(e) == ENTRY_SIZE, len(e)
    dir_off = len(out)
    struct.pack_into("<i", out, 4, dir_off)
    out += b"".join(entries)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(out)
    total = sum(os.path.getsize(p) for _, p in files)
    print(f"wrote {args.out}: {len(files)} entries, dir at {dir_off}, "
          f"{total} bytes of payload, {len(out)} bytes total")


if __name__ == "__main__":
    main()
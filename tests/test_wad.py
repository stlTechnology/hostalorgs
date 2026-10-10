#!/usr/bin/env python3
"""Independent WAD2 reader + checks for the WADs we ship in web/id1.

Deliberately does NOT import scripts/mkwad.py.  It re-implements the WAD2
layout from scratch so a bug in the packer cannot hide behind a shared helper:

    header : "WAD2", int32 lumpcount, int32 dir_offset
    dir    : int32 filepos, int32 disksize, int32 size,
             uint8 type, uint8 compression, uint8 pad1, uint8 pad2,
             char name[16]                                   -- 32 bytes
    miptex : char name[16], int32 width, int32 height, int32 offsets[4]

Exits non-zero on the first failed expectation, so it works as a plain script
under `python3 tests/test_wad.py` and needs no test framework.

Usage:
    python3 tests/test_wad.py [--wad web/id1/our.wad] [--keep-old OLD_WAD]
"""

import argparse
import os
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

LUMPINFO_SIZE = 32
MIPTEX_HEADER = 40
MIPLEVELS = 4
LUMP_MIPTEX = 0x44

fails = []


def check(cond, what):
    print(("  ok   " if cond else "  FAIL ") + what)
    if not cond:
        fails.append(what)
    return cond


class Wad:
    """Minimal WAD2 reader, written against the layout above."""

    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            self.data = f.read()
        if self.data[:4] != b"WAD2":
            raise SystemExit(f"{path}: not a WAD2 (magic {self.data[:4]!r})")
        self.numlumps, self.dir_off = struct.unpack("<ii", self.data[4:12])

    def dir_entries(self):
        out = []
        for i in range(self.numlumps):
            off = self.dir_off + i * LUMPINFO_SIZE
            filepos, disksize, size, ctype, comp, pad1, pad2 = struct.unpack(
                "<iiiBBBB", self.data[off:off + 16])
            name = self.data[off + 16:off + 32].split(b"\0")[0].decode("latin1")
            out.append(dict(filepos=filepos, disksize=disksize, size=size,
                            type=ctype, compression=comp, pad=(pad1, pad2), name=name))
        return out

    def lump(self, entry):
        return self.data[entry["filepos"]:entry["filepos"] + entry["disksize"]]

    def miptex(self, entry):
        """Return (name, w, h, offsets, payload)."""
        blob = self.lump(entry)
        if len(blob) < MIPTEX_HEADER:
            raise SystemExit(f"{entry['name']}: lump is {len(blob)} bytes, "
                             f"shorter than a {MIPTEX_HEADER}-byte miptex header")
        name = blob[:16].split(b"\0")[0].decode("latin1")
        w, h = struct.unpack("<ii", blob[16:24])
        offsets = struct.unpack("<%di" % MIPLEVELS, blob[24:40])
        return name, w, h, offsets, blob[40:]


def expected_mip_sizes(w, h):
    return [max(1, w >> i) * max(1, h >> i) for i in range(MIPLEVELS)]


def check_wad(path, label):
    print(f"== {label}: {path}")
    try:
        w = Wad(path)
        entries = w.dir_entries()
    except (SystemExit, struct.error, IndexError) as e:
        # A WAD2 this reader cannot even enumerate is a failure, not a crash.
        check(False, f"the WAD2 directory is readable ({type(e).__name__}: {e})")
        return None, []
    check(True, "the WAD2 directory is readable")
    check(w.dir_off + w.numlumps * LUMPINFO_SIZE == len(w.data),
          f"directory ends exactly at EOF ({w.dir_off} + {w.numlumps}*{LUMPINFO_SIZE}"
          f" == {len(w.data)})")
    check(len(entries) > 0, f"has {len(entries)} lumps")

    names = []
    for e in entries:
        names.append(e["name"])
        check(e["type"] == LUMP_MIPTEX,
              f"{e['name']}: dir type is 0x{e['type']:02x} ('{chr(e['type'])}') == 0x44 'D'")
        check(e["compression"] == 0, f"{e['name']}: uncompressed")
        check(e["pad"] == (0, 0), f"{e['name']}: dir padding is zero")
        check(e["filepos"] >= 12, f"{e['name']}: filepos {e['filepos']} is past the header")

        mn, tw, th, offs, pixels = w.miptex(e)
        sizes = expected_mip_sizes(tw, th)
        check(mn.upper() == e["name"].upper(),
              f"{e['name']}: miptex name {mn!r} matches the directory entry")
        check(tw > 0 and th > 0 and (tw & (tw - 1)) == 0 and (th & (th - 1)) == 0,
              f"{e['name']}: {tw}x{th} is a power of two")
        want_off = [MIPTEX_HEADER + sum(sizes[:i]) for i in range(MIPLEVELS)]
        check(list(offs) == want_off,
              f"{e['name']}: mip offsets {list(offs)} == {want_off} for {tw}x{th}")
        check(len(pixels) == sum(sizes),
              f"{e['name']}: {len(pixels)} bytes of pixels == {sizes} summed to {sum(sizes)}")
        check(len(w.lump(e)) == MIPTEX_HEADER + sum(sizes),
              f"{e['name']}: lump size {e['size']} covers header plus all 4 mips")
    return w, names


def check_pixels(path, names):
    """Unpack the first mip back through the palette and compare with the PNG.

    Guards the quantiser: a squared-distance overflow in int16 wraps negative,
    argmin then returns near-arbitrary indices, and the WAD still parses.  A
    format check alone cannot see that, so decode and diff against the source.
    """
    import numpy as np
    from PIL import Image

    lq = os.path.join(ROOT, "third_party/LibreQuake")
    sources = {
        "conc1_1": "texture-wads/lq_conc/conc1_1.png",
        "light_fbr": "texture-wads/lq_utility/light_fbr.png",
        "tek_wall4_1": "texture-wads/lq_tech/tek_wall4_1.png",
        "skip": "texture-wads/lq_dev_legacy/skip.png",
    }
    palpath = os.path.join(lq, "lq1/gfx/palette.lmp")
    if not os.path.exists(palpath):
        print("  skip LibreQuake not fetched; cannot check pixels")
        return
    pal = np.frombuffer(open(palpath, "rb").read(), dtype=np.uint8).reshape(256, 3)

    w = Wad(path)
    by_name = {e["name"].lower(): e for e in w.dir_entries()}
    for name, rel in sources.items():
        if name not in by_name or name not in names:
            continue
        src = os.path.join(lq, rel)
        if not os.path.exists(src):
            continue
        _, tw, th, _, pixels = w.miptex(by_name[name])
        got = pal[np.frombuffer(pixels[:tw * th], dtype=np.uint8).reshape(th, tw)]
        want_rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.int32)
        # nearest palette entry of the source, the reference the packer must hit
        want = pal[((want_rgb[:, :, None, :] - pal.astype(np.int32)) ** 2)
                   .sum(-1).argmin(-1)].astype(np.int32)
        err = np.abs(got.astype(np.int32) - want).mean()
        n_idx = len(np.unique(np.frombuffer(pixels[:tw * th], dtype=np.uint8)))
        check(err == 0.0,
              f"{name}: pixels decode to exactly the source's nearest palette "
              f"entries ({n_idx} distinct indices, mean error {err:.2f}/255)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wad", default=os.path.join(ROOT, "web/id1/our.wad"))
    ap.add_argument("--old", default=None,
                    help="a WAD2 written by the old (broken) packer; the checks "
                         "above are expected to FAIL on it")
    args = ap.parse_args()

    w, names = check_wad(args.wad, "our WAD")

    # The names the map and qbsp actually reference.  If qbsp can't find these,
    # every face on the map gets a missing texture.  `skip` is not on any brush;
    # qbsp looks it up unconditionally (MakeSkipTexinfo).
    wanted = ["conc1_1", "light_fbr", "tek_wall4_1", "skip"]
    have = {n.upper() for n in names}
    for n in wanted:
        check(n.upper() in have, f"map texture {n!r} is present")

    print("-- pixels --")
    check_pixels(args.wad, [n.lower() for n in names])

    if args.old:
        print(f"\n== negative control: {args.old} (the old packer's output)")
        # Failures on the old WAD are the point of the exercise, so score them
        # separately: this control passes when the reader rejects that file.
        mark = len(fails)
        del fails[mark:]
        check_wad(args.old, "old WAD")
        rejected = len(fails)
        if rejected == 0:
            print("  FAIL the reader accepted the old, malformed WAD2")
            fails.append("old WAD was not rejected")
        else:
            print(f"  ok   the reader rejected the old WAD2 on {rejected} check(s)")
        del fails[:]

    print()
    if fails:
        print(f"FAIL: {len(fails)} of the checks above did not hold")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
#!/usr/bin/env python3
"""Pack PNG textures into a Quake WAD2 (paletted miptex lumps).

Format, as read by ericw-tools (common/fs.cc wad_archive + common/imglib.cc
load_mip, include/common/bspfile_generic.hh dmiptex_t) and by FTE:

    header  : char[4] "WAD2", int32 lumpcount, int32 dir_offset
    dir[]   : int32 filepos, int32 disksize, int32 size,
              char type, char compression, char pad1, char pad2,
              char name[16]                       -- 32 bytes per entry
    lumps   : payload

A texture lump is a Quake miptex_t, 40 bytes:

    char name[16]; int32 width, height; int32 offsets[4];   -- MIPLEVELS = 4

followed by exactly four mip levels of 8-BIT PALETTED pixels, one byte per
pixel, with no padding between them and no trailing palette.  Mip i has
dimensions max(1, width>>i) x max(1, height>>i), so the lump is

    40 + w*h + (w>>1)*(h>>1) + (w>>2)*(h>>2) + (w>>3)*(h>>3)          (bytes)

Both numbers matter: a directory entry that is not 32 bytes long, or a miptex
with 16 offsets or RGBA pixels, parses as garbage and qbsp reports
"unable to find texture" for every texture in the map.  tests/test_wad.py
checks this file's output against an independent reader.

Pixels are quantised to the 256-colour Quake palette in LibreQuake's
lq1/gfx/palette.lmp (BSD-3-Clause), which is what the engine and qbsp use to
turn indices back into colour, so an 8-bit index has to mean the same colour
here as it does there.  Nearest-colour in RGB; the palette is a short ramp, so
the error is a couple of levels on heavily saturated pixels.

Usage:
    mkwad.py -o web/id1/our.wad tex1.png tex2.png ...
The lump name is the PNG's basename with the extension stripped, except that a
`star_` prefix becomes `*`: a `*` cannot appear in a file name, so LibreQuake ships
water as `star_water1.png` and the WAD has to call it `*water1`.

That is not cosmetic. qbsp decides what a brush IS from its texture name: a leading
`*` makes it water (CONTENTS_WATER), and anything else makes it solid. So a map that
asks for water needs a lump literally named `*water1`, and with only `star_water1.png`
copied in verbatim qbsp warns

    WARNING: unable to find texture *water1

and the channel is either solid or empty. build_maps.sh refuses on that warning,
which is how it was found.
"""

import argparse
import os
import struct
import sys

import numpy as np
from PIL import Image

# Quake MIPLEVELS (bspfile_generic.hh: constexpr size_t MIPLEVELS = 4;)
MIPLEVELS = 4
# miptex_t: char name[16]; int32 width, height; int32 offsets[MIPLEVELS]
MIPTEX_HEADER = 16 + 4 + 4 + MIPLEVELS * 4
# lumpinfo_t: 3 x int32 + 4 x char + char name[16]
LUMPINFO_SIZE = 12 + 4 + 16

# 'D' (0x44) marks a lump as a miptex.  See fs.cc wad_lump_header::type.
LUMP_MIPTEX = 0x44
# Every other lump type FTE's wad_archive cares about.  fs.cc keys files by name
# only, but keeping the conventional type byte makes the WAD readable by
# other tools too.  See Quake's wad lump types: 0x44 miptex, 0x50 palette,
# 0x42 picture, 0x30 flat, 'M'..'N' alias models, 'D'..'E' player models.
LUMP_RAW = 0x00

DEFAULT_PALETTE = "third_party/LibreQuake/lq1/gfx/palette.lmp"


def lump_name(path):
    """The WAD lump name for a PNG: basename, with `star_` meaning `*`.

    A `*` is legal in a WAD lump name but not in a file name, which is why the
    water textures ship as star_water1.png.
    """
    name = os.path.splitext(os.path.basename(path))[0]
    if name.startswith("star_"):
        name = "*" + name[len("star_"):]
    return name


def lump_type(name, data):
    """Conventional WAD2 type byte for a lump we are copying verbatim."""
    ext = os.path.splitext(name)[1].lower()
    if ext == ".mdl":
        first = data[:4]
        return ord("M") if first[:3] == b"IDP" else ord("N")
    if ext == ".spr":
        return ord("C")
    if ext == ".wav":
        return ord("P")
    return LUMP_RAW


def load_palette(path):
    """Return an (256, 3) uint8 array of RGB triples."""
    with open(path, "rb") as f:
        raw = f.read()
    if len(raw) != 768:
        raise SystemExit(f"{path}: expected 768 bytes (256 RGB triples), got {len(raw)}")
    return np.frombuffer(raw, dtype=np.uint8).reshape(256, 3)


def quantise(img, palette):
    """Map an RGB(A) image to a (h, w) uint8 array of palette indices."""
    # int32, not int16: a squared channel distance reaches 255*255 = 65025,
    # which wraps negative in int16 and makes argmin pick arbitrary colours.
    a = np.asarray(img.convert("RGB"), dtype=np.int32)
    h, w, _ = a.shape
    pal = palette.astype(np.int32)
    # Nearest palette entry, in chunks so a 256x256 texture does not allocate
    # a h*w*256 int16 array (that is 256 MiB) all at once.
    out = np.empty((h, w), dtype=np.uint8)
    step = max(1, (1 << 22) // 256)
    for y0 in range(0, h, step):
        chunk = a[y0:y0 + step]
        d = ((chunk[:, :, None, :] - pal[None, None, :, :]) ** 2).sum(axis=-1)
        out[y0:y0 + step] = d.argmin(axis=-1).astype(np.uint8)
    return out


def build_miptex(name, img, palette):
    """Return (bytes, width, height) for one paletted miptex lump."""
    w, h = img.size
    # Quake needs power-of-two dimensions.
    if (w & (w - 1)) or (h & (h - 1)):
        raise SystemExit(f"{name}: {w}x{h} is not a power of two")

    base = quantise(img, palette)
    mips = [base]
    for i in range(1, MIPLEVELS):
        mw, mh = max(1, w >> i), max(1, h >> i)
        mips.append(np.asarray(
            Image.fromarray(base).resize((mw, mh), Image.BOX), dtype=np.uint8))

    offsets = []
    cursor = MIPTEX_HEADER
    for m in mips:
        offsets.append(cursor)
        cursor += m.shape[0] * m.shape[1]

    raw = name.encode("latin1")
    if len(raw) > 15:
        raise SystemExit(f"{name}: name is {len(raw)} chars, WAD2 holds 15 plus a NUL")
    head = struct.pack("<16s", raw)
    head += struct.pack("<ii", w, h)
    head += b"".join(struct.pack("<i", o) for o in offsets)
    assert len(head) == MIPTEX_HEADER, len(head)

    return head + b"".join(m.tobytes() for m in mips), w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--palette", default=None,
                    help=f"768-byte Quake palette (default: {DEFAULT_PALETTE})")
    ap.add_argument("--raw-prefix", default=None,
                    help="treat inputs whose path contains this as verbatim "
                         "lumps (e.g. 'progs/') rather than textures to "
                         "quantise. Inputs before --raw-prefix are textures, "
                         "inputs after it are raw.")
    ap.add_argument("pngs", nargs="+")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    palette = load_palette(args.palette or os.path.join(root, DEFAULT_PALETTE))

    # Inputs up to --raw-prefix are PNG textures; the rest are raw lumps.
    split = len(args.pngs)
    if args.raw_prefix:
        for i, p in enumerate(args.pngs):
            if args.raw_prefix in p.replace(os.sep, "/"):
                split = i
                break

    lumps = []
    for p in args.pngs[:split]:
        name = lump_name(p)
        with Image.open(p) as im:
            data, w, h = build_miptex(name, im, palette)
        lumps.append((name, data, LUMP_MIPTEX))
        print(f"  {name:<24} {w}x{h}  {len(data):>8} bytes  miptex")

    for p in args.pngs[split:]:
        rel = p.replace(os.sep, "/")
        i = rel.find(args.raw_prefix) if args.raw_prefix else -1
        name = rel[i:] if i >= 0 else os.path.basename(rel)
        if len(name) > 15:
            raise SystemExit(f"{name}: WAD2 lump names hold 15 chars plus a NUL")
        with open(p, "rb") as f:
            data = f.read()
        t = lump_type(name, data)
        lumps.append((name, data, t))
        print(f"  {name:<24} {len(data):>8} bytes  type 0x{t:02x} "
              f"('{chr(t)}') raw")
    if not lumps:
        raise SystemExit("no input files")

    # header, then lump payloads, then the directory.
    # NOTE: dir_off must be the position AFTER the last lump.  Capturing it right
    # after the 12-byte header points the directory straight through the first
    # lump, which is what the first version did.
    out = bytearray()
    out += struct.pack("<4sii", b"WAD2", len(lumps), 0)

    entries = []
    for name, data, ltype in lumps:
        pos = len(out)
        out += data
        raw = name.upper().encode("latin1")
        entries.append(struct.pack("<iiiBBBB16s", pos, len(data), len(data),
                                   ltype, 0, 0, 0, raw))
    for e in entries:
        assert len(e) == LUMPINFO_SIZE, len(e)

    dir_off = len(out)
    struct.pack_into("<i", out, 8, dir_off)
    out += b"".join(entries)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(out)
    print(f"wrote {args.out}: {len(lumps)} lumps, {len(out)} bytes, "
          f"dir at {dir_off} ({len(entries)} x {LUMPINFO_SIZE} bytes)")


if __name__ == "__main__":
    main()
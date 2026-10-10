#!/usr/bin/env python3
"""Tint a LibreQuake texture into a team colour, for the CTF map's two bases.

GAME-DESIGN.md asks for "red-tinted textures and lights in one base, blue in the
other". Lights alone would carry the identity, which is weak: a screenshot of an
unlit corner gives nothing away, and the base would read as the same castle twice.

Quake textures are 8-bit paletted, so a tint cannot be a colour attribute on the
brush -- it has to be baked into the pixels. So this reads a LibreQuake texture
and writes a tinted copy, and scripts/build_maps.sh packs the result into
our.wad alongside the originals. Nothing new is drawn: the pixels come from
LibreQuake (GPL/BSD notice already in web/licences/), only the channels are
scaled, and the result is named so the licence trail stays obvious.

    scripts/mktinted.py SRC.png OUT.png --tint 255,90,90

The tint is a per-channel multiply, which keeps the texture's own light and
dark detail instead of flattening it to a colour, then a small contrast lift so
the darker team wall does not disappear in an unlit corridor.
"""

import argparse
import os
import sys

from PIL import Image


def tint(img, rgb, strength=0.65, lift=1.15):
    """Duotone the image into `rgb`, keeping the texture's own light and dark.

    My first attempt multiplied each channel toward the target, which does
    almost nothing on a texture that is already brown: the brick stayed brown.
    Team identity has to be obvious from a screenshot, so this maps the
    texture's LUMINANCE across a ramp of the team colour instead -- dark stone
    stays dark, lit stone stays bright, and everything reads as red or blue.
    The source's own detail still shows, because only the shading is remapped.
    """
    out = Image.new("RGB", img.size)
    src = img.convert("RGB")
    px_src = src.load()
    px_out = out.load()
    w, h = src.size
    for y in range(h):
        for x in range(w):
            r, g, b = px_src[x, y]
            lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255.0
            # Blend between "the original texel" and "the team colour at this
            # brightness", so `strength` still means something.
            # `k` is CONSTANT, not scaled by luminance: the ramp below already
            # carries the brightness, and scaling the mix by it too left the
            # source's own colour showing through, which on a brown brick meant
            # the "red" wall came out brown.
            k = strength
            cr = rgb[0] * (0.30 + 0.70 * lum)
            cg = rgb[1] * (0.30 + 0.70 * lum)
            cb = rgb[2] * (0.30 + 0.70 * lum)
            px_out[x, y] = (
                int(min(255, (r * (1 - k) + cr * k) * lift)),
                int(min(255, (g * (1 - k) + cg * k) * lift)),
                int(min(255, (b * (1 - k) + cb * k) * lift)),
            )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--tint", required=True,
                    help="R,G,B target colour, e.g. 255,90,90")
    ap.add_argument("--strength", type=float, default=0.85)
    ap.add_argument("--lift", type=float, default=1.25)
    args = ap.parse_args()

    if not os.path.exists(args.src):
        sys.exit(f"FATAL: {args.src} missing. Run scripts/fetch_third_party.sh")

    rgb = tuple(int(v) for v in args.tint.split(","))
    if len(rgb) != 3 or any(not 0 <= c <= 255 for c in rgb):
        sys.exit("FATAL: --tint must be three 0-255 values")

    img = Image.open(args.src)
    w, h = img.size
    # mkwad.py requires power-of-two dimensions, so refuse early with a clear
    # message rather than letting the WAD packer fail later.
    if w & (w - 1) or h & (h - 1):
        sys.exit(f"FATAL: {args.src} is {w}x{h}, not a power of two")

    out = tint(img, rgb, args.strength, args.lift)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    # Quake reads RGB, but mkwad.py quantises with a palette; saving as P with
    # an adaptive palette keeps the file small and the packer happy.
    out.convert("P", palette=Image.ADAPTIVE, colors=256).save(args.out)
    print(f"  tinted {os.path.basename(args.src)} -> {args.out} "
          f"({w}x{h}, rgb{rgb}, strength {args.strength})")


if __name__ == "__main__":
    main()
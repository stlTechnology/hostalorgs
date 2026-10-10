#!/usr/bin/env python3
"""Decode BSP face ids from a face-id view image (debug view 1).

  python3 tools/faceat.py recordings/<snap>/faceid.png 640 400     # face at a pixel
  python3 tools/faceat.py recordings/<snap>/faceid.png --box 500 300 700 450
        # faces covering a region, by pixel count (e.g. a suspicious rectangle)
  python3 tools/faceat.py replay/v1/00012.png --top 15             # biggest faces on screen

Encoding (r_render.c dbg_id_color): id + 1 = R + 256 * round((B - 40) / 85).
Pixels that are not world geometry (sky, models, HUD) decode to -1 or noise
and are reported as 'other'.  Coordinates are image pixels, origin top-left.
"""
import sys
from collections import Counter

from PIL import Image


def decode(px):
    r, g, b = px[:3]
    hi = round((b - 40) / 85)
    if hi < 0 or hi > 3 or abs(b - (40 + 85 * hi)) > 2:
        return None
    v = r + 256 * hi
    if (v * 97) & 0xFF != g and abs(((v * 97) & 0xFF) - g) > 1:
        return None   # G is a checksum of the id
    return v - 1


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 2
    im = Image.open(a[0]).convert('RGB')
    W, H = im.size
    if len(a) == 3 and a[1].isdigit():
        x, y = int(a[1]), int(a[2])
        f = decode(im.getpixel((x, y)))
        print(f'pixel ({x},{y}) of {W}x{H}: ' + (f'face {f}' if f is not None else f'not a world face {im.getpixel((x, y))}'))
        return 0
    box = (0, 0, W, H)
    top = 20
    if '--box' in a:
        i = a.index('--box')
        box = tuple(int(v) for v in a[i + 1:i + 5])
    if '--top' in a:
        top = int(a[a.index('--top') + 1])
    c = Counter()
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            f = decode(im.getpixel((x, y)))
            c['other' if f is None else f] += 1
    total = sum(c.values())
    print(f'region {box} of {W}x{H}: {total} px')
    for f, n in c.most_common(top):
        print(f'  {"face " + str(f) if f != "other" else "other (sky/model/HUD)":>24}  {n:7d} px  {100 * n / total:5.1f}%')
    return 0


if __name__ == '__main__':
    sys.exit(main())

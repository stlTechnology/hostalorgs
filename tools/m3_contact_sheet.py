#!/usr/bin/env python3
"""Build a contact sheet from the frames tests/mp_combat.js captured.

  python3 tools/m3_contact_sheet.py            # -> screens/m3-contact.jpg
  python3 tools/m3_contact_sheet.py --frames tests/artifacts/frames \
                                    --out screens/m3-contact.jpg

This is a small sibling of tools/contact_sheet.py, which reads the retired
custom engine's JSON recordings. Those are gone; M3's recording is an FTE .mvd
plus PNG frames grabbed from the live browser clients, so this reads the frames.

Each tile is labelled with its index and the timestamp within the recording, so
the sheet shows the session's progression rather than ten near-identical stills.
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def font(size):
    for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
              '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', default=os.path.join(ROOT, 'tests/artifacts/frames'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'screens/m3-contact.jpg'))
    ap.add_argument('--cols', type=int, default=5)
    ap.add_argument('--tile-width', type=int, default=320)
    ap.add_argument('--window', type=float, default=10.0,
                    help='length of the recording the frames span, in seconds')
    args = ap.parse_args()

    if not os.path.isdir(args.frames):
        print(f'FATAL: no frames directory at {args.frames}\n'
              f'       run: node tests/mp_combat.js', file=sys.stderr)
        return 1
    names = sorted(n for n in os.listdir(args.frames) if n.endswith('.png'))
    if not names:
        print(f'FATAL: no .png frames in {args.frames}', file=sys.stderr)
        return 1

    first = Image.open(os.path.join(args.frames, names[0]))
    tw = args.tile_width
    th = max(1, round(tw * first.height / first.width))
    label = 16
    cols = max(1, min(args.cols, len(names)))
    rows = (len(names) + cols - 1) // cols

    sheet = Image.new('RGB', (cols * tw, rows * (th + label)), (16, 16, 20))
    d = ImageDraw.Draw(sheet)
    f = font(12)

    for i, n in enumerate(names):
        im = Image.open(os.path.join(args.frames, n)).convert('RGB')
        im = im.resize((tw, th), Image.LANCZOS)
        x = (i % cols) * tw
        y = (i // cols) * (th + label)
        sheet.paste(im, (x, y))
        t = (i / max(1, len(names) - 1)) * args.window
        d.text((x + 4, y + th + 2), f'{n}  t={t:0.1f}s', fill=(200, 200, 210), font=f)
        d.rectangle([x, y, x + tw - 1, y + th + label - 1], outline=(60, 60, 70))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sheet.save(args.out, quality=88)
    print(f'wrote {args.out}: {len(names)} frames, {cols}x{rows}, '
          f'{sheet.width}x{sheet.height}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
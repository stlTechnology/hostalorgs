#!/usr/bin/env python3
"""Turn a recording into contact sheets an agent can read in one image.

  python3 tools/contact_sheet.py recordings/<id>                 # contact.jpg (+ marks.jpg)
  python3 tools/contact_sheet.py recordings/<id> --from 3.0 --to 5.0 --n 16 --out zoom.jpg
  python3 tools/contact_sheet.py recordings/<id> --replay replay/v0 --out compare.jpg
        # side by side: the user's frame (left) vs the headless replay (right)

Each tile is labelled with frame index, time, origin, yaw/pitch and keys held.
Tiles at an F9 marker get a red border.
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

KEYNAMES = {87: 'W', 65: 'A', 83: 'S', 68: 'D', 32: 'SPC', 16: 'SHF', 17: 'CTL',
            38: 'UP', 40: 'DN', 37: 'LT', 39: 'RT', 69: 'E', 81: 'Q'}


def font(size):
    for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
              '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def label(fr, idx):
    o, a = fr['o'], fr['a']
    keys = '+'.join(KEYNAMES.get(k, str(k)) for k in fr.get('k', [])) or '-'
    m = fr.get('m', [0, 0])
    return (f"#{idx} t={fr['t']:.2f}s keys {keys} mouse {m[0]:+d},{m[1]:+d}\n"
            f"pos {o[0]:.0f},{o[1]:.0f},{o[2]:.0f} yaw {a[2]:.0f} pitch {a[1]:.0f}")


def pick(thumbs, n, t0=None, t1=None):
    sel = [t for t in thumbs if (t0 is None or t['t'] >= t0) and (t1 is None or t['t'] <= t1)]
    if len(sel) <= n:
        return sel
    step = (len(sel) - 1) / (n - 1)
    return [sel[round(i * step)] for i in range(n)]


def sheet(rec_dir, rec, tiles, out, replay_dir=None, cols=None, title=''):
    if not tiles:
        return None
    frames, marks = rec['frames'], {m['f'] for m in rec.get('marks', [])}
    first = Image.open(os.path.join(rec_dir, tiles[0]['file']))
    tw, th = first.size
    pair = 2 if replay_dir else 1
    cols = cols or (2 if pair == 2 else 4)
    rows = (len(tiles) + cols - 1) // cols
    lh, f = 32, font(11)
    head = 28
    W, H = cols * tw * pair + (cols + 1) * 6, head + rows * (th + lh + 6) + 6
    img = Image.new('RGB', (W, H), (18, 20, 28))
    d = ImageDraw.Draw(img)
    d.text((8, 6), title, fill=(230, 230, 240), font=font(13))
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        x, y = 6 + c * (tw * pair + 6), head + r * (th + lh + 6)
        im = Image.open(os.path.join(rec_dir, t['file'])).convert('RGB').resize((tw, th))
        img.paste(im, (x, y))
        if replay_dir:
            rp = os.path.join(replay_dir, f"{t['f']:05d}.png")
            if os.path.exists(rp):
                img.paste(Image.open(rp).convert('RGB').resize((tw, th)), (x + tw, y))
            else:
                d.text((x + tw + 8, y + 8), 'no replay frame', fill=(200, 80, 80), font=f)
        near_mark = any(abs(t['f'] - m) <= 3 for m in marks)
        if near_mark:
            d.rectangle([x - 3, y - 3, x + tw * pair + 2, y + th + 2], outline=(230, 40, 40), width=3)
        fr = frames[t['f']] if 0 <= t['f'] < len(frames) else None
        if fr:
            d.text((x, y + th + 2), label(fr, t['f']), fill=(200, 210, 230), font=f)
    img.save(out, quality=88)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--n', type=int, default=16)
    ap.add_argument('--from', dest='t0', type=float)
    ap.add_argument('--to', dest='t1', type=float)
    ap.add_argument('--out')
    ap.add_argument('--replay', help='directory of replay frames named NNNNN.png by frame index')
    a = ap.parse_args()
    rec = json.load(open(os.path.join(a.dir, 'rec.json')))
    thumbs = rec.get('thumbs', [])
    if not thumbs:
        print('no thumbnails in recording', file=sys.stderr)
        return 1
    note = (rec.get('note') or '').strip().replace('\n', ' ')
    dur = rec['frames'][-1]['t'] if rec['frames'] else 0
    title = f"{os.path.basename(a.dir.rstrip('/'))}  {dur:.1f}s  {len(rec['frames'])} frames  note: {note[:120]}"
    if a.out or a.t0 is not None or a.t1 is not None or a.replay:
        out = a.out or os.path.join(a.dir, 'zoom.jpg')
        print(sheet(a.dir, rec, pick(thumbs, a.n, a.t0, a.t1), out, a.replay, title=title))
        return 0
    print(sheet(a.dir, rec, pick(thumbs, a.n), os.path.join(a.dir, 'contact.jpg'), title=title))
    marks = rec.get('marks', [])
    if marks:
        tiles = []
        for m in marks[:4]:
            tiles += pick(thumbs, 4, m['t'] - 0.6, m['t'] + 0.3)
        print(sheet(a.dir, rec, tiles, os.path.join(a.dir, 'marks.jpg'),
                    title=title + '  (4 frames up to each F9 mark, one row per mark)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Render the CTF map from directly above, as an overhead layout picture.

M4a's done-when asks for "an overhead screenshot of the layout". This produces
that picture without a browser, by raycasting the generator's own box list
straight down onto a grid: for each cell, the highest surface below the camera is
found and coloured by what it is made of.

Doing it from the generator rather than from the compiled .bsp is deliberate and
it is also the check that matters: if the picture shows three routes, a flag room
in each corner and a rise in the middle, then those exist in the GEOMETRY. A
screenshot of the BSP would only prove the BSP rendered.

    scripts/overhead.py -o screens/m4a-overhead.png
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_map as g
import mapfile  # noqa: E402

# Colour per surface, chosen so the two bases and the routes are unmistakable.
COLOURS = {
    g.TEX_RED: (150, 45, 40),
    g.TEX_BLUE: (45, 70, 150),
    g.TEX_FLOOR: (70, 70, 74),
    g.TEX_CEIL: (40, 40, 44),
    g.TEX_WALL: (110, 108, 104),
    g.TEX_PILLAR: (128, 126, 120),
}
FALLBACK = (60, 60, 64)


def all_boxes():
    return (g.shell_geometry()
            + g.base_geometry()
            + g.mirror_boxes(g.base_geometry(), g.TEX_RED, g.TEX_BLUE)
            + g.midfield_geometry())


def surface_at(boxes, x, y, ceiling_z):
    """The highest walkable surface at or below `ceiling_z` covering (x, y).

    RAMP-AWARE (0341, 0395: "floorplan.py (show slope direction)"). `z1` on a ramp is
    the plane's z at its HIGH end, so reading z1 here drew the whole slope at the top and
    left its low end as a hole in the plan -- and a plan with holes in it is the one
    artefact a reviewer reads to decide whether the map makes sense. So the surface is
    `mapfile.top_at(b, x, y)`, the same question the router and the checks ask, and
    `slope_of` is what says which way the ground tilts under a cell.
    """
    best_z, best_tex, best_slope = None, None, 0.0
    for b in boxes:
        x0, y0, _z0, x1, y1, _z1, tex = b[:7]
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            continue
        z = mapfile.top_at(b, x, y)
        if z > ceiling_z:
            continue
        if best_z is None or z > best_z:
            best_z, best_tex, best_slope = z, tex, _tilt(b, x, y)
    return best_z, best_tex, best_slope


def _tilt(b, x, y, probe=16):
    """Which way the surface falls from (x, y), in map units per unit, and in sign.

    Positive means it falls as x rises, negative as x falls, and a slope that runs in y
    is reported as 0 with `axis` saying so -- the floor plan needs the DIRECTION, not
    just that the ground is not flat.
    """
    if not mapfile.is_ramp(b):
        return (0.0, None)
    along = b[7][1]
    ax = (x + probe, y) if along == "x" else (x, y + probe)
    a = (x - probe, y) if along == "x" else (x, y - probe)
    return (mapfile.top_at(b, *ax) - mapfile.top_at(b, *a), along)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--scale", type=int, default=2,
                    help="pixels per 16 map units")
    args = ap.parse_args()

    boxes = all_boxes()
    x0, x1 = -16, g.CTF_LEN + 16
    y0, y1 = g.CTF_Y0 - 16, g.CTF_Y1 + 16
    cell = 16
    w = (x1 - x0) // cell
    h = (y1 - y0) // cell
    img = Image.new("RGB", (w * args.scale, h * args.scale), (12, 12, 14))
    px = img.load()

    # Camera above everything, so we see the walkable top of each surface: the
    # walkway and the overlook show as platforms, the tunnel as a slot.
    ceiling_z = g.CTF_H + 1
    for cy in range(h):
        y = y0 + cy * cell + cell / 2
        for cx in range(w):
            x = x0 + cx * cell + cell / 2
            z, tex, tilt = surface_at(boxes, x, y, ceiling_z)
            if z is None:
                continue
            col = COLOURS.get(tex, FALLBACK)
            # Brighter the higher the surface, so the rise and the walkway read
            # as raised without needing a legend.
            k = 0.55 + 0.45 * min(1.0, max(0.0, (z + 100) / 340.0))
            col = tuple(int(min(255, c * k)) for c in col)
            # AND THE DIRECTION IT FALLS (0341: the floor plan shows slope direction).
            # A plan that only says how HIGH a cell is cannot tell a ramp from a stair
            # from a flat roof, which is the whole thing a plan is for here. A sloped
            # cell is drawn a third darker on the side it falls towards, so the ramp
            # reads as a ramp in the picture and not only in the numbers.
            if tilt[1]:
                col = tuple(int(c * (0.78 if (tilt[0] > 0) == (dx > args.scale / 2)
                                  else 1.0)) for c in col)
            for dy in range(args.scale):
                for dx in range(args.scale):
                    px[cx * args.scale + dx, cy * args.scale + dy] = col

    d = ImageDraw.Draw(img)

    def mark(mx, my, colour, label):
        cx = int((mx - x0) / cell * args.scale)
        cy = int((my - y0) / cell * args.scale)
        r = 3 * args.scale
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=colour, width=args.scale)
        d.text((cx + r + 2, cy - 6), label, fill=colour)

    ents = g.base_entities(False) + g.base_entities(True)
    for fields in ents:
        name = fields[0]
        origin = next((f for f in fields if f.startswith('"origin"')), None)
        if not origin:
            continue
        parts = origin.split('"')[3].split()
        x, y = float(parts[0]), float(parts[1])
        if name == "info_player_deathmatch":
            mark(x, y, (255, 255, 255), "")
        elif name == "info_ctf_flag":
            mark(x, y, (255, 230, 40), "flag")
        elif name.startswith("item_"):
            mark(x, y, (120, 255, 120), "")

    # The dividing wall and its three routes, labelled on the picture itself.
    my = g.CTF_MID_Y
    for label, oy in (("hall", my), ("walk", 320), ("tunnel", 728)):
        cx = int((408 - x0) / cell * args.scale)
        cy = int((oy - y0) / cell * args.scale)
        d.line([cx - 8 * args.scale, cy, cx + 8 * args.scale, cy],
               fill=(255, 255, 255), width=args.scale)
        d.text((cx + 9 * args.scale, cy - 6), label, fill=(255, 255, 255))

    d.text((4, 4), "red base <- three routes -> midfield -> three routes -> blue base",
           fill=(200, 200, 200))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    img.save(args.out)
    print(f"wrote {args.out}: {img.size[0]}x{img.size[1]} from {len(boxes)} boxes "
          f"(top-down, {cell}u cells)")


if __name__ == "__main__":
    main()
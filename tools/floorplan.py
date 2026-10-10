#!/usr/bin/env python3
"""A floor plan of the forts map at a chosen level, as text.

    tools/floorplan.py                 # hall floor level, side A
    tools/floorplan.py --level 24      # 24 above a surface
    tools/floorplan.py --z -264        # bed level
    tools/floorplan.py --all           # every level that has any

WHY THIS EXISTS
---------------
Reviewer 0324: "the walls you added are all BELOW the hall floor. They wall the shaft
from the corridor, not from the hall. A player walking the hall still steps straight
off the edge, which is exactly the trace." Then: "Please put this plan in your
statuses (tools/floorplan.py, 0308 item 3). It would have shown this before the
commit."

It would have. The shaft read as blank on both long sides at hall level in the same
way it read as walled in the source, because a wall that is not at the level you are
looking at is not a wall at that level -- and every other view of this map is either
a number or an engine trace, neither of which shows a missing edge.

    .   floor at this level        #   solid across this column
    s   a stair tread here         (   lower step
    ~   a drop of 32 or more below this column
    (space)  nothing to stand on

It reads maps/forts.map through scripts/mapfile.py, so what it draws is what qbsp
compiles and what a player walks on. It is a VIEW, not a model: it cannot disagree
with the map without the map changing.
"""

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import gen_map as g  # noqa: E402
import mapfile  # noqa: E402

HULL_XY = g.HULL_MAX_XY          # 16: the player is not a point
STEP = 32


def free(bs, x, y, z):
    """Is a hull-sized box centred on (x, y, z) inside nothing?"""
    for x0, y0, z0, x1, y1, z1, _t in bs:
        if (x0 < x + HULL_XY and x1 > x - HULL_XY
                and y0 < y + HULL_XY and y1 > y - HULL_XY
                and z0 < z + g.HULL_MAX_Z and z1 > z - g.HULL_MIN_Z):
            return False
    return True


def surfaces(bs, x, y):
    """Every surface at this column a player could stand on, ascending."""
    out = []
    for b in bs:
        top = b[5]
        if b[0] <= x <= b[3] and b[1] <= y <= b[4] and top not in out:
            if free(bs, x, y, top + g.HULL_MIN_Z):
                out.append(top)
    return sorted(out)


def at_level(bs, x, y, level):
    """The standable surface NEAREST this level, and how far off it is.

    Nearest, not highest: every column of a fort has a roof over it and most have the
    sky above that, so "the highest surface" draws the whole map as solid and shows
    nothing at all. The question a floor plan is asked is "what is underfoot HERE".
    """
    tops = surfaces(bs, x, y)
    if not tops:
        return None, None
    best = min(tops, key=lambda t: abs(t - level))
    return best, best - level


def plan(bs, level, x0, x1, mirror=False):
    """One row of characters per STEP of y, one column per STEP of x."""
    rows = []
    y = 0
    while y <= g.sc(g.FORTS_WID):
        row = []
        x = x0
        while x <= x1:
            cx = g.sc(g.FORTS_LEN) - x if mirror else x
            top, off = at_level(bs, cx, y, level)
            if top is None:
                row.append(" ")
            elif abs(off) <= STEP // 2:
                row.append(".")
            elif 0 < off <= 40:
                row.append("(")      # a step up: this is a stair
            elif off > 40:
                row.append("#")      # solid across at this level
            else:
                row.append("~")      # a drop: this is an edge
            x += STEP
        rows.append("".join(row))
        y += STEP
    return rows


def header(x0, x1, mirror):
    ticks = ""
    for i, x in enumerate(range(x0, x1 + 1, STEP)):
        if x % (STEP * 10) == 0:
            ticks += ("" if len(ticks) > i else " ") * 0
    marks = [" "] * (((x1 - x0) // STEP) + 1)
    for x in range(x0, x1 + 1, STEP):
        if x % (STEP * 10) == 0:
            marks[(x - x0) // STEP] = "|"
        if x % (STEP * 5) == 0:
            marks[(x - x0) // STEP] = marks[(x - x0) // STEP] or "+"
    return "".join(marks), ticks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default=os.path.join(ROOT, "maps/forts.map"))
    ap.add_argument("--level", type=float, default=None,
                    help="the surface height to draw (default: the hall floor)")
    ap.add_argument("--z", type=float, default=None,
                    help="an origin height; the level drawn is z - HULL_MIN_Z")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--mirror", action="store_true", help="draw fort B instead")
    ap.add_argument("--x0", type=int, default=0)
    ap.add_argument("--x1", type=int, default=None)
    a = ap.parse_args()

    bs = [b for b in mapfile.brushes(a.map) if b[6] != g.TEX_WATER]
    if a.x1 is None:
        # Side A only, which is the side everything is built on (0314).
        a.x1 = g.sc(g.FORTS_FORT_X1)

    levels = []
    if a.all:
        seen = sorted({b[5] for b in bs if -400 <= b[5] <= 700})
        levels = seen
    elif a.level is not None:
        levels = [a.level]
    elif a.z is not None:
        levels = [a.z - g.HULL_MIN_Z]
    else:
        levels = [g.sc(g.FORTS_GROUND_Z)]

    print(f"forts {'B' if a.mirror else 'A'}, world units, "
          f"x {a.x0}..{a.x1} step {STEP}")
    print(f"  '.' floor at this level   '#' solid across   '(' lower step   "
          f"'~' drop 32+ below   ' ' nothing to stand on")
    for lev in levels:
        rows = plan(bs, lev, a.x0, a.x1, a.mirror)
        marks, _ = header(a.x0, a.x1, a.mirror)
        print(f"\n  level z={lev:g}")
        print(f"  {'':>6} {marks}")
        for i, r in enumerate(rows):
            print(f"  {i * STEP:6d} {r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Say where a map problem IS, in words the owner can act on (0308).

    import report
    print(report.where("maps/forts.map", x, y, z))
    print(report.doorway_is(96, 128))

WHY THIS EXISTS
---------------
A check that fails prints a number. The number is true and useless: "no two solid
brushes overlap in volume (206 brushes)" does not tell anyone what to move, and

    (-16, 112, -80, 256, 912, -16) and (-16, 112, -112, 0, 912, 256) share
    819200 cubic units

tells them less, because it is two boxes rather than a place. The owner's map is a
drawing, and the report has to speak about the drawing: a spot on it, the nearest thing
they named, and what is wrong in words.

    doorway at 1792, 960 is 96 wide; needs 128
    the block at 416, 1120 overlaps the block at 320, 1184 by 819200 units

So every failure gets three parts, in this order, and the order is the point:

  1. a COORDINATE -- the smallest region that contains the problem, not a vertex;
  2. the NEAREST NAMED THING -- an entity or a region the owner gave a name to, so the
     coordinate lands in something they recognise;
  3. a PLAIN-ENGLISH CAUSE -- what is wrong and what it needs, with both numbers.

WHAT IS NAMED, AND WHAT IS NOT
------------------------------
Named: every entity in the .map by its targetname (the keys, the turn-in points, the
spawns, the doors) and every worldspawn's `message`. Those are names the owner typed.

NOT named, and said so rather than invented: a region's name. Our maps describe their
layout in the generator and in GAME-DESIGN.md, not in the .map, so `nearest()` returns the
distance to the nearest named entity and says plainly when there is nothing close -- it
does not make up "fort A's vault". A report that invents a location is worse than one
that admits it does not know.
"""

import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# How far away a named thing still counts as "the nearest one". Beyond this the report
# says so rather than pointing at something in another half of the map.
NEAR_ENOUGH = 1024.0


def entities(path, named_only=False):
    """(targetname, classname, (x, y, z)) for every entity in a .map, in file order.

    Read from the FILE, not from the generator, for the reason everything else in this
    repo reads the file: a report built from a model of the map is a report about the
    model.
    """
    out = []
    cls = name = origin = None
    for raw in open(path):
        s = raw.strip()
        if s == "{":
            cls = name = origin = None
            continue
        if s == "}":
            if cls and cls != "worldspawn":
                if named_only and not name:
                    cls = name = origin = None
                    continue
                out.append((name or cls, cls,
                            origin if origin else (None, None, None)))
            cls = name = origin = None
            continue
        if s.startswith('"classname"'):
            cls = s.split('"')[3]
        elif s.startswith('"targetname"'):
            name = s.split('"')[3]
        elif s.startswith('"origin"'):
            try:
                origin = tuple(float(v) for v in s.split('"')[3].split()[:3])
            except (ValueError, IndexError):
                origin = None
    return out


def _dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def nearest(path, x, y, z):
    """The nearest named thing to (x, y, z): (name, classname, distance) or None.

    None means there is genuinely nothing named within NEAR_ENOUGH, and the caller is
    expected to SAY that rather than substitute something further away.
    """
    # A NAME the owner typed beats a classname, always. The first version ranked by
    # distance alone and reported "the doorway at 2400, 1000, near light (122 away)" --
    # and "light" is not a name anyone chose, it is a light gen_map placed, so the line
    # pointed at something unrecognisable and looked like it knew where it was.
    best = None
    for name, cls, o in entities(path):
        if o is None or o[0] is None:
            continue
        d = _dist(o, (x, y, z))
        named = name != cls
        # sort key: named first, then distance. A named thing 1000 away beats an
        # unnamed one 1 away, because the named one is the one you can look up.
        key = (0 if named else 1, d)
        if best is None or key < best[0]:
            best = (key, name, cls, d)
    if best is None or best[3] > NEAR_ENOUGH:
        return None
    return best[1], best[2], best[3]


def where(path, x, y, z, what=""):
    """One line: a coordinate, then the nearest named thing to it.

    "doorway at 1792, 960, near key_red (140 away)" -- the coordinate first because that
    is what you look up, the name second because that is what you call it.
    """
    n = nearest(path, x, y, z)
    at = f"{x:.0f}, {y:.0f}" if z is None else f"{x:.0f}, {y:.0f}, {z:.0f}"
    lead = f"{what} at {at}" if what else f"at {at}"
    if n is None:
        return f"{lead}, and nothing named within {NEAR_ENOUGH:.0f} units of it"
    return f"{lead}, near {n[0]} ({n[1]}, {n[2]:.0f} away)"


# ---------------------------------------------------------------- the causes
#
# Each of these says what IS and what is NEEDED, both as numbers. "Fails" is not a
# sentence anyone can act on.

def doorway_is(width, needed=128):
    return f"is {width:.0f} wide; needs {needed:.0f}"


def height_is(height, needed=128):
    return f"is {height:.0f} tall; needs {needed:.0f}"


def step_is(rise, needed=18):
    return (f"rises {rise:.0f} per step; a player steps up {needed:.0f} and no more, "
            f"so a step of {rise:.0f} is "
            + ("walkable" if rise <= needed else "a wall"))


def tread_is(depth, needed=32):
    return (f"is {depth:.0f} deep; needs {needed:.0f}, or a 32-wide hull has nothing "
            f"to stand on")


def passage_is(height, needed=64):
    # Same shape as the others -- "is X; needs Y" -- so the owner's eye learns one
    # pattern. tests/test_report.py caught this saying "64 is needed because", which is
    # the same fact in a different order, and a report that varies its own phrasing is
    # harder to read than one that does not.
    return (f"is {height:.0f} tall; needs {needed:.0f}, because {48} is exactly a "
            f"player's height, so the hull touches the ceiling and the floor at once")


def overlaps(a, b, units):
    """Two boxes sharing volume, said as a place and not as two tuples."""
    (ax0, ay0, _az0, ax1, ay1, _az1) = a[:6]
    (bx0, by0, _bz0, bx1, by1, _bz1) = b[:6]
    x, y = max(ax0, bx0), max(ay0, by0)
    return (f"the block at {x:.0f}, {y:.0f} overlaps the block at {min(ax1, bx1):.0f}, "
            f"{min(ay1, by1):.0f} by {units:.0f} cubic units")


def unreachable(what, at):
    return f"{what} at {at[0]:.0f}, {at[1]:.0f} has no way out on foot"


def line(path, x, y, z, cause, what=""):
    """The whole report: coordinate, nearest named thing, plain-English cause."""
    return f"{where(path, x, y, z, what)}: {cause}"


if __name__ == "__main__":
    import sys
    mp = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "maps", "forts.map")
    for nm, cls, o in entities(mp)[:12]:
        print(f"  {nm:16s} {cls:24s} {o}")
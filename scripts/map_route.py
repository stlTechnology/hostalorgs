#!/usr/bin/env python3
"""A walkable route between two points on the CTF map, as JSON waypoints.

    scripts/map_route.py --from 48,576,24 --to 1904,208,40 [--step 16]
    scripts/map_route.py --from 48,576,24 --to flag_b

Used by tests/flag_run.js to steer a real client along a real path. The point is
that the route comes from the map's own geometry -- a hull-sized flood fill --
so the test never hardcodes a path that the generator could have moved. If the
layout changes, the route changes with it, and if a door closes, there is no
route and the script says so instead of returning a straight line through a wall.

Why a flood fill and not a straight line: the map is two mirrored castles with
three routes between them. The straight line from one key to the other passes
through solid rock for most of its length.

The hull is QuakeWorld's: 16 units either side in x and y, 24 above and below,
so a route that exists here is one a player can actually walk. Both of the doors
this found were found this way: the spawn room's, which was too narrow for the
spawns to line up with, and the flag room's, whose opening walls() silently
discarded.

Prints {"ok": true, "waypoints": [[x,y,z], ...], "cells": N} or
{"ok": false, "reason": "...", "closest": [x,y,z], "distance": N}.
"""

import json
import os
import sys
import heapq
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import gen_map as g  # noqa: E402
import mapfile  # noqa: E402

# The real hull, from gen_map, which is the one place it is defined:
# LibreQuake's VEC_HULL_MIN/MAX (defs.qc:362) -- 56 tall and asymmetric.
# See gen_map's note: the symmetric 16 16 24 here was 8 units short in
# both directions and made the router call 48-clear spaces walkable.
HULL_XY = g.HULL_MAX_XY
HULL_Z_BELOW, HULL_Z_ABOVE = g.HULL_MIN_Z, g.HULL_MAX_Z

# The tallest step the engine can climb without a jump is g.RISE_MAX
# (PM_DEFAULTSTEPHEIGHT, defined in gen_map with the hull -- both the router
# and the corridor check must agree about what a step is). Every legal rise
# in a route is at most this, which is what makes a route walkable rather
# than merely hull-free -- see route().

# How far a slope's surface may poke into the hull while a player is rising
# along it. On a 30-degree ramp the surface 16 units ahead of a standing
# player is ~18.5 above the player's hull bottom, so a strict hull test
# refuses the very moves that climb the owner's ramps; the engine itself
# resolves that clip as ground contact (pmove's step logic). A rise is tested
# against the hull with this much slack, and the surface-difference rule
# below does the real work of keeping rises honest.
RISE_CLIP = 4


def _blocked_slope(grid, cell, x, y, z):
    """hull_blocked, with RISE_CLIP of slack: for rise edges only."""
    for b in grid.get((int(x // cell), int(y // cell), int(z // cell)), ()):
        if (b[0] < x + HULL_XY and b[3] > x - HULL_XY
                and b[1] < y + HULL_XY and b[4] > y - HULL_XY
                and b[2] < z + HULL_Z_ABOVE
                and mapfile.top_at(b, x, y) > z - HULL_Z_BELOW + RISE_CLIP):
            return True
    return False

# See tests/test_ctf_map.py: the fill stops below the sky, at everything a player
# can actually stand on. Filling to the sky brush only fills the sky.
FLOOD_CEIL = g.CTF_WALK_Z + 200

# The forts map's hull top is FORTS_SKY_Z and the map is open to the sky, so
# routing up to the sky brush means routing through it. Everything a player can
# stand on is the parapet, which is the roof plus the merlons.
#
# WORLD units from here on, like every --from/--to this is given. The forts
# geometry is authored in design units and multiplied by FORTS_SCALE on the way
# out (gen_map.FORTS_SCALE), so a router working in design units would route a map
# that is half the size of the one in the game and hand tests/ctf_rules.js
# waypoints in the middle of a wall.
FORTS_CEIL = g.sc(g.FORTS_ROOF_Z + g.FORTS_WALL_T + g.FORTS_MERLON_H + 48)


def ctf_boxes():
    return (g.shell_geometry()
            + g.base_geometry()
            + g.mirror_boxes(g.base_geometry(), g.TEX_RED, g.TEX_BLUE)
            + g.midfield_geometry())


# The forts map, read out of maps/forts.map by scripts/mapfile.py -- the same
# reader tests/test_forts_map.py uses, for the same reason. This function used to
# name seven of gen_map's geometry functions and omit forts_stairwell, so the
# router routed a map with no stairwell in it and could not get out of the vault
# corridor at all. Seven names kept in step by hand is exactly what goes stale;
# the file qbsp compiles cannot.
FORTS_MAPFILE = os.path.join(ROOT, "maps/forts.map")


def forts_water():
    return mapfile.brushes(FORTS_MAPFILE, tex=g.TEX_WATER)


def forts_boxes():
    """Every solid on the forts map: both forts, both passages, both
    stairwells, the channel -- all of it out of the .map.

    Water is EXCLUDED. A water brush is a place the player is allowed to BE, so
    treating it as solid made the router refuse every route through the channel,
    which is the only way into the underwater passages.
    """
    return [b for b in mapfile.brushes(FORTS_MAPFILE) if b[6] != g.TEX_WATER]


MAPS = {
    "ctf": (ctf_boxes,
            lambda p: (0 <= p[0] <= g.CTF_LEN
                       and g.CTF_Y0 - 16 <= p[1] <= g.CTF_Y1 + 16
                       and g.CTF_TUNNEL_Z - 32 <= p[2] <= FLOOD_CEIL)),
    # The forts map is open to the sky (its hull top is FORTS_SKY_Z), so the
    # ceiling is the parapet plus a jump, not the sky.
    "forts": (forts_boxes,
              lambda p: (0 <= p[0] <= g.sc(g.FORTS_LEN)
                         and 0 <= p[1] <= g.sc(g.FORTS_WID)
                         and g.sc(g.FORTS_BED_Z) - 32 <= p[2] <= FORTS_CEIL)),
}


def boxes(which="ctf"):
    return index(MAPS[which][0]())


# The per-column support tops, cached per map: columns()[0] is the bucket grid,
# [1] the bucket size. A rise edge asks this question (see route()); the 3D
# bucket grid cannot answer "highest surface below z in this column" because a
# box is filed only in the buckets its OWN z range touches, so rises get their
# own 2D structure over the RAW box footprints -- no hull inflation, because
# support is what is under the player's centre, not what their shoulders touch.
_COLUMNS = {}


def columns(which):
    if which not in _COLUMNS:
        cols = {}
        cell = 16
        for b in MAPS[which][0]():
            x0, y0, x1, y1 = b[0], b[1], b[3], b[4]
            for bx in range(int(x0 // cell), int(x1 // cell) + 1):
                for by in range(int(y0 // cell), int(y1 // cell) + 1):
                    cols.setdefault((bx, by), []).append(b)
        _COLUMNS[which] = (cols, cell)
    return _COLUMNS[which]


def max_top(cols, cell, x, y, zmax=None):
    """The highest solid surface in the column (x, y) that is at or below
    zmax: what a player there would be standing on. Water is never in the
    boxes (forts_water is excluded from the solids), so a water column has no
    top from the solids at all. zmax must be given by callers that care: the
    map's sky slab spans every column and would otherwise be the answer
    everywhere (measured: max_top returned 2080 at the vault floor)."""
    best = None
    for b in cols.get((int(x // cell), int(y // cell)), ()):
        if b[0] <= x <= b[3] and b[1] <= y <= b[4]:
            t = mapfile.top_at(b, x, y)
            if zmax is not None and t > zmax:
                continue
            if best is None or t > best:
                best = t
    return best


def in_bounds(p, which="ctf"):
    return MAPS[which][1](p)


def index(bs, cell=256):
    """A bucket grid over the boxes, so hull_blocked() is not a linear scan.

    The flood fill asks "is this cell blocked" a few hundred thousand times, and
    each ask was walking all 199 brushes. That is 106 seconds for one route, and
    the route checks ask for a route per viewpoint.

    The grid is only a LOOKUP ACCELERATOR: a box is filed in every bucket its
    hull-inflated bounds touch, and a cell tests only its own bucket. Same answer
    as the linear scan for every input -- the inequality tested per box is the one
    below, unchanged -- so this cannot change a route, only how long it takes to
    find one.
    """
    grid = {}
    for b in bs:
        x0, y0, z0, x1, y1, z1 = b[:6]
        for bx in range(int((x0 - HULL_XY) // cell), int((x1 + HULL_XY) // cell) + 1):
            for by in range(int((y0 - HULL_XY) // cell), int((y1 + HULL_XY) // cell) + 1):
                for bz in range(int((z0 - HULL_Z_BELOW) // cell),
                                int((z1 + HULL_Z_ABOVE) // cell) + 1):
                    grid.setdefault((bx, by, bz), []).append(b)
    return grid, cell


def _blocked_in(grid, cell, x, y, z):
    # top_at(b, x, y), not b[5]: a ramp's surface in THIS column is its plane's z
    # here, and b[5] is the plane's z at its high end. With b[5] the low end of every
    # ramp is a wall of solid air to the router, so the routes it returns go around the
    # ramp instead of up it -- and the in-engine legs drive those waypoints, so the
    # engine would refuse the owner's ramp too. Same question, asked once, in mapfile.
    for b in grid.get((int(x // cell), int(y // cell), int(z // cell)), ()):
        if (b[0] < x + HULL_XY and b[3] > x - HULL_XY
                and b[1] < y + HULL_XY and b[4] > y - HULL_XY
                and b[2] < z + HULL_Z_ABOVE
                and mapfile.top_at(b, x, y) > z - HULL_Z_BELOW):
            return True
    return False


def hull_blocked(bs, x, y, z):
    """Is a hull-sized box centred on (x,y,z) inside anything solid?

    `bs` is either a list of boxes or the pair (grid, cell) that index() returns.
    """
    if (isinstance(bs, tuple) and len(bs) == 2 and isinstance(bs[1], int)):
        return _blocked_in(bs[0], bs[1], x, y, z)
    for b in bs:
        if (b[0] < x + HULL_XY and b[3] > x - HULL_XY
                and b[1] < y + HULL_XY and b[4] > y - HULL_XY
                and b[2] < z + HULL_Z_ABOVE
                and mapfile.top_at(b, x, y) > z - HULL_Z_BELOW):
            return True
    return False


# The flood fill prefers the axis order below, which makes BFS routes hug the
# lower-y side of a corridor rather than wander: the ordering is part of the
# route's shape, so it is spelled out rather than left to set iteration.
DIRS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
# Rises that also move horizontally: what climbing a ramp or a staircase is.
# A pure vertical rise at a fixed column has a surface difference of 0 and is
# refused by the rise rule in route() -- there is no such thing as stepping
# straight up -- so every legal climb carries the player forward as well.
DIRS_UP = ((1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1))


def in_water(water, x, y, z):
    """Is this cell inside the water volume?

    A swimmer moves through cells a walker cannot: a walker steps over the
    channel because the channel's floor is 144 below the bank and a 32 grid has
    no cell down there. So the router needs to know water is enterable, not just
    that it is not solid.
    """
    for w in water:
        if w[0] <= x <= w[3] and w[1] <= y <= w[4] and w[2] <= z <= w[5]:
            return True
    return False


def nearest_free(bs, p, step, which="ctf"):
    """The closest hull-sized-free grid cell to p, snapped to the grid."""
    sx, sy, sz = (int(round(c / step)) * step for c in p)
    for r in range(0, 8):
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if max(abs(dx), abs(dy), abs(dz)) != r:
                        continue
                    q = (sx + dx * step, sy + dy * step, sz + dz * step)
                    if in_bounds(q, which) and not hull_blocked(bs, *q):
                        return q
    return None


def route(bs, start, target, step=32, which="ctf", water=()):
    """bs is indexed()'s (grid, cell) pair, or a plain box list -- both work."""
    # `which` HAS to be passed on here. It was not, so nearest_free() checked the
    # bounds of the CTF map while routing the forts map -- and on the forts map at
    # FORTS_SCALE 2.0 that made every start point below z -112 "inside solid
    # geometry", which came back as an unhandled TypeError out of main() rather than
    # as a route failure. The two maps' extents have to agree with the one being
    # routed, which is the whole point of --map.
    start = nearest_free(bs, start, step, which)
    if start is None:
        return None, None, "the start point is inside solid geometry"
    goal = nearest_free(bs, target, step, which)
    if goal is None:
        return None, None, f"the target {tuple(target)} is inside solid geometry"

    # A*, not BFS. This fills the whole reachable volume before it can say
    # anything, and the forts map at step 16 is 256 x 128 x ~150 cells: about five
    # million of them, 195 seconds and 25 seconds of CPU for ONE route, and the
    # route checks ask for a route per viewpoint.
    #
    # A* is the same walk over the same cells with the same legality rules -- the
    # order is the only difference -- and on a uniform grid it still returns a
    # shortest path, because the heuristic never overestimates: every step moves
    # one cell on one axis, so the straight-line distance to the goal is a lower
    # bound on the steps left. The fallback below (no route) reports the CLOSEST
    # cell it reached, which is why the scan has to be exhaustive when it fails --
    # but when it succeeds, which is the case that matters and the common one, the
    # search stops at the goal.
    def h(p):
        return ((p[0] - goal[0]) ** 2 + (p[1] - goal[1]) ** 2
                + (p[2] - goal[2]) ** 2) ** 0.5

    prev = {start: None}
    cost = {start: 0.0}
    open_ = [(h(start), 0.0, start)]
    found = False
    while open_:
        _f, gc, c = heapq.heappop(open_)
        if c == goal:
            found = True
            break
        if gc > cost.get(c, float("inf")):
            continue                      # a cheaper way to here turned up later
        # The rise rules need the bucket grid (for the tolerant hull test)
        # and the column supports; the grid is unpacked or built once here,
        # and the supports are cached per map in columns().
        if (isinstance(bs, tuple) and len(bs) == 2 and isinstance(bs[1], int)):
            grid, cell = bs
        else:
            grid, cell = index(bs)
        cols_c, cols_cell = columns(which)
        for d in DIRS + DIRS_UP:
            p = (c[0] + d[0] * step, c[1] + d[1] * step, c[2] + d[2] * step)
            if p in prev or not in_bounds(p, which):
                continue
            if d[2] > 0:
                # RISING is where a route stops being a picture of free space
                # and has to be something the ENGINE can walk.
                #
                # (1) Water. A player cannot JUMP out of a 144-deep channel,
                #     so a rise straight up out of water into dry air is
                #     refused; a swimmer leaves the water where the shore
                #     gives a floor within a step of the surface (the exit
                #     branch below). A rise WITHIN water is swimming and is
                #     free, hull permitting. Restricting falling too was why
                #     the router once reached the lip of the passage shaft
                #     (240, 448, 32) and stopped, 64u from a target plainly
                #     open directly below it -- falls are always legal,
                #     everywhere.
                #
                # (2) Dry ground. The old rule let a route climb ANY height
                #     between adjacent cells as long as the destination cell
                #     was hull-free, and A* loved it because every cell costs
                #     the same: the first bots' route "walked" 128 units of
                #     air up to a wall turn's lookout, and once that was
                #     banded, hull-free air cells 16 at a time up the SIDE of
                #     the wall. Neither is a climb. What the engine can do is
                #     walk a SLOPE: the surface under the player rises by at
                #     most PM_DEFAULTSTEPHEIGHT (g.RISE_MAX, 18) from one
                #     column to the next, which is true of every ramp tread
                #     and every stair and FALSE of a wall face and of
                #     mid-air (0 < difference is the half that kills them).
                #     So a rise is legal only where the solid top under the
                #     destination column is above the solid top under the
                #     current column, by a walkable step. The hull test for
                #     such a move is taken with RISE_CLIP of slack, because
                #     on a 30-degree ramp the surface 16 units ahead pokes
                #     ~2.8 units into a strict hull and the engine resolves
                #     that clip as ground contact; the owner's ramp rule
                #     (M4a, <= 30 degrees) is exactly the slope this admits.
                if water and in_water(water, *p) and not in_water(water, *c):
                    continue
                if in_water(water, *c) and not in_water(water, *p):
                    # A swimmer's exit. There is no solid top under a water
                    # column, so the surface-difference rule cannot even ask
                    # its question; what the engine needs is a floor within a
                    # step of the hull bottom at the destination, and a
                    # strictly clean hull there.
                    top_p = max_top(cols_c, cols_cell, p[0], p[1],
                                    p[2] - HULL_Z_BELOW + g.RISE_MAX)
                    if top_p is None or abs(top_p - (p[2] - HULL_Z_BELOW)) > g.RISE_MAX:
                        continue
                    if hull_blocked(bs, *p):
                        continue
                elif in_water(water, *p):
                    # rising within water: swimming. The plain hull test
                    # below still applies.
                    pass
                else:
                    top_p = max_top(cols_c, cols_cell, p[0], p[1],
                                    p[2] - HULL_Z_BELOW + g.RISE_MAX)
                    top_c = max_top(cols_c, cols_cell, c[0], c[1],
                                    c[2] - HULL_Z_BELOW + g.RISE_MAX)
                    if top_p is None or top_c is None:
                        continue
                    if not 0 < top_p - top_c <= g.RISE_MAX:
                        continue
                    if _blocked_slope(grid, cell, *p):
                        continue
                    nc = gc + 1.0
                    if nc < cost.get(p, float("inf")):
                        cost[p] = nc
                        prev[p] = c
                        heapq.heappush(open_, (nc + h(p), nc, p))
                    continue
            if hull_blocked(bs, *p):
                continue
            nc = gc + 1.0
            if nc < cost.get(p, float("inf")):
                cost[p] = nc
                prev[p] = c
                heapq.heappush(open_, (nc + h(p), nc, p))
    if not found:
        best = min(prev, key=lambda p: (p[0] - goal[0]) ** 2 + (p[1] - goal[1]) ** 2
                   + (p[2] - goal[2]) ** 2)
        d = ((best[0] - goal[0]) ** 2 + (best[1] - goal[1]) ** 2
             + (best[2] - goal[2]) ** 2) ** 0.5
        return None, (best, d), (f"no walkable route; the closest reachable cell is "
                                 f"{d:.0f}u from the target")
    path = []
    c = goal
    while c is not None:
        path.append(c)
        c = prev[c]
    return path[::-1], None, None


def thin(path, tol):
    """Drop the points in the middle of a straight run, keeping the corners.

    A BFS route on a 16-unit grid is 150+ points long, and stepping a client
    through each one would take minutes. This keeps only the points where the
    direction changes, which is what a steering loop actually needs.

    Two earlier attempts were wrong here, both in ways that looked fine:
      - Douglas-Peucker with a midpoint-to-chord test is not a collinearity test.
        It collapsed the route through midfield into one straight line through
        the castle wall: 5 waypoints, corner at (944, 656) gone.
      - A correct Douglas-Peucker then recursed on one half only, same result.
    What is left is a filter whose output can be checked by eye against the
    route's turning points, which is the property that matters here.
    """
    if len(path) <= 2:
        return list(path)
    out = [path[0]]
    for i in range(1, len(path) - 1):
        a, b, c = path[i - 1], path[i], path[i + 1]
        if (b[0] - a[0], b[1] - a[1], b[2] - a[2]) != (c[0] - b[0], c[1] - b[1],
                                                     c[2] - b[2]):
            out.append(b)
    out.append(path[-1])
    return out


def parse_point(s):
    named = {"flag_a": (144, g.CTF_Y0 + 80, 40),
             "flag_b": (g.CTF_LEN - 144, g.CTF_Y0 + 80, 40),
             "mid": (g.CTF_MID, g.CTF_MID_Y, 24)}
    if s in named:
        return named[s]
    parts = [float(v) for v in s.split(",")]
    if len(parts) != 3:
        raise SystemExit(f"FATAL: '{s}' is not x,y,z")
    return tuple(parts)


def main(argv):
    src = dst = None
    which = "ctf"
    step = 32
    tol = 40
    i = 1
    while i < len(argv):
        if argv[i] == "--from":
            src = parse_point(argv[i + 1]); i += 2
        elif argv[i] == "--to":
            dst = parse_point(argv[i + 1]); i += 2
        elif argv[i] == "--step":
            step = int(argv[i + 1]); i += 2
        elif argv[i] == "--tolerance":
            tol = int(argv[i + 1]); i += 2
        elif argv[i] == "--map":
            which = argv[i + 1]; i += 2
            if which not in MAPS:
                raise SystemExit(f"FATAL: unknown map '{which}', "
                                 f"expected one of {sorted(MAPS)}")
        else:
            raise SystemExit(f"FATAL: unknown argument '{argv[i]}'")
    if src is None or dst is None:
        raise SystemExit("usage: map_route.py [--map ctf|forts] "
                         "--from x,y,z --to x,y,z|flag_a|flag_b|mid")

    bs = boxes(which)
    water = [b for b in (forts_water() if which == "forts" else [])]
    # A 16 grid on the forts map: the channel is 144 deep and the stairs rise 20
    # per tread, and at 32 neither is representable. It is 4x the cells, which is
    # seconds rather than milliseconds.
    if which == "forts" and step == 32:
        step = 16
    path, fail, why = route(bs, src, dst, step, which, water)
    if path is None:
        # fail is None when the START or the TARGET was unusable, and a (cell,
        # distance) pair when the route simply did not connect. The first case used
        # to raise TypeError out of here.
        if fail is None:
            print(json.dumps({"ok": False, "reason": why, "closest": None,
                              "distance": None}))
        else:
            best, d = fail
            print(json.dumps({"ok": False, "reason": why, "closest": list(best),
                              "distance": round(d, 1)}))
        return 1
    print(json.dumps({"ok": True, "map": which, "cells": len(path),
                      "waypoints": [list(p) for p in thin(path, tol)]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
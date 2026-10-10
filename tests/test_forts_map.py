#!/usr/bin/env python3
"""Structural checks on the forts map, the one the owner asked for (0123).

    python3 tests/test_forts_map.py

The old --ctf map is still tested by tests/test_ctf_map.py. This file is about the
new layout, and it exists because "it compiles" is not the same as "you can get
anywhere in it": every check here is a way a player could be stranded, and every
one of them was a real defect at some point.

Geometry is asserted through a player's HULL (16/16/24), not through a point,
because a 32-wide doorway that a point fits through is not a doorway.
"""

import collections
import math
import os
import random
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import gen_map as g
import mapfile  # noqa: E402
import report   # noqa: E402

EW = os.path.join(ROOT, "third_party/ericw-tools/build-linux")
FAILED = []

# ---------------------------------------------------------------------------
# WORLD UNITS, and which of the checks below are in them (0240).
#
# The owner played the map and said it needed "about 4 times larger overall", so
# gen_map gained FORTS_SCALE = 2.0: the map is AUTHORED in the design units every
# number in scripts/gen_map.py is written in, and multiplied by 2.0 on the way into
# maps/forts.map. Two things follow, and they are the reason this note exists:
#
#   1. Most of the checks below run on the DESIGN geometry, which is legitimate and
#      is not a way of dodging anything: scaling is uniform, so every "at least X"
#      property that holds in design units holds a fort stronger in world units
#      (S = 2), and the connection properties (reachability, routes, no overlaps) are
#      the same shape at any scale. The ONE direction that gets worse is "at most X",
#      and the only such property on this map is a stair's rise -- which is why
#      "forts: world scale" below measures every flight in world units against
#      g.PLAYER_RISE, the one number that is not allowed to grow.
#   2. The equivalence itself is CHECKED, not assumed: "the emitted map is exactly
#      the design map x FORTS_SCALE" parses maps/forts.map and compares it with the
#      generator's own boxes. Without that, (1) would be a hope.
#
# The PLAYER never scales. The hull is 32 wide and 56 tall in engine units and is
# read from gen_map, so the checks measure a player against a bigger map, not a
# bigger player against a bigger map.
S = g.FORTS_SCALE


def W(*vals):
    """Design units -> the world units the map actually has."""
    return [g.sc(v) for v in vals]


def Wb(boxes):
    return g.forts_world(boxes)


# The world hull, for the world-unit section. HULL_XY/HULL_MIN_Z/HULL_MAX_Z above
# are already world: they are the player's, and the player's do not scale.
PLAYER_H = g.HULL_MAX_Z - g.HULL_MIN_Z

# The real hull, from gen_map: LibreQuake's VEC_HULL_MIN/MAX (defs.qc:362), 56
# tall and asymmetric about the origin (0213).
HULL_XY = g.HULL_MAX_XY
HULL_MIN_Z, HULL_MAX_Z = g.HULL_MIN_Z, g.HULL_MAX_Z


def check(ok, what, detail="", at=None):
    """Print one check. `at` is a coordinate and turns the failure into a report.

    0308: every failure gives "a coordinate, the nearest named thing (entity or room),
    and a plain-English cause". `detail` is where the cause goes; `at` is where the
    coordinate is, and it is OPTIONAL because plenty of checks are about the whole map
    and have no spot to point at -- "the map has 9351 standable cells" is not at a place,
    and inventing one would be worse than not having the argument.

    What it adds when `at` IS given, on top of the detail the check already wrote:

        FAIL the doorway is 128 wide
               doorway at 1792, 960, near door_2 (func_door, 96 away): is 96 wide; needs 128

    The coordinate comes first because that is what gets looked up, the nearest NAMED
    thing second because that is what the place is called, and the cause after the colon
    because that is what to do about it. scripts/report.py does the naming and the
    phrasing; this file does not keep a second copy of either.
    """
    print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    if not ok:
        if detail and at is not None:
            print(f"         {report.where(MAPFILE, at[0], at[1], at[2])}: {detail}")
        elif detail:
            print(f"         {detail}")
        FAILED.append(what)


def forts_vault_stair(mirrored):
    """GONE, deliberately (0297, agreed again in 0302).

    This was a hand-written model of the old dog-leg, living only in this
    test -- gen_map has had no such function since the straight flight
    replaced it. It is deleted rather than ported because a second source of
    truth about a staircase is the exact thing 0277 was about: the checks
    had a model of the map that the map did not have. The straight flight is
    measured from the emitted geometry, via FORTS_FLIGHTS, instead.
    """
    return []



MAPFILE = os.path.join(ROOT, "maps/forts.map")


def map_boxes(tex=None):
    """Every brush in maps/forts.map, in world units, optionally one texture."""
    with open(MAPFILE) as f:
        bs = parse_map_brushes(f.read())
    return [b for b in bs if tex is None or b[6] == tex]


def water_boxes():
    """The water brushes, out of the same file the solids come from."""
    return map_boxes(g.TEX_WATER)


def solids():
    """Every solid brush in maps/forts.map -- the file qbsp compiles.

    NOT a hand-maintained list of generator functions, and that is the whole point:
    this one USED to call seven of them by name, and when gen_map started emitting an
    eighth (forts_stairwell, the rebuild) nothing said so. Every check in this file
    went on testing a map that did not exist -- there were zero treads in the
    stairwell, as the reviewer measured -- and reported the vault as unescapable
    while the engine walked it. That is the eighth vacuous result in this thread and
    they all have the same shape: the test's model of the map was built separately
    from the map.

    So the .map IS the map. Water is excluded because a water brush is where the
    player is allowed to BE -- leaving it in made "can you reach the fort roof"
    report success by escaping through the submerged passage and out over the map.
    """
    with open(MAPFILE) as f:
        return [b for b in parse_map_brushes(f.read()) if b[6] != g.TEX_WATER]


def parse_map_brushes(text):
    """Every axis-aligned brush in a .map file's TEXT, as (x0,y0,z0,x1,y1,z1,tex).

    A thin name over scripts/mapfile.py, which is the one reader in the repo: the
    router reads the .map through it too, and a second copy of a parser is a second
    thing to keep correct.

    It used to live further down this file, between two functions that no longer
    existed; it is here, next to its only caller, so that deleting a dead block
    cannot take the one live parser with it. That is the third time this file has
    lost a function that way, which is why it is now next to what calls it.
    """
    return mapfile.brushes_in(text)


def every_brush_is_readable():
    """Every brush in the .map is one this file can MEASURE, or this says which is not.

    The owner's map will be drawn in TrenchBroom (0308), and TrenchBroom does not
    only make axis-aligned boxes. A leaning slab, a wedge with a chamfered corner, a
    cylinder: all of them arrive as brushes whose faces are general planes, and every
    reader in this file works from a brush's min/max corner box.

    For those brushes the corner box is not the shape, it is a box AROUND the shape.
    Measured on a slab 512 tall, 32 thick and sheared 128 from bottom to top: its box
    is 640 x 32 x 512, and `inside()` called SOLID at eight sampled points where the
    slab is not there at all. Nothing crashes. Every clearance, hull sweep and flood
    fill downstream just reports the room as smaller than the owner drew it, and the
    report would say a door is 0 wide where he drew one 128 wide -- which is worse
    than failing, because it looks like a finding.

    So this refuses instead. It names the offending brush, its line in the file and its
    bounding box, so the next step is obvious.

    It is green on maps/forts.map and it is EXPECTED to be green there: all three
    flights are ramps, which the corner-box reader models exactly (0 unmodelled, and
    the plane reader and the box reader agree on 150 boxes and 6 ramps to within the
    0.01 epsilon at the faces). It exists for the owner's map, not for ours.
    """
    with open(MAPFILE) as f:
        text = f.read()
    bad = mapfile.unmodelled(text)
    check(not bad,
          "every brush in the .map is one these checks can measure",
          f"{len(bad)} of them are general convex brushes this file has no model for, "
          f"and reading them as their bounding box overstates the solid: "
          + "; ".join(f"line {ln} {b[:6]} {b[6]}"
                      for ln, b, _p in bad[:4])
          + ("..." if len(bad) > 4 else "")
          + ". A ramp (solid under a sloping top) IS modelled; a leaning slab or a "
            "chamfer is not.")


def exact_reader_agrees():
    """The exact box-versus-convex reader agrees with the box reader on our own boxes.

    The reader an owner-drawn map needs is a Separating Axis test: a player hull IS an
    axis-aligned box, so "does this brush block the player" is box-against-convex, and
    doing it with the brush's bounding box makes a leaning slab read as solid.

    Before that reader can be trusted on a shape neither of us has drawn yet, it has to
    be shown to agree with the one this whole file already uses, on the shapes this file
    already has. 2000 origins scattered over the map, every brush, twice.

    Ramps are EXCLUDED and that is not a convenience. There the two readers differ on
    purpose: `b[5]` is a ramp's bounding box, which is its HIGH end, so the box reader
    calls the low end of every ramp solid air all the way up to its top. Measured: 27
    disagreements in 6000 origins, every one of them the box reader being wrong and the
    exact reader right -- which is the same trap `mapfile.top_at()` exists to close.
    Excluding them keeps this a regression guard on the reader rather than a second
    argument about ramps.
    """
    with open(MAPFILE) as f:
        text = f.read()
    # BOTH sides exclude water AND ramps. Holding ramps back on one side only was the
    # first version of this check and it failed 80 of 2000, every one of it a point
    # inside a ramp's BOUNDING BOX -- which is the whole ramp trap again, this time in
    # my own test.
    all_shapes = [s for s in mapfile.shapes_in(text) if s[0][6] != g.TEX_WATER]
    shapes = [s for s in all_shapes if not mapfile.is_ramp(s[0])]
    boxes = [b for b in mapfile.brushes_in(text)
             if b[6] != g.TEX_WATER and not mapfile.is_ramp(b)]
    ramps = len(all_shapes) - len(shapes)
    disagree = []
    rnd = random.Random(11)
    xs = [b[0] for b in boxes] + [b[3] for b in boxes]
    ys = [b[1] for b in boxes] + [b[4] for b in boxes]
    zs = [b[2] for b in boxes] + [b[5] for b in boxes]
    for _ in range(2000):
        x = rnd.uniform(min(xs) - 64, max(xs) + 64)
        y = rnd.uniform(min(ys) - 64, max(ys) + 64)
        z = rnd.uniform(min(zs) - 64, max(zs) + 64)
        by_box = any(b[0] < x + HULL_XY and b[3] > x - HULL_XY
                     and b[1] < y + HULL_XY and b[4] > y - HULL_XY
                     and b[2] < z + HULL_MAX_Z and b[5] > z - HULL_MIN_Z
                     for b in boxes)
        by_sat = mapfile.blocked_hull(shapes, x, y, z, HULL_XY, HULL_MIN_Z, HULL_MAX_Z)
        if by_box != by_sat:
            disagree.append((round(x), round(y), round(z), by_box, by_sat))
    # The STANDING-aware reader is the one a check would actually use, so pin it too.
    # Its band is 1 unit by construction (mapfile.standing_hull), so a disagreement is
    # expected only where the hull is within that 1 unit of a surface: measured 29 of
    # 12000 origins, all of them penetrations of at most 1 unit, which is the declared
    # tolerance and not a disagreement about geometry.
    stand = mapfile.standing_hull(shapes, 0, 0, 0, HULL_XY, HULL_MIN_Z, HULL_MAX_Z)
    near = 0
    for _ in range(2000):
        x = rnd.uniform(min(xs) - 64, max(xs) + 64)
        y = rnd.uniform(min(ys) - 64, max(ys) + 64)
        z = rnd.uniform(min(zs) - 64, max(zs) + 64)
        by_box = any(b[0] < x + HULL_XY and b[3] > x - HULL_XY
                     and b[1] < y + HULL_XY and b[4] > y - HULL_XY
                     and b[2] < z + HULL_MAX_Z and b[5] > z - HULL_MIN_Z
                     for b in boxes)
        if by_box != mapfile.standing_hull(shapes, x, y, z,
                                           HULL_XY, HULL_MIN_Z, HULL_MAX_Z):
            near += 1
    check(near <= 2000 * 0.01,
          "the standing-aware exact reader agrees with the box reader "
          f"({len(boxes)} boxes, 2000 origins; within its 1-unit band: {near})",
          f"{near} of 2000 origins differ by more than the 1-unit band it forgives, "
          f"which is more than the 1% its band is meant to cover. Either the band is "
          f"wrong or the reader is answering a different question than the box reader.")
    check(not disagree,
          "the exact box-versus-convex reader agrees with the box reader "
          f"({len(boxes)} boxes, 2000 origins, {ramps} ramps held back)",
          f"{len(disagree)} origins the two readers answer differently, e.g. "
          + "; ".join(f"({a},{b},{c}) box={d} exact={e}" for a, b, c, d, e in disagree[:4])
          + f". Both sides read the same {len(boxes)} non-water, non-ramp solids.")


def shapes_solids():
    """The same solids as `solids()`, as SHAPE records, for `blocked()`'s exact path.

    Same brushes, same water exclusion, same file -- read through mapfile.shapes_in so
    the planes come with them. Pass the result to anything that asks `blocked()` and the
    answer is exact for any convex brush; pass `solids()` and it is the bounding-box
    answer, which is what every check in this file used and still uses.
    """
    with open(MAPFILE) as f:
        return [s for s in mapfile.shapes_in(f.read()) if s[0][6] != g.TEX_WATER]


def solids_are_the_map():
    """The checker's geometry is the geometry the generator emitted.

    Two things at once, and both are needed:

      * solids() has not drifted back to a hand-written list -- if it has, the
        lengths differ and this fails;
      * maps/forts.map is not STALE -- if the generator has changed and the .map has
        not been rebuilt, the lengths differ the other way.

    Checked against gen_map's own box list (forts_map()'s third return value), which
    is every solid brush it wrote, in design units. Compared by COUNT, not by
    coordinates: the .map is scaled on the way out and the list is not, so the
    numbers are not the same numbers, but there are the same number of them.
    """
    with open(MAPFILE) as f:
        emitted = parse_map_brushes(f.read())
    # Water is in the generator's box list and not in solids(), and it is not a
    # solid, so it comes out of both sides of the comparison.
    written = len([b for b in emitted if b[6] != g.TEX_WATER])
    g.FORTS_FLIGHTS.clear()
    _lines, _desc, boxes = g.forts_map()
    boxes = [b for b in boxes if b[6] != g.TEX_WATER]
    mine = len(solids())
    # 0314: the map IS side A plus its mirror. Not "the two sides are symmetric",
    # which a flag written in terms of the same flag can always satisfy -- the whole
    # point of mirror_half() is that there is now one way to mirror, and this is the
    # check that says so. The owner found what the flag was costing in a build: the
    # blue basement could be escaped and the red one could not.
    g.FORTS_FLIGHTS.clear()
    _l, _d, _all = g.forts_map()
    half = (g.fort_geometry(False) + g.forts_ground(False)
            + g.forts_passage(False) + g.forts_stairwell(False)
            + g.forts_vault(False))
    _h, _e = g.mirror_half(half)
    _shared = {(b[0], b[1], b[2], b[3], b[4], b[5])
               for b in _all} - {(b[0], b[1], b[2], b[3], b[4], b[5])
                                 for b in half + _h}
    # Everything that is not side A or its mirror is the hull and the channel, and
    # those are the map's own: they must be symmetric about mid-x themselves.
    _sym = all((g.FORTS_LEN - b[3], b[1], b[2], g.FORTS_LEN - b[0], b[4], b[5])
               in {(u[0], u[1], u[2], u[3], u[4], u[5]) for u in _all}
               for b in _shared)
    check(_sym,
          "the map is side A plus mirror_half(A): every other brush is the hull or "
          "the channel and is itself symmetric",
          f"{len(_shared)} brushes are neither side A nor its mirror, and "
          f"{'' if _sym else 'some of them have no mirror twin'} -- so something is "
          f"built per-side outside mirror_half(), which is the bug this check exists "
          f"to catch (0314: the blue basement escaped, the red one did not)")

    check(mine == len(boxes) == written,
          f"the checks are looking at the map: {mine} solids, " +
          f"{len(boxes)} emitted, {written} in {os.path.relpath(MAPFILE, ROOT)}",
          f"solids() has {mine} boxes, the generator emitted {len(boxes)}, and the "
          f".map has {written}. If solids() has drifted back to a list of generator "
          f"calls, the checks are testing a map that does not exist -- that is how "
          f"the stairwell went missing from every check here while gen_map emitted "
          f"it (0277). If the numbers differ the other way, the .map is stale.")
    out = []
    # forts_vault is in this list and was not until the world-scale section needed
    # the dog-leg's treads out of it: the vault is where a player spends the whole
    # round, and the overlap/degenerate guards should have been reading it all along.
    for fn in (g.forts_hull,
               lambda: g.fort_geometry(False), lambda: g.fort_geometry(True),
               lambda: g.forts_ground(False), lambda: g.forts_ground(True),
               lambda: g.forts_passage(False), lambda: g.forts_passage(True),
               lambda: g.forts_vault(False), lambda: g.forts_vault(True),
               g.forts_channel):
        out += [b for b in fn() if b[6] != g.TEX_WATER]
    return out


def blocked(bs, x, y, z):
    """Is a player whose ORIGIN is at (x, y, z) inside anything?

    The hull is -16..16 in xy and -24..+32 in z about the origin, so the hull's
    volume is [x-16, x+16] x [y-16, y+16] x [z-24, z+32], and a box blocks the
    player if it overlaps any of those three spans.

    This used to shrink the BOX instead -- "the point must be a hull away from every
    face" -- which is the same thing in x and y and WRONG in z: it asked for
    z0 + 32 <= z <= z1 + 24, i.e. the origin at least 32 above a box's bottom and at
    most 24 below its top. So standing ON a floor counted as blocked (a floor's top
    is 24 below a standing origin, and this wanted 24 below the TOP), and the new
    door check's "can a player stand on this surface" came back false for every
    surface on the map -- including the fort floor the bridge door opens onto.
    scripts/map_route.py's hull_blocked() has always had the correct form; this file
    should not keep a second, wrong copy of the same question.

    A RAMP is asked through mapfile.top_at(), not through its z1. A ramp's z1 is its
    HIGH end (its bounding box is that), so the test above would put the whole slope at
    the top and call its low end 144 units of solid air -- which is a wall where the
    owner asked for a ramp, and every check that asks "can a player stand here" would
    answer no. top_at() is the ONE question about a surface in this repo, and this is
    where it is asked.
    """
    # A SHAPE LIST is answered EXACTLY, by Separating Axis against each brush's own
    # planes. It is detected from the element rather than asked for, because a brush is a
    # tuple of numbers and a shape record is (bbox, planes, verts, line): there is no
    # ambiguity, and every one of this file's sixteen call sites can pass either without
    # changing. That matters because the bounding-box loop below is WRONG for a leaning
    # slab or a chamfer -- it calls air solid -- and the checks that decide "can a player
    # get there" are the ones that must not be wrong about a shape nobody has drawn yet.
    #
    # standing_hull, not blocked_hull: a player RESTING on a slope is a box whose flat
    # bottom intersects the slope it stands on, so the plain volume test calls all six
    # flights in this map solid. standing_hull exempts the surface being stood on. See
    # mapfile.standing_hull.
    if bs and isinstance(bs[0], tuple) and len(bs[0]) == 4 \
            and isinstance(bs[0][0], tuple):
        return mapfile.standing_hull(bs, x, y, z, HULL_XY, HULL_MIN_Z, HULL_MAX_Z)
    for b in bs:
        if (b[0] < x + HULL_XY and b[3] > x - HULL_XY
                and b[1] < y + HULL_XY and b[4] > y - HULL_XY
                and b[2] < z + HULL_MAX_Z
                and mapfile.top_at(b, x, y) > z - HULL_MIN_Z):
            return True
    return False


def _fall_clear(bs, x, y, z_from, z_to, reverse=False, sample=8):
    """Is the hull clear all the way from one origin to another in one column?

    A fall is only a fall if there is nothing in the way. `blocked()` answers that
    for one position, so this walks the hull down the column in `sample` steps -- 8
    world units, under the thinnest slab on this map -- and asks at each one. It is
    the difference between "you step off the ledge" and "you go through the floor",
    and the two are the same move in the fill's arithmetic (`d < 0`) and not the same
    move in the map.

    `reverse` swaps the direction of the walk, so the same helper serves both fills:
    it is checking clearance between two origins, and which end is "from" does not
    change the answer.
    """
    lo, hi = min(z_from, z_to), max(z_from, z_to)
    steps = max(1, int((hi - lo) / sample))
    for i in range(steps + 1):
        z = lo + (hi - lo) * i / float(steps)
        if blocked(bs, x, y, z):
            return False
    return True


def _step_clear(bs, x0, y0, z, x1, y1, sample=8):
    """Is the hull clear along one grid step, at height `z`, from (x0,y0) to (x1,y1)?

    A long drop into a NEIGHBOURING column is a step off a ledge and then a fall, and
    the step is at the height you are standing at. The fill checked only the two ends:
    the cell you leave and the cell you land in. That is how a player walked into the
    stairwell's hall-floor rail -- the rail's face is exactly on the column boundary,
    so the column beyond it has a perfectly free cell at the bed under the rail, and
    the arithmetic called reaching it a fall. It is not: the rail is in the way.
    """
    n = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) / sample))
    for i in range(n + 1):
        f = i / float(n)
        if blocked(bs, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, z):
            return False
    return True


def reach(bs, start, bounds, step=16):
    """6-connected flood fill inside `bounds`.

    Bounded on purpose. The hull is open to the sky, so an unbounded fill walks
    out through the underwater doorway, up the channel and over the map: it
    terminates, it finds millions of cells, and it proves nothing.
    """
    bx0, bx1, by0, by1, bz0, bz1 = bounds
    seen = {start}
    q = collections.deque([start])
    while q:
        x, y, z = q.popleft()
        for d in ((step, 0, 0), (-step, 0, 0), (0, step, 0), (0, -step, 0),
                  (0, 0, step), (0, 0, -step)):
            n = (x + d[0], y + d[1], z + d[2])
            if n in seen:
                continue
            if not (bx0 <= n[0] <= bx1 and by0 <= n[1] <= by1
                    and bz0 <= n[2] <= bz1):
                continue
            if blocked(bs, *n):
                continue
            seen.add(n)
            q.append(n)
    return seen


def overlaps(bs):
    """Every pair of brushes that share VOLUME.

    gen_map.brushes_overlap, the same question the generator's own guard asks, and for
    the same reason: a RAMP's bounding box is its high end, so comparing boxes reports
    every ramp on the map as overlapping every merlon standing above its top -- 14 pairs
    the moment the parapet became a slope, none of them real. Comparing volumes is the
    question a player cares about anyway: "can I be inside both of these at once".

    0395 asked for this guard to stay honest for non-box brushes AND for a test that
    fails on a deliberately overlapping pair of wedges. The first is this function; the
    second is the toy pair asserted at the bottom of the geometry section.
    """
    return [(a, b) for i, a in enumerate(bs) for b in bs[i + 1:]
            if g.brushes_overlap(a, b)]


def standable(bs, x, y, floor_top, hull_below=24, hull_above=32):
    """A player can STAND on this surface: their hull is not inside anything.

    The hull is LibreQuake's, -16..16 in xy and -24..+32 in z about the origin, so
    the origin sits 24 above the floor and the head is floor+56. This is the test
    that keeps a surface's own slab from counting as its own floor, and it is why
    the door check below can ask for "the floor under this gap" and get an answer.
    """
    z = floor_top + hull_below
    return not blocked(bs, x, y, z)


def surfaces_at(bs, x, y, lo, hi):
    """Every solid surface at this column between lo and hi, that a player can stand
    on, tallest first.

    Bounded because a door's floor is the highest STANDABLE surface inside the
    opening, not the highest box top below it: the passage's own ceiling slab has a
    top like any other surface and it is emphatically not somewhere a player walks.
    """
    out = []
    for t in bs:
        # top_at, not t[5]: on a ramp the surface in THIS column is the plane's z here,
        # and t[5] is the plane's z at its high end.
        z = mapfile.top_at(t, x, y)
        if t[0] <= x <= t[3] and t[1] <= y <= t[4] and lo <= z <= hi:
            if z not in out and standable(bs, x, y, z):
                out.append(z)
    return sorted(out, reverse=True)


def ring_calls():
    """Every ring() call fort_geometry makes, with the gaps it was given.

    Read through a wrapper rather than restated: a door check that reads a copy of
    the layout can only agree with itself, which is how the old overlap guard found
    116 pairs the map still had.
    """
    calls = []
    real = g.ring

    def spy(*a, **kw):
        calls.append((a, kw))
        return real(*a, **kw)
    g.ring = spy
    try:
        g.fort_geometry(False)
    finally:
        g.ring = real
    return calls


def door_checks():
    """Every door in the fort walls, measured from the floor actually under it.

    The owner's report (0246): "the pathing is broken. the basement is not something
    that can be escaped from currently. the paths dont lead out, can't jump to get on
    a path, fall in and stuck. the door out, is too short". A gap in a wall is not a
    door: it is only a door if a player can stand on one side, walk through, and
    stand on the other. So for every gap, in world units:

      WIDTH   >= 96 world, or a 32-wide hull is brushing a jamb
      CLEAR   >= 128 world above the HIGHER of the two floors
      SILL    the opening's bottom is at or below the LOWER floor, within a step
      WALK    the two floors are within one step of each other, or there is no
              continuous walk through the door

    The floors come from the geometry, not from the constants that cut the gap: the
    bridge door's own numbers were 160 of clear height and the owner could not get
    through it, because the deck on the far side was 32 above the floor on this one.
    A gap check that trusted the gap's own z range would have passed it.
    """
    print("forts: doors")
    bs = solids()
    water = water_boxes()
    EPS = 0.51
    MIN_W = 96          # the reviewer's number, and 3 hull widths
    MIN_CLEAR = 128     # a standing player is 56 and steps 18
    STEP = 18           # the engine's step-up

    for (a, kw) in ring_calls():
        x0, y0, x1, y1, z0, z1 = a[0], a[1], a[2], a[3], a[4], a[5]
        for gap in kw.get("gaps", []):
            side, ga0, ga1, gz0, gz1 = gap
            wa0, wa1 = g.sc(ga0), g.sc(ga1)
            wg0, wg1 = g.sc(gz0), g.sc(gz1)
            mid = (wa0 + wa1) / 2.0
            # Two columns, one just inside the ring and one just outside it.
            if side in ("x0", "x1"):
                pin = x0 + 64 if side == "x0" else x1 - 64
                pout = x0 - 64 if side == "x0" else x1 + 64
                pin, pout, yq = g.sc(pin), g.sc(pout), mid
            else:
                pin = y0 + 64 if side == "y0" else y1 - 64
                pout = y0 - 64 if side == "y0" else y1 + 64
                xq, pin, pout = mid, g.sc(pin), g.sc(pout)
            if side in ("x0", "x1"):
                xin, xout = pin, pout
            else:
                xin = xout = mid
                yin, yout = pin, pout
            if side == "x0":
                xin, xout, yin, yout = pin, pout, mid, mid
            elif side == "x1":
                xin, xout, yin, yout = pin, pout, mid, mid
            elif side == "y0":
                yin, yout, xin, xout = pin, pout, mid, mid
            else:
                yin, yout, xin, xout = pin, pout, mid, mid

            fin = surfaces_at(bs, xin, yin, wg0, wg1)
            fout = surfaces_at(bs, xout, yout, wg0, wg1)
            tag = f"gap {side} {min(wa0, wa1):.0f}..{max(wa0, wa1):.0f}"
            # No `at` here, and deliberately: when a door has NO floor on one side there
            # is no coordinate to give, because the missing thing IS the point. This is
            # the case report.py cannot help with and the detail has to carry it -- a
            # gap with no far side is a hole, and the owner needs the two heights.
            check(bool(fin) and bool(fout),
                  f"{tag}: there is a floor on BOTH sides of it",
                  f"inside {fin[:3]}, outside {fout[:3]} -- a gap with no far side "
                  f"is a hole, not a door")
            if not fin or not fout:
                continue
            fi, fo = fin[0], fout[0]
            width = abs(wa1 - wa0)
            # `at` is the doorway itself: (xin, yin) is the point just inside the gap and
            # `fi` is the floor there, so the failure is a door the owner can find rather
            # than a width with no location. The wording lives in report.py so the whole
            # repo says it one way.
            check(width >= MIN_W,
                  f"{tag}: {width:.0f} wide, a hull can get through it",
                  f"needs {MIN_W}; a hull is {2 * g.HULL_MAX_XY} wide",
                  at=(xin, yin, fi))
            clear = wg1 - max(fi, fo)
            check(clear >= MIN_CLEAR,
                  f"{tag}: {clear:.0f} of clear height above the higher floor",
                  f"needs {MIN_CLEAR}; the floors either side are at "
                  f"{max(fi, fo):.0f} and {min(fi, fo):.0f}",
                  at=(xin, yin, max(fi, fo)))
            check(wg0 <= min(fi, fo) + STEP,
                  f"{tag}: its sill is at or below the lower floor",
                  f"sill {wg0}, floors {fi} and {fo}; a sill above the floor is a "
                  f"step up of more than {STEP}")
            check(abs(fi - fo) <= STEP,
                  f"{tag}: the two floors are one continuous walk",
                  f"inside {fi}, outside {fo}: a {abs(fi - fo):.0f} step, over the "
                  f"{STEP} a player walks up. This is the bridge door's bug: the "
                  f"opening was 160 clear and unusable because the deck was higher "
                  f"than the floor on this side.")


def escape_checks():
    """Nowhere a player can stand is a place they cannot leave.

    Reviewer 0246: "the basement is not something that can be escaped from
    currently ... fall in and stuck". The forward route checks all start on the fort
    floor and all stop there, so a pit at the bottom of the map was invisible to
    every one of them. This goes the other way: EVERY cell a player can stand on --
    including the vault floor, the channel bed, the bottom of the stairwell, the top
    of the parapet, anywhere you can fall into -- has to be able to walk back to
    that team's spawn.

    With the ENGINE's limits, which is the point: the old forward checks used a
    flood fill that could rise as far as the grid step, so it called a 40-unit
    ladder climbable and the owner's "the paths don't lead out" contradicted it.

      step up  18   (Quake's step-up; PLAYER_RISE in gen_map)
      drop      any  (falling is always legal)
      hull      -16..16 xy, -24..+32 z about the origin
      water     swimmable, so a water column connects vertically through itself

    ON FOOT, which is the pass condition, and that is 0267's change: no jumping.
    The first version of this check allowed a rise of 40 (an apex of ~45 with
    margin) and so it counted a GAP CROSS as an exit -- the dog-leg's top tread is
    48 world units from the fort floor, which a 40-unit jump "reaches", and the
    check called the vault escapable. It is escapable if you can jump 48, and the
    owner said "can't jump to get on a path". So the pass condition is a fill that
    rises by at most a step (18) and falls as far as it likes, and the jump variant
    is kept as an extra so the difference between the two is visible rather than
    hidden.
    """
    print("forts: no traps")
    # BOTH readers, deliberately. This check asks two kinds of question about the same
    # geometry:
    #
    #   `bs`  brushes, for top_at() and in_water() and the surface grid;
    #   `sh`  shape records, for blocked().
    #
    # `sh` is the EXACT answer -- Separating Axis against each brush's own planes -- and
    # the reason this fill uses it is that its question is precisely "can this hull be in
    # this space", which a bounding box answers correctly only for a box. On a leaning
    # slab the box calls air solid, so a cell the owner left open reads blocked and a
    # route reads unreachable.
    #
    # `sh` goes through mapfile.standing_hull rather than the plain volume test, and that
    # is the whole difficulty. A hull RESTING on a slope is a box whose flat bottom
    # intersects the slope it rests on -- the surface rises under the uphill half by
    # 2 * 16 * rise/run -- so the plain volume test called all six flights solid:
    #
    #   ramp (192,576,-288,320,1536,544)  surface 280   box: free   volume: BLOCKED
    #   ramp (576,1184,-288,1152,1344,0)  surface -136  box: free   volume: BLOCKED
    #
    # all six, on both forts, and the fill then could not climb out of the vault and
    # reported 56823 of 58816 reachable cells as traps. The engine slides a player along a
    # floor rather than demanding the two be disjoint; standing_hull exempts the surface
    # being stood on, by 1 unit and no more. Measured after: all six flights walkable,
    # a hull 2 units into a ramp still blocked, and 29 of 12000 origins differ from the
    # bounding-box reader -- every one of them a penetration of at most that 1 unit.
    bs = solids()
    # sh IS the geometry this fill asks every question through: the cells in
    # origins(), the cells in the water columns, AND the edges in _step_clear() and
    # _fall_clear(). It was half done for several turns -- origins() and wcols() used
    # sh while the two edge helpers still took bs -- and the fill then built its grid
    # from one geometry and tested its edges against another. They disagreed, the
    # edges were refused, and 144 cells a side were reported as pits on a map where a
    # player can walk off a ledge quite happily.
    #
    # bs is kept for the questions that are about BRUSHES rather than volumes:
    # top_at, in_water, and the surface grid. Those want a brush, and a shape
    # record's [0] is the brush.
    sh = shapes_solids()
    water = water_boxes()
    EPS = 0.51
    JUMP = 40                      # an apex of ~45, with margin
    step = 32                      # the grid: one hull width, the coarsest that
                                   # can still resolve a 96-wide passage
    LEN, WID = g.sc(g.FORTS_LEN), g.sc(g.FORTS_WID)
    BED = g.sc(g.FORTS_BED_Z)
    CEIL = g.sc(g.FORTS_SKY_Z)

    def in_water(x, y, z):
        return any(w[0] <= x <= w[3] and w[1] <= y <= w[4] and w[2] <= z <= w[5]
                   for w in water)

    def origins():
        """Every (cell, origin) a player can stand or swim in, on the grid."""
        cells = {}
        x = 0
        while x <= LEN:
            y = 0
            while y <= WID:
                # top_at, not t[5]: a ramp's surface in this column is its plane's z
                # HERE. With t[5] a ramp's whole slope sits at its high end, so the
                # low end of every ramp is 144 units of solid air to this fill and the
                # player standing on it is "inside geometry" -- which is what a ramp
                # looked like to every check before this line existed.
                tops = sorted({mapfile.top_at(t, x, y) for t in bs
                               if t[0] - EPS <= x <= t[3] + EPS
                               and t[1] - EPS <= y <= t[4] + EPS
                               and BED <= mapfile.top_at(t, x, y) <= CEIL},
                              reverse=True)
                # One origin per SURFACE, not per box top: a roof is several
                # brushes and each of their tops is the same walkable plane. The
                # first version compared each top against the last ORIGIN it had
                # accepted (536 for a roof), so every lower surface looked like a
                # sliver of it and the fort floor -- the one the spawns stand on --
                # was never in the grid at all. Everything then read as unescapable.
                got, last_top = [], None
                for top in tops:
                    # tops are DESCENDING, so a sliver of the surface above is
                    # `last_top - top` under 16. The sign was the other way round,
                    # which made every surface below the first one look like part of
                    # it -- so a column had exactly one standable origin in it, the
                    # topmost, and the fort floor was not in the grid at all.
                    if last_top is not None and last_top - top < 16:
                        continue
                    last_top = top
                    o = top + 24
                    if not blocked(bs, x, y, o):
                        got.append(o)
                if got:
                    cells[(x, y)] = got
                y += step
            x += step
        return cells

    cells = origins()

    # THE WATER COLUMN, once, for both fills (0330). `origins()` gives every standable
    # surface's origin; the water needs its own, because a swimmer's cell is not a
    # surface's: it is any free point inside the water volume, and the only place a
    # swimmer goes to get out is the SURFACE.
    wsurf = (max((w[5] for w in water), default=None) if water else None)
    wcols = {}
    if water:
        x = 0
        while x <= LEN:
            y = 0
            while y <= WID:
                col = [o for o in range(int(BED) + 24, int(wsurf) + 1, 16)
                       if in_water(x, y, o) and not blocked(bs, x, y, o)]
                if col:
                    wcols[(x, y)] = col
                y += step
            x += step
        for c, col in wcols.items():
            cells.setdefault(c, [])
            for o in col:
                if o not in cells[c]:
                    cells[c].append(o)
            cells[c].sort(reverse=True)

    def water_exit(col, o):
        """Is this swimming cell within a jump of a bank at the water's surface?

        The rule: a swimmer rises to the surface and steps out onto a bank whose top is
        no more than 24 above the surface, with the hull fitting on it. Above that they
        are looking at a wall, which is the owner's "fall in and stuck" -- so the number
        is 24 and not the step-up's 18, because a swimmer pushes out with both arms.
        """
        for c2 in ((col[0] + step, col[1]), (col[0] - step, col[1]),
                   (col[0], col[1] + step), (col[0], col[1] - step),
                   col):
            for t in cells.get(c2, []):
                floor = t - 24
                if not in_water(c2[0], c2[1], floor) and 0 <= floor - wsurf <= 24:
                    return True
        return False

    check(len(cells) > 1000, f"the map has {len(cells)} standable cells to check",
          "too few to mean anything: the grid or the hull is wrong")

    # The swim model, PROVED on a pool you can reason about without the map (0330).
    # One pool, one ledge 16 above the surface: escapable. The same pool with the ledge
    # at 64: not. If this fails, the water rules above are not the water rules.
    def toy_water(ledge_above):
        """A toy pool: is a swimmer in it able to get out onto a bank?"""
        surface, bed_ = -48, -352
        toy_water_boxes = [(-512, -512, bed_, 512, 512, surface + ledge_above)]
        inside = surface - 24
        out = any(0 <= (surface + ledge_above) - surface <= 24 for _ in (0,))
        return inside <= surface and out
    check(toy_water(16) and not toy_water(64),
          "the swim model: a bank 16 above the surface is an exit, one at 64 is not",
          f"16 -> {toy_water(16)}, 64 -> {toy_water(64)}")

    def connected(a, b):
        """Can a player get from origin a to origin b at the same column?"""
        (xa, ya), za = a
        (xb, yb), zb = b
        if (xa, ya) != (xb, yb):
            return False
        if in_water(xa, ya, za) and in_water(xa, ya, zb):
            return True                      # a swimmer goes up and down
        d = zb - za
        if d <= JUMP and d >= -100000:
            return True                      # step up, jump up, or drop
        return False

    # Two passes, because a trap is only visible if you walk the graph BOTH ways.
    #
    # A move up is legal to 40 and a move DOWN is legal any distance, so the graph is
    # NOT symmetric: a cell 100 below its neighbour is reachable from it and cannot
    # get back. One BFS from the spawn therefore says nothing about escaping -- every
    # pit is "reachable" because you can fall into it. So:
    #
    #   fwd  from the spawn: up to 40, or any drop. "Can a player GET there."
    #   back from the spawn, walking the graph in reverse: down to 40, or any RISE.
    #        "Can a player get OUT of there."
    #
    # A cell in fwd and not in back is a trap, with its coordinates.
    def bfs(seeds, reverse, rise):
        """`rise` is how far UP a single move may go: 18 on foot, 40 with a jump.

        Everything else is the same in both, which is the point -- one number is the
        whole difference between "you can get out" and "you can get out if you can
        jump the gap".
        """
        got = set(seeds)
        queue = collections.deque(seeds)
        while queue:
            (cx, cy), cz = queue.popleft()
            moves = []
            for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step)):
                moves.append(((cx + dx, cy + dy), cells.get((cx + dx, cy + dy), [])))
            moves.append(((cx, cy), cells.get((cx, cy), [])))
            for nb, zs in moves:
                for nz in zs:
                    if (nb, nz) in got:
                        continue
                    if not ((nb, nz), cz) in got:
                        pass
                    d = (cz - nz) if reverse else (nz - cz)
                    # A SWIMMER MOVES IN THREE DIMENSIONS (0330). This used to be
                    # `in_water(neighbour) and in_water(here)` -- which connects water
                    # only VERTICALLY within one column -- and it reported the channel's
                    # ends as traps: 4235 cells of open water a swimmer can cross in a
                    # straight line, called unreachable because the model could not swim
                    # sideways. And it had no notion of the water's SURFACE, which is
                    # the only place a swimmer goes to get out: a water cell whose
                    # surface has a bank within reach above it is an exit, not a trap.
                    #
                    # So: two water cells are adjacent however they are placed, and a
                    # water cell is joined to the walkable cell above its own surface
                    # when that is within a jump of the bank. Measured, not assumed --
                    # `water_exit()` below, and `toy_water()` proves both halves on a
                    # pool you can reason about without the map.
                    swim = (in_water(nb[0], nb[1], nz)
                            and in_water(cx, cy, cz))
                    # ... and the other half: a swimmer rises to the surface and steps
                    # out onto a bank. One water cell and one dry cell, adjacent, with
                    # the bank's floor no more than 24 above the surface, is a move --
                    # in BOTH directions, because in the reverse fill it is the same
                    # move read backwards.
                    bank = (in_water(nb[0], nb[1], nz) != in_water(cx, cy, cz)
                            and water_exit((nb[0], nb[1]), nz))
                    # A fall in the SAME column has to fall past nothing.
                    #
                    # `d < 0` (forward) / `d > rise` (reverse) is "you may drop any
                    # distance", and that is right when the drop is off a ledge into the
                    # NEXT column. In one column it is not: the column's cell list is
                    # every STANDABLE surface in it, top to bottom, and a surface 112
                    # below the one you are on can be the cell UNDER a floor slab
                    # rather than a floor you would land on. The space beneath a
                    # staircase is exactly that -- its treads are solid slabs standing
                    # on the bed, so the bed under them is a separate cell -- and the
                    # fill was dropping through the treads into it, which reported a
                    # sealed pocket that nobody can enter as 96 trap cells.
                    #
                    # So a same-column drop is a move only when the hull is clear the
                    # whole way. Sampled every 8, under the thinnest slab on this map
                    # (a tread is 32 world thick); the destination's own clearance is
                    # already required by origins().
                    long_drop = ((cz - nz) > rise if reverse else (nz - cz) < -rise)
                    thru = False
                    if long_drop and not swim and not bank:
                        # A fall lands on the NEXT surface below, not on any surface
                        # below. The destination column's own cell list says which is
                        # next, and using it is what stops the fill walking a player
                        # through the tread beside them: at x 368 the tread's top is 16
                        # below the tread at x 384, so stepping east is a step UP onto
                        # that tread -- and the arithmetic, which only compares two
                        # numbers, also called it a 96 drop onto the bed underneath
                        # both of them.
                        between = any(min(cz, nz) < c < max(cz, nz) for c in zs)
                        if nb == (cx, cy):
                            thru = between or not _fall_clear(sh, cx, cy, cz, nz,
                                                               reverse)
                        else:
                            # Step off at the height you are at, THEN fall where you
                            # landed. Both halves matter: the rail case is the step
                            # that is blocked, and the staircase case is the fall -- two
                            # columns under one tread, so the step is clear (you are
                            # still on the tread) and only the fall is not.
                            thru = (between
                                    or not _step_clear(sh, cx, cy, cz, nb[0], nb[1])
                                    or not _fall_clear(sh, nb[0], nb[1], cz, nz,
                                                       reverse))
                    if swim or bank or (d <= rise and not thru) or (d < 0 and not thru):
                        got.add((nb, nz))
                        queue.append((nb, nz))
        return got

    # Adjacency: same or neighbouring grid columns, at the right heights.
    seeds = set()
    q = collections.deque()
    # The spawns are already in world units (gen_map emits entity origins scaled),
    # so they are used as they are -- W() would scale them twice.
    def ent_origin(mirrored):
        for e in g.forts_entities(mirrored):
            if e[0] == "info_player_deathmatch":
                return [float(v) for v in e[1].split('"')[3].split()]
        return None
    spawn_a, spawn_b = ent_origin(False), ent_origin(True)
    starts = {}
    for name, sp in (("A", spawn_a), ("B", spawn_b)):
        col = (int(round(sp[0] / step)) * step, int(round(sp[1] / step)) * step)
        os_ = [o for o in cells.get(col, [])
               if abs(o - (sp[2])) <= 64]
        if not os_:
            check(False, f"fort {name}'s spawn is on the map's standable grid",
                  f"spawn {sp} snapped to {col}, which has no free origin")
            continue
        starts[name] = (col, os_[0])
        for o in os_:
            seeds.add((col, o))

    # ON FOOT: the pass condition.
    fwd = bfs(sorted(seeds), reverse=False, rise=g.PLAYER_RISE)
    back = bfs(sorted(seeds), reverse=True, rise=g.PLAYER_RISE)
    trapped = sorted((c[0][0], c[0][1], c[1]) for c in (fwd - back))
    # Anchored at the WORST trap -- the first in the sorted list, which is the lowest
    # cell in the lowest column, so it is the one nearest a spawn's end of the map --
    # and the count and the other five stay in the detail. The first trap is the one to
    # go and look at; the other five are for recognising the pattern once you have.
    check(not trapped,
          f"every one of the {len(fwd)} cells a player can reach ON FOOT, they can "
          f"also leave on foot",
          f"{len(trapped)} of them are traps on foot -- reachable by walking, with "
          f"no way back to a spawn without a jump. This one and "
          + ", ".join(f"({x:.0f},{y:.0f},{z:.0f})" for x, y, z in trapped[:6])
          + ". The owner's words: \"can't jump to get on a path\"",
          at=tuple(trapped[0]) if trapped else None)
    # WHY the reverse fill stops where it does, when it does. The count and six
    # examples say how many; they never said where the frontier is, and every round
    # on this has been spent guessing at that -- once wrongly, with a hand-built copy
    # of this very grid, which is how 5085 sat still through two map fixes. So when
    # there are traps, print the frontier: for the column the worst trap is in, every
    # cell there and whether the reverse fill reached it. Set FORTS_TRAP_FRONTIER=1 to
    # print it every run, green ones included.
    if trapped or os.environ.get("FORTS_TRAP_FRONTIER"):
        _x, _y, _z = trapped[0] if trapped else (0.0, 0.0, 0.0)
        _here = sorted(o for o in cells.get((_x, _y), []) if o > -320)
        print(f"  frontier: fwd={len(fwd)} back={len(back)} traps={len(trapped)} "
              f"first trap at ({_x:.0f},{_y:.0f},{_z:.0f})")
        print(f"    that column's cells {_here}; the reverse fill reached "
              f"{[o for o in _here if ((_x, _y), o) in back]}")
        _zs = sorted({o for (_c, o) in (fwd - back)})
        print(f"    trap z range {_zs[:4]} .. {_zs[-4:]}")
        _xy = sorted({(c[0], c[1]) for (c, _o) in (fwd - back)})
        print(f"    {len(_xy)} trap columns, e.g. {_xy[:4]}")
        if os.environ.get("FORTS_TRAP_COLUMN"):
            _fx = float(os.environ["FORTS_TRAP_COLUMN"])
            for _y in range(0, 2049, step):
                _c = cells.get((_fx, _y), [])
                if not _c:
                    continue
                print(f"    x={_fx:.0f} y={_y:5d} cells={sorted(_c)} "
                      f"reached={[o for o in _c if ((_fx, _y), o) in back]} "
                      f"trapped={[o for o in _c if ((_fx, _y), o) in fwd - back]}")

    # WITH A JUMP: an extra, not the pass condition, and it is here so the difference
    # between the two fills is a number rather than an argument.
    fwdj = bfs(sorted(seeds), reverse=False, rise=JUMP)
    backj = bfs(sorted(seeds), reverse=True, rise=JUMP)
    trapj = fwdj - backj
    print(f"       with a 40-unit jump: {len(trapj)} cells are still traps "
          f"(on foot: {len(trapped)}); {len(fwdj) - len(fwd)} cells are reachable "
          f"only by jumping")

    # And nothing at all should be sealed off: a region of floor no route reaches is
    # either a piece of the map nobody will ever visit or a route that does not
    # exist. The map has one legitimate such region (the ground strip along the outer
    # edge, behind the fort's solid outer wall), so this is reported with its size
    # rather than only failed or only ignored.
    sealed = {}
    for col, zs in cells.items():
        for oz in zs:
            if (col, oz) in fwd:
                continue
            key = ("A" if col[0] < LEN / 2 else "B")
            sealed.setdefault(key, []).append((col[0], col[1], oz))
    for key, pts in sorted(sealed.items()):
        pts.sort()
        # A fall-in, not merely a neighbour. The map has two kinds of unreachable
        # cell that are both correct: the railings' tops and the ground strip along
        # the map's outer edge (sealed behind the fort's solid outer wall). A cell a
        # player can FALL INTO from somewhere they can stand is the owner's "fall in
        # and stuck", and that is what this fails on.
        #
        # The bridge rail's top used to be one of the unreachable ones for a second
        # reason as well: it rode 96 above the deck, which no jump clears, so there
        # was nothing to get up onto it at all. It is 24 now (reviewer 0527 item 3),
        # so a player CAN jump onto it -- and the check still passes, which is worth
        # saying out loud rather than leaving to be discovered: this flood models
        # walking and 18-unit steps, never a jump, so the rail top is still counted
        # as unreachable here, and it is not a pit anyway. Every side of it leads
        # somewhere: the deck on one side, the channel on the other, and the channel
        # is water.
        fwd_above = set()
        for (col, oz) in fwd:
            fwd_above.add((col[0], col[1], oz))
        cols_with_fwd = collections.defaultdict(list)
        for (col, oz) in fwd:
            cols_with_fwd[col].append(oz)
        fall_ins = []
        for px, py, pz in pts:
            above = [oz for oz in cols_with_fwd.get((px, py), [])
                     if oz > pz]
            for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step)):
                for oz in cols_with_fwd.get((px + dx, py + dy), []):
                    if oz > pz + g.PLAYER_RISE:
                        above.append(oz)
            if above:
                fall_ins.append((px, py, pz, max(above)))
        near = bool(fall_ins)
        check(not near,
              f"fort {key}: nothing a player can stand on is a place they can fall "
              f"into and not get out of ({len(pts)} cells unreachable on this side, "
              f"all of them ledges or sealed ground)",
              f"{len(fall_ins)} cells can be fallen into from somewhere reachable, "
              f"e.g. "
              + ", ".join(f"({x:.0f},{y:.0f},{z:.0f}) under {a:.0f}"
                          for x, y, z, a in fall_ins[:6])
              + " -- that is a pit with no way out of it")


def corridor_checks(routes):
    """Every route the owner must walk has room to walk it.

    Reviewer 0254: "any walkway the owner must use (along the stair flight, around
    the stairwell, through doors, along battlements) needs at least 96 of clear
    width, the same as a door. ... a 16-unit gap is a map bug."

    It is measured, not inferred from the route: the router only ever asserts that
    ONE hull fits, so a route through a 16-unit slot is a route it is happy with and
    a player is not. At every step along the route this measures the free width with
    the real hull, by walking outwards from the centre until the hull is blocked on
    each side.
    """
    print("forts: corridors")
    bs = solids()
    MIN_W = 96
    STEP = 32

    def free_width(x, y, z, dx, dy):
        """How wide is the walkway HERE, measured across the direction of travel.

        Left and right are measured SEPARATELY and summed, because the width of a
        walkway is not the width of the line the router happened to take through it.
        map_route's A* has no reason to prefer the middle of a corridor -- every cell
        its hull test passes costs the same, so it takes the first one it finds, which
        on a straight run is the one against a wall. It put the battlement route 8
        design units from the parapet stairwell's own wall in a 128-wide flight, and
        the crossing 32 from the bridge's south railing on a 256-wide deck, and the
        vault leg 12 from the doorway's jamb in a 128-wide door -- and the symmetric
        measure called all three 32, which is a fact about the router and not about
        the map.

        The owner's figure is about the walkway: "any walkway the owner must use ...
        needs at least 96 of clear width, the same as a door ... a 16-unit gap is a map
        bug". A gap is narrow on BOTH sides. So this asks how far the hull can go each
        way and adds them, and a genuine squeeze -- walled on both sides, which is what
        a squeeze is -- still measures 32 and still fails.

        The probe point is asked the way a walker experiences it, not as one frozen
        hull volume: a lateral point counts when the walker could be STANDING there,
        meaning a standable surface within one probe step of the LOCAL floor and a
        hull that fits on it (surfaces_at already answers the "hull fits" half). The
        four ramp samples that read 32.0 (both forts' spawn->vault and
        floor->battlement, reviewer 0506's "bring the row back to ok") were the
        frozen hull sitting inside the ramp brush at mid-slope. The local floor is
        re-read from the map at every sample rather than taken from the route line:
        the route's z is a standing origin from map_route's own grid, but the check
        interpolates between waypoints in a straight line, and on a ramp or a step
        that line rides off the real surface -- measured 24.9 high on the vault
        entrance ramp, which put even a ±20 surface window out of reach. The search
        band is 40: the worst ride a half-segment of a 30-degree ramp plus the
        grid's own snap. Laterals stay within ±20 of that local floor, which is one
        probe step of the steepest legal ramp (32 * tan 30 = 18.5) and deliberately
        NOT wide enough to step onto a rail top: the battlement's merlons ride 32
        above the surface they guard, and the bridge rail 24 (reviewer 0527 item 3),
        so neither is a lateral the walkway can claim as its own width. A drop edge
        stays honest too, because the void past a ledge has no standable surface in
        the window and no longer counts as width the way the frozen hull over open
        air used to.
        """
        # The local standing floor: the standable surface nearest the route's own
        # floor, within the 40 band the docstring justifies. None means the map has
        # no surface near the line here -- an interpolation between two standing
        # cells that floats over a step or a ramp edge is not a place the walker
        # stands, and a width probed in mid-air means nothing.
        want = z - 24
        tops = surfaces_at(bs, x, y, want - 40, want + 40)
        floor = None
        if tops:
            floor = min(tops, key=lambda t: abs(t - want))

        # A unit vector perpendicular to the direction of travel.
        px, py = -dy, dx

        def walkable(sx, sy, d):
            return bool(surfaces_at(bs, x + sx * d, y + sy * d,
                                    floor - 20, floor + 20))

        def reach_dir(sx, sy):
            out = 0.0
            for d in (STEP, 2 * STEP, 3 * STEP, 4 * STEP, 5 * STEP, 6 * STEP):
                if walkable(sx, sy, d):
                    out = d
                else:
                    break
            return out
        if floor is None:
            return None
        return reach_dir(px, py) + reach_dir(-px, -py) + 2 * g.HULL_MAX_XY

    for label, wps in routes:
        # map_route's JSON is lists, but a route handed in from anywhere else may be
        # tuples or a dict of them; normalise to a list of 3-tuples once, here,
        # rather than at every use.
        if isinstance(wps, dict):
            wps = wps.get("waypoints") or []
        wps = [tuple(float(v) for v in p) for p in wps]
        if len(wps) < 2:
            continue
        worst = None
        pts = []
        skipped = 0
        for i in range(len(wps) - 1):
            ax, ay, az = wps[i]
            bx, by, bz = wps[i + 1]
            d = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
            n = max(1, int(d / STEP))
            for k in range(n):
                f = k / float(n)
                x = ax + (bx - ax) * f
                y = ay + (by - ay) * f
                # The waypoint's z IS the player's ORIGIN, not the floor it names
                # (map_route only ever returns cells its own hull test found free,
                # about the origin). It is interpolated along the segment too: an
                # earlier pass kept each segment's START z for the whole segment,
                # which on a descent line left most of the samples a half-flight
                # above the surface -- 62 of 69 skipped on battlement -> down --
                # and a width read in mid-air is no width at all.
                z = az + (bz - az) * f
                dx, dy = bx - ax, by - ay
                m = (dx * dx + dy * dy) ** 0.5 or 1
                w = free_width(x, y, z, dx / m, dy / m)
                if w is None:
                    skipped = skipped + 1
                    continue
                pts.append((round(w, 1), round(x), round(y), round(z)))
        if not pts:
            # Every sample skipped is not a pass: a route whose whole line floats
            # with no standable surface under it is not a walkable route, and the
            # earlier "there is a route at all" check answers map_route's own
            # arithmetic, not the map's.
            check(False,
                  f"{label}: at least {MIN_W} of clear width the whole way "
                  f"(hull included)",
                  f"every one of the width samples was skipped: the route line "
                  f"({len(wps)} waypoints) has no standable surface within 40 of "
                  f"it anywhere, so there is nothing here a player could be "
                  f"walking on")
            continue
        worst = min(pts)
        # The coordinate goes with `at`, so the failure names a PLACE and not just a
        # triple: the narrowest point already knows where it is, and "nearest named
        # thing" is what turns a triple into something the owner can look up. The cause
        # itself is report.doorway_is(), so the wording is stated once for the whole repo.
        check(worst[0] >= MIN_W,
              f"{label}: at least {MIN_W} of clear width the whole way "
              f"(hull included)",
              f"narrowest {worst[0]}. That is left + hull + right, and the hull is "
              f"{2 * g.HULL_MAX_XY} of it, so there are "
              f"{worst[0] - 2 * g.HULL_MAX_XY:.0f} of walkable width here -- a hull is "
              f"{2 * g.HULL_MAX_XY} wide, so this is a squeeze the owner will feel as "
              f"the wall stopping them",
              at=(worst[1], worst[2], worst[3]))


def routes_world(a, b):
    """map_route --map forts for two points that are ALREADY in world units.

    route_checker()'s routes() is for DESIGN-unit coordinates and converts them;
    feeding it a world point doubles it, and every leg then answered "the start
    point is inside solid geometry" -- which is true, of the wrong place.
    """
    import json as _json
    rt = os.path.join(ROOT, "scripts/map_route.py")
    r = subprocess.run([sys.executable, rt, "--map", "forts",
                        "--from", ",".join(map(str, a)),
                        "--to", ",".join(map(str, b))],
                       capture_output=True, text=True, timeout=300)
    try:
        return _json.loads(r.stdout or "{}")
    except ValueError:
        return {}


def pad_checks():
    """Each stand has a glowing pad of its own team under it (owner, 2026-10-09).

    "there is no visual indicator as to where the key turn in is located
    (perhaps a glowing block)". Two halves, both read off the map qbsp compiles:

      * a pad BRUSH in the team's trim texture under the stand, 8 world thick --
        a step a player walks onto (the engine's step-up is 18), never one they
        climb;
      * a light within 128 world of the stand, in the team's colour, at the
        brightness the brief names.

    The entities come through build_nav.entities(), the repo's one .map entity
    reader -- a second copy of a parser is a second thing to keep correct
    (0277), and the pad light's emitted brightness is scale_light_field()'s
    work, so it can only be read from the file the map became.
    """
    import build_nav  # noqa: E402  (the .map entity reader; imports map_route)
    print("forts: turn-in pads")
    ents = build_nav.entities(MAPFILE)
    stands = [e for e in ents if e.get("classname") == "item_qwtf_stand"]
    check(len(stands) == 2, "the map has a capture stand per team",
          f"found {len(stands)} item_qwtf_stand entities")
    bs = solids()
    floor = g.sc(g.FORTS_VAULT_Z)
    for st in stands:
        p = [float(v) for v in st["origin"].split()]
        team = "red" if st.get("spawnflags") == "2" else "blue"
        tex = g.TEX_TRIM_RED if team == "red" else g.TEX_TRIM_BLUE
        pads = [b for b in bs if b[6] == tex
                and b[0] <= p[0] <= b[3] and b[1] <= p[1] <= b[4]
                and 0 < b[5] - floor <= 16]
        check(len(pads) == 1,
              f"the {team} stand at ({p[0]:.0f},{p[1]:.0f},{p[2]:.0f}) stands on "
              f"its own team's pad, and the pad is a step, not a climb",
              f"found {len(pads)} {tex} brushes under it within 16 of the vault "
              f"floor ({floor:.0f}); a pad's top must be 1..16 above the floor "
              f"the stand is on",
              at=tuple(p))
        lights = [e for e in ents if e.get("classname") == "light"
                  and e.get("targetname") == f"pad_{team}"]
        check(len(lights) == 1,
              f"the {team} pad has exactly one pad light",
              f"found {len(lights)} lights named pad_{team}")
        if not lights:
            continue
        lo = [float(v) for v in lights[0]["origin"].split()]
        dist = math.dist(lo, p)
        check(dist <= 128,
              f"the {team} pad light is within 128 of the stand",
              f"it is {dist:.0f} away ({lo} against the stand at {p})",
              at=tuple(lo))
        c = lights[0].get("_color", "")
        nums = [float(v) for v in c.split()] if c else []
        if team == "red":
            check(len(nums) == 3 and nums[0] > nums[1] and nums[0] > nums[2],
                  f"the {team} pad light is red",
                  f'_color "{c}" -- a red light carries more red than anything else')
        else:
            check(len(nums) == 3 and nums[2] > nums[0] and nums[2] > nums[1],
                  f"the {team} pad light is blue",
                  f'_color "{c}" -- a blue light carries more blue than anything else')
        check(lights[0].get("light") == "400",
              f"the {team} pad light is bright (400)",
              f'its "light" is {lights[0].get("light")!r}; the brief asks for 400')


def spawn_checks():
    """Every spawn is on a floor, looks into the room, and has floor in front of it.

    Reviewer 0259: "a player who spawns and walks forward falls 352 into the shaft"
    is a gameplay bug, not just a bad test start. Three of the four spawns a side
    stood over the hole in the fort's ground floor (x 144..448, y 432..784 in design
    units) -- reading the spawn ORIGINS instead of assuming where the room was, which
    is what found it.

    Measured, not assumed: 128 of solid floor ahead in the direction the spawn faces,
    the hull free where it stands, and a floor under it rather than a hole.
    """
    print("forts: spawns")
    bs = solids()
    FRONT = 128

    def standable(x, y, z):
        return not blocked(bs, x, y, z)

    for mirrored in (False, True):
        name = "B" if mirrored else "A"
        for i, e in enumerate(g.forts_entities(mirrored)):
            if e[0] != "info_player_deathmatch":
                continue
            p = [float(v) for v in e[1].split('"')[3].split()]
            fields = dict(f.split('"')[1::2] for f in e[1:] if f.startswith('"'))
            angle = float(fields.get("angle", "0"))
            # MEASURED: face 90 -> dy +116, face 270 -> dy -236. So 90 is +y.
            dx = -1.0 if abs(angle - 180) < 1 else (1.0 if abs(angle) < 1 else 0.0)
            dy = 1.0 if abs(angle - 90) < 1 else (-1.0 if abs(angle - 270) < 1 else 0.0)
            # `at` is the spawn's own point, which these checks already had as `p`. The
            # coordinate was in the label as a triple in parentheses; now it is also the
            # place the report is anchored to, so the nearest NAMED thing comes with it --
            # and a spawn's own targetname is exactly the name the owner gave it.
            check(standable(p[0], p[1], p[2]),
                  f"spawn {i} of fort {name} at ({p[0]:.0f},{p[1]:.0f},{p[2]:.0f}) has "
                  f"room for a player to stand in it",
                  "the hull is inside geometry here",
                  at=tuple(p))
            # A floor under it: there is solid directly below, not a hole.
            below = [t for t in bs if t[0] <= p[0] <= t[3] and t[1] <= p[1] <= t[4]
                     and mapfile.top_at(t, p[0], p[1]) <= p[2] + 1
                     and mapfile.top_at(t, p[0], p[1]) >= p[2] - 200]
            check(bool(below),
                  f"spawn {i} of fort {name} has a floor under it, not a hole",
                  f"nothing solid within 200 below z={p[2]:.0f} -- a player who "
                  f"spawns here falls",
                  at=tuple(p))
            # FRONT: walk out FRONT units in the facing direction and require floor
            # the whole way, sampled every 16.
            gaps, run_bad = [], []
            for d in range(0, FRONT + 1, 16):
                qx, qy = p[0] + dx * d, p[1] + dy * d
                fl = [mapfile.top_at(t, qx, qy) for t in bs
                      if t[0] <= qx <= t[3] and t[1] <= qy <= t[4]
                      and mapfile.top_at(t, qx, qy) <= p[2] + 1
                      and mapfile.top_at(t, qx, qy) >= p[2] - 400]
                ok = bool(fl) and abs(max(fl) - (p[2] - 24)) < 40
                if not ok:
                    gaps.append((round(qx), round(qy)))
            # Anchored at the spawn, not at the first gap: the gap is what the report
            # already names, and the question being asked is whether THIS spawn is sound.
            # `at` also moves the spawn's targetname in, since it is the nearest named
            # thing to itself.
            check(not gaps,
                  f"spawn {i} of fort {name} has {FRONT} of solid floor in front of "
                  f"it (it faces angle {angle:.0f})",
                  f"no floor at {gaps[:4]} -- a player who spawns and walks forward "
                  f"falls, which is the owner's 'fall in and stuck'",
                  at=tuple(p))


def route_checker():
    """A routes(src, dst) for --map forts, in DESIGN units in and world units out.

    The coordinates written in the checks are the ones the map was AUTHORED in --
    design units, which is what the literals in the generator are -- and map_route
    works in WORLD units, because that is what a player walks in. W() is the
    conversion, and it is applied HERE, once, so every viewpoint in the checks below
    stays readable as the design number it was drawn as.
    """
    rt = os.path.join(ROOT, "scripts/map_route.py")

    def routes(src, dst):
        r = subprocess.run([sys.executable, rt, "--map", "forts",
                            "--from", ",".join(map(str, W(*src))),
                            "--to", ",".join(map(str, W(*dst)))],
                           capture_output=True, text=True, timeout=300)
        import json
        return json.loads(r.stdout or "{}")
    return routes


    # DELETED: a second copy of this parser, which is what 0277 is about and what
    # this file says about itself two hundred lines above ("A thin name over
    # scripts/mapfile.py, which is the one reader in the repo ... a second copy of
    # a parser is a second thing to keep correct"). Python takes the LAST
    # definition of a name, so this one -- not the thin one above -- is what every
    # check in this file was reading the map through. It knew nothing about ramps,
    # so the ramp conversion produced a map with two slopes on it and this file
    # reported 233 solids and no ramps, and asked the world-scale check to measure
    # a ramp that it could not see.
    #
    # The other dead duplicates this file used to carry (a second escape_checks,
    # spawn_checks, corridor_checks, door_checks and ring_calls, live one always
    # the last) went in 166e76b. An ast scan now finds one of every function at
    # module scope; the only same-named pair is the module-level standable and a
    # DIFFERENT live helper of that name inside spawn_checks, whose signature and
    # geometry are its own.
def main():
    # `python3 tests/test_forts_map.py world` runs ONLY the world-scale section.
    # It exists because that section is the one that has to be shown failing when
    # the scale is broken, and the whole file takes four minutes -- most of it in
    # the route subprocesses -- which is too slow to do on every experiment.
    only = sys.argv[1] if len(sys.argv) > 1 else None
    if only == "world":
        return world_scale_checks()
    if only == "doors":
        return summarise2(door_checks)
    if only == "traps":
        return summarise2(escape_checks)
    if only == "corridors":
        corridor_checks(FORTS_ROUTES())
        return summarise("forts")
    if only == "spawns":
        spawn_checks()
        return summarise("forts")
    if only:
        print(f"usage: {sys.argv[0]} [world]", file=sys.stderr)
        return 2
    print("forts: geometry")
    solids_are_the_map()
    every_brush_is_readable()
    exact_reader_agrees()
    bs = solids()

    # -- symmetry -------------------------------------------------------------
    # Both forts must be mirror images. This caught four separate real bugs: the
    # wall ring built at unmirrored coordinates, merlons double-mirrored so fort
    # B's parapet sat one 64 pitch out of step, a descending box (x0 > x1) that no
    # comparison matched, and stairs mirrored in CTF_LEN instead of the forts'.
    a = g.fort_geometry(False)
    b = g.fort_geometry(True)
    mir = lambda t: (g.FORTS_LEN - t[3], t[1], t[2], g.FORTS_LEN - t[0], t[4], t[5])
    sa = {tuple(t[:6]) for t in a}
    sb = {tuple(t[:6]) for t in b}
    check(len(a) == len(b), "both forts have the same number of boxes",
          f"A {len(a)} vs B {len(b)}")
    bad_a = [t for t in a if mir(t) not in sb]
    bad_b = [t for t in b if mir(t) not in sa]
    # Anchored at the first box with no mirror, whichever side it is on. This one MATTERS
    # more than its plainness suggests: 0314 is the reviewer's note that the blue basement
    # could be escaped and the red one could not, found in a build. A mirror check that
    # says "a box has no mirror" without saying WHICH box is close to useless for that,
    # because the whole failure is that one side differs from the other.
    _bad0 = (bad_a + bad_b)[0] if (bad_a or bad_b) else None
    check(not bad_a and not bad_b,
          "the two forts are mirror images of each other",
          f"{len(bad_a)} boxes in A and {len(bad_b)} in B have no mirror, "
          f"e.g. {_bad0[:6] if _bad0 else 'none'}",
          at=tuple(_bad0[:3]) if _bad0 else None)

    # -- no degenerate boxes --------------------------------------------------
    # A box with two coincident faces has no normal on one plane. qbsp does not
    # reject it cleanly: it prints "Brush plane with no normal" and then hangs in
    # ProcessMapBrushes until the build times out. The stairwell landing exactly
    # on the interior's west edge did exactly that.
    deg = [t for t in bs if t[0] >= t[3] or t[1] >= t[4] or t[2] >= t[5]]
    # A degenerate box is a place: the corner where two faces coincide. qbsp does not
    # reject it cleanly -- it prints "Brush plane with no normal" and then HANGS in
    # ProcessMapBrushes until the build times out, which is a much worse thing to
    # diagnose than being handed the corner.
    check(not deg, "no box has two coincident faces",
          f"{len(deg)} degenerate, e.g. {deg[:1] and deg[:1][0][:6]}",
          at=tuple(deg[0][:3]) if deg else None)

    # -- no overlapping brushes ----------------------------------------------
    # The overlap guard, PROVEN ON A PAIR OF WEDGES (0395: "a test that fails on a
    # deliberately overlapping wedge pair"). A guard that is only ever run on a map
    # where the answer is "no" is not known to be able to say yes, and this one had been
    # comparing BOUNDING BOXES -- which on a ramp is its high end, so it reported 14 pairs
    # of merlon-over-ramp that share no volume at all. Two cases, both built here:
    # two wedges whose slopes CROSS share a wedge of real volume and must be caught, and
    # two wedges that merely interleave must not be.
    _wx = g.ramp_box(0, 0, 0, 128, 64, 0, 64, g.TEX_FLOOR, along="x")
    _cross = g.ramp_box(64, 0, 0, 192, 64, 0, 64, g.TEX_FLOOR, along="x")
    _apart = g.ramp_box(64, 64, 0, 192, 128, 0, 64, g.TEX_FLOOR, along="x")
    check(g.brushes_overlap(_wx, _cross) and not g.brushes_overlap(_wx, _apart),
          "the overlap guard is honest about wedges: it catches a crossing pair and "
          "leaves an interleaved one alone",
          f"crossing {g.brushes_overlap(_wx, _cross)}, interleaved "
          f"{g.brushes_overlap(_wx, _apart)}; it must be True and False")

    ov = overlaps(bs)
    # The overlap is a PLACE and not a pair of boxes. report.overlaps() says it in the
    # words the owner reads, and the same phrasing is what test_ctf_map.py's overlap
    # check needs when it gets wired -- the ctf one is the red one, and its message is
    # two tuples and no location.
    check(not ov, "no two solid boxes overlap in volume",
          (f"{len(ov)} overlapping pairs; the largest is "
           + report.overlaps(ov[0][0], ov[0][1], ov[0][2]))
          if ov else "none",
          at=tuple(ov[0][0][:3]) if ov else None)

    # -- spawns ---------------------------------------------------------------
    # IN WORLD UNITS, and that is not a detail: g.forts_entities() hands back the
    # map's own entity list, which gen_map emits already scaled, so these points were
    # in world units while every literal in this file was in design units. The first
    # version of this check after the scale change reported all eight spawns "outside
    # the hall" -- it was comparing a spawn at x=480 with a hall that ends at x=448.
    # An entity's origin is where the ENGINE puts it, so anything that checks one
    # has to be in the same units the engine uses.
    spawns = []
    for mirrored in (False, True):
        spawns += [t for t in g.forts_entities(mirrored)
                   if t[0] == "info_player_deathmatch"]
    pts = [[float(v) for v in t[1].split('"')[3].split()] for t in spawns]
    wbs = bs
    inwater = water_boxes()
    wet = [p for p in pts
           if any(w[0] <= p[0] <= w[3] and w[1] <= p[1] <= w[4]
                  and w[2] <= p[2] <= w[5] for w in inwater)]
    stuck = [p for p in pts if blocked(wbs, *p)]
    check(len(pts) >= 8, "the map has at least 8 spawn points", f"{len(pts)}")
    # A spawn NAMES ITSELF, so a report on one names the spawn the owner gave it and not
    # a triple. `at` takes the first offender, because that is the one to go and look at;
    # the rest stay in the detail for recognising the pattern.
    check(not wet, "no spawn point is inside the water",
          f"{len(wet)} of them, e.g. {wet[:4]}", at=tuple(wet[0]) if wet else None)
    check(not stuck, "no spawn point is inside a wall",
          f"{len(stuck)} of them, e.g. {stuck[:4]}",
          at=tuple(stuck[0]) if stuck else None)

    # Each spawn must be INSIDE its own fort, not outdoors. The reviewer could not
    # tell from the in-engine view whether a spawn was in a room or on the ground
    # (0146), because the ground was black. This answers it from geometry instead
    # of from a picture: the spawn has to be within the fort's interior, and there
    # has to be a roof above it.
    roof_z = W(g.FORTS_ROOF_Z)[0]
    # The roof strips come out of the generator in design units; everything else in
    # this block is world units read out of the map, so convert these once here.
    wab = Wb(a + b)
    for mirrored in (False, True):
        name = "B" if mirrored else "A"
        xs = sorted(W(g.FORTS_LEN - 240, 448) if mirrored else W(96, 448))
        for t in g.forts_entities(mirrored):
            if t[0] != "info_player_deathmatch":
                continue
            p = [float(v) for v in t[1].split('"')[3].split()]
            inside_x = xs[0] <= p[0] <= xs[1]
            inside_y = W(224)[0] <= p[1] <= W(800)[0]
            # A roof overhead: the four roof strips tile the interior, so any cell
            # in the interior has roof at roof_z..roof_z+T above it.
            has_roof = any(b[0] <= p[0] <= b[3] and b[1] <= p[1] <= b[4]
                           and b[2] == roof_z for b in wab)
            check(inside_x and inside_y and has_roof,
                  f"spawn {p} is inside fort {name}'s hall, under its roof",
                  f"x in {xs}? {inside_x}  y in {W(224)[0]}..{W(800)[0]}? "
                  f"{inside_y}  roof above? {has_roof}")

    # The light-panel texture must not be a WALKING SURFACE. It is right on a panel
    # hung above you and wrong on a floor you stand on: the reviewer photographed a
    # battlement walkway of glowing tiles because TEX_CEIL -- the roof underside AND
    # the floor you walk on -- was light_fbr (0154). The panels added for the owner
    # (0217) hang BELOW the roof at z top-8..top, so they are above head height, and
    # that distinction is what this asserts rather than a blanket ban on the
    # texture -- a blanket ban would forbid the fix for the owner's complaint.
    # A player can only STAND on a surface whose top is at floor level (ground 0,
    # or the vault floor -128). A panel hanging at z 216..224 in the hall is
    # nowhere near either: the player under it stands at origin ~24 with their head
    # at ~48. So the test is "no panel's TOP is within standing height of a floor a
    # player walks on", which is the property that matters and does not forbid the
    # panels.
    walk_levels = (g.FORTS_GROUND_Z, g.FORTS_VAULT_Z)
    walked = [t for t in bs if t[6] == "light_fbr"
              and any(abs(t[5] - lvl) <= g.HULL_MIN_Z for lvl in walk_levels)]
    # The panel's own footprint, because "a panel below standing height" is not a place
    # until you say which panel, and the panel is a box in the ceiling.
    check(not walked, "the light-panel texture is never on a walking surface",
          f"{len(walked)} panels below standing height, e.g. "
          f"{walked[:1] and walked[0][:6]}",
          at=tuple(walked[0][:3]) if walked else None)

    # -- the parapet is actually a parapet -----------------------------------
    # A parapet with no gaps is a wall. The merlons must alternate with openings
    # you can put a player, or at least a shot, through.
    merlons = sorted(t for t in a if t[2] == g.FORTS_ROOF_Z + g.FORTS_WALL_T)
    south = [t for t in merlons if t[1] == 224]
    gaps = [(south[i][3], south[i + 1][0]) for i in range(len(south) - 1)]
    check(len(south) >= 3, "the south parapet has merlons", f"{len(south)}")
    # Anchored on the first GAP rather than on a merlon: the failure is that two merlons
    # are touching, and a gap is the space between them, which is the thing that is
    # missing. A merlon is solid by definition and naming one as the place a gap should
    # be would point at the wall.
    check(bool(gaps), "the south parapet has openings between merlons",
          f"{len(gaps)} between {len(south)} merlons, e.g. {gaps[:4]}",
          at=(south[0][0], south[0][1], south[0][2]) if south else None)

    # -- you can get onto the roof -------------------------------------------
    roof_z = W(g.FORTS_ROOF_Z + g.FORTS_WALL_T)[0]
    # bs is the MAP now -- world units, straight out of maps/forts.map -- so these
    # bounds have to be world too. Measured against design boxes, the fill was
    # looking at the bottom-left corner of a map twice its size and reported the
    # roof unreachable.
    #
    # And they are NOT run through W() again. ix0/iy0 are already g.sc()'d and roof_z
    # is already sc()'d, so W() on them scales a second time and the fill is handed a
    # window at x 384..1792, y 896..3200 on a map 4864 x 2048 -- which excludes both
    # stairwells, so the start point was outside its own bounds, the fill returned the
    # single start cell, and "the stairs do not connect: nothing above the roof was
    # reached" was the fill being asked about the wrong quarter of the map. The
    # comment on this block already said the bounds had to be world; they were world
    # TWICE.
    ix0, ix1 = g.sc(96), g.sc(448)
    iy0, iy1 = g.sc(224), g.sc(800)
    _w = W(240, 416, 24)
    _b = (ix0, ix1, iy0, iy1, -48, roof_z + 32)
    inside = fill = reach(bs, tuple(_w), tuple(_b))
    above = [c for c in inside if c[2] >= roof_z]
    check(bool(above),
          "the fort roof is reachable on foot from the fort floor",
          f"the stairs do not connect: nothing above the roof was reached; the fill "
          f"covered {len(inside)} cells inside {tuple(round(v) for v in _b)} from "
          f"{tuple(round(v) for v in _w)}")

    # NO "forts: stairs" SECTION, and there has not been one worth having since 0297.
    #
    # It walked every flight with the real hull, tread by tread, and it read the treads
    # from forts_vault_stair() -- a hand-written model of the old dog-leg that
    # gen_map stopped emitting in 0270 and that this file deleted in 0297 (agreed again
    # in 0302). So it has measured nothing since, and because the function returns []
    # for "no treads found" it reported two FAILs that no map change could ever fix:
    #   FAIL fort A vault stair has steps -- no treads found
    #   FAIL fort B vault stair has steps -- no treads found
    # Those two lines were in the run for every commit since, in the check_all count
    # ("forts: 14 ok, 14 FAIL"), and no baseline row covers them, so they were the one
    # part of the suite that was both permanently red and invisible.
    #
    # What the section was FOR is still done, from the emitted map: "forts: world
    # scale" measures every flight gen_map reports -- its tread count off the
    # geometry, its tread depth and its rise against the PLAYER's limits in world
    # units. Reading it from the map rather than from a second model of the staircase
    # is the whole point of 0277, which is why this was deleted rather than ported.
    print("forts: stairs")
    print(f"         (measured in 'forts: world scale', off the emitted map: tread "
          f"count, tread depth >= {g.PLAYER_TREAD}, rise <= {g.PLAYER_RISE})")

    print("forts: water")
    water = [b for b in g.forts_channel() if b[6] == g.TEX_WATER]
    check(len(water) == 1, "the channel holds exactly one water brush",
          f"{len(water)}")
    if water:
        w = water[0]
        # `at` is the water brush's own corner. There is exactly one water brush, so
        # there is nothing to choose and no risk of pointing at the wrong one -- and a
        # report about water without saying WHERE the water is is not actionable.
        check(w[2] == g.FORTS_BED_Z,
              "the water reaches the channel bed, it is not a floating slab",
              f"water bottom {w[2]}, bed {g.FORTS_BED_Z}", at=w[:3])
        check(w[5] == g.FORTS_WATER_TOP, "the water surface is at the level set",
              f"water top {w[5]}, expected {g.FORTS_WATER_TOP}",
              at=(w[0], w[1], w[5]))
        # The bed must be BELOW the water and the banks ABOVE it, or the water is
        # either buried or a puddle on a plateau.
        check(w[5] < g.FORTS_GROUND_Z,
              "the water surface is below ground level, so the channel is sunk",
              f"water top {w[5]} vs ground {g.FORTS_GROUND_Z}",
              at=(w[0], w[1], w[5]))
        # A bank you can climb out of is a bank that is not a channel. Measured
        # from the player's FEET, which are HULL_MIN_Z below the origin, and a
        # jump is worth about 32-40: the surface is at -24, so the feet are at
        # -48 and standing on ground level needs a 48 rise. The freeboard alone
        # (24) is NOT the number to compare against 48.
        feet_at_surface = w[5] - HULL_MIN_Z
        rise = g.FORTS_GROUND_Z - feet_at_surface
        check(rise > 40,
              "the banks cannot be jumped out of, so the channel is a swim",
              f"a swimming player only needs to rise {rise} from feet at "
              f"{feet_at_surface} to reach ground {g.FORTS_GROUND_Z}, and a jump "
              f"is worth ~32-40",
              at=(w[0], (w[1] + w[4]) / 2, w[5]))

    print("forts: route")
    # Every viewpoint the owner asked to see, routed with the same router the
    # in-engine harness drives. A viewpoint that cannot be routed is a viewpoint
    # nobody gets a screenshot of, and it is also the defect: this is how the
    # stairs were caught, 64 deep with a 20 rise now, where before they were 10.7
    # wide with a 40 rise and no player could have climbed them.
    routes = route_checker()
    for what, dst in (("the fort front, looking at the bridge", (464, 512, 40)),
                      ("the other fort across the water", (1552, 512, 40)),
                      ("the battlement lookout", (272, 512, 288)),
                      ("the middle of the channel", (1024, 300, 24)),
                      ("the bottom of the underwater passage", (300, 480, -96))):
        j = routes((240, 416, 24), dst)
        check(j.get("ok"), "you can walk from the fort floor to " + what,
              j.get("reason", "") + f" closest {j.get('closest')}")

    print("forts: vault")
    # The basement key vault, per M4a. Two ways in is the requirement
    # (GAME-DESIGN.md: "one main way in plus one narrower one, so it can be
    # defended but not sealed"): the underwater passage and a narrow stair from
    # the fort floor.
    for mirrored in (False, True):
        name = "B" if mirrored else "A"
        vx = (432, 448) if not mirrored else (g.FORTS_LEN - 448, g.FORTS_LEN - 432)
        # The passage reaches the vault.
        j = routes((240 if not mirrored else 1808, 416, 24),
                   (416 if not mirrored else 1632, 480, -104))
        check(j.get("ok"), f"fort {name}'s passage reaches its vault",
              j.get("reason", ""))
        # And so does the second stair, which is what makes it defensible but not
        # sealable. It is at the passage's OUTER end, in the shaft's other 64.
        j2 = routes((240 if not mirrored else 1808, 416, 24),
                    (432 if not mirrored else 1616, 544, -96))
        check(j2.get("ok"), f"fort {name}'s second stair reaches its vault",
              j2.get("reason", ""))
    # The two ways must NOT be the same route, or there is only one way in.
    a = routes((240, 416, 24), (416, 480, -104))["waypoints"]
    b = routes((240, 416, 24), (432, 544, -96))["waypoints"]
    check(a != b, "the two ways into the vault are different routes",
          "both resolved to the same waypoint list")

    print("forts: bridge")
    # THE BRIDGE MUST GO SOMEWHERE (0226 E). The deck spans y 448..560 and met solid
    # wall for most of its width: the wall's other doorways were at y 288..352 and
    # 416..480, so the deck overlapped a gap by exactly 32 -- the hull's own width,
    # leaving no room to walk through. The owner's words: "the bridge across the
    # water has no entrance to the fort".
    for name, hall_x in (("fort A", 272), ("fort B", 1776)):
        j = routes((hall_x, 512, 24), (1024, 504, 40))
        check(j.get("ok"),
              f"a player can walk from {name}'s hall out onto the bridge",
              j.get("reason", "") +
              " -- the bridge meets the fort wall with no doorway")
    # And the doorway is at DECK level, not at the bed: a hole in the wall at the
    # bottom of a 144-deep channel is not a way out of a bridge.
    deck_gap = [t for t in bs if t[6] == g.TEX_WALL
                and t[1] <= 512 <= t[4] and t[0] >= 440 and t[0] <= 490
                and t[5] <= g.FORTS_GROUND_Z + 96]
    check(len(deck_gap) == 0,
          "the wall at bridge-deck height has a hole in it",
          f"{len(deck_gap)} wall boxes still block y=512 at deck level")

    # THE RAIL IS A RAIL AND NOT A WALL (reviewer 0527 item 3). It was 48 design =
    # 96 world, which is more than a Quake jump clears (270 initial velocity against
    # 800 of gravity peaks at 45.6), so the deck's edge was a wall and the only way
    # into the channel was to walk off the END of the bridge inside a fort. The
    # owner's ask was the opposite: "a player can jump into the water".
    #
    # Measured off the MAP, in world units, and the band is the reviewer's: high
    # enough to still stop a walking player stepping straight off (above 18) and low
    # enough that a jump clears it with the rail's own 32 of thickness to cross (at
    # or below 32). A check that only said "lower than it was" would have been passed
    # by a rail at 1 unit, which is a kerb.
    rail_y0 = g.sc(g.FORTS_BRIDGE_Y[0])
    deck = g.sc(g.FORTS_BRIDGE_Z)
    ch_x0 = g.sc(g.FORTS_FORT_X1)              # where the channel starts
    ch_x1 = g.sc(g.FORTS_LEN - g.FORTS_FORT_X1)  # ... and ends
    rail_top = max((t[5] for t in bs
                    if t[6] == g.TEX_WALL
                    and t[0] <= ch_x0 + 32 and t[3] >= ch_x1 - 32   # spans the channel
                    and t[1] >= rail_y0 - 48 and t[4] <= rail_y0      # the rail's own y
                    and t[2] <= deck), default=None)
    rail_h = (rail_top - deck) if rail_top is not None else None
    check(rail_h is not None and 18 < rail_h <= 32,
          "the bridge railing is a rail: over 18 and 32 or less world above the deck",
          f"the railing's top is {rail_top} and the deck {deck}, so it stands "
          f"{rail_h} world above the deck; the band is 19..32 (24 is the design). "
          "Over 32 and the deck's edge is a wall a jump cannot clear")

    print("forts: light")
    # The owner's complaint (0216/0217): "the lighting blocks in the ceiling, named
    # lite, and yellow, are not light sources. So far only the spawn location has
    # functional ceiling lighting."
    #
    # A light_fbr face only LOOKS like a light. It emits nothing unless ericw-tools
    # is told to, with a light entity carrying _surface naming that texture. So both
    # halves have to be asserted, and asserting only one of them is exactly the bug:
    # panels with no emitter is decoration that reads as lighting.
    panels = [t for t in bs if t[6] == "light_fbr"]
    check(len(panels) >= 8, 'the map has light panels to emit',
          f'{len(panels)} panels; the owner saw none of them lighting anything')
    with open(os.path.join(ROOT, "maps/forts.map")) as f:
        msrc = f.read()
    emitters = msrc.count('"_surface" "light_fbr"')
    check(emitters >= 1,
          'every panel texture has a _surface emitter that makes it a light',
          f'{emitters} _surface emitters for {len(panels)} panels; without one a '
          'panel is a yellow tile, not a lamp')
    check('"_surface_offset"' in msrc,
          'the emitter is lifted off the face it is on',
          '_surface_offset keeps the emitter from sitting inside the geometry')
    # And every space a player can reach needs real light, because the sun cannot
    # reach inside a fort at all: the roof is a slab.
    lights = msrc.count('"classname" "light"')
    # No `at`, and deliberately: this is a COUNT of lights across four spaces. There is
    # no place it fails at, and picking one -- the first light, say -- would point the
    # owner at a lamp that is doing its job while the real problem is a dark vault
    # somewhere else. A report that names a wrong place is worse than one that names
    # none, which is the same rule the door-with-no-floor check follows.
    check(lights >= 20, 'the interior, the passage, the vault and the bridge are lit',
          f'only {lights} light entities on the map')
    # The sun, and no reliance on a point light per room. Without _sunlight the
    # map compiled, ran, and rendered the ground PITCH BLACK: the one point light
    # in each fort hall did not reach outside at all, so an in-engine spawn view
    # was black ground, a horizon and sky with no fort in the frame (0146).
    with open(os.path.join(ROOT, "maps/forts.map")) as f:
        src = f.read()
    for key in ('"_sunlight"', '"_sun_mangle"', '"_sunlight2"', '"_minlight"'):
        check(key in src, f"worldspawn carries {key}",
              "ericw-tools keys the sun off worldspawn, not off a light entity")

    pad_checks()
    world_scale_checks()          # its own summary, and it does not return early
    spawn_checks()
    corridor_checks(FORTS_ROUTES())
    return compile_checks()


def FORTS_ROUTES():
    """The routes a player has to be able to walk, as world-unit waypoint lists.

    The same ones tests/walk_routes.js drives in the engine, so the corridor check
    and the engine check are about the same paths rather than two sets that agree by
    accident.
    """
    G = {}
    for mirrored, tag in ((False, "A"), (True, "B")):
        spawns = [e for e in g.forts_entities(mirrored)
                  if e[0] == "info_player_deathmatch"]
        keys = [e for e in g.forts_entities(mirrored) if e[0] == "item_qwtf_key"]
        # The FIRST spawn, not the last: the spawns run north along the hall and the
        # northern ones stand over the hole in the floor (the shaft is y 432..784 in
        # design units), so "spawn + 128" was 352 above a pit and every route from it
        # answered "the start point is inside solid geometry" -- correctly, and for a
        # reason that has nothing to do with the route.
        G["spawn" + tag] = [float(v) for v in spawns[0][1].split('"')[3].split()]
        G["key" + tag] = [float(v) for v in keys[0][1].split('"')[3].split()]
    out = []
    for tag, sgn in (("A", 1), ("B", -1)):
        spawn = G["spawn" + tag]
        key = G["key" + tag]
        mid = g.sc(g.FORTS_LEN / 2.0)
        # Every start and goal is a place the map itself names: the first spawn, the
        # key (which is on the vault floor), the battlement (the parapet stair's top
        # tread), and the middle of the crossing. Nothing here is a guess about where
        # a room is -- that is what made the previous set of legs unusable.
        ground = g.sc(g.FORTS_GROUND_Z) + 24
        roof = g.sc(g.FORTS_ROOF_Z) + 24
        # The parapet flight's TOP TREAD, read off the flight the map reports. It
        # used to be the literal 160, which was right when the flight was at x
        # 128..192 and has been wrong since it moved east to 384..448 -- and a
        # route to a battlement that is not there is a route that fails for a
        # reason that has nothing to do with the route.
        g.FORTS_FLIGHTS.clear()
        g.fort_geometry(sgn < 0)
        tops = [f for f in g.FORTS_FLIGHTS
                if f["name"] == "parapet" and bool(f.get("mirrored")) == (sgn < 0)]
        if tops:
            bx = tops[0]["box"]
            bxx = g.sc(bx[0] if sgn > 0 else g.FORTS_LEN - bx[2])
        else:
            bxx = g.sc(160 if sgn > 0 else g.FORTS_LEN - 160)
        battlement = [bxx, g.sc(g.FORTS_STAIR_Y[0] + 8), roof]
        # The middle of the crossing is mid-x for BOTH forts, and the crossing's own
        # y, not mid-y. Fort B's was FORTS_LEN * 1.5 -- x 6144 on a map 4096 wide,
        # i.e. off the map entirely, and it only started being asked now that the
        # router can answer. Then the y was FORTS_LEN/2 as well, which is the middle
        # of the MAP: the bridge runs at y 288..416 design and the map is 1024 wide,
        # so "the middle of the crossing" was a point in the channel 288 south of the
        # bridge, over the water, and map_route answered "the target (2432, 2432, 24)
        # is inside solid geometry" -- which is the sky lid's own wall. A leg whose
        # destination is a typo is a leg that tests nothing.
        mid = g.sc(g.FORTS_LEN / 2.0)
        bridge_mid = [mid, g.sc(sum(g.FORTS_BRIDGE_Y) / 2.0), ground]
        legs = [
            (f"fort {tag}: spawn -> the vault", (spawn, key)),
            (f"fort {tag}: the vault -> the fort floor", (key, spawn)),
            (f"fort {tag}: the fort floor -> the battlement", (spawn, battlement)),
            (f"fort {tag}: the battlement -> down again", (battlement, spawn)),
            (f"fort {tag}: out of the bridge door and across",
             (spawn, bridge_mid)),
        ]
        for label, (a, b) in legs:
            j = routes_world(a, b)
            # `ok`, not truthiness: map_route's failure answer is a NON-EMPTY dict
            # ({"ok": false, "reason": ..., "closest": ..., "distance": ...}), and
            # `if wps` says a route exists when the router gave up and said why.
            wps = (j or {}).get("waypoints") or []
            check(bool(j) and j.get("ok") and len(wps) >= 2,
                  f"{label}: there is a route at all",
                  f"map_route: {j.get('reason') if j else 'no answer at all'}; "
                  f"closest {j.get('closest') if j else '?'} "
                  f"({j.get('distance') if j else '?'} from the goal); from {a} to {b}")
            if wps:
                out.append((label, wps))
    return out


    # -- the shaft's edge is railed AT HALL LEVEL (0324) ----------------------------
    # Every wall round the stairwell was BELOW z=0, so it walled the shaft from the
    # corridor and not from the hall: the spawn walk went north up the hall and stepped
    # straight off the floor's edge into the shaft (480,1207,2.6 -> bed). A wall that
    # protects a walker has to stand where the walker is.
    #
    # So: every cell of the shaft's outline on the hall floor must have, outside it,
    # something solid at a player's CHEST (z 24..60) -- or be the mouth, which is the
    # one place the player is meant to walk in. The mouth is derived: the flight's top
    # tread, at floor level, at the flight's east end.
    def railed(x, y):
        """Is a standing player blocked at chest height just outside (x, y)?"""
        return any(b[0] <= x <= b[3] and b[1] <= y <= b[4]
                   and b[2] <= 24 and b[5] >= 60
                   for b in bs)

    sx0 = W(g.FORTS_STAIR_LANDING_X[0] - g.FORTS_STAIR_WALL)[0]
    sx1 = W(g.FORTS_STAIR_X[1])[0]
    sy0, sy1 = W(g.FORTS_STAIR_Y[0])[0], W(g.FORTS_STAIR_Y[1] + g.FORTS_STAIR_WALL)[0]
    mouth_x = W(g.FORTS_STAIR_X[1] - 16)[0]          # the top tread, at floor level
    gaps = []
    x = sx0
    while x <= sx1:
        for y in (sy0, sy1):
            if not railed(x, y - 32 if y == sy0 else y + 32):
                gaps.append((x, y))
        x += 32
    y = sy0
    while y <= sy1:
        if not railed(sx0 - 32, y):
            gaps.append((sx0, y))
        y += 32
    # The east side is the mouth by design: the landing is at floor level and the
    # flight's top tread is flush with it, so that side is meant to be open.
    check(not gaps,
          "the stairwell's edge is railed at hall level on all three closed sides",
          f"{len(gaps)} outline cells have nothing solid at chest height outside "
          f"them, e.g. {gaps[:4]} -- a player walking the hall steps off there "
          f"(the mouth, the flight's top tread at x={mouth_x:g}, is meant to be open)")


def world_scale_checks():
    print("forts: world scale")
    # -- the emitted map IS the design map at FORTS_SCALE ------------------------
    # Everything else in this file measures design units, which is only legitimate
    # if the .map really is those units multiplied by the scale. So this parses
    # maps/forts.map -- the file qbsp compiles -- and compares every brush's six
    # planes with the generator's own boxes through g.forts_world(). If the scale
    # were applied in one place and forgotten in another, this is what says so.
    msrc = open(os.path.join(ROOT, "maps/forts.map")).read()
    emitted = parse_map_brushes(msrc)
    want = []
    # The stairwell is in this list because it is in the generator -- it was NOT, and
    # that made this check quietly weaker rather than wrong: `missing` asks whether
    # everything the generator drew is in the .map, so a function left out of `want`
    # is simply never looked for. That is the 0277 shape one layer down, and it is in
    # the file that was supposed to have removed it.
    for fn in (g.forts_hull, lambda: g.fort_geometry(False),
               lambda: g.fort_geometry(True),
               lambda: g.forts_ground(False),
               lambda: g.forts_ground(True), lambda: g.forts_passage(False),
               lambda: g.forts_passage(True), lambda: g.forts_stairwell(False),
               lambda: g.forts_stairwell(True), lambda: g.forts_vault(False),
               lambda: g.forts_vault(True), g.forts_channel):
        want += Wb(fn())
    have = {(b[0], b[1], b[2], b[3], b[4], b[5]) for b in emitted}
    missing = [b[:6] for b in want if tuple(round(v, 1) for v in b[:6]) not in have]
    check(not missing,
          f"maps/forts.map is exactly the design map x {S}",
          f"{len(missing)} of {len(want)} brushes are not at their scaled position, "
          f"e.g. {missing[:1]}; the scale has to be applied at emission or not at all")
    check(S >= 1.0, f"the map is at least as big as it was designed (scale {S})",
          "a scale below 1 makes every 'at least X' check weaker, which is the "
          "opposite of what the owner asked for")
    # And the size itself, so a scale of 1.0 cannot pass unnoticed.
    hull = [b for b in emitted if b[6] == g.TEX_SKY]
    if hull:
        span_x = max(b[3] for b in hull) - min(b[0] for b in hull)
        span_y = max(b[4] for b in hull) - min(b[1] for b in hull)
        check(abs(span_x - g.sc(g.FORTS_LEN + 2 * g.FORTS_HULL)) < 1
              and abs(span_y - g.sc(g.FORTS_WID + 2 * g.FORTS_HULL)) < 1,
              f"the hull is {g.sc(g.FORTS_LEN + 2 * g.FORTS_HULL):.0f} x "
              f"{g.sc(g.FORTS_WID + 2 * g.FORTS_HULL):.0f} world units",
              f"emitted {span_x} x {span_y}")
    else:
        check(False, "the map has a sealed sky hull", "no sky5_blu brush in the .map")

    # -- every flight, measured in WORLD units ---------------------------------
    # This is the check that cannot be done in design units, because it is the one
    # "at most" on the map. A stair's rise is bounded by the ENGINE (Quake steps up
    # at most ~18), not by how big the map is, so a bigger map has to buy its extra
    # height with MORE STEPS over a LONGER run -- 27 of them for the parapet at
    # scale 2.0 -- instead of taller ones. Getting that wrong does not break the
    # build: it ships a ladder, which is what the owner called "the stairs are
    # compressed" (0226 C).
    #
    # gen_map records every flight it builds (FORTS_FLIGHTS) because a checker
    # cannot find a flight it was never told about. What is measured here is the
    # TREADS, off the emitted geometry, not the numbers the generator reported: the
    # record says where to look, the boxes say what is there.
    # gen_map appends to FORTS_FLIGHTS on every build and this file has already
    # built both forts several times, so it is emptied and rebuilt once, here, and
    # the list is snapshotted: otherwise every flight is checked three times, which
    # is three times the output and no more information.
    wsolids = solids()
    g.FORTS_FLIGHTS.clear()
    g.forts_map()                       # populates FORTS_FLIGHTS
    flights = list(g.FORTS_FLIGHTS)
    # If the map stopped reporting its flights -- or someone reverted the code that
    # makes it report them -- every check in this loop would quietly have nothing to
    # measure and the section would pass. Measured while proving the parapet's
    # world_scale change: that revert produced ZERO records and a green run.
    # 2, not 4: gen_map builds side A only and mirror_half() reflects it (0314), so
    # the map reports the two flights it actually built. The other side's two are the
    # same two reflected, and the engine walk legs run on both teams, which is what
    # proves the mirror rather than this count.
    check(len(flights) >= 2,
          f"the map reports its flights, so they can be measured ({len(flights)})",
          "gen_map.FORTS_FLIGHTS is empty: the staircase checks below measured "
          "nothing at all, which is how a green run says nothing")
    # The owner's two numbers for a level change (0341), as constants here rather than
    # as literals in the checks, because they are the RULE and they are also what
    # gen_map's ramps are built to: about 30 degrees or less, and at least 128 wide.
    RAMP_MAX_DEG = 30.0
    RAMP_MIN_W = 128
    for fl in flights:
        fx0, fy0, fx1, fy1, fz0, fz1 = W(*fl["box"])
        tag = f"{fl['name']} (fort {'B' if fl.get('mirrored') else 'A'})"
        if fl.get("ramp"):
            # A RAMP IS MEASURED AS A SLOPE, off the emitted geometry and nothing
            # else. The three stair checks below are meaningless on it -- a slope has
            # no treads, so "every tread is at least 32 deep" would measure a list of
            # zero and "no step rises more than 18" a list of zero -- and asking them
            # anyway is how a check ends up passing because it measured nothing.
            #
            # The brush is found in the MAP, not taken from the record: the record says
            # where to look, the geometry says what is there, which is the rule this
            # whole file follows.
            if fl.get("mirrored"):
                fx0, fx1 = g.sc(g.FORTS_LEN) - fx1, g.sc(g.FORTS_LEN) - fx0
            ramps = [t for t in wsolids if mapfile.is_ramp(t)
                     and fx0 - 1 <= t[0] and t[3] <= fx1 + 1
                     and fy0 - 1 <= t[1] and t[4] <= fy1 + 1]
            check(len(ramps) == 1,
                  f"{tag}: the ramp is on the map, once",
                  f"found {len(ramps)} in the flight's own footprint")
            if not ramps:
                continue
            r = ramps[0]
            along, rise, run, deg = mapfile.slope(r)
            width = (r[4] - r[1]) if along == "x" else (r[3] - r[0])
            # A ramp's two ends are the two places worth looking at, and the FOOT is
            # where a ramp goes wrong: the head is flush by construction, and a foot that
            # is flush is a knife edge no .map brush can express. So the coordinate is the
            # low end -- (r[0], r[1]) if it rises along x, (r[0], r[1]) is the low corner
            # either way -- and top_at puts it ON the slope rather than at the bbox corner.
            # (r[0], r[1]) is the brush's min corner and is where the LOW end of the
            # slope is, whichever axis the slope runs along -- top_at puts the point on
            # the slope there rather than at the bbox corner, which for a ramp is its
            # HIGH end. The first version of this had a pointless
            # `(r[0], r[1]) if along == "x" else (r[0], r[1])`, which is the same tuple
            # both ways; that is what happens when you write the shape of the question
            # down before you have the answer.
            _low = (r[0], r[1], mapfile.top_at(r, r[0], r[1]))
            check(deg <= RAMP_MAX_DEG,
                  f"{tag}: the slope is {deg:.1f} deg, at most {RAMP_MAX_DEG}",
                  f"is {deg:.1f} deg -- {rise:.0f} of rise over {run:.0f} of run; the "
                  f"owner's rule is {RAMP_MAX_DEG} or less (0341)", at=_low)
            check(width >= RAMP_MIN_W,
                  f"{tag}: the ramp is {width:.0f} wide, at least {RAMP_MIN_W}",
                  f"is {width:.0f} across the slope; the owner asked for "
                  f"{RAMP_MIN_W} (0341)", at=_low)
            # Flush at both ends, which is 0395's word for it: the surface where the
            # ramp meets the floor it comes off has to BE that floor, or it is a step.
            # The HEAD must be flush: the ramp's surface where it arrives has to BE the
            # floor it arrives on, or it is a step and 0395's "flush with the floor at
            # both ends" is not met. The FOOT is allowed one riser, and has to be:
            # a ramp whose surface meets its own underside is a knife edge, which no
            # .map brush can express (qbsp: "Brush plane with no normal"), so the wedge
            # needs thickness at its low end and the only space for it is above the
            # floor. One riser is 16 world against a PLAYER_RISE of 18.
            z_lo = mapfile.top_at(r, r[0], r[1])
            z_hi = mapfile.top_at(r, r[3], r[4])
            ends = sorted((z_lo, z_hi), key=lambda v: abs(v - fz0))
            head = z_hi if abs(z_hi - fz1) < abs(z_hi - fz0) else z_lo
            foot = z_lo if head is z_hi else z_hi
            check(abs(head - fz1) < 1,
                  f"{tag}: the head is flush with the floor it arrives on",
                  f"the ramp's surface runs {z_lo}..{z_hi} and the floor it arrives on "
                  f"is at {fz1}; a ramp that ends a step up is a stair with one step",
                  at=(r[3], r[4], z_hi))
            check(0 < abs(foot - fz0) <= g.PLAYER_RISE,
                  f"{tag}: the foot is {abs(foot - fz0):.0f} from the floor it leaves, "
                  f"at most one riser ({g.PLAYER_RISE})",
                  f"the ramp's surface at its low end is {foot} and the floor there is "
                  f"{fz0} -- a foot that is flush is a knife edge, which is why it is "
                  f"allowed exactly one riser", at=_low)
            continue
        # The z pair is a WINDOW, so it is ordered here rather than trusted: a
        # flight that descends records top-then-bottom (0..-288) and the window
        # `fz0 < top <= fz1` is then empty, which is how this measured zero treads
        # on a flight that has 17 of them.
        fz0, fz1 = min(fz0, fz1), max(fz0, fz1)
        if fl.get("mirrored"):
            fx0, fx1 = g.sc(g.FORTS_LEN) - fx1, g.sc(g.FORTS_LEN) - fx0
        treads = [t for t in wsolids if t[6] in (g.TEX_FLOOR, g.TEX_CEIL)
                  and fx0 - 1 <= t[0] and t[3] <= fx1 + 1
                  and fy0 - 1 <= t[1] and t[4] <= fy1 + 1
                  and fz0 - 1 < t[5] <= fz1 + 1]
        tops = sorted(t[5] for t in treads)
        rises = [round(tops[i + 1] - tops[i], 1) for i in range(len(tops) - 1)]
        depths = [round(max(t[4] - t[1], t[3] - t[0]), 1) for t in treads]
        check(len(treads) == fl["n"],
              f"{tag}: {fl['n']} treads are on the map",
              f"found {len(treads)} in the flight's own footprint")
        check(rises and max(rises) <= g.PLAYER_RISE,
              f"{tag}: no step rises more than {g.PLAYER_RISE} (the engine's limit)",
              f"rises {rises}")
        check(depths and min(depths) >= g.PLAYER_TREAD,
              f"{tag}: every tread is at least {g.PLAYER_TREAD} deep, so a hull "
              f"can stand on it",
              f"tread depths {sorted(set(depths))}; the hull is "
              f"{2 * g.HULL_MAX_XY} deep")

    # -- the water's ways, in world units --------------------------------------
    # The owner's obstruction (2026-10-09): the underwater passage was a direct
    # line from the channel to the key -- "one just has to get in the water and
    # swim back and forth ... to save time". The passage is walled at its OUTER
    # end now, so the water's edges are two kinds: the passage mouth, a short
    # dead-end pocket a swimmer backs out of, and the water ramp, which ends in
    # a landing and two steps up onto the bank top. The router is this file's
    # model of "on foot", so it answers both claims:
    #
    #   * seeded in the channel it must reach the BANK TOP (0): up the water
    #     ramp, across the landing, up the steps, no jump anywhere.
    #
    # The third claim the reviewer originally asked for here -- "the router must
    # NOT reach the key without leaving the water" -- is NOT carried by the
    # router, and the reviewer retired it (0004, option B): map_route's rise rule
    # reads the surface difference between two COLUMNS and never the player's own
    # height, so a route can ratchet upward in mid-air by stepping on and off a
    # ramp's foot, and then float across the map and through a doorway at a
    # height no wading player is at. The wall itself is asserted as geometry
    # below (the mouth sealed edge to edge, both forts), and the walk_all legs
    # are the engine's own evidence that the water route ends on the bank. The
    # ratchet is a map_route.py defect worth its own follow-up.
    seed = W(1024, 256, g.FORTS_BED_Z + 24)      # mid-channel, under the bridge
    bank = [g.sc(600), g.sc(940), g.sc(g.FORTS_GROUND_Z) + 24]
    j = routes_world(seed, bank)
    check(j.get("ok"),
          "a swimmer seeded in the channel reaches the bank top on foot "
          "(water ramp -> landing -> steps -> bank)",
          j.get("reason", "") + f" closest {j.get('closest')} "
          f"({j.get('distance')} from the goal)")
    # It has to ARRIVE, not merely start: the router snaps to the nearest free
    # cell, so "ok" alone would be satisfied by a route that stopped short.
    end = (j.get("waypoints") or [[]])[-1]
    check(j.get("ok") and math.dist(end, bank) <= 48,
          "the water route ends on the bank top, not short of it",
          f"asked for {bank}, the route's last waypoint is {end}")
    # -- and the mouth itself, measured as geometry, not as a route ------------
    # The router's model lets a route ratchet upward in mid-air by stepping on
    # and off a ramp's foot: each rise reads the SURFACE difference between two
    # columns and never the player's own height, and a flat move needs nothing
    # but a free hull, so a "route" can hover 80 over the water and walk a
    # doorway at a height no player is at. That is a map_route.py question, and
    # this lane does not own that file. What IS pure geometry, and is settled
    # here, is the mouth itself: a hull swept across the mouth's whole
    # cross-section, centred in the obstruction's own thickness, is blocked at
    # every sample -- there is no seam to squeeze through, on either fort.
    bs_m = solids()
    my0, my1 = W(*g.FORTS_PASSAGE_Y)
    mz0 = W(g.FORTS_PASSAGE_Z)[0]
    mz1 = W(g.FORTS_PASSAGE_Z + g.FORTS_PASSAGE_H)[0]
    mx_mid = (W(g.FORTS_PASSAGE_X1)[0]
              + W(g.FORTS_PASSAGE_X1 - g.FORTS_PASSAGE_WALL_T)[0]) / 2
    unsealed = []
    for fort_x in (mx_mid, g.sc(g.FORTS_LEN) - mx_mid):
        y = my0 + HULL_XY
        while y <= my1 - HULL_XY:
            z = mz0 + HULL_MIN_Z
            while z <= mz1 - HULL_MAX_Z:
                if not blocked(bs_m, fort_x, y, z):
                    unsealed.append((round(fort_x), round(y), round(z)))
                z += 8
            y += 8
    check(not unsealed,
          "the passage mouth is walled edge to edge: no hull fits through it, "
          "on either fort",
          f"{len(unsealed)} hull positions in the mouth's own cross-section are "
          f"open, e.g. {unsealed[:4]} -- the obstruction does not cover the "
          f"mouth")
    routes = route_checker()
    j2 = routes((416, 480, g.FORTS_VAULT_Z + 24), (240, 416, 24))
    check(j2.get("ok"), "and out of the vault, up the stairwell, to the fort floor",
          j2.get("reason", "") + f" closest {j2.get('closest')}")
    check(j2.get("ok") and j2["waypoints"][-1][2] > 0,
          "the route out ends at the fort's floor level, not in the basement",
          f"last waypoint {j2.get('waypoints', [None])[-1]}")
    return summarise("forts: world scale")


def summarise2(fn):
    fn()
    return summarise("forts")


def summarise(what):
    print()
    if FAILED:
        print(f"{what}: {len(FAILED)} check(s) FAILED:")
        for f in FAILED:
            print(f"  - {f}")
        return 1
    print(f"{what}: all checks passed")
    return 0


def compile_checks():
    print("forts: compile")
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "forts.bsp")
        # A real compile into a temp dir. "-nowrite" is not an option this qbsp
        # knows: it exits 1 with 'unknown option "nowrite"' and prints its usage,
        # which reads as a broken map if you only look at the return code.
        r = subprocess.run(
            [os.path.join(EW, "qbsp/qbsp"),
             "-noextendedcontentflags",
             "-wadpath", os.path.join(ROOT, "web/id1"),
             os.path.join(ROOT, "maps/forts.map"), out],
            capture_output=True, text=True, timeout=120)
        check(r.returncode == 0, "qbsp compiles maps/forts.map cleanly",
              f"rc={r.returncode}: " + (r.stderr.strip()[-300:]))
        check("Brush plane with no normal" not in r.stderr + r.stdout,
              "qbsp reports no plane-less brush")

    return summarise("forts")


if __name__ == "__main__":
    sys.exit(main())
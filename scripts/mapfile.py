#!/usr/bin/env python3
"""Read a .map file: the brushes in it, in world units.

    import mapfile
    for b in mapfile.brushes("maps/forts.map"):
        x0, y0, z0, x1, y1, z1, tex = b

WHY THIS EXISTS
---------------
Everything that needs to know "what is the shape of this map" -- the checks in
tests/test_forts_map.py, the router in scripts/map_route.py -- used to ask
gen_map for it, by calling its geometry functions by name. That is a list of
names kept in step with the generator by hand, and when gen_map started emitting
one more piece of geometry (the stairwell, 4ee9796) nothing said so: every
check went on testing a map that did not exist.

That is not a bug in a test, it is a shape: the test's model of the map was
built separately from the map. The reviewer measured the consequence -- "probe
along the flight: the only tops are the bed and the roof. There are zero treads"
-- while the .map the engine loads had 18 of them, and the checks were reporting
the vault as unescapable.

So there is ONE reader, here, and it reads the file. The file is the map: qbsp
compiles it, the engine loads it, a player walks on it. A check that reads the
file cannot disagree with the map without the disagreement being a real defect.

A brush in a Quake .map is six lines:

    {
    ( x y z ) ( x y z ) ( x y z ) TEXNAME xoff yoff rot xscale yscale
    ...
    }

and it is axis aligned, so its extent is the min and max of every vertex on it.
Coordinates come out in world units, which is what the map is compiled at and
what the hull is measured in -- gen_map's FORTS_SCALE has already been applied by
the time a number reaches this file, and applying it again is how the solids in
these checks came to be doubled once.

RAMPS (0341, 0395)
------------------
The owner's ramps are boxes whose TOP face slopes, so a brush is no longer the min
and max of its vertices: for a ramp that bounding box is the HIGH end, and a reader
that used b[5] as "the surface at this column" would put the whole slope at its top
and call the low end 256 units of solid air. That is not a small correction -- it is
the difference between a slope and a wall, and every reader here has to know which it
is looking at.

So this module, which is the ONE reader in the repo, is also the one place that knows:

    a ramp brush comes back as an EIGHTH field, ("ramp", along, z_low), exactly the
    shape gen_map writes, so a brush read from the file and a brush from the generator
    are the same object and compare equal;

    `top_at(b, x, y)` is the walkable surface's z at a column -- b[5] for a box, the
    PLANE's z for a ramp -- and `inside(b, x, y, z)` asks the same question of a
    volume. Everything that needs "what is the surface here" calls one of those two,
    so there is no second copy of the slope rule to get wrong.

`ramps_in(text)` and the `ramp=` argument are for the checks that want to talk about
slopes on their own (the world-scale flight check measures a ramp's angle).

GENERAL CONVEX BRUSHES (0308)
-----------------------------
The owner's map will be drawn in TrenchBroom, and TrenchBroom does not only make
axis-aligned boxes: a slanted roof, a wedge, a cylinder or a chamfered corner all
arrive as brushes whose faces are general PLANES. Every reader above works from a
brush's min/max corner box, and for those brushes the box is not the shape -- it is a
box AROUND the shape, bigger than the solid by whatever the slant cut away.

That is not a small error. `inside(b, x, y, z)` would report solid air as solid, so
every clearance measurement, hull sweep and flood fill in this repo would come back
"blocked" in places the owner left open, and the report would say a door is 0 wide
where he drew one 128 wide. A check that silently misreads the map is worse than a
check that refuses to: it is the whole reason this module exists.

So the file is read BOTH ways:

    `brushes_in()`  keeps the corner box, because our own maps are boxes and ramps
                    and twenty-odd call sites depend on the 7-tuple;
    `convexes_in()` gives every brush's PLANES, and `convex_contains()` asks whether
                    a point is inside them, which is exact for any convex brush and
                    agrees with the corner box on ours;
    `unmodelled()`  names the brushes that are NEITHER a box NOR a recognised ramp --
                    the ones the corner-box reader cannot model. It returns them with
                    their source line, so a check can fail loudly and point at the
                    brush instead of quietly measuring the wrong shape.
"""

import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def brushes(path=None, tex=None):
    """Every axis-aligned brush in a .map file, as (x0,y0,z0,x1,y1,z1,tex).

    path    the .map to read; defaults to maps/forts.map
    tex     only brushes with this texture name, or all of them

    Rounded to 1 decimal, which is the precision the file is written at, so a
    parsed box and a generated one compare equal.
    """
    if path is None:
        path = os.path.join(ROOT, "maps/forts.map")
    with open(path) as f:
        return brushes_in(f.read(), tex)


def is_ramp(b):
    """Is this brush one of ours -- a box whose top face slopes?"""
    return len(b) > 7 and isinstance(b[7], tuple) and b[7][0] == "ramp"


def top_at(b, x, y):
    """The walkable surface's z at column (x, y). b[5] for a box, the plane for a ramp.

    THE question every reader of this map has to ask, so it is asked here once. A
    reader that used b[5] directly is wrong on a ramp by the whole rise of the slope.
    """
    if not is_ramp(b):
        return b[5]
    _tag, along, z_lo, z_hi = b[7]
    lo, hi = (b[0], b[3]) if along == "x" else (b[1], b[4])
    if hi == lo:
        return z_lo
    t = ((x if along == "x" else y) - lo) / (hi - lo)
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return z_lo + (z_hi - z_lo) * t


def inside(b, x, y, z, eps=0.01):
    """Is the point inside the brush? True for a box AND for a ramp.

    `top_at` rather than b[5], which is the whole point: a ramp's volume is under its
    SLOPE, not under its high corner.
    """
    if not (b[0] - eps < x < b[3] + eps and b[1] - eps < y < b[4] + eps):
        return False
    if z < b[2] - eps:
        return False
    return z < top_at(b, x, y) - eps


def slope(b):
    """(along, rise, run, degrees) for a ramp, or None for a box.

    `degrees` is what the owner's 30 degrees is measured against, and it is measured
    on the EMITTED geometry rather than on the numbers the generator was handed --
    which is the rule every other check in this repo follows.
    """
    if not is_ramp(b):
        return None
    _tag, along, z_lo, z_hi = b[7]
    run = (b[3] - b[0]) if along == "x" else (b[4] - b[1])
    if run <= 0:
        return None
    rise = z_hi - z_lo
    # atan2(rise, run), NOT rise/run * 180/pi. That second one multiplies the SLOPE by
    # 57.3 and calls it degrees, which is only right if the slope were a sine: a 0.5 ramp
    # came out 27.06 when atan(0.5) is 26.57, and the parapet's 0.55 came out 31.5
    # against a limit of 30 -- so the check was refusing a ramp that is inside the
    # owner's rule, on arithmetic rather than on geometry.
    return (along, rise, run,
            abs(math.degrees(math.atan2(abs(rise), run))))


def _planes(text):
    """(planes, texture) per brush -- the two-field form older callers expect."""
    for tri, name, _line in _planes_with_lines(text):
        yield tri, name


def _planes_with_lines(text):
    """(planes, texture, line) per brush: the SIX PLANES, each as its own three points.

    `line` is the 1-based line the brush's opening brace is on, so a caller that has to
    refuse a brush can point at it in the file.

    Grouped by plane, not flattened into one pile of vertices, because "is this brush's
    top face sloped" is a question about a PLANE and not about three corners that
    happen to be in the file. Flattened, a plain box has corners that span a plane with
    a tilted normal -- (512,0,0), (496,0,0), (496,512,128) is one -- and every box in
    the map came back as a ramp.
    """
    pts, tri, name = [], [], None
    for lineno, raw in enumerate(text.splitlines(), 1):
        s = raw.strip()
        if s == "{":
            pts, tri, name = [], [], None
            start = lineno
            continue
        if s == "}":
            if tri:
                yield tri, name, start
            pts, tri, name = [], [], None
            continue
        if not s.startswith("("):
            continue
        line = []
        for grp in re.findall(r"\(([^)]*)\)", s):
            vals = grp.split()
            if len(vals) == 3:
                line.append(tuple(float(v) for v in vals))
        pts.extend(line)
        if len(line) == 3:
            tri.append(tuple(line))
        rest = re.sub(r"\([^)]*\)", "", s).strip()
        if rest and name is None:
            name = rest.split()[0]
    start = 0


def brushes_in(text, tex=None):
    """The same, from the .map's text rather than a file.

    A brush whose top face slopes gets the eighth field ("ramp", along, z_low). It is
    found from the brush's own planes, not from a texture or a name, so a ramp written
    by anything at all reads back as a ramp.
    """
    out = []
    for tri, name in _planes(text):
        pts = [p for t in tri for p in t]
        x0 = round(min(p[0] for p in pts), 1)
        y0 = round(min(p[1] for p in pts), 1)
        z0 = round(min(p[2] for p in pts), 1)
        x1 = round(max(p[0] for p in pts), 1)
        y1 = round(max(p[1] for p in pts), 1)
        z1 = round(max(p[2] for p in pts), 1)
        b = (x0, y0, z0, x1, y1, z1, name)
        sl = _slope_of(tri)
        if sl:
            b = b + (("ramp",) + sl,)
        out.append(b)
    return [b for b in out if tex is None or b[6] == tex]


def _normal(t):
    a, b, c = t
    u = [b[i] - a[i] for i in range(3)]
    v = [c[i] - a[i] for i in range(3)]
    return (u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0])


def _slope_of(tri, eps=1e-6):
    """("x"|"y", z_low) if one of this brush's six planes is a sloping TOP, else None.

    Three things have to be true of that plane, and which of them decides is worth
    writing down because the obvious two do not:

      * its normal is dominated by z (|n.z| > |n.x| + |n.y|), so it is a top or a
        bottom rather than a side -- true of BOTH of those, so it picks neither;
      * it leans (n.x or n.y non-zero), so it is not a box's flat top;
      * **its z at the brush's centre is above the brush's lowest z**, and THAT is what
        makes it the top. The normal's SIGN does not: this repo writes a brush's top
        plane with the opposite winding to its bottom (box_brush's (p0, p2, p1) order),
        so the top's normal points DOWN. A sign test skipped every ramp in the map.

    z_low is the plane's z at the brush's low end along the axis, which is what
    top_at() needs.
    """
    pts = [p for t in tri for p in t]
    z0 = min(p[2] for p in pts)
    cx = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2.0
    cy = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2.0
    for t in tri:
        n = _normal(t)
        if all(abs(c) < eps for c in n):
            continue                                   # degenerate
        if abs(n[2]) <= abs(n[0]) + abs(n[1]):
            continue                                   # a side
        if abs(n[0]) <= eps and abs(n[1]) <= eps:
            continue                                   # flat: a box's top
        a = t[0]
        c = -(n[0] * a[0] + n[1] * a[1] + n[2] * a[2])
        z_here = -(n[0] * cx + n[1] * cy + c) / n[2]
        if z_here <= z0 + eps:
            continue                                   # the bottom face
        along = "x" if abs(n[0]) >= abs(n[1]) else "y"
        lo = min(p[0] for p in pts) if along == "x" else min(p[1] for p in pts)
        hi = max(p[0] for p in pts) if along == "x" else max(p[1] for p in pts)

        def z_at(v):
            return -(n[0] * (v if along == "x" else 0.0)
                    + n[1] * (0.0 if along == "x" else v) + c) / n[2]
        # BOTH ends, in coordinate order, because a mirror in x turns a ramp that rose
        # with x into one that falls with it. One number cannot say which.
        return (along, round(z_at(lo), 1), round(z_at(hi), 1))
    return None

def ramps_in(text, tex=None):
    """Only the brushes whose top face slopes."""
    return [b for b in brushes_in(text, tex) if is_ramp(b)]


# ---------------------------------------------------------------------------
# General convex brushes: the planes are the shape (0308).
# ---------------------------------------------------------------------------

def _plane_of(tri):
    """One face as (nx, ny, nz, d), the half-space  nx*x + ny*y + nz*z <= d.

    Outward normal, so "inside" is every plane satisfied at once. `tri` is three
    points ON the plane and they are read in the order the file writes them, which
    for a .map brush is counter-clockwise seen from outside -- the same convention
    qbsp uses, so a face written by TrenchBroom and a face written by gen_map come
    out with the same normal.
    """
    n = _normal(tri)
    ln = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
    if ln == 0.0:
        return None
    n = (n[0] / ln, n[1] / ln, n[2] / ln)
    p = tri[0]
    d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2]
    return (n[0], n[1], n[2], d)


def _axes(n, eps=1e-6):
    """The world axis this normal points along: 'x', 'y', 'z', or None if slanted."""
    for i, a in enumerate("xyz"):
        if abs(abs(n[i]) - 1.0) <= eps and all(abs(n[j]) <= eps for j in range(3) if j != i):
            return a
    return None


def convexes_in(text, tex=None):
    """Every brush as its planes: (bbox7, planes, line) per brush.

    `planes` is the list of (nx, ny, nz, d) half-spaces from `_plane_of`, and `line`
    is where the brush starts in the file, so a failure can NAME the brush instead of
    describing a shape.
    """
    out = []
    for tri, name, line in _planes_with_lines(text):
        pts = [p for t in tri for p in t]
        b = (round(min(p[0] for p in pts), 1), round(min(p[1] for p in pts), 1),
             round(min(p[2] for p in pts), 1), round(max(p[0] for p in pts), 1),
             round(max(p[1] for p in pts), 1), round(max(p[2] for p in pts), 1), name)
        sl = _slope_of(tri)
        if sl:
            b = b + (("ramp",) + sl,)
        planes = [p for p in (_plane_of(t) for t in tri) if p]
        planes = _outward(planes, pts)
        out.append((b, planes, line))
    return [c for c in out if tex is None or c[0][6] == tex]


def _outward(planes, pts):
    """Point every plane's normal OUT of the brush, using the vertex centroid.

    The .map convention is that a face's three points wind counter-clockwise seen from
    OUTSIDE, so the cross product is the outward normal -- but gen_map's own writer and
    TrenchBroom's do not agree on it, and getting it backwards does not fail loudly:
    `convex_contains` then says a point is outside the brush only when it is INSIDE
    every face, which for a convex brush is nowhere at all, so the brush silently stops
    existing. Measured on forts.map: all six faces of a plain box came out inward.

    So the sign is decided by the brush itself instead of by the file. The centroid of
    a convex brush's vertices is inside it, so any plane whose normal points at the
    centroid is pointing the wrong way and is flipped. This is winding-independent,
    which is the point: it does not care who wrote the brush.
    """
    if not planes or not pts:
        return planes
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    cz = sum(p[2] for p in pts) / len(pts)
    out = []
    for nx, ny, nz, d in planes:
        if nx * cx + ny * cy + nz * cz > d:
            out.append((-nx, -ny, -nz, -d))
        else:
            out.append((nx, ny, nz, d))
    return out


def convex_contains(planes, x, y, z, eps=0.01):
    """Is the point inside these half-spaces? Exact for any CONVEX brush.

    Outward normals, so inside is "every plane satisfied". Degenerate (zero) planes
    are dropped by `_plane_of` rather than treated as "inside", so a brush written
    with a repeated point cannot swallow the whole map.
    """
    for nx, ny, nz, d in planes:
        if nx * x + ny * y + nz * z > d + eps:
            return False
    return True


def _proj_aabb(n, lo, hi):
    """Project an axis-aligned box onto axis n: (min, max)."""
    c = [(lo[i] + hi[i]) / 2.0 for i in range(3)]
    h = [(hi[i] - lo[i]) / 2.0 for i in range(3)]
    mid = sum(n[i] * c[i] for i in range(3))
    rad = sum(abs(n[i]) * h[i] for i in range(3))
    return mid - rad, mid + rad


def _proj_pts(n, pts):
    vs = [sum(n[i] * p[i] for i in range(3)) for p in pts]
    return min(vs), max(vs)


def aabb_hits(planes, pts, lo, hi, eps=1e-6):
    """Does the axis-aligned box lo..hi touch this CONVEX brush? Separating Axis Theorem.

    Exact, for any convex brush, and it is the test the hull needs: a player hull IS an
    axis-aligned box, so "does this brush block the player" is box-versus-convex and not
    box-versus-box. Doing it with the brush's bounding box instead is what makes a
    leaning slab read as solid air (see `unmodelled`).

    The axes are the box's three and every face normal of the brush. For a convex box
    against a convex polyhedron that set is complete, so if no axis separates them they
    overlap -- no sampling, no epsilon fudging.
    """
    if not planes or not pts:
        return False
    # TOUCHING IS FREE, and that is this repo's convention, not a tolerance fudge. The
    # bounding-box reader everywhere here uses STRICT comparisons -- `b[0] < x + HULL_XY
    # and b[5] > z - HULL_MIN_Z` -- so a hull flush against a face is not blocked: a
    # player standing on a floor has his hull's bottom exactly at the floor's top, and
    # the first version of this said he was inside it. Measured: every spawn in the map
    # came back "snapped to a cell which has no free origin", and the on-foot reachability
    # fill found 0 cells of 4109.
    #
    # So separation is `a1 <= b0`, not `a1 < b0 - eps`. The two readers then answer the
    # same question the same way, which is what makes the agreement check meaningful
    # rather than a comparison of two different definitions of "touching".
    for n in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)):
        a0, a1 = _proj_aabb(n, lo, hi)
        b0, b1 = _proj_pts(n, pts)
        if a1 <= b0 + eps or b1 <= a0 + eps:
            return False
    for p in planes:
        n = (p[0], p[1], p[2])
        a0, a1 = _proj_aabb(n, lo, hi)
        b0, b1 = _proj_pts(n, pts)
        if a1 <= b0 + eps or b1 <= a0 + eps:
            return False
    return True


def blocked_hull(shapes, x, y, z, hull_xy, hull_min_z, hull_max_z):
    """Is a player whose ORIGIN is (x, y, z) inside or touching any of these brushes?

    `shapes` is what `shapes_in()` returns: (bbox, planes, verts, line) per brush. This
    is the exact version of the question `blocked()` answers with bounding boxes, and
    it is the one an owner-drawn map needs.

    `hull_min_z` and `hull_max_z` are MAGNITUDES, both positive, and this repo's
    convention throughout: gen_map's HULL_MIN_Z is 24, not -24, and every call site
    writes `z - HULL_MIN_Z` and `z + HULL_MAX_Z`. Taking them signed instead put the
    hull's bottom at z + 24, and the first version of the agreement check below failed
    73 of 2000 origins for that reason alone -- the one test in this repo that would
    have caught it being wrong about it.
    """
    lo = (x - hull_xy, y - hull_xy, z - hull_min_z)
    hi = (x + hull_xy, y + hull_xy, z + hull_max_z)
    for _b, planes, pts, _line in shapes:
        if aabb_hits(planes, pts, lo, hi):
            return True
    return False


def _support_plane(planes):
    """The plane a player would be STANDING on: the topmost upward-facing face.

    nz > 0.05 picks it out of a box's six faces (the top and only the top has an upward
    normal) and out of a ramp's (its slope is the one face with an upward normal, at
    nz = cos(slope)). Ties break on the greatest offset, so a wedge with two leaning
    faces takes the one that is actually higher.
    """
    up = [p for p in planes if p[2] > 0.05]
    if not up:
        return None
    return max(up, key=lambda p: (p[2], p[3]))


def _corners(lo, hi):
    return [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]


def standing_hull(shapes, x, y, z, hull_xy, hull_min_z, hull_max_z, band=1.0):
    """`blocked_hull`, but a player RESTING on a surface is not inside it.

    THE PROBLEM THIS SOLVES. A hull is a box and a ramp is a plane, so a player standing
    on a ramp has a box whose flat bottom intersects the slope it is resting on: the
    surface rises under the uphill half by `2 * hull_xy * rise/run`. A volume overlap test
    reads that as solid, and `blocked_hull` said BLOCKED at the middle of all six flights
    in the map. That is the engine's problem too -- it slides a player along a floor
    rather than demanding the two be disjoint -- and `top_at` is how the rest of this repo
    says so.

    THE RULE. For each brush, work out the surface the player is standing on in THIS
    column. If the hull's bottom is within `band` of that surface, the player is resting
    on it: clip the hull to the halfspace ABOVE the support plane and test that, so the
    part of the hull that dips below the slope it stands on is not counted twice. If the
    hull is not resting on it -- genuinely buried, or clear of it -- the test is the plain
    volume test, because then there is no surface to forgive.

    The clip is convex (a box cut by a plane) so Separating Axis still applies exactly,
    with the support plane added to the axis set.

    `band` is 1 and not 8, measured: at 8 a hull 8 units into the ramp reads as free,
    which is a real penetration being forgiven; at 1 all six flights are walkable AND a
    hull 2 units in still reads blocked, and so does 8 and 20. So 1 forgives float noise
    and nothing else.
    """
    lo = (x - hull_xy, y - hull_xy, z - hull_min_z)
    hi = (x + hull_xy, y + hull_xy, z + hull_max_z)
    corners = _corners(lo, hi)
    for b, planes, pts, _line in shapes:
        # BOUNDING-BOX REJECT FIRST, and this is a speed fix with no accuracy cost.
        # A hull can only be inside a brush whose BOX it overlaps, so when the boxes are
        # disjoint the answer is False and Separating Axis need not run. That is almost
        # every call on a real map -- 155 solids, one hull -- and without it the reachability
        # fill does not finish: it timed out at 900s with the exact reader, because
        # _fall_clear() asks the question every 8 units along every edge of every cell.
        # With the reject, the SAT runs only on near misses, which is where it is needed.
        #
        # It is NOT the bounding-box reader being used as the answer. The reject can only
        # prove NO overlap; every yes still goes to the planes.
        if (b[0] > hi[0] or b[3] < lo[0] or b[1] > hi[1] or b[4] < lo[1]
                or b[2] > hi[2] or b[5] < lo[2]):
            continue
        sp = _support_plane(planes)
        rest = False
        if sp is not None:
            # top_at is the surface in THIS column: the slope's plane for a ramp, and
            # the face itself for a box. The first version of this gated the exemption on
            # `not is_modelled(b)` -- i.e. on the brush NOT being a ramp -- which is
            # backwards: it skipped the exemption for the six brushes in the map that
            # need it and all six flights still read blocked.
            surf = top_at(b, x, y)
            rest = (surf - band) <= (z - hull_min_z) <= (surf + band)
        if rest:
            nx, ny, nz, d = sp
            keep = [c for c in corners if nx * c[0] + ny * c[1] + nz * c[2] >= d - 1e-6]
            if len(keep) < 4:
                continue                      # the whole hull is under the surface
            if _sat(keep, pts, planes + [sp]):
                return True
            continue
        if _sat(corners, pts, planes):
            return True
    return False


def _sat(hull_pts, pts, planes, eps=1e-6):
    """Separating Axis between a convex hull given as POINTS and a convex brush.

    Touching counts as free, which is this repo's convention: every bounding-box
    comparison here is strict, so a hull flush against a face is not blocked.
    """
    for n in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)):
        a0, a1 = _proj_pts(n, hull_pts)
        b0, b1 = _proj_pts(n, pts)
        if a1 <= b0 + eps or b1 <= a0 + eps:
            return False
    for p in planes:
        n = (p[0], p[1], p[2])
        a0, a1 = _proj_pts(n, hull_pts)
        b0, b1 = _proj_pts(n, pts)
        if a1 <= b0 + eps or b1 <= a0 + eps:
            return False
    return True


def shapes_in(text, tex=None):
    """Every brush with everything a containment test needs: (bbox, planes, verts, line).

    `verts` is there for `aabb_hits`: the SAT projections are of the brush's POINTS, and
    a set of half-spaces alone does not give the far side of the brush along an axis that
    is not one of its faces.
    """
    out = []
    for tri, name, line in _planes_with_lines(text):
        pts = [p for t in tri for p in t]
        b = (round(min(p[0] for p in pts), 1), round(min(p[1] for p in pts), 1),
             round(min(p[2] for p in pts), 1), round(max(p[0] for p in pts), 1),
             round(max(p[1] for p in pts), 1), round(max(p[2] for p in pts), 1), name)
        sl = _slope_of(tri)
        if sl:
            b = b + (("ramp",) + sl,)
        out.append((b, _outward([p for p in (_plane_of(t) for t in tri) if p], pts),
                    pts, line))
    return [s for s in out if tex is None or s[0][6] == tex]


def is_modelled(b):
    """Can the corner-box reader model this brush: a box, or one of our ramps?

    A brush is a box when every plane's normal is a world axis. Our ramps also have
    one slanted plane -- the top -- so they are recognised by the eighth field that
    `_slope_of` sets from the planes themselves.
    """
    return len(b) > 7 and isinstance(b[7], tuple) and b[7][0] == "ramp"


def unmodelled(text, tex=None):
    """Brushes the corner-box reader CANNOT model, as (line, bbox, planes).

    These are the ones a check must refuse rather than mis-measure: a slanted wall, a
    wedge, a cylinder. On our own maps this returns nothing, and it is expected to
    return nothing there -- the point is that an owner-drawn map says so HERE, by
    name, instead of every clearance quietly reading the bounding box.
    """
    out = []
    for b, planes, line in convexes_in(text, tex):
        if is_modelled(b):
            continue
        if all(_axes(p[:3]) is not None for p in planes):
            continue                      # every face axis aligned: it IS a box
        out.append((line, b, planes))
    return out


if __name__ == "__main__":
    import sys
    bs = brushes(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"{len(bs)} brushes")
    for b in bs:
        print(" ", b)

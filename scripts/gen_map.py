#!/usr/bin/env python3
"""Emit a Quake .map (ValVe220) for our corridor test map.

The layout matches the corridor described in START-HERE.md and previously built
by the retired custom engine, so the same movement/slide diagnostics apply: a
long straight corridor along +X with one obstruction in the middle.

Coordinate convention is Z-up, floor at z=0, same as the corridor.bsp the old
gen_assets.js produced, so measurements carry over.

ValVe220 brush = 3 planes of 3 points each (9 floats), then
texture name, xshift yshift rotation xscale yscale.

Usage: gen_map.py -o maps/corridor.map
"""

import argparse
import os

# --- layout (must match the old corridor.bsp) ---
LEN = 512          # corridor runs 0..LEN along X
Y0, Y1 = 208, 304  # interior width 96u
H = 96             # ceiling height
T = 16             # wall/floor slab thickness
PX0, PX1 = 248, 264   # pillar X
PY0, PY1 = 248, 264   # pillar Y
PH = 40               # pillar height

# --- duel fixture map (tests only, see duel_map()) ---
# Length chosen so a frag is both unambiguous and reachable in the 10 s the
# test allows. The QW shotgun is hitscan with spread that grows with range, so:
#   - at 384u I could still hit a target facing AWAY, so the negative control
#     (--flip-b) failed for the wrong reason and needed a solid wall;
#   - at 256u that was fixed, but a kill needed 4-5 hits and the test's 10 s
#     budget was marginal -- the run ended with bravo on 76 health.
# 320u puts the spawns 288u apart.
#
# Getting here took three wrong lengths, each measured rather than guessed:
#   384u - the shotgun's range-scaled spread still reached a target facing AWAY,
#          so the negative control failed for the wrong reason.
#   256u - no kills inside the 10 s budget; the run ended with bravo on 76.
#   128u - the players interpenetrated at point-blank, alpha's own gun filled
#          the screen, and again no kill.
# 288u of separation is a clean shooting distance: the target is a distinct
# silhouette, and the shotgun's damage there still takes only a few hits.
DUEL_LEN = 320        # interior length along X
DUEL_W = 128          # interior width, generous so both ends see each other
DUEL_H = 128          # interior height
DUEL_Y0 = (512 - DUEL_W) // 2   # centred on the same Y as the corridor
DUEL_Y1 = DUEL_Y0 + DUEL_W

# textures, packed into web/id1/our.wad by scripts/mkwad.py
# A QuakeWorld player's hull, and the ONE place it is defined.
#
# It is NOT 16 16 24, which is what three separate files in this repo used to
# assume. LibreQuake's own defs.qc:362 says:
#
#     #define VEC_HULL_MAX   '16 16 32'
#
# and client.qc:634 does setsize(self, VEC_HULL_MIN, VEC_HULL_MAX), with MIN
# '-16 -16 -24'. So a player is 32 units ABOVE the origin and 24 below: 56 tall, and
# asymmetric about the origin.
#
# The symmetric +/-24 was inherited from the retired custom engine and it made a
# player 8 units shorter than the real one in every direction, in the flood fills,
# in map_route, and in both map tests. Every one of those was modelling a player who
# can fit places the real player cannot, so a passage called "walkable" might not
# be -- which is exactly how the vault shipped with 48 of clear height and nobody
# could stand in it (0213).
HULL_MIN_XY, HULL_MIN_Z = 16, 24     # how far the hull reaches below/behind
HULL_MAX_XY, HULL_MAX_Z = 16, 32     # and above/ahead
HULL_HEIGHT = HULL_MIN_Z + HULL_MAX_Z  # 56

# The tallest step the engine climbs without a jump: PM_DEFAULTSTEPHEIGHT
# (FTE, engine/qcommon/pmove.h). It lives HERE, with the hull, because two
# readers ask the same question with it and they must never disagree about
# what a step is: map_route.route() bands every RISE in a route with it (a
# rise bigger than this is a wall, not a climb), and test_forts_map's
# corridor check stands its sideways probe on the surface under it (a
# surface within a step of the walker's feet is ground they can walk onto;
# higher than that is a wall).
RISE_MAX = 18

TEX_WALL = "tek_wall4_1"
TEX_FLOOR = "conc1_1"
# The underside of a roof, and the top of the roof you walk on.
#
# This was light_fbr, which is a LIGHT PANEL texture, so standing on the
# battlement meant standing on ceiling lights -- a battlement floor of glowing
# yellow tiles, which is what the reviewer photographed (0154). A light panel
# belongs on a light, not on every horizontal surface in the map, and TEX_FLOOR's
# concrete is already the stone family the rest of the map uses.
TEX_CEIL = "conc1_1"

# A light PANEL: it LOOKS like a ceiling light and, on its own, emits nothing. That
# is the owner's complaint about the first rough pass (0216/0217): "the lighting
# blocks in the ceiling, named lite, and yellow, are not light sources. So far only
# the spawn location has functional ceiling lighting."
#
# The texture is only half of a light. ericw-tools makes a textured surface EMIT
# through a light entity carrying _surface, and one such entity lights every face of
# that texture in the map -- so a panel needs the panel AND an emitter, and a map
# full of panels with no emitter is a map full of decoration that reads as lighting.
# See forts_lights().
TEX_LIGHT = "light_fbr"
TEX_PILLAR = "conc1_1"
# A brush whose texture name starts with "sky" is SKY, not a surface: renderers do
# not light it and do not draw it as a wall, they scroll it to the camera angle.
# A sky brush seals a map exactly as well as a solid one, so it costs nothing in
# leak or vis.
TEX_SKY = "sky5_blu"
# Water is a brush CLASS, not a texture: a brush whose texture name starts with '*'
# becomes a func_* entity (func_water, func_breakable, ...) and its texture is the
# surface you see the water through. qbsp still wants that surface to exist, so it
# needs a real texture -- the same one the floor uses, which is a plausible murky
# blue-grey -- while the CLASS is what makes the brush behave as water.
#
# Getting this wrong is loud rather than silent: qbsp warned
#   WARNING: unable to find texture *water
# and build_maps.sh refuses on that warning, because a missing texture gives a BSP
# with a zero-size surface rather than an error.
# The water's texture name. The leading '*' is what makes it water: qbsp gives a
# brush CONTENTS_WATER from that name, and anything else makes it solid. It is a
# WORLD brush, not an entity -- func_water1 is not a classname LibreQuake's QuakeC
# knows, so an entity of that name is removed at spawn and the channel is empty.
#
# The lump is packed from LibreQuake's star_water1.png, because '*' cannot be in a
# file name; scripts/mkwad.py maps the star_ prefix back to '*'.
TEX_WATER = "*water1"

# For each of the 6 axis directions: outward normal, and the two in-plane axes
# (u, v).  Quake derives the face normal from the winding of the three points,
# and the handedness is NOT cross(u, v) == normal: emitting (p0, p1, p2) that
# way makes every face inward-facing, and qbsp then discards every brush with
# "no visible sides" and reports world extent -inf.  Verified empirically: the
# points must be emitted as (p0, p2, p1) -- i.e. the opposite winding.  With
# that, the corridor compiles to 53 visible faces.
FACES = [
    (( 1, 0, 0), (0, 1, 0), (0, 0, 1)),   # +X
    ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),   # -X
    (( 0, 1, 0), (0, 0, 1), (1, 0, 0)),   # +Y
    (( 0,-1, 0), (1, 0, 0), (0, 0, 1)),   # -Y
    (( 0, 0, 1), (1, 0, 0), (0, 1, 0)),   # +Z
    (( 0, 0,-1), (0, 1, 0), (1, 0, 0)),   # -Z
]


def mirror_brush_one(b, L):
    """One brush reflected about x = L/2. The ONLY place a brush is mirrored.

    A box's x pair is swapped and re-sorted. A RAMP's plane is reflected as well: its two
    ends trade places, so the tuple's top corner and the slope's z_low swap when the slope
    runs along x (0395). Having this in one function is the point -- mirror_half and
    is_symmetric were each doing it separately and disagreed, which is how "a ramp and its
    mirror are not symmetric" happened.
    """
    x0, y0, z0, x1, y1, z1, tex = b[:7]
    a, c = sorted((L - x0, L - x1))
    extra = b[7:]
    if extra and isinstance(extra[0], tuple) and extra[0][0] == "ramp":
        _tag, along, z_lo, z_hi = extra[0]
        if along == "x":
            # The x ends TRADE PLACES, so the two surface heights do too: what rose with
            # x now falls with x. Recording only the high value left fort B's ramp
            # reading back as flat (deg 0.0) and the mirror check could not see it,
            # because the tuple it compared was the ramp's own.
            return (a, y0, z0, c, y1, z1, tex, ("ramp", along, z_hi, z_lo))
        # A slope that runs in y is not touched by a mirror in x at all.
        return (a, y0, z0, c, y1, z1, tex, ("ramp", along, z_lo, z_hi))
    return (a, y0, z0, c, y1, z1, tex) + extra


def ramp_box(x0, y0, z0, x1, y1, z_low, z_high, tex, along="x", scale=1.0):
    """A RAMP as a tuple the guards and the checks can reason about.

    The 7-tuple shape a box uses, with an 8th element: ("ramp", along, z_low). z1 is the
    top at the HIGH end, so it is the box's own top corner and every existing reader of
    b[5] still works; the slope is the extra field.
    """
    if scale != 1.0:
        f = (sc if scale == FORTS_SCALE else (lambda v: round(v * scale, 1)))
        x0, y0, z0, x1, y1, z_low, z_high = (f(v) for v in
                                             (x0, y0, z0, x1, y1, z_low, z_high))
    # BOTH ends, in COORDINATE order -- z_low is the surface at (x0, y0) and z_high the
    # surface at (x1, y1), whether or not that is the lower of the two. Storing only
    # "the low one" is not enough once the map is mirrored: an x-mirror turns a ramp
    # that rose with x into one that FALLS with x, so the same pair of numbers now
    # describes the opposite slope, and a reader that interpolates low-end-first walks
    # fort B's ramp up the wrong way. Both ends, always.
    return (x0, y0, z0, x1, y1, max(z_low, z_high), tex,
            ("ramp", along, z_low, z_high))


def ramp_top(b, x, y):
    """The height of a ramp's surface at (x, y). (0395: a slope's standable surface is
    its plane's z at the cell, not a corner.)"""
    if len(b) < 8 or not (isinstance(b[7], tuple) and b[7][0] == "ramp"):
        return b[5]
    _tag, along, z_lo, z_hi = b[7]
    lo, hi = (b[0], b[3]) if along == "x" else (b[1], b[4])
    t = 0.0 if hi == lo else (x if along == "x" else y) - lo
    t = t / (hi - lo)
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return z_lo + (z_hi - z_lo) * t


def brush_inside(b, x, y, z, eps=0.01):
    """Is the point strictly inside this brush? True for a box AND a ramp."""
    if not (b[0] - eps < x < b[3] + eps and b[1] - eps < y < b[4] + eps):
        return False
    if z < b[2] - eps:
        return False
    return z < ramp_top(b, x, y) - eps


def brushes_overlap(a, b, steps=6):
    """Do two brushes share VOLUME? Not just their bounding boxes.

    A ramp's bounding box is its high end, so two ramps whose slopes cross overlap as
    boxes without sharing a volume -- and reporting that would make the guard refuse
    correct maps, which is how a guard gets switched off. So the bounding boxes are the
    cheap reject and the volume is sampled inside them.
    """
    if not (min(a[3], b[3]) - max(a[0], b[0]) > 0 and
            min(a[4], b[4]) - max(a[1], b[1]) > 0 and
            min(a[5], b[5]) - max(a[2], b[2]) > 0):
        return False
    x0 = max(a[0], b[0]); x1 = min(a[3], b[3])
    y0 = max(a[1], b[1]); y1 = min(a[4], b[4])
    z0 = max(a[2], b[2]); z1 = min(a[5], b[5])
    for i in range(steps + 1):
        x = x0 + (x1 - x0) * i / steps
        for j in range(steps + 1):
            y = y0 + (y1 - y0) * j / steps
            for k in range(steps + 1):
                z = z0 + (z1 - z0) * k / steps
                if brush_inside(a, x, y, z) and brush_inside(b, x, y, z):
                    return True
    return False


def ramp_brush(x0, y0, z0, x1, y1, z_low, z_high, tex, along="x", scale=1.0):
    """Six planes of a RAMP: a box whose top face slopes. (0341, 0395.)

    `along` is which axis the slope runs along; the other two are flat. z_low is the top
    at the low end and z_high the top at the high end, so the walkable surface is

        top(x, y) = z_low + (z_high - z_low) * t,   t = (x - x0)/(x1 - x0)   [along x]

    and everything else about the map goes on reading `b[5]` as "the top at the box's
    corner", which for a ramp is the MAXIMUM of the two ends -- so the checks measure a
    ramp by its plane, not by a corner (0395: "traps' standable surface on a slope is
    the plane's z at the cell"). That is also why the slope field carries BOTH ends and
    not just the lower one: see ramp_box.

    This exists because the owner's ramps cannot be steps: 18 treads of 32 deep with the
    hull exactly 32 wide meant the hull always overlapped the next tread, the stair rule
    and the engine legs disagreed about the same corner pair, and the parapet's foot came
    out a STEP UP off the hall floor. A slope has no treads to miss.

    Returned in the same 7-tuple shape as a box, with the slope appended, so the map
    writer, mirror_half, mapfile and the guards can all be taught about it one field at a
    time instead of all at once.
    """
    if scale != 1.0:
        f = (sc if scale == FORTS_SCALE else (lambda v: round(v * scale, 1)))
        x0, y0, z0, x1, y1, z_low, z_high = (f(v) for v in
                                             (x0, y0, z0, x1, y1, z_low, z_high))
    # FIVE of the six planes are a box's, and they are built by box_brush's OWN loop
    # with one rule on top: every vertex it placed at the box's TOP is a vertex on the
    # slope, so its z becomes the slope's z AT THAT VERTEX.
    #
    # That rule is what makes a ramp whose high end is at its LOW coordinate work --
    # i.e. every ramp on the second half of this map, because a mirror in x turns "rises
    # with x" into "falls with x". Taking the box's z1 as the ramp's high value instead
    # gave that case a zero-height box, and qbsp said so at the first mirrored ramp:
    #   WARNING: maps/forts.map[line 1840]: Brush plane with no normal
    # and then every one of its planes was collinear.
    z_lo, z_hi = z_low, z_high
    z_top = max(z_lo, z_hi)
    # THREE elements, like box_brush's: its loop indexes lo[]/hi[] by axis and reads
    # index 2 for z. With two-element lists the z of every vertex stayed at the
    # initialiser 0.0, so the bottom face came out as three points at z=0 -- collinear,
    # which is qbsp's "Brush plane with no normal", four times per mirrored ramp.
    lo, hi = [x0, y0, z0], [x1, y1, z_top]
    s_ax = 0 if along == "x" else 1        # the axis the slope runs along

    def zsurf(q):
        """The slope's z at a vertex that sits on it."""
        return z_lo if q[s_ax] == (x0 if s_ax == 0 else y0) else z_hi

    out = ["{"]
    for n, u, v in FACES:
        ax = next(k for k in range(3) if n[k])
        # The TOP face's plane is the slope, so its coordinate is the high end. The
        # BOTTOM's is the brush's own z0 -- ax == 2 covers both, and giving the bottom
        # z_top put three points on the plane z = 0 and qbsp said "Brush plane with no
        # normal" for the face that has nothing to do with the slope at all.
        c = z_top if (ax == 2 and n[2] > 0) else (hi[ax] if n[ax] > 0 else lo[ax])
        ua = next(k for k in range(3) if u[k])
        va = next(k for k in range(3) if v[k])
        p0 = [0.0, 0.0, 0.0]
        p0[ax] = c
        p0[ua] = lo[ua] if u[ua] > 0 else hi[ua]
        p0[va] = lo[va] if v[va] > 0 else hi[va]

        def add(axis, sign):
            q = list(p0)
            q[axis] = hi[axis] if sign > 0 else lo[axis]
            return q
        p1 = add(ua, u[ua])
        p2 = add(va, v[va])
        pts = []
        for q in (p0, p2, p1):
            if abs(q[2] - z_top) < 1e-6:
                q[2] = zsurf(q)
            pts.append("( " + " ".join(f"{x:.1f}" for x in q) + " )")
        out.append(" ".join(pts) + f" {tex} 0 0 0 1 1")
    out.append("}")
    return out


def box_brush(x0, y0, z0, x1, y1, z1, tex, xofs=0, yofs=0, scale=1.0):
    """Six outward-facing planes of an axis-aligned box, classic quaked format.

    `scale` is FORTS_SCALE for the forts map and 1 for the others, and it is the
    ONLY place the scale is applied to a brush: the geometry above is authored in
    design units (see FORTS_SCALE), so this is where the map becomes the size the
    owner asked for. The offsets go with it, or the texture would slide.
    """
    xofs *= scale
    yofs *= scale
    if scale != 1.0:
        x0, y0, z0, x1, y1, z1 = (sc(v) if scale == FORTS_SCALE else round(v * scale, 1)
                                  for v in (x0, y0, z0, x1, y1, z1))
    lo = [x0 - xofs, y0 - yofs, z0]
    hi = [x1 - xofs, y1 - yofs, z1]
    out = ["{"]
    for n, u, v in FACES:
        ax = next(k for k in range(3) if n[k])
        # plane coordinate along the normal axis, and the extents of the other two
        c = hi[ax] if n[ax] > 0 else lo[ax]
        ua = next(k for k in range(3) if u[k])
        va = next(k for k in range(3) if v[k])
        # start corner: sweep u and v from their low ends
        p0 = [0.0, 0.0, 0.0]
        p0[ax] = c
        p0[ua] = lo[ua] if u[ua] > 0 else hi[ua]
        p0[va] = lo[va] if v[va] > 0 else hi[va]

        def add(axis, sign):
            q = list(p0)
            q[axis] = hi[axis] if sign > 0 else lo[axis]
            return q

        p1 = add(ua, u[ua])
        p2 = add(va, v[va])
        pts = []
        for q in (p0, p2, p1):
            pts.append("( " + " ".join(f"{x:.1f}" for x in q) + " )")
        out.append(" ".join(pts) + f" {tex} 0 0 0 1 1")
    out.append("}")
    return out


def duel_map(flip_b=False):
    """A bare hall with EXACTLY two deathmatch spawns, facing each other.

    This exists only for tests/mp_combat.js. The corridor has six spawns and
    PutClientInServer picks one at random, so two test clients regularly landed
    on the same spot or facing away from each other and 24 rounds of firing
    produced no hits. Here there are only two spawns, and occupied ones are
    skipped, so two clients always get one each -- and they face down the hall
    at each other, so holding fire is enough to hit.

    `flip_b` puts a solid pillar directly in front of B's spawn and turns B to
    face the wall. That is the negative control for the test: alpha must NOT be
    able to score, which proves the test is measuring a real line of fire rather
    than the mere passage of time.

    Turning the spawn alone is NOT enough, and I tried that first: the QW
    shotgun is hitscan with spread that widens with range, so at 232u I could
    still hit a target facing directly away from me and the control failed for
    the wrong reason. A solid blocker removes the line of fire outright.

    Why there are still only two spawns, given the telefrag the reviewer hit
    (0052): the victim respawns by picking a random UNOCCUPIED deathmatch spot,
    and with exactly two spots the only one free is the spot the killer is
    standing on, so bravo telefrags alpha on respawn. The reviewer's two fixes
    were "add 2 more spawns at each end" or "end the test at the first frag".
    Adding spawns is the wrong fix HERE: PutClientInServer picks at random, so
    both clients could then land at the same end of the hall facing the same
    way and the duel would stop being a duel. So the fixture keeps two spawns
    and mp_combat.js ends at the first frag, which removes the respawn from the
    test entirely. Spawn spacing for real maps is an M4a concern, with its own
    done-when (8 respawns with 2 players, zero telefrags).
    """
    L = []
    L.append("// Generated by scripts/gen_map.py -- duel fixture for tests/mp_combat.js.")
    L.append("// Straight lit hall, no cover, two opposed deathmatch spawns.")
    L.append("// Not a gameplay map; see duel_map() for why it exists.")
    L.append("{")
    L.append('"classname" "worldspawn"')
    L.append('"wad" "our.wad"')
    L.append('"message" "duel - test fixture"')
    # Start everyone with the nailgun and unlimited ammo.
    #
    # Both are worldspawn infokeys honoured by LibreQuake's deathmatch progs
    # (deathmatch_starting_nailgun reads infokey(world, "have_nailgun");
    # deathmatch_unlimited_ammo reads "have_unlimited_ammo"). They matter
    # for a test fixture: the default spawn gives 5 shells of shotgun, so a
    # 10 s fight runs the player dry long before anything dies, and the frag is
    # then decided by ammo pickups rather than by aim. The nailgun is hitscan
    # and hitscan-ammo is unlimited, so the fixture measures exactly one thing.
    L.append('"have_unlimited_ammo" "1"')
    L.append('"have_nailgun" "1"')

    mid_y = DUEL_Y0 + DUEL_W // 2

    # Negative-control variant only: a solid wall across the hall just in front
    # of B's spawn, so there is no line of fire at all. It must go inside the
    # worldspawn brush block -- emitted as its own entity it is not a valid
    # brush entity and qbsp rejects the map with "Line is incomplete".
    if flip_b:
        # Close to B's spawn so the wall is unambiguously between the two
        # players rather than somewhere down the hall.
        L += box_brush(DUEL_LEN - 48, mid_y - 24, 0,
                       DUEL_LEN - 32, mid_y + 24, 96, TEX_PILLAR)

    # floor, ceiling, two side walls, two end caps: a closed box.
    L += box_brush(0, DUEL_Y0 - T, -T, DUEL_LEN, DUEL_Y1 + T, 0, TEX_FLOOR)
    L += box_brush(0, DUEL_Y0 - T, DUEL_H, DUEL_LEN, DUEL_Y1 + T, DUEL_H + T, TEX_CEIL)
    L += box_brush(0, DUEL_Y0 - T, 0, DUEL_LEN, DUEL_Y0, DUEL_H, TEX_WALL)
    L += box_brush(0, DUEL_Y1, 0, DUEL_LEN, DUEL_Y1 + T, DUEL_H, TEX_WALL)
    L += box_brush(DUEL_LEN, DUEL_Y0 - T, 0, DUEL_LEN + T, DUEL_Y1 + T, DUEL_H, TEX_WALL)
    L += box_brush(-T, DUEL_Y0 - T, 0, 0, DUEL_Y1 + T, DUEL_H, TEX_WALL)
    L.append("}")

    # info_player_start as well, so the map is usable if deathmatch is off; the
    # deathmatch spawns below are what the tests rely on.
    L.append("{")
    L.append('"classname" "info_player_start"')
    L.append(f'"origin" "16 {DUEL_Y0 + DUEL_W // 2} 24"')
    L.append('"angle" "0"')
    L.append("}")

    eye = 24          # player eye height above the floor
    b_angle = 90 if flip_b else 180   # 90 = +Y, i.e. facing a side wall

    SPAWNS = [
        # A at the -X end, facing +X (angle 0) down the hall at B.
        (16, mid_y, eye, 0),
        # B at the +X end, facing -X (angle 180) back down the hall at A.
        (DUEL_LEN - 16, mid_y, eye, b_angle),
    ]
    for x, y, z, a in SPAWNS:
        L.append("{")
        L.append('"classname" "info_player_deathmatch"')
        L.append(f'"origin" "{x} {y} {z}"')
        L.append(f'"angle" "{a}"')
        L.append("}")

    # Lights: one per half, so the whole hall is lit and the render check in
    # mp_combat.js has something to see.
    for x in (96, DUEL_LEN - 96):
        L.append("{")
        L.append('"classname" "light"')
        L.append(f'"origin" "{x} {mid_y} {DUEL_H - 24}"')
        L.append('"light" "350"')
        L.append("}")

    return L, f"interior x 0..{DUEL_LEN}, y {DUEL_Y0}..{DUEL_Y1}, z 0..{DUEL_H}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--duel", action="store_true",
                    help="generate the duel test fixture instead of the corridor")
    ap.add_argument("--forts", action="store_true",
                    help="the forts map: two forts, water, a bridge, two "
                         "underwater passages")
    ap.add_argument("--ctf", action="store_true",
                    help="generate the two-base CTF map (M4a)")
    ap.add_argument("--flip-b", action="store_true",
                    help="duel only: turn spawn B to face the wall (negative "
                         "control for tests/mp_combat.js)")
    ap.add_argument("--forts-scale", type=float, default=None,
                    help="forts only: override FORTS_SCALE, the one global size "
                         "knob (default 2.0, which is the size the owner asked "
                         "for: about 4x the floor area). The generated .map records "
                         "the scale it was written at.")
    args = ap.parse_args()

    global FORTS_SCALE
    if args.forts_scale:
        FORTS_SCALE = args.forts_scale

    if args.forts:
        L, desc, solid = forts_map()
        # The overlap guard, at generation time as well as in the test: an
        # overlapping map is not worth writing out, and the reason is that qbsp
        # resolves volume with splits (tests/test_ctf_map.py, maps/SKY-ATTEMPT.md).
        pairs = []
        # SOLID brushes only. The water is in this list because it is a brush, but it
        # is not solid -- qbsp decides that from the texture name, and
        # forts_channel's own note says so -- so solid geometry standing IN the water
        # is not an overlap, it is a pier. The water steps out of the channel (0330)
        # are 68 such pairs and every one of them is correct: a stone stair in a river
        # displaces the river. Comparing water against solids also meant the guard
        # could never be satisfied by anything built in the channel, which is where the
        # owner's "fall off the bridge and have to find a tunnel" was fixed.
        solid_only = [b for b in solid if b[6] != TEX_WATER]
        for i in range(len(solid_only)):
            for j in range(i + 1, len(solid_only)):
                a, b = solid_only[i], solid_only[j]
                if brushes_overlap(a, b):
                    pairs.append((a[:6], b[:6]))
        if pairs:
            raise SystemExit(
                f"FATAL: {len(pairs)} solid brush pairs overlap in volume, e.g. "
                f"{pairs[0][0]} and {pairs[0][1]}. qbsp resolves overlap with "
                f"splits; see maps/SKY-ATTEMPT.md.")
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            f.write("\n".join(L) + "\n")
        print(f"wrote {args.out}: {len(L)} lines, {desc}, 0 overlapping pairs")
        return

    if args.ctf:
        L, desc = ctf_map()
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            f.write("\n".join(L) + "\n")
        print(f"wrote {args.out}: {len(L)} lines, {desc}")
        return

    if args.duel:
        L, desc = duel_map(flip_b=args.flip_b)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            f.write("\n".join(L) + "\n")
        note = "  [spawn B faces the wall: negative control]" if args.flip_b else ""
        print(f"wrote {args.out}: {len(L)} lines, {desc}{note}")
        return

    L = []
    L.append("// Generated by scripts/gen_map.py -- corridor movement test map.")
    L.append("// Straight +X corridor, flat floor, one pillar at the midpoint.")
    L.append('{')
    L.append('"classname" "worldspawn"')
    L.append('"wad" "our.wad"')
    L.append('"message" "corridor - movement test map"')

    # floor slab (below z=0) and ceiling slab (above H), both non-solid visually
    # but present so there is no sky leak
    L += box_brush(0, Y0 - T, -T, LEN, Y1 + T, 0, TEX_FLOOR)
    L += box_brush(0, Y0 - T, H, LEN, Y1 + T, H + T, TEX_CEIL)

    # side walls, outside the playable volume
    L += box_brush(0, Y0 - T, 0, LEN, Y0, H, TEX_WALL)
    L += box_brush(0, Y1, 0, LEN, Y1 + T, H, TEX_WALL)

    # end caps
    L += box_brush(LEN, Y0 - T, 0, LEN + T, Y1 + T, H, TEX_WALL)
    L += box_brush(-T, Y0 - T, 0, 0, Y1 + T, H, TEX_WALL)

    # the single obstruction
    L += box_brush(PX0, PY0, 0, PX1, PY1, PH, TEX_PILLAR)

    L.append("}")
    L.append("{")
    L.append('"classname" "info_player_start"')
    L.append('"origin" "32 256 24"')   # centreline, 216u clear of the pillar
    L.append('"angle" "0"')
    L.append("}")

    # Deathmatch spawns.  PutClientInServer (qcsrc/client.qc) branches on
    # `deathmatch`: when it is set it searches for "info_player_deathmatch"
    # and never falls back to info_player_start, so a map with only
    # info_player_start spawns the player at the world origin and the player
    # ends up outside the level looking at a black screen.
    #
    # Spread along the corridor, clear of the pillar at x 248..264 so nobody
    # spawns inside it.  angle 0 faces +X (down the corridor towards the far
    # end), 180 faces -X, 90 faces +Y, 270 faces -Y.
    #
    # The first two face each other along the corridor's long axis, so a player
    # spawning there sees the whole length of the level rather than a nearby
    # wall.  PutClientInServer picks spots at random, so which one you get
    # varies; the pairs are arranged so the interesting view is common.
    DM_SPAWNS = [
        (48, 240, 24, 0),
        (48, 272, 24, 0),
        (440, 240, 24, 180),
        (440, 272, 24, 180),
        (180, 256, 24, 0),
        (360, 256, 24, 180),
    ]
    for x, y, z, a in DM_SPAWNS:
        L.append("{")
        L.append('"classname" "info_player_deathmatch"')
        L.append(f'"origin" "{x} {y} {z}"')
        L.append(f'"angle" "{a}"')
        L.append("}")

    # Lights.  Without a light entity ericw-tools' `light` writes a zero-byte
    # lightdata lump, and FTE then prints "no valid lightmap offsets in map" and
    # draws the geometry unlit (gl_model.c: lightmapusable check).  classname
    # must start with "light" for light/entities.cc to pick it up.
    # "light" with a "light" value is a plain non-switchable light.
    LIGHTS = [
        # (x, y, z, brightness)
        (96, 256, 72, 300),
        (256, 256, 72, 300),   # just before the pillar
        (416, 256, 72, 300),
    ]
    for x, y, z, b in LIGHTS:
        L.append("{")
        L.append('"classname" "light"')
        L.append(f'"origin" "{x} {y} {z}"')
        L.append(f'"light" "{b}"')
        L.append("}")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        f.write("\n".join(L) + "\n")
    print(f"wrote {args.out}: {len(L)} lines, interior "
          f"x 0..{LEN}, y {Y0}..{Y1}, z 0..{H}")



# ---------------------------------------------------------------------------
# CTF map: two bases, three routes each (M4a)
# ---------------------------------------------------------------------------
# GAME-DESIGN.md "Map 1": our own two-base layout, NOT 2fort's. The shape we must
# avoid is two facing forts joined by a single bridge over a moat, so there is no
# moat and no single bridge here: each base has three separate ways out into a
# shared midfield, which is also what stops one held doorway from being the
# entire defence.
#
# Symmetric by construction: the base is authored once and mirrored. The check is
# real rather than decorative -- ctf_is_symmetric() runs over the box list before
# the map is written and refuses to emit an unbalanced map.
#
# Geometry is collected as plain (x0,y0,z0,x1,y1,z1,texture) tuples and only
# turned into brush text at the end. That is what makes the symmetry check
# possible at all: comparing generated line text would compare formatting.
#
# Axis convention matches the rest of this file: Z up, ground floor z=0, x runs
# base A -> midfield -> base B.
CTF_LEN = 2048          # x from 0 to CTF_LEN
CTF_Y0, CTF_Y1 = 128, 896
CTF_H = 240             # main ceiling height
CTF_UPPER = 112         # upper walkway floor
CTF_TUNNEL_Z = -80      # lower tunnel floor
# The tunnel's ceiling is the underside of the ground floor, at -16. It used to
# be -32, which made the tunnel exactly 48 units tall -- the height of a player,
# so a hull touching the ceiling and the floor at once collides and the route is
# unusable. 64 units gives 16 of clearance.
CTF_TUNNEL_TOP = -16
CTF_MID = CTF_LEN // 2
CTF_MID_Y = (CTF_Y0 + CTF_Y1) // 2

# -- the castle top and the basement key vault (owner's requests, 0086) ---------
#
# The battlements walk along the TOP of the castle walls, at z 176, which is where
# those walls already end. Not above the ceiling: the shell caps the whole map, so
# anything higher would be inside solid rock. A walkway under the roof line is still
# a real elevated position -- it overlooks the courtyard and the approach -- and it
# is the height the geometry already has.
#
# THE ROOF LINE HAS TO CLEAR THE PLAYER, THOUGH, AND 224 DID NOT. This comment used
# to say "under the roof line is fine" and the walkway check proved it was not: with
# the ceiling at 224 and the walk at 176 the clearance was 48, and a hull is 56
# (HULL_MAX_Z - HULL_MIN_Z = 32 - -24). Every one of the walkway's sample points read
# as solid, which is what a player standing there with his head in the roof looks
# like. It is the SAME bug the tunnel above already fixed and this map had already
# learned once: a 48-tall passage is exactly a player's height. CTF_H is 240, so the
# walkway has 64 -- the same clearance CTF_TUNNEL_TOP was given for the same reason.
CTF_WALK_Z = 176          # the battlement walkway floor
CTF_MERLON_H = 32         # merlons rise this far above it

# The basement vault, under the castle's spawn room. It has to be a hole in the
# shell's solid fill as well as in the ground floor, because the fill is what is
# between the ground and the tunnel level (shell_geometry's vertical stack). The
# vault is a separate hole from the tunnel's, so the two passages never meet.
CTF_VAULT = (48, 384, 240, 640)      # x0, y0, x1, y1
CTF_VAULT_Z = -80                    # its floor, level with the tunnel
CTF_VAULT_H = 48                     # headroom: a player is 48 tall, so 64 is
                                     # the minimum that is actually walkable

# Team-tinted textures, written by scripts/mktinted.py and packed into our.wad by
# scripts/build_maps.sh. Same source pixels as the castle brick (LibreQuake,
# notice already in web/licences/), duotoned so a screenshot says which base is
# which. Lights carry the identity too, so it survives in an unlit corner.
TEX_RED = "ctf_red_brick"
TEX_BLUE = "ctf_blue_brick"


def box(x0, y0, z0, x1, y1, z1, tex):
    """One solid box, as data, snapped to whole units.

    The snapping is not cosmetic. Staircase steps divide a span into N parts, so
    their coordinates are fractions, and reflecting a fraction about CTF_LEN is
    not bit-identical in floating point: 2048 - 413.71428571428571 comes back as
    413.7142857142858. That made the symmetry check fail on a map that was in
    fact perfectly mirrored. Whole units mirror exactly, and qbsp only ever
    writes tenths of a unit anyway.
    """
    return (round(x0), round(y0), round(z0), round(x1), round(y1), round(z1), tex)


def slab_with_hole(x0, y0, x1, y1, z0, z1, tex, hole):
    """A slab with one rectangular hole, as up to four boxes.

    The lower tunnel is genuinely below z=0 and .map has no subtraction, so the
    floor is emitted as the rectangles around the tunnel mouth instead.
    """
    hx0, hy0, hx1, hy1 = hole
    assert x0 <= hx0 < hx1 <= x1 and y0 <= hy0 < hy1 <= y1, (hole, (x0, y0, x1, y1))
    out = []
    if hx0 > x0:
        out.append(box(x0, y0, z0, hx0, y1, z1, tex))
    if hx1 < x1:
        out.append(box(hx1, y0, z0, x1, y1, z1, tex))
    if hy0 > y0:
        out.append(box(hx0, y0, z0, hx1, hy0, z1, tex))
    if hy1 < y1:
        out.append(box(hx0, hy1, z0, hx1, y1, z1, tex))
    return out


def stairs(x0, y0, x1, y1, z_from, z_to, steps, tex, flip_x=False, map_len=None,
           along="x", tread=None, world_scale=1.0, name="flight",
           forts_mirrored=False, rest=None):
    """A staircase of boxes, climbing along x or along y.

    A ramp would need non-axis-aligned planes and box_brush only emits axis
    aligned ones; steps are axis aligned, read clearly to a player, and cannot be
    rocket-jumped past a level.

    `flip_x` marches the run the other way, which it must when the run is on a
    mirrored map: a run at the mirrored west end climbs the WRONG way otherwise --
    step i is at z_from + rise*i for both forts, so fort B's steps are at the wrong
    heights for its own position. `map_len` says which map's length to mirror in;
    it used to be CTF_LEN, so the forts' stairs were mirrored in the old map's
    2048 and landed outside their own fort entirely.

    `along` is which axis the treads march along. Climbing along y is what makes
    the forts' flight climbable: a run 64 wide in x over 6 steps gives treads 10.7
    wide and 40 tall, and a player cannot do that -- their hull is 32 wide, so there
    is nowhere to stand, and a 40 step-up is above Quake's ~32. Along y with
    `tread` as the run's depth, each tread is a full 64 deep and the rise is
    (z_to - z_from) / steps.

    `world_scale` is FORTS_SCALE on the forts map, and it is the reason a bigger map
    gets MORE STEPS rather than taller ones: Quake's step-up limit is a fixed
    height, so a flight that grew its rise with the map would stop being climbable
    even though every dimension of it grew. So the step count is recomputed from
    the WORLD rise, capped at PLAYER_RISE, and the design rise follows from it.
    That is also why the run gets longer in world units while the rise does not:
    128 of design rise at 2.0 is 256 of world rise, which needs 15 steps of <= 18
    where the design wanted 8.
    """
    L = CTF_LEN if map_len is None else map_len
    if world_scale != 1.0:
        need = int(-(-(abs(z_to - z_from) * world_scale) // PLAYER_RISE))
        steps = max(steps, need)
    out = []
    rise = (z_to - z_from) / steps
    run = abs(y1 - y0) if along == "y" else abs(x1 - x0)
    if world_scale != 1.0:
        tread_world = run * world_scale / steps
        if tread_world < PLAYER_TREAD:
            print(f"WARNING: the {name} has {steps} steps over {tread_world:.1f} of "
                  f"world tread, under the {PLAYER_TREAD} a hull can stand on. "
                  f"Lengthen the run (see FORTS_SCALE): more steps is the wrong "
                  f"cure, they make the tread shallower.")
        # What this flight IS, in world units, for whoever checks it. The test
        # measures the treads off the emitted geometry rather than believing this,
        # but it cannot find a flight it does not know exists -- so the map has to
        # say which flights it built.
        FORTS_FLIGHTS.append({
            "name": name,
            "n": steps,
            "tread": tread_world,
            "rise": abs(rise) * world_scale,
            # the treads' own plan footprint, so a checker can look at THIS flight
            "box": (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1),
                    z_from, z_to),
            "tread_axis": along,
            # Said by the caller, not guessed from map_len: CTF_LEN and FORTS_LEN
            # are both 2048, so "is this the other length" cannot tell the two forts
            # apart -- which is how both of them first claimed to be fort A.
            "mirrored": forts_mirrored,
        })
    for i in range(steps):
        top = z_to if i == steps - 1 else z_from + rise * (i + 1)
        # Each step rests on the one below, 16 below its own top. `rest` overrides
        # that with a single height EVERY tread starts from, which is what a flight
        # climbing out of a floor needs: with the default, the flight's bottom tread
        # is a slab 16 thick hanging above the floor, and the first STEP onto it is
        # its own thickness plus a whole rise -- 32 world units at FORTS_SCALE 2.0,
        # over the 18 a player walks up. So the parapet flight was a staircase you
        # could look at and not climb, and tests/test_forts_map.py's no-traps fill
        # found the whole battlement unreachable because of it.
        base = z_from + rise * i - 16 if rest is None else rest
        if along == "x":
            span = x1 - x0
            step = span / steps
            a0 = x0 + step * i
            a1 = x1 if i == steps - 1 else x0 + step * (i + 1)
            if flip_x:
                a0, a1 = L - a1, L - a0
            out.append(box(a0, y0, base, a1, y1, top, tex))
        else:
            span = y1 - y0
            step = span / steps
            b0 = y0 + step * i
            b1 = y1 if i == steps - 1 else y0 + step * (i + 1)
            out.append(box(x0, b0, base, x1, b1, top, tex))
    return [b for b in out if b[0] < b[3] and b[1] < b[4] and b[2] < b[5]]

def walls(x0, y0, z0, x1, y1, z1, tex, gaps=(), skip=()):
    """A hollow room: four perimeter walls, minus the openings in `gaps`.

    My first pass emitted each room as a single SOLID box, which filled the space
    the player is supposed to stand in. qbsp noticed: it reported "No entities in
    empty space -- no filling performed", because there was no empty space. A room
    is the negative space between walls, so it has to be built out of walls.

    `skip` names sides to leave out, for walls that sit flush against the outer
    shell. Emitting them anyway produced boxes exactly on top of the shell's own
    walls: overlapping solid brushes, which sent the BSP to 119136 nodes from 116
    brushes and left qbsp with 3 portals and no .prt for vis to read.

    `gaps` is a list of (side, a0, a1, gz0, gz1), where side is one of
    "x0", "x1", "y0", "y1" naming the plane the opening is in, a0/a1 run along
    that plane's free axis and gz0/gz1 are the opening's height. Openings are
    subtracted by splitting the wall into strips, which is all the layout here
    needs: they never overlap on one side.
    """
    T = 16
    out = []

    def side_wall(plane, fixed, a0, a1, za, zb, side):
        # Split the free axis around every opening on this side, then for each
        # strip emit the z ranges that no opening covers.
        cuts = {a0, a1}
        openings = []
        for sd, ga0, ga1, gz0, gz1 in gaps:
            if sd != side:
                continue
            ga0, ga1 = max(a0, ga0), min(a1, ga1)
            if ga0 >= ga1:
                continue
            openings.append((ga0, ga1, gz0, gz1))
            cuts.add(ga0)
            cuts.add(ga1)
        edges = sorted(cuts)
        for i in range(len(edges) - 1):
            s0, s1 = edges[i], edges[i + 1]
            mid = (s0 + s1) / 2
            covered = [(gz0, gz1) for ga0, ga1, gz0, gz1 in openings
                       if ga0 < mid < ga1]
            zedges = {za, zb}
            for gz0, gz1 in covered:
                zedges.add(max(za, gz0))
                zedges.add(min(zb, gz1))
            zl = sorted(zedges)
            for k in range(len(zl) - 1):
                c0, c1 = zl[k], zl[k + 1]
                cmid = (c0 + c1) / 2
                if any(gz0 <= cmid <= gz1 for gz0, gz1 in covered):
                    continue
                if c1 - c0 <= 0:
                    continue
                if plane == "x":
                    out.append(box(fixed - T if fixed == x0 else fixed,
                                   s0, c0, fixed if fixed == x0 else fixed + T,
                                   s1, c1, tex))
                else:
                    out.append(box(s0, fixed - T if fixed == y0 else fixed, c0,
                                   s1, fixed if fixed == y0 else fixed + T,
                                   c1, tex))

    for side, plane, fixed, a0, a1 in (("x0", "x", x0, y0, y1),
                                       ("x1", "x", x1, y0, y1),
                                       ("y0", "y", y0, x0, x1),
                                       ("y1", "y", y1, x0, x1)):
        if side in skip:
            continue
        side_wall(plane, fixed, a0, a1, z0, z1, side)
    return out


def base_geometry():
    """Base A's geometry, authored for x < CTF_MID. Mirrored by mirror_boxes.

    Built from walls and platforms, not solid blocks: the space the player walks
    through is the empty space between them. Solid pieces here are only the
    things that are genuinely solid -- the upper walkway, its railing, the
    overlook, the stairs and the tunnel floor.
    """
    B = []
    my = CTF_MID_Y

    # -- spawn room: deep in the base, behind the team door ------------------
    # Walls on three sides; the fourth (facing the courtyard) has the doorway.
    #
    # The door is 192 wide (my-96 .. my+96) and the spawns sit on my-64 / my /
    # my+64, because of what the narrower version did. The door used to be
    # my-48 .. my+48, i.e. 96 wide, and the spawns were at my-96 / my-32 /
    # my+32. A player's hull is 16 units either side of its origin, so:
    #
    #   spawn my-96 -> hull my-112..my-80, entirely OUTSIDE the door
    #   spawn my-32 -> hull my-48..my-16, flush against the near jamb
    #   spawn my+32 -> hull my+16..my+48, flush against the far jamb
    #
    # Measured on the server through qwtf/probe.qc: a player at the my-32 spawn
    # ran 112 units in the first second and then stopped dead at 32 units, held
    # against the door's near face for the rest of the run, and my-96 never moved
    # at all. A hull exactly touching a jamb collides. A player would walk around
    # it; a scripted run cannot, and neither should have to.
    B += walls(16, my - 128, 0, 176, my + 128, 144, TEX_RED,
               gaps=[("x1", my - 96, my + 96, 0, 112)],   # the team door
               skip=("x0",))                               # shell has this wall

    # -- flag room: the far corner from midfield, so a defender has depth ----
    #
    # Its door used to be declared as gaps=[("x1", 288, 336, 0, 112)]. The y
    # range 288..336 lies OUTSIDE this room's own y range, which is
    # CTF_Y0..288 = 128..288, and walls() clamps an opening to the side it is
    # named on and then throws it away if nothing is left:
    #
    #     ga0, ga1 = max(a0, ga0), min(a1, ga1)
    #     if ga0 >= ga1: continue
    #
    # So the opening was silently discarded and the room's x1 face came out as
    # ONE solid box, measured: (240, 128, 0, 256, 288, 176). No error, no
    # warning -- just no door where the map said there was one.
    #
    # The room was still enterable, because it has no ceiling (its walls stop at
    # z=176 and the map's ceiling is at 224) and because x0 was skipped: with
    # nothing at x 32..48 the room opened into a 32-wide slot along the map edge
    # that runs south to the spawn room's outer wall. So the key was reachable
    # by walking on top of the walls and dropping in, which is not a route anyone
    # would choose and not one the map intends.
    #
    # Now: the door is at y 208..272, inside the room's own y range, 64 wide so a
    # 32-wide hull has 16 units of clearance either side, onto the courtyard. And
    # x0 is no longer skipped, because the shell has no wall at x=48 -- verified,
    # the slot had nothing in it -- so the room is a proper room with one door
    # instead of a room with a missing door and an accidental one. The x1 face is
    # now split into (240,128,0,256,208,176), a lintel (240,208,112,256,272,176)
    # and (240,272,0,256,288,176): the doorway is real.
    B += walls(48, CTF_Y0, 0, 240, 288, 176, TEX_RED,
               gaps=[("x1", 208, 272, 0, 112)],   # its only door, to the courtyard
               skip=("y0",))                      # the shell does have this one

    # -- the wall between the base and midfield, with exactly three openings ---
    #
    # This is what makes "three routes" structural rather than decorative: the
    # openings are the only ways out of the base, and a test can count them.
    #   1. main hall   ground level, wide, the obvious way
    #   2. walkway     the upper route, at CTF_UPPER
    #   3. tunnel      the lower route, at CTF_TUNNEL_Z, through the lower
    #                  section of the same wall (below the ground floor)
    # The gaps are listed on BOTH faces. walls() builds a closed box, so a gap on
    # one face alone leaves a 16-unit dead-end pocket between them: I could walk
    # into the gap and hit the far wall, which is why qbsp reported the pickups
    # beyond it as unreachable occupants.
    # The main hall opening is my-96..my+96, the same span as the team door, for
    # the reason the spawn room's door is: a hull is 16 either side of its
    # origin, so an opening that lines up exactly with a spawn row puts half the
    # hull in the wall. Measured with the server-side probe: a player spawned on
    # the my-64 row ran 240 units east and stopped dead at x=368, against the
    # dividing wall, with its hull straddling the old gap's lower edge at y=448.
    # Only the two openings this wall can actually host. The tunnel's belongs to
    # the lower section of the same dividing wall, below the ground floor; see
    # the note there.
    route_gaps = [("x0", my - 128, my + 128, 0, CTF_H),             # main hall
                  ("x0", 288, 352, CTF_UPPER, CTF_UPPER + 120)]     # upper walkway
    route_gaps += [("x1", a0, a1, gz0, gz1) for _s, a0, a1, gz0, gz1 in route_gaps]
    B += walls(400, CTF_Y0, 0, 416, CTF_Y1, CTF_H, TEX_RED, gaps=route_gaps,
               skip=("y0", "y1"))   # it spans the map, so the shell's side walls are these

    # The same dividing wall again, BELOW the ground floor, with the tunnel's
    # passage through it.
    #
    # This is a second instance of the bug the tunnel already had, and the same
    # silent one: the wall above spans z 0..CTF_H, but the tunnel opening is
    # declared at z CTF_TUNNEL_Z..-16, i.e. entirely below it. walls() clamps an
    # opening to the wall it is cut into and discards what is left, so this
    # opening was thrown away and the tunnel ran into solid rock at the halfway
    # line. Found by tests/test_ctf_map.py, which asks each declared opening
    # whether it overlaps the wall it is cut into:
    #
    #   walls(400,128,0,416,896,224) declares a x0 opening at z -80..-16, which
    #   does not overlap the wall's z 0..224
    #
    # It is a separate box rather than one taller wall so it does not overlap the
    # ground-floor slab at z -16..0, which the shell already builds. -16 is that
    # slab's underside: the tunnel's ceiling.
    tunnel_gap = [("x0", 704, 752, CTF_TUNNEL_Z, CTF_TUNNEL_TOP),
                  ("x1", 704, 752, CTF_TUNNEL_Z, CTF_TUNNEL_TOP)]
    B += walls(400, CTF_Y0, CTF_TUNNEL_Z, 416, CTF_Y1, CTF_TUNNEL_TOP, TEX_RED,
               gaps=tunnel_gap, skip=("y0", "y1"))

    # -- route 2: upper walkway along the low-y wall ------------------------
    B.append(box(256, 288, CTF_UPPER - 16, 768, 352, CTF_UPPER, TEX_FLOOR))
    B += stairs(400, 288, 496, 352, 0, CTF_UPPER, 7, TEX_FLOOR)
    B.append(box(256, 288, CTF_UPPER, 768, 296, CTF_UPPER + 24, TEX_RED))  # railing

    # -- route 3: narrow lower tunnel along the high-y wall -----------------
    # No floor slab here: shell_geometry() already builds one under each tunnel
    # mouth, and a second copy was an exactly duplicated brush.
    #
    # The stairs DESCEND from the courtyard at the tunnel's near end. They used to
    # sit mid-tunnel climbing back up, which meant the entrance was a hole you
    # fell into and the far end of the tunnel had no way out at all.
    B += stairs(256, 704, 368, 752, 0, CTF_TUNNEL_Z, 6, TEX_FLOOR)
    # And stairs back UP at the midfield end, so the tunnel is a route between the
    # base and midfield rather than a hole with a passage in it.
    B += stairs(CTF_TUNNEL_EXIT - 64, 704, CTF_TUNNEL_EXIT, 752,
                CTF_TUNNEL_Z, 0, 6, TEX_FLOOR)

    # -- defensive high point overlooking the main entrance -----------------
    B.append(box(352, 352, 144, 432, 416, 160, TEX_FLOOR))
    B += stairs(432, 352, 496, 416, 96, 160, 4, TEX_FLOOR)

    B += battlement_geometry()

    return B


def battlement_geometry():
    """The castle top: a walkway, merlons to shoot through, and two lookouts.

    The owner's request (0086, GAME-DESIGN.md): "each castle has a walkable
    battlement walk around its top. It has crenellations (merlons and gaps) to
    shoot through and duck behind, and lookout spots at the wall's turns."

    The walkway sits on the walls the base already has, at z=CTF_WALK_Z, which is
    where those walls end. Under the roof, because the shell caps the map at
    CTF_H=224 and anything taller would be inside solid rock.

    Width: the walkway is 48 deep (two players abreast with room to shoot over a
    merlon), centred on the wall it follows. Merlons are CTF_MERLON_H tall with
    gaps between them, so a defender can shoot through the gaps and duck behind
    them -- which is the whole point of a crenellation and is why they are
    modelled rather than painted.

    The lookouts are at the wall's TURNS, which for this castle are the two
    corners facing midfield: one over the main hall's outer corner, one over the
    tunnel mouth's. They are wider, raised a step, and open on three sides.
    """
    B = []
    z = CTF_WALK_Z
    merlon = CTF_MERLON_H

    def run(x0, y0, x1, y1, along_x, merlon_period=64, merlon_len=32):
        """A walkway rectangle with merlons along its outer edge."""
        B.append(box(x0, y0, z - 16, x1, y1, z, TEX_FLOOR))
        # The outer edge is whichever side faces away from the castle.
        if along_x:
            edge = y1 if y1 > (CTF_Y0 + CTF_Y1) / 2 else y0
            a0, a1 = x0, x1
        else:
            edge = x1
            a0, a1 = y0, y1
        span = a1 - a0
        n = max(1, int(span // merlon_period))
        step = span // n
        for i in range(n):
            a = a0 + i * step
            if along_x:
                B.append(box(a, edge, z, a + merlon_len, edge + 16, z + merlon, TEX_WALL))
            else:
                B.append(box(edge, a, z, edge + 16, a + merlon_len, z + merlon, TEX_WALL))

    # The three walls the castle has, each with a walk along its top. The fourth
    # (x0, against the map edge) has no wall of its own, so there is nothing to
    # walk on there.
    #
    # Each run is 64 deep, not 48, and that is arithmetic rather than taste: the
    # merlons take 16 of it, and a player is 32 wide, so a 48-deep run left
    # exactly 32 of clear floor and a hull that fitted to the unit. Two players
    # cannot pass, and neither can one turn round. 64 leaves 48 of clear floor.
    run(16, 368, 192, 432, along_x=True)      # the low-y wall
    run(16, 608, 192, 672, along_x=True)      # the high-y wall
    run(160, 368, 224, 672, along_x=False)    # the wall facing the courtyard

    # Lookout at the courtyard corner by the main hall, and at the tunnel corner.
    # Wider than the walkway, one step up, and merloned on the two outside faces
    # only, so a defender there can watch the approach, midfield and the far
    # castle's own battlements.
    for (lx0, ly0, lx1, ly1) in ((160, 368, 256, 464), (160, 576, 256, 672)):
        B.append(box(lx0, ly0, z - 16, lx1, ly1, z, TEX_FLOOR))
        B.append(box(lx0, ly0, z, lx1, ly1, z + 16, TEX_FLOOR))     # the step up
        B.append(box(lx0, ly0, z + 16, lx1, ly0 + 16, z + 16 + merlon, TEX_WALL))
        B.append(box(lx0, ly1 - 16, z + 16, lx1, ly1, z + 16 + merlon, TEX_WALL))
        B.append(box(lx0, ly0, z + 16, lx0 + 16, ly1, z + 16 + merlon, TEX_WALL))

    # Stairs up from inside the castle, in the spawn room, arriving at the
    # courtyard wall walkway.
    #
    # They run along x INSIDE the spawn room (y 384..448), not along the wall they
    # serve. The first attempt put them at y 368..416, which is the low-y walkway
    # own footprint, so the staircase filled the walkway it was meant to reach:
    # test_ctf_map found 6 of 19 sample points solid at z=184, inside the steps.
    #
    # One run, not two. A second staircase on the courtyard side would be a second
    # way onto our own roof, and the point of a battlement is that the team that
    # owns it is the only team that reaches it easily.
    #
    # The spawn room is now free of spawns (see base_entities), so the staircase
    # can use its whole width: y 384..448, which reaches the courtyard wall's
    # walkway at x 176..224.
    B += stairs(16, 384, 176, 448, 0, z, 11, TEX_FLOOR)

    return B


def vault_geometry():
    """The basement key vault -- WRITTEN BUT NOT IN THE MAP.

    NOT CALLED. Do not wire it in until its stair is proven walkable from the
    courtyard floor, because the failure mode is a pit.

    Concretely: the vault has to be a hole in the shell ground floor AND in the
    solid fill beneath it (the vertical stack in shell_geometry), and a hole wide
    enough for a 32-unit hull is one a player walks into sideways. The lower
    tunnel had exactly that bug and it was found by driving the map, not by
    reading it: the run ended at z=-3, below the floor. The tunnel's fix was to
    make the hole the length of a walkable run with stairs at both ends. The vault
    needs the same treatment, and that is the next piece of map work rather than
    something to ship on a maybe.

    The basement key vault, under the castle, and its two ways in.

    The owner's request (0086): "each team's key sits in a vault in its castle's
    basement. Reach it by a stair/ramp down from inside the castle. The vault
    itself has one main way in plus one narrower one, so it can be defended but
    not sealed."

    The vault floor is CTF_VAULT_Z, the same level as the lower tunnel, and it is
    a SEPARATE hole in the shell's fill from the tunnel's, so the two passages
    never meet -- a key vault that connects to the tunnel route would be a
    back door into the base.

    Both ways in come down from inside the castle:
      * the main stair, in the open, against the spawn room's wall
      * a narrower ramp, behind it, which is what makes the vault defensible
        rather than sealable: a defender can hold the main stair, but a player who
        knows the ramp can still get in.
    """
    B = []
    vx0, vy0, vx1, vy1 = CTF_VAULT
    z = CTF_VAULT_Z

    # The vault room: floor, ceiling and four walls, with the two openings. Built
    # with walls() so the openings are real holes rather than a missing wall.
    B += walls(vx0 - 16, vy0 - 16, z, vx1 + 16, vy1 + 16, z + CTF_VAULT_H, TEX_WALL,
               gaps=[("y0", vx0 + 32, vx0 + 128, z, z + CTF_VAULT_H),   # the main stair
                     ("x0", vy0 + 96, vy0 + 144, z, z + CTF_VAULT_H)], # the narrow ramp
               skip=())
    # Floor and ceiling, so the vault is a room and not a hole in the world.
    B.append(box(vx0 - 16, vy0 - 16, z - 16, vx1 + 16, vy1 + 16, z, TEX_FLOOR))
    B.append(box(vx0 - 16, vy0 - 16, z + CTF_VAULT_H, vx1 + 16, vy1 + 16,
                 z + CTF_VAULT_H + 16, TEX_CEIL))

    # A pedestal for the key, so it is not lying in the middle of the floor.
    B.append(box(vx0 + 64, vy0 + 224, z, vx0 + 112, vy0 + 272, z + 24, TEX_FLOOR))

    return B


def mirror_boxes(boxes, tex_from, tex_to):
    """Reflect across the map's mid-x, swapping the team's wall texture."""
    out = []
    for x0, y0, z0, x1, y1, z1, tex in boxes:
        out.append((CTF_LEN - x1, y0, z0, CTF_LEN - x0, y1, z1,
                    tex_to if tex == tex_from else tex))
    return out


def base_entities(mirrored):
    """Spawns, the flag, route pickups and a team light, as entity key lines."""
    def X(v):
        return CTF_LEN - v if mirrored else v

    E = []
    my = CTF_MID_Y
    angle = "180" if mirrored else "0"

    # Six deathmatch spawns, per M4a's done-when (4-6 per team). Two players
    # landing on one point is what made the duel fixture telefrag.
    #
    # In the COURTYARD, not the spawn room, and that is arithmetic plus a bug.
    # The battlement staircase has to climb 176 units from the ground floor to the
    # castle top, and the only ground floor under the walkway is the spawn room. A
    # staircase 64 wide needs a 64-unit strip of that room's 256-unit width -- and
    # the six spawns were at y 448, 512 and 576 with 32-wide hulls, so every strip
    # either 64 wide or between two spawns was either too narrow or on a spawn.
    # test_ctf_map caught it twice:
    #   stuck spawns: [(48.0, 448.0, 24.0)]   then   [(48.0, 576.0, 24.0)]
    #
    # Spawning in the courtyard instead fixes that and a second problem: the
    # flag-to-flag run could not leave the spawn room, because its route aims at
    # the flag room's door and the spawn room's own door is on the FAR side of the
    # room, so the player walked into the back wall. From the courtyard a player is
    # already on the route, and the team door is a door rather than a wall.
    #
    # x 272 and 336 are clear of the walkway above (y 288..352), the defensive high
    # point (x 352..432) and the tunnel stairs (y 704..752).
    for i, (dx, dy) in enumerate([(272, -96), (272, 0), (272, 96),
                                  (336, -96), (336, 0), (336, 96)]):
        E.append(["info_player_deathmatch",
                  f'"origin" "{X(dx)} {my + dy} 24"',
                  f'"angle" "{angle}"',
                  f'"targetname" "spawn_{i}"'])

    # The key. Our own entity, not an id/Valve one: M4b implements carry, drop
    # and capture. This is the home position only.
    #
    # It stays in the flag room for now. The owner asked for a basement key vault
    # (0086) and vault_geometry() below is written, but a vault under the castle
    # needs a hole in the shell ground floor with a stair down into it, and a hole
    # wide enough for a 32-wide hull is a pit a player walks into sideways -- the
    # same trap the lower tunnel had. Shipping the battlements first and leaving
    # the key provably reachable beats shipping an unreachable objective.
    # GAME-DESIGN.md now says "flag" means "key"; the position moves with the
    # vault.
    E.append(["info_ctf_flag",
              f'"origin" "{X(144)} {CTF_Y0 + 80} 40"',
              '"targetname" "flag"'])

    # Health and armour on the routes, never in the flag room.
    # On the centre line of each route: qbsp refused to fill hulls around the two
    # pickups that sat off it (32u off the wall), reporting them as unreachable
    # occupants even though the geometry there was open.
    for cls, ox, oy, oz in [("item_health", 300, my, 24),
                            ("item_armor2", 560, my, 24),
                            ("item_health", 480, 320, CTF_UPPER + 24),
                            ("item_health", 600, 728, CTF_TUNNEL_Z + 24),
                            # 368, not 384: x=384 is the dividing wall's own
                            # face, so the armour was embedded in it.
                            ("item_armor1", 368, 384, 184)]:
        E.append([cls, f'"origin" "{X(ox)} {oy} {oz}"'])

    colour = "90 140 255" if mirrored else "255 90 80"
    E.append(["light", f'"origin" "{X(120)} {my} 120"', f'"light" "{colour}"'])

    return E


def midfield_geometry():
    """Shared middle: open ground, cover, and one rise worth jumping to."""
    B = []
    my = CTF_MID_Y

    # The vertical feature. Steps on BOTH sides so it can be taken from either
    # base, not just the one that happens to face the ramp.
    B.append(box(CTF_MID - 64, my - 128, 0, CTF_MID + 64, my + 128, 96, TEX_PILLAR))
    B += stairs(CTF_MID - 192, my - 48, CTF_MID - 64, my + 48, 0, 96, 6, TEX_FLOOR)
    # No flip on this one: midfield is SHARED, not mirrored. Flipping it dropped
    # the right-hand ramp exactly on top of the left one (832..960), which left
    # overlapping brushes and a light buried inside solid geometry.
    B += stairs(CTF_MID + 64, my - 48, CTF_MID + 192, my + 48, 0, 96, 6, TEX_FLOOR)

    # Cover, off the straight line between the two main halls, so crossing
    # midfield is never a single straight sprint.
    for cx, cy, cw, cd, ch in [(860, 300, 64, 64, 72), (860, 600, 64, 64, 72),
                               (1124, 300, 64, 64, 72), (1124, 600, 64, 64, 64),
                               (CTF_MID, 240, 96, 48, 80)]:
        B.append(box(cx, cy, 0, cx + cw, cy + cd, ch, TEX_PILLAR))
    return B


def bands_with_holes(x0, y0, x1, y1, z0, z1, tex, holes):
    """A slab spanning a rectangle, with rectangular holes left open.

    Bands along x, each split around the holes it contains. Quake has no
    subtraction, so a hole has to be expressed as the rectangles beside it.
    """
    out = []
    edges = [x0]
    for hx0, _hy0, hx1, _hy1 in holes:
        edges += [max(x0, hx0), min(x1, hx1)]
    edges.append(x1)
    edges = sorted(set(edges))
    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        if b - a <= 0:
            continue
        inner = [h for h in holes if max(x0, h[0]) <= a and b <= min(x1, h[2])]
        if not inner:
            out.append(box(a, y0, z0, b, y1, z1, tex))
            continue
        # Holes in one band share a y range here, so one split does it.
        hy0 = min(h[1] for h in inner)
        hy1 = max(h[3] for h in inner)
        out.append(box(a, y0, z0, b, hy0, z1, tex))
        out.append(box(a, hy1, z0, b, y1, z1, tex))
    return out


# The lower tunnel's footprint in x: from the stairs down at the courtyard end,
# under the dividing wall, to the stairs up at the midfield end.
#
# It used to be 256..768, which is a trap and not a route. The floor hole ran the
# whole length of the tunnel, so a player walking over the courtyard dropped into
# a passage with no way out except back to the stairs they had walked past --
# measured through the probe: the run ended at (1757, 736, -3), i.e. fallen into
# the tunnel and stuck. And the passage never reached midfield: 768 is still on
# this side of the halfway line at 1024, so it crossed the dividing wall and then
# dead-ended.
#
# Now it runs 256..CTF_TUNNEL_EXIT, so the tunnel goes from the base, under the
# halfway line, and back up into midfield. That is what makes it the third route
# rather than a pit.
CTF_TUNNEL_EXIT = 896


def tunnel_holes():
    """The two lower tunnels' footprints in the ground floor, as (x0,y0,x1,y1).

    These are the holes cut in the ground floor and in the solid fill beneath it,
    so they must cover the whole run INCLUDING both staircases -- otherwise the
    stairs have no floor to stand on.
    """
    return [(256, 704, CTF_TUNNEL_EXIT, 752),
            (CTF_LEN - CTF_TUNNEL_EXIT, 704, CTF_LEN - 256, 752)]


def shell_geometry():
    """Outer walls, ceiling, and the ground floor with both tunnel mouths cut.

    The vertical stack, because the tunnels are the fiddly part:

        z  224..240   ceiling
        z  -16..0     ground floor, cut open at the two tunnel mouths
        z  -80..-16   the tunnel void itself, 64 tall so a player fits
        z  -80..-16   solid fill UNDER the ground floor, cut open at the mouths
        z -112..-96   a bottom slab across the whole map

    The tunnel void and the fill occupy the same z range because the fill is
    what surrounds the void; the void is the part of that slab the mouths cut
    away. There is no ceiling over a mouth -- see the loop below.

    The solid fill and the bottom slab are what stop the map leaking. Without
    them the entire space under the ground floor was one open region that
    reached the outside, qbsp wrote ctf.leak.prt instead of ctf.prt, and vis had
    nothing to read. Flooring only the tunnel mouths was not enough -- the void
    around them was the actual hole in the map.
    """
    B = []
    T = 16
    X0, X1 = -T, CTF_LEN + T
    Y0, Y1 = CTF_Y0 - T, CTF_Y1 + T
    holes = tunnel_holes()

    # bottom slab, so nothing under the map is open to the void
    B.append(box(X0, Y0, CTF_TUNNEL_Z - 2 * T, X1, Y1, CTF_TUNNEL_Z - T, TEX_FLOOR))

    # solid fill beneath the ground floor, open only where the tunnels run
    B += bands_with_holes(X0, Y0, X1, Y1, CTF_TUNNEL_Z, -T, TEX_FLOOR, holes)

    # the ground floor, with the tunnel mouths cut through it
    B += bands_with_holes(X0, Y0, X1, Y1, -T, 0, TEX_FLOOR, holes)

    for hx0, hy0, hx1, hy1 in holes:
        # Tunnel side walls, carried past both ends so the void cannot slip
        # sideways into the fill.
        #
        # There is deliberately NO ceiling over the mouth. There used to be one,
        # at z -32..-16, and it sat inside the descending stairs: the mouth is
        # the hole in the floor that those stairs come down through, so capping it
        # sealed the only way into the tunnel. Measured with the hull-sized flood
        # fill: not one cell of the tunnel was reachable from the courtyard, on
        # either side. The floor above and the fill below already bound the void,
        # so nothing was leaking and the ceiling was only ever in the way.
        B.append(box(hx0 - T, hy0 - T, CTF_TUNNEL_Z, hx1 + T, hy0, CTF_TUNNEL_TOP, TEX_WALL))
        B.append(box(hx0 - T, hy1, CTF_TUNNEL_Z, hx1 + T, hy1 + T, CTF_TUNNEL_TOP, TEX_WALL))

    B.append(box(X0, Y0, CTF_H, X1, Y1, CTF_H + T, TEX_CEIL))

    # Outer walls, from below the bottom slab to above the ceiling.
    bottom = CTF_TUNNEL_Z - 2 * T
    B.append(box(X0, Y0, bottom, 0, Y1, CTF_H + T, TEX_WALL))
    B.append(box(CTF_LEN, Y0, bottom, X1, Y1, CTF_H + T, TEX_WALL))
    B.append(box(0, Y0, bottom, CTF_LEN, CTF_Y0, CTF_H + T, TEX_WALL))
    B.append(box(0, CTF_Y1, bottom, CTF_LEN, Y1, CTF_H + T, TEX_WALL))
    return B


# ---------------------------------------------------------------------------
# The forts map (--forts): two forts facing each other across water, a bridge,
# and an underwater passage into each fort's bottom.
#
# Built the way the reviewer's measurement says it has to be (0130): a sealed hull
# of SIX brushes, and everything inside it assembled out of space rather than by
# cutting holes in a fill. No two solid brushes overlap in volume -- touching faces
# are fine, overlap is not, because overlap is what qbsp resolves with splits, and
# the old --ctf layout's 116 overlapping pairs are why it was 32 units from a
# qbsp hang (tests/test_ctf_map.py's overlap guard, and maps/SKY-ATTEMPT.md).
#
# Verified against the reviewer's own control: a sealed sky box of this footprint
# (2080 x 1040), a floor and two simple forts compiles in 0.035 s.

# ---------------------------------------------------------------------------
# THE SCALE KNOB (reviewer 0240).
#
# The owner played the map at its authored size and said: "it's still squished ...
# it needs to be about 4 times larger overall to accommodate the amount of space
# the game had". Everything here had been sized near the hull minimum, so this is
# ONE multiplier rather than forty room-by-room edits, and it is here rather than in
# each constant so that changing it cannot leave two rooms disagreeing.
#
# HOW IT WORKS, and this is the part worth reading before changing anything:
#
#   * Every coordinate in the forts section below is authored in DESIGN UNITS, at
#     the size it was drawn. The arithmetic inside the geometry functions is all
#     design units too, which is why it still works: the scale is applied ONCE, at
#     emission (box_brush, and the entity origins in forts_lights/forts_entities).
#     So the geometry functions, the symmetry guard, the overlap guard and the
#     design-unit tests all keep talking about the same numbers as before.
#   * What the GAME sees is the world: design x FORTS_SCALE. tests/test_forts_map.py
#     measures the world (it converts through g.forts_world()/g.sc), so the checks
#     describe the map that ships, and scripts/map_route.py --map forts routes in
#     world units too, because tests/ctf_rules.js walks a real player through it.
#
# WHAT DOES NOT SCALE, deliberately:
#
#   * The player. HULL_MIN_Z/MAX_Z/MAX_XY are the hull in engine units and the hull
#     is what it is: 32 wide, 56 tall. Scaling it would scale the thing that is
#     supposed to be the constant, and every "a player can get through" check would
#     then be asserting nothing.
#   * A stair's RISE. Quake's step-up limit is a fixed height, so a flight that
#     grew its rise with the map would stop being climbable. stairs() therefore
#     takes MORE STEPS at a bigger scale (see `world_scale` there) and a test
#     asserts the world rise is <= 18.
#   * An entity's height ABOVE ITS OWN FLOOR: a 32-tall key 16 above the vault
#     floor, a player origin 24 above the ground. Those are world distances set by
#     how big the thing is, and they are why org_off() takes the floor in design
#     units and the offset in world units.
#
# Tunable without editing this file: `gen_map.py --forts --forts-scale 1.5`.
FORTS_SCALE = 2.0


def sc(v):
    """One design-unit coordinate -> its world value."""
    return round(v * FORTS_SCALE, 1)


def forts_world(boxes):
    """Geometry functions return DESIGN units; this is what the map actually has.

    box() deliberately does NOT scale, so the symmetry and overlap guards keep
    running on the numbers the map was authored in -- uniform scaling preserves
    every inequality they test -- while everything that measures the shipped map
    goes through here. Anything that mixes the two is a bug that shows up as a
    check failing, not as a check that quietly passes.

    A RAMP's slope scales too, so the eighth field is scaled with the box: a slope
    recorded in design units and read from the shipped map is a slope 128 too steep,
    because the run doubled and the rise did not. Both ends of it, for the reason in
    mirror_brush_one.
    """
    out = []
    for b in boxes:
        w = tuple(sc(v) for v in b[:6]) + (b[6],)
        if len(b) > 7 and isinstance(b[7], tuple) and b[7][0] == "ramp":
            w += (("ramp", b[7][1], sc(b[7][2]), sc(b[7][3])),)
        out.append(w)
    return out


def org(x, y, z):
    """An entity origin: design units in, world units out."""
    return f'"origin" "{sc(x)} {sc(y)} {sc(z)}"'


def org_off(x, y, floor_z, off):
    """An entity origin a fixed WORLD distance above a floor.

    The floor is design units and scales with the map; `off` is a world distance
    and does not: a 32-tall key 16 above its floor, a player origin 24 above the
    ground. Those two numbers are set by how big the THING is, and the thing is
    the one thing on this map that must not grow (see FORTS_SCALE).
    """
    return f'"origin" "{sc(x)} {sc(y)} {sc(floor_z) + off}"'


def scale_light_field(field, scale=None):
    """A light's brightness, raised for a room that is `scale` times as big.

    Illuminance falls off with the square of distance, so a hall twice as wide and
    twice as high needs four times the light for the same brightness at the far
    wall. Scaling it by scale^2 is that compensation; scaling by scale would make
    the map grow visibly dimmer every time the knob is turned up, and the owner
    asked for a bigger map, not a darker one.

    The value is either one number or an RGB triple (the passage light is a cold
    blue), and every component is multiplied by the same factor, so the tint is
    unchanged. A field that is not a "light" is returned untouched.
    """
    s = FORTS_SCALE if scale is None else scale
    if s == 1.0 or not field.startswith('"light" "'):
        return field
    head, _, val = field[1:].partition('" "')          # '"light" "350"' -> 350"
    nums = val[:-1].split()
    return ('"' + head + '" "'
            + " ".join(str(int(round(float(v) * s * s))) for v in nums) + '"')


# The player's own limits, which no scale may change. Restated here only so the
# tests read them from one place next to the scale that must not touch them.
PLAYER_RISE = 18               # Quake's step-up limit; a stair rise may not exceed it
PLAYER_TREAD = 32              # and a hull 32 deep needs a tread at least this deep

# Every flight the forts map builds, in world units, filled in by stairs() and by
# the vault's dog-leg. tests/test_forts_map.py measures the treads off the emitted
# geometry and uses this to know WHICH flights to measure -- a checker cannot find
# a flight it was never told about, and the map is the only thing that knows.
FORTS_FLIGHTS = []

# 2304, not 2048 (0291): grow the fort OUTWARD, keep the channel at its 1088 of design.
# Widening each fort by 128 while holding the map's length would have taken the channel
# to 832, and the water and the bridge are the middle of the game -- the owner asked for
# a bigger map, not a narrower one. So the two forts move away from the channel instead
# and the map grows by 2 x 128. The channel's edges were already derived from this
# number and from FORTS_FORT_W, so this is the whole edit.
FORTS_LEN = 2432              # x 0..2432, interior. 2304 was enough for the flight
                                # and one landing; the bottom landing (0318) needs 64
                                # more of interior and the channel keeps its 1088, so
                                # the map grows rather than the water.
FORTS_WID = 1024              # y 0..1024, interior; the channel runs along y
FORTS_HULL = 16               # the sky walls' thickness

# The three levels, and why the water has to reach the bottom one (0138/0142).
#
# It did not, and the symptom was waterlevel 0 everywhere: QuakeWorld samples the
# point at the player's FEET (origin + mins_z + 1 = -95) and compares it with the
# water volume. With the ground at -96 and the water from -80, there was a 16-unit
# layer of AIR under the water and the player walked along underneath it, dry, with
# the water visibly above their head. 0 wet samples out of 50.
#
# So the channel is a depression, not a box standing on the ground:
#
#   FORTS_BED_Z    -144   the hull slab's top: the channel's bed
#   FORTS_GROUND_Z    0   the ground either side, and the forts' floor
#   FORTS_WATER_TOP -24   the water's surface, below the ground, so falling in
#                          puts you IN it rather than on top of it
#
# The banks are 144 tall against the water surface, which is far more than a jump,
# so the only way out of the channel is a passage -- which is the owner's
# description.
FORTS_BED_Z = -144
FORTS_GROUND_Z = 0
FORTS_WATER_TOP = -24
FORTS_SKY_Z = 1024            # the sky lid
# 544, not 416 (0286: "grow the fort's interior as needed"). The interior has to hold,
# side by side and with 64 of clear floor between them: the 288-run flight, a 64-deep
# landing at floor level at the top of it, and the parapet stairwell on its own strip.
# 416 left 352 of interior, which is 128 short, and squeezing it is what put the
# parapet's treads inside the new stairwell's shaft in the first place.
FORTS_FORT_W = 608            # a fort's footprint, x 64..672
FORTS_FORT_X1 = 64 + FORTS_FORT_W      # its channel-side OUTER face, 672
FORTS_FORT_D = 640            # and y 192..832
FORTS_WALL_T = 32             # fort wall thickness
FORTS_ROOF_Z = 224            # the fort roof
FORTS_TOP_Z = 272             # the top of the parapet
FORTS_PASSAGE_Z = FORTS_BED_Z  # the passage floor IS the bed, so a swimmer walks in
# Headroom above the passage floor. A player is HULL_HEIGHT = 56 (defs.qc:362), not
# the 48 this comment assumed, and the vault needs room to stand in AND step, so:
#
#   64  -> 56 tall, exactly enough to stand. The vault shipped with 48 of clear
#          height, which is 8 short of a standing player, and a player who walked in
#          was wedged and could not take a single step (0213). 48 was never even
#          enough to stand.
#   88  -> 88 clear, i.e. 56 of player plus 32 of slack. That is the figure now.
#
# The extra 24 means cutting more out of the fort's ground floor, which the shaft
# (FORTS_SHAFT_Y) already allows: the passage walls and ceiling stand inside the
# hole the ground leaves, so raising the ceiling changes no brush that touches
# anything else.
FORTS_PASSAGE_H = 112
# The passage's y span, and the gap in the fort's ground floor above it. It is
# FORTS_SHAFT_Y is the gap in the fort's ground floor above it, and that is 128
# wide because it has to hold TWO stairs side by side: the main one out of the
# passage (in the passage's own 64) and the narrow second way into the vault (in
# the other 64). At 64 the passage took all of it and there was nowhere to put the
# second stair but through the passage ceiling, which is 32 overlapping pairs.
# The passage's own y span. It was 64 (448..512), which is one hull width plus 32:
# a player could get through but there was nowhere to stand, pass or fight, and the
# owner called the basement "a bit compressed" (0226 D). It is now 128 wide, with
# the stair bay beyond it, so the vault is a room rather than a corridor.
FORTS_PASSAGE_Y = (448, 576)   # the passage's own y span, 64 wide: a 32 hull
                               # channel-side wall is cut at exactly this span; they
                               # used to be 416..480 and 448..512, which left a
                               # wall segment standing across the passage.
# How far under the fort the passage runs, and where it stops. It must stop at the
# fort's INNER wall face (x 448), not at the outer one (480): running it to 480 put
# the passage's own side walls inside the fort's channel-side wall, x 448..480,
# which the guard reported as 6 overlapping pairs.
# 208..576: out to the new inner wall, because the vault is at the passage's outer
# end and moves with it -- and its INNER end starts at 208, not 144, because the
# parapet stairwell owns the west strip x 96..160 and the two must not share. That
# overlap is not cosmetic: the ground slab is cut for the passage's x span, so a
# passage starting at 144 cut the floor out from under the parapet's treads and left
# a void at bed level with the flight 194 above it.
FORTS_PASSAGE_X = (208, 576)
# The bridge deck IS the ground level, and it used to be 16 above it. That is a
# 32-unit step up out of the fort onto the bridge, which is over the 18 a player
# steps up and under the 45 a jump manages, and it is the owner's "the door out is
# too short, so can't get to the other fort" (0246): the door's own opening was
# 160 of clear height, so the door was not the problem -- the floor on the far side
# of it was. The comment in forts_channel already said "a walkway over it at ground
# level"; the constant disagreed with it.
FORTS_BRIDGE_Z = FORTS_GROUND_Z  # the bridge deck, level with the ground
# Where the crossing is, in y. It used to be 448..560, which is UNDER THE SHAFT: the
# hole cut in the fort's ground floor runs x 144..448, y 432..784, so the door in the
# channel-side wall opened onto the shaft with no floor on this side of it at all. A
# player could not walk to the door -- the floor in front of it was gone -- and the
# way in was to fall into the shaft, which is the owner's "fall in and stuck" and
# "the paths dont lead out" (0246). The crossing now runs at y 288..416, clear of
# the shaft on both sides and 256 wide in the world, and the door is cut there.
FORTS_BRIDGE_Y = (288, 416)
FORTS_BRIDGE_RAIL = 12          # the bridge's railing, DESIGN units above the deck:
                                # 24 world at FORTS_SCALE 2. Low enough that a jump
                                # clears it (the band is 19..32 world, reviewer 0527
                                # item 3), high enough to still be a rail. Was 48,
                                # which is 96 world: taller than a jump, so the
                                # bridge's edge was a wall. See forts_channel().
FORTS_MERLON_H = 32           # parapet merlons above the roof

# THE BATTLEMENT RAMP's own footprint, in LOCAL x (so the mirror handles it) and in y
# (which is never mirrored). One pair of numbers, read by fort_geometry for the roof
# strips, the ramp and its rail, and by forts_ground for the hole the ramp's foot needs
# in the hall floor. They used to be written out in both places -- `wall_x(96, 160)` and
# `iy0 + 64, iy1 - 32` -- and a ramp is the one thing on this map whose foot has to agree
# with the floor cut beneath it to the unit.
FORTS_PARAPET_X = (96, 160)   # 64 design = 128 world, the owner's width
FORTS_PARAPET_Y = (288, 768)  # 480 design of run for 256 of rise = 28.1 degrees

# The passage's own wall thickness, and the x the corridor runs to.
#
# TWO numbers the passage's shape is derived from, and both were implicit until the
# door check said "gap x1 896..1152: there is a floor on BOTH sides of it ... inside
# []". The passage's side walls and its mouth have to stand on the fort floor, and the
# floor's hole has to stop at their FACES -- so the thickness is written once, here,
# and used by both forts_passage() and forts_ground(). The floor's hole was cutting
# FORTS_STAIR_WALL (32) either side of the corridor instead, which is 16 too far on
# each side: two 32-world slots with no floor and no wall along the corridor's length,
# one of them the "narrowest 32.0" the corridor check reports and the other the hole
# spawn 3 walks into.
#
# And the corridor's run: to the wall's INNER face, not to the end of its own boxes.
# It stopped 64 short, and the ground slab's band across that 64 was solid from the
# bed to the ground -- so the corridor's outer end was a wall of rock, the wall's own
# doorway opened onto it, and the "underwater way in" was a sealed tunnel. That is
# what the door check calls a hole with no far side, and it is the same defect on both
# forts, which is the class 0403 was about.
FORTS_PASSAGE_WALL_T = 16
FORTS_PASSAGE_X1 = FORTS_FORT_X1 - FORTS_WALL_T   # 640: the wall's inner face

# The gap cut in the fort's ground floor for the passage and the vault's second
# stair. 128 wide, starting at FORTS_PASSAGE_Y[0].
# The stair bay beside the passage needs to be deep enough to hold a flight a
# player can actually climb (0226 C). 128 of rise at <=18 per step is >=8 steps, and
# >=32 of tread each is >=256 of run; the bay was 64 (512..576) and the flight came
# out with 5.8-deep treads rising 11.6, which a 32-deep hull cannot climb. That is
# the owner's "I can't get out of the basement because the stairs are compressed".
# The passage keeps 448..512 and the flight takes 512..736.
FORTS_SHAFT_Y = (448, 800)

# How far from the key a team's capture stand sits, in x. Beside the key, not on it
# (0226 B): co-located, one frame both fire and the capture scores inside the enemy
# vault.
FORTS_STAND_OFFSET = 96

# The key's own x, in LOCAL design units. It lives here and not as a literal in
# forts_entities because the turn-in pad (owner, 2026-10-09) is placed under the
# STAND, which is this x plus FORTS_STAND_OFFSET -- one number, one place, or the
# pad and the stand it is under drift apart the first time either moves.
FORTS_KEY_X = 328

# The turn-in pad's team trim textures (owner: "perhaps a glowing block").
# Written by scripts/mk_textures.py and packed into our.wad by build_maps.sh,
# like the CTF map's team bricks -- same idea, different texture family.
TEX_TRIM_RED = "trim_red"
TEX_TRIM_BLUE = "trim_blue"

# How much of the passage's outer end is given over to the vault's second stair.
# BOTH the passage's side walls and the stair are derived from this, in local x
# from the passage's OUTER edge, and mirrored. Deriving them from separate
# expressions -- bx - 64 here, vx1 - 64 there -- is what made them disagree by 16
# and produce 26 overlapping pairs, twice, in two directions.
FORTS_VAULT_STAIR_W = 64

# The basement key vault, at the bottom of each fort's underwater passage. Its
# floor IS the passage floor (the passage runs from the bed at -144 up to the
# fort), so the vault needs no hole of its own -- which is the whole reason to
# put it here rather than reuse vault_geometry()'s design, which had to cut a new
# hole in a solid fill and therefore had to solve the pit problem again.
# The vault's floor is the PASSAGE's floor, and the passage's floor is the bed.
# It was -128 while the passage's walking surface was -128 and the bed -144, which
# is the 32-unit ledge out of the water described above; with the floor slab gone
# (see forts_passage) all three are the bed and there is no ledge.
FORTS_VAULT_Z = FORTS_BED_Z

# ---------------------------------------------------------------------------
# THE STAIRWELL (reviewer 0270's decision: one straight enclosed stairwell, and
# move things to fit it).
#
# 288 of world rise at 16 a step is 18 steps, and at a 32-deep tread that is 576 of
# run -- which is why this is a straight flight and not a dog-leg: the old bay had
# 448 of run for the same rise, and 448/32 = 14 steps against 288/16 = 18, so no
# single flight fitted and two flights needed 512 of run in a 448 bay. Straight and
# long is the only shape that fits without a puzzle, and 288 is a multiple of 16.
#
# The numbers, in DESIGN units (the map is emitted at FORTS_SCALE):
#
#   x 160..448   the run: 288 design = 576 world, 18 treads of 16 design
#   y 592..672   the width: 80 design = 160 world, over the 128 asked for
#   rise 8 design = 16 world a step, 18 steps, from the fort floor to the bed
#
# It is walled on the north, walled on the south by the corridor's own north wall
# (with a 96-world door at the bottom), and OPEN ABOVE -- which is the whole point of
# it being a stairwell rather than a tunnel: a flight that descends needs the height
# of its own shaft, so the fort floor's hole is exactly this footprint. A player who
# walks into it walks DOWN 18 steps; there is nothing to fall into, which is the
# owner's complaint ("fall in and stuck") and what the filled-in bay used to be.
# It descends EASTWARD from the floor's own edge, and that direction is not a
# detail: built the other way, its top tread landed at the hole's EAST edge, 640
# world from the nearest floor, which is the same defect as the dog-leg's head in a
# different place (a player at the top of the stair with nothing to step onto). The
# fort floor's solid strip is x 96..128 design -- west of the hole -- so the flight
# starts at 128 and the first tread is against it.
# The flight, west to east: 224..512 is its 288 of run, 512..576 is the landing at
# floor level that the bridge door opens onto, and 96..160 is the parapet's own strip.
# It DESCENDS WESTWARD (0286), so its top tread is at 512, flush with the landing, and
# its bottom tread is at 224, in the corridor.
# 288..576 now, not 224..512: the bottom LANDING takes the 64 west of it (0318 --
# "no door may open onto the side of a flight"). West to east, the interior is
# 96..160 parapet, 160..224 floor, 224..288 the landing at bed level, 288..576 the
# flight descending westward, 576..640 the top landing at floor level where the
# bridge door opens onto it.
FORTS_STAIR_X = (288, 576)        # the flight's run: 288 design = 576 world
# The landing at the flight's FOOT, at bed level. 64 design = 128 world, which is
# the reviewer's figure. The corridor's door opens onto this and not onto the side
# of a flight, because coming through a side door put the hull over tread 17 and
# above -- a 32+ rise from the bed -- and only the first 16 of the door's width gave
# a legal step, which is narrower than a hull. So the side door was effectively
# closed and the corridor was a trap; the engine stalled in it at (480,1168,-264).
FORTS_STAIR_LANDING_X = (224, 288)
FORTS_STAIR_Y = (592, 672)        # the flight's width: 80 design = 160 world
FORTS_STAIR_WALL = 32             # the north wall's thickness
FORTS_STAIR_STEPS = 18
FORTS_STAIR_DOOR = (224, 288)     # the door at the bottom: 48 design = 96 world,
                                   # and it has to END at 384 -- the passage's north
                                   # wall stops there (that is where the old
                                   # dog-leg's gap was), so a door at 368..416 left a
                                   # 32-world opening and the rest of the piece was
                                   # a box with its faces the wrong way round
FORTS_VAULT_H = 64


def forts_ground(mirrored):
    """The ground either side of the channel, from the bed up to z=0.

    In PIECES, because the fort's walls stand on it and two solid brushes may not
    share volume: the overlap guard refuses the map otherwise, which is the whole
    point of it. The pieces tile the left bank exactly:
      * west of the fort            x 0..64
      * the strip between the fort's east wall and the water, x 464..480
      * south of the fort           x 64..464, y 0..192
      * north of the fort           x 64..464, y 832..1024
      * the fort's own floor        x 96..432, y 224..800, with the passage cut out
    """
    B = []
    bed, ground = FORTS_BED_Z, FORTS_GROUND_Z
    def X(v):
        return (FORTS_LEN - v) if mirrored else v
    def rng(lo, hi):
        a, b = X(hi), X(lo)
        return (min(a, b), max(a, b))

    pw0, pw1 = FORTS_PASSAGE_X
    py0, py1 = FORTS_SHAFT_Y
    px0, px1 = rng(pw0, pw1)          # the passage, mirrored

    # box() takes (x0, y0, z0, x1, y1, z1, tex), so the x pair from rng() goes in
    # the x slots -- unpacking it positionally put x1 where y0 belongs and produced
    # zero-height boxes, which the symmetry check caught as "the forts are not
    # symmetric".
    B.append(box(rng(0, 64)[0], 0, bed, rng(0, 64)[1], FORTS_WID, ground, TEX_FLOOR))
    # The strip between the fort's east wall and the water, cut for the passage
    # like the fort floor is: the passage runs out to x=480, which is where the
    # water starts, so a plain slab here interpenetrates its walls. That was the
    # first of the 18 pairs:
    #   (464, 0, -144, 480, 1024, 0) and (144, 432, -144, 480, 448, -80)
    # Only the y the fort does NOT occupy: the fort's walls run y 192..832 across
    # the full x 64..480, so a strip at x 464..480 spanning y 0..1024 ran straight
    # through the south and north walls' corners. That was the last 14
    # overlapping pairs, e.g.
    #   (464, 0, -144, 480, 432, 0)  vs  (64, 192, -144, 480, 224, 224)
    # Where the fort is NOT: y 0..192 and 832..1024 only. The passage runs at
    # y 448..512, which is inside the fort's own y span (192..832), and at that
    # x (464..480) the fort's channel-side wall is already there, so there is no
    # strip to build -- the passage's own floor covers it.
    # Derived from the wall, not written out: these were the literal 464 and
    # 480, which is how widening the fort by 128 produced four overlapping pairs
    # the moment FORTS_FORT_W changed -- the floor slab still stopped 128 short
    # of the wall it was supposed to meet. Same class as the two hand-written
    # box lists: one number, written in more than one place.
    sx0, sx1 = rng(FORTS_FORT_X1 - FORTS_WALL_T // 2, FORTS_FORT_X1)
    for (by0, by1) in ((0, 192), (832, FORTS_WID)):
        B.append(box(sx0, by0, bed, sx1, by1, ground, TEX_FLOOR))
    fx0, fx1 = rng(64, FORTS_FORT_X1 - FORTS_WALL_T // 2)
    B.append(box(fx0, 0, bed, fx1, 192, ground, TEX_FLOOR))
    B.append(box(fx0, 832, bed, fx1, FORTS_WID, ground, TEX_FLOOR))
    # The fort floor, with the passage's hole cut out of it -- so the passage is a
    # lower level reached from inside the fort, not a sealed box under it.
    # y 224..800, the fort's INTERIOR: the pieces north and south of the fort stop
    # at 832 and start at 192, so reaching 1024 here overlapped them (the guard
    # caught 10 pairs that way).
    # The floor reaches to the shaft's END, so the hole -- which is cut 16 wider than
    # the shaft on each side -- stays inside it. With the floor ending at a fixed 800
    # and the shaft now at 800 too, the hole's north edge (800+16 = 816) fell OUTSIDE
    # the floor and produced a degenerate box, y 816..800: two coincident faces,
    # which qbsp rejects as "Brush plane with no normal".
    # To the wall's INNER face (448), not 16 short of it (432). The 16 was a
    # no-overlap precaution that outlived its reason, and it left a 32-world slot
    # along the whole channel side of the fort with nothing at floor level in it --
    # so the floor stopped short of the bridge door, the door's threshold had no
    # floor at all, and the way onto the bridge was to walk off an edge into a
    # 352-deep trench. The floor's hole is cut at px0..px1 = 144..448, which already
    # reaches the wall, so nothing overlaps.
    fx0, fx1 = rng(96, 448)
    # The floor stops at the fort's INTERIOR north edge (800), NOT at the shaft's
    # end. Extending it to the shaft's end pushed it 16 into the north wall's
    # corner -- 4 overlapping pairs, e.g.
    #   (64, 800, -144, 480, 832, 224) and (96, 224, -144, 144, 832, 0)
    #
    # So the shaft cannot be deeper than the interior is long. That is a real limit
    # and it is why the shaft stops at 800 and the stair bay runs 576..800 inside it.
    # THE HOLE IS THE STAIRWELL AND NOTHING ELSE (0270: "fill the shaft").
    #
    # It used to be ONE rectangle, x 144..448 and y 432..784: 352 of design y for a
    # stair that needs 288 of it, which is how the bay existed at all, and how the
    # owner kept ending up in it. Now there are exactly two holes, each one something
    # that genuinely has to be open:
    #
    #   the corridor   x 144..448, y 448..576   it is a tunnel under the fort
    #   the stairwell  x 128..448, y 592..704   it is 18 steps down
    #
    # and the floor is emitted as the seven rectangles around them. Explicit pieces
    # rather than bands_with_holes(), which takes ONE hole: it computes each x band
    # from the union of the holes it contains, so two holes at different y in
    # overlapping x -- which is exactly this pair -- would have opened a rectangle
    # from the corridor's south edge to the stairwell's north edge and taken the wall
    # between them with it.
    stair_y0 = FORTS_STAIR_Y[0]
    stair_y1 = FORTS_STAIR_Y[1] + FORTS_STAIR_WALL
    # The hole is the flight's own footprint plus its NORTH WALL only. There is no
    # wall at the top (west) end -- that is the mouth, and it has to be against the
    # floor's solid strip at x 96..128, not 64 world away from it.
    stair_x0, stair_x1 = FORTS_STAIR_X
    pass_y0, pass_y1 = FORTS_PASSAGE_Y
    # ALL LOCAL x, mirrored once at the end. fx0/fx1/px0 arrive already mirrored
    # from rng(), and mixing those with stair_x0 (a plain constant) gave fort B the
    # bands (1600,128), (128,1904), (1904,1952) -- which is why is_symmetric()
    # reported 9 boxes with no mirror. y is never mirrored.
    # The interior, and the floor cut into bands by WHATEVER crosses it -- the
    # stairwell's x span and the passage's. Written as three hand-picked bands in
    # the order (west, stair, passage) it only worked while the stairwell really was
    # west of the passage; moving the flight east made the bands overlap each other
    # (96..224 and 144..576 share 144..224) and the guard refused the map with four
    # pairs. Sorted distinct boundaries cannot overlap by construction, whatever
    # order the features are in.
    lx0, lx1 = 96, 64 + FORTS_FORT_W - FORTS_WALL_T
    # Sorted at BOTH features' x boundaries, and then each band skips only the y
    # intervals that apply TO THAT BAND. It used to skip the same three y bands in
    # every band, which is right for the vault stairwell -- which goes DOWN and so
    # has to have no floor over it -- and wrong for the parapet, which goes UP from
    # the floor and stands ON it. Cutting the floor under the parapet's treads left
    # a void at bed level under the stairs, with the flight 194 above it and nothing
    # between: 5661 trap cells, every one of them in that void, and the owner would
    # have fallen through the battlements' stairwell into an unescapable hole.
    # The shaft is the landing AND the flight: the landing is at bed level, so the
    # hall floor has to be gone over it too, or there is no headroom to stand in it.
    # ... and over the landing's own west wall, which is T west of the landing:
    # cutting to the landing's edge left the ground slab running into it (8
    # overlapping pairs, refused).
    shaft_x0 = FORTS_STAIR_LANDING_X[0] - FORTS_STAIR_WALL
    shaft_x1 = stair_x1
    # The BATTLEMENT RAMP is a cut boundary too, or its footprint lands inside
    # whichever band happens to contain it -- and that band is 96 wide, so cutting
    # "the ramp's y range" out of it opens 16 of hole either side of a 64-wide ramp.
    # Its own two ends are the boundaries, so the band that IS the ramp is its own.
    cuts = sorted({lx0, lx1, FORTS_PASSAGE_X[0], FORTS_PASSAGE_X[1],
                   shaft_x0, shaft_x1,
                   FORTS_PARAPET_X[0], FORTS_PARAPET_X[1]})
    for (a, b) in zip(cuts, cuts[1:]):
        if b <= a:
            continue
        aa, bb = sorted((X(a), X(b)))
        mid = (a + b) / 2.0
        # A hole is a piece of y THIS BAND loses, and it is the walls that make the
        # hole, not the room: the passage's own walls occupy y 432..448 and 576..592
        # (FORTS_PASSAGE_Y 448..576 plus its 16 wall), and the stairwell's occupy
        # 592..688 (FORTS_STAIR_Y 592..672 plus its wall). Getting these two wrong
        # put the floor under a wall -- 42 overlapping pairs -- and getting them
        # right is what puts the floor back under the parapet.
        T = FORTS_STAIR_WALL
        holes = []
        if FORTS_PARAPET_X[0] <= mid <= FORTS_PARAPET_X[1]:
            # The ramp's own footprint, and nothing else: this band IS the ramp, so the
            # hole is its y span exactly. The ramp is a solid wedge from the bed, so what
            # is cut here is filled by the ramp and there is no void under it -- which is
            # the whole reason it is a wedge rather than a slab standing on treads.
            holes += [FORTS_PARAPET_Y]
        # The corridor's hole runs to the WALL's inner face (FORTS_PASSAGE_X1), not to
        # the end of the passage's own boxes: the corridor's last 64 are the mouth, and
        # leaving them floored sealed the underwater way in. Only the passage's own y
        # band is cut there, because this band is east of the stairwell too and taking
        # the stairwell's y as well would open the shaft's east end to the bed.
        if FORTS_PASSAGE_X[0] <= mid <= FORTS_PASSAGE_X1:
            # The passage's WHOLE band, walls and interior: the corridor's floor is
            # the bed, so the ground slab has no business being in there at all.
            # Holing only the walls left the slab filling the corridor up to z=0,
            # which is 2 overlapping pairs with the passage's own ceiling.
            #
            # The corridor's OWN wall thickness either side (432 and 592), not the
            # stairwell's: the comment below this loop has said "432 and 592" since
            # 0270 while the code subtracted FORTS_STAIR_WALL, which is 32. The extra
            # 16 on each side is a hole in the hall floor with no wall beside it --
            # 32 world wide and 288 deep, along the whole corridor -- and it is both
            # reds: the corridor check's "narrowest 32.0" and the spawn check's
            # "no floor at [(480, 840), (480, 856)]".
            holes += [(pass_y0 - FORTS_PASSAGE_WALL_T,
                       pass_y1 + FORTS_PASSAGE_WALL_T)]
        if shaft_x0 <= mid <= shaft_x1:
            # stair_y1 ALREADY has the wall added -- it is
            # FORTS_STAIR_Y[1] + FORTS_STAIR_WALL -- so adding T again took the hole
            # 32 too far and left a 32-world strip of NO FLOOR along the shaft's north
            # side: design y 704..736, x 192..576, with the bed showing through it.
            # That one cell was the whole first trap: a hole in the hall floor a
            # player could fall through and not get out of.
            holes += [(stair_y0, stair_y1)]
        # 432 and 592, not 448 and 576: the passage's own side walls occupy
        # y 432..448 and y 576..592, so the floor has to stop at their FACES. With
        # 448/576 the floor's south piece ran under the south wall and the overlap
        # guard refused the map with 11 pairs.
        for (c, d) in solid_bands(224, 800, holes):
            B.append(box(aa, c, bed, bb, d, ground, TEX_FLOOR))
    return B


def solid_bands(lo, hi, holes):
    """(lo, hi) minus every (a, b) in holes, as a list of ascending pairs.

    The intervals may overlap and may be given in any order; the result is the
    complement, sorted and non-overlapping by construction, so two bands emitted from
    two such lists cannot share volume. That is the property the fort floor needs and
    the reason it is written this way rather than as three hand-picked bands.
    """
    spans = sorted((max(lo, a), min(hi, b)) for a, b in holes if b > lo and a < hi)
    out, cur = [], lo
    for a, b in spans:
        if a > cur:
            out.append((cur, a))
        cur = max(cur, b)
    if cur < hi:
        out.append((cur, hi))
    return [(a, b) for a, b in out if b > a]


def forts_hull():
    """Six brushes: one floor slab, four sky walls, one sky lid.

    Deliberately minimal and deliberately non-overlapping. The four walls span the
    full y range and the two x walls only the interior, so they meet at a plane
    instead of interpenetrating -- which is the whole lesson of the 116 pairs.
    """
    B = []
    X0, X1 = -FORTS_HULL, FORTS_LEN + FORTS_HULL
    Y0, Y1 = -FORTS_HULL, FORTS_WID + FORTS_HULL
    top = FORTS_SKY_Z + FORTS_HULL
    B.append(box(0, 0, FORTS_BED_Z - 2 * FORTS_HULL, FORTS_LEN, FORTS_WID,
                 FORTS_BED_Z, TEX_FLOOR))                       # the slab
    B.append(box(X0, Y0, FORTS_BED_Z - 2 * FORTS_HULL, 0, Y1, FORTS_SKY_Z, TEX_SKY))
    B.append(box(FORTS_LEN, Y0, FORTS_BED_Z - 2 * FORTS_HULL, X1, Y1, FORTS_SKY_Z,
                 TEX_SKY))
    B.append(box(0, Y0, FORTS_BED_Z - 2 * FORTS_HULL, FORTS_LEN, 0, FORTS_SKY_Z,
                 TEX_SKY))
    B.append(box(0, FORTS_WID, FORTS_BED_Z - 2 * FORTS_HULL, FORTS_LEN, Y1,
                 FORTS_SKY_Z, TEX_SKY))
    B.append(box(0, 0, FORTS_SKY_Z, FORTS_LEN, FORTS_WID, top, TEX_SKY))   # the lid
    return B


def ring(x0, y0, x1, y1, z0, z1, t, tex, gaps=()):
    """Four wall boxes around an interior, with the walls OUTSIDE it.

    Written out explicitly rather than assembled from walls(), because walls() puts
    each side outside the span it is given and that is not visible from the call
    site: I passed x0..x0+t and named side "x0" and got a wall at x0-t..x0, which
    is a wall thickness out and overlapping its neighbour (18 pairs, refused by the
    generation-time guard). Three different spans went wrong that way before I
    stopped using walls() here.

    The four boxes TILE by construction: the two long ones (south, north) own the
    corners and span the full length including them, and the two short ones (west,
    east) fit BETWEEN them and take no corners. So no two boxes share any volume,
    which is the property the whole map depends on.

    `gaps` are doorways, as (side, a0, a1, gz0, gz1): side is "x0"/"x1" for a
    doorway in a west/east wall (a0..a1 runs along y) or "y0"/"y1" for one in a
    south/north wall (a0..a1 runs along x). Each doorway is cut by SPLITTING the
    wall it is in into left / right / lintel-above, never by overlapping anything:
    three pieces that share faces but no volume.
    """
    walls = {
        "y0": (x0 - t, y0 - t, x1 + t, y0),        # south, owns both corners
        "y1": (x0 - t, y1, x1 + t, y1 + t),        # north, owns both corners
        "x0": (x0 - t, y0, x0, y1),               # west, between them
        "x1": (x1, y0, x1 + t, y1),               # east, between them
    }
    out = []
    for side, (wx0, wy0, wx1, wy1) in walls.items():
        mine = [g for g in gaps if g[0] == side]
        if not mine:
            out.append((wx0, wy0, z0, wx1, wy1, z1, tex))
            continue
        # The free axis of this wall: y for x0/x1, x for y0/y1.
        along_y = side in ("x0", "x1")
        lo, hi = (wy0, wy1) if along_y else (wx0, wx1)

        def piece(a0, a1, gz0, gz1):
            if a1 - a0 <= 0 or gz1 - gz0 <= 0:
                return
            if along_y:
                out.append((wx0, a0, gz0, wx1, a1, gz1, tex))
            else:
                out.append((a0, wy0, gz0, a1, wy1, gz1, tex))

        # Walk the wall in strips between the doorways, and for each gap emit the
        # parts below and above it.
        cuts = sorted({lo, hi} | {max(lo, min(hi, g[1])) for g in mine}
                                   | {max(lo, min(hi, g[2])) for g in mine})
        for i in range(len(cuts) - 1):
            a0, a1 = cuts[i], cuts[i + 1]
            if a1 - a0 <= 0:
                continue
            mid = (a0 + a1) / 2
            covered = [g for g in mine if g[1] < mid < g[2]]
            if not covered:
                piece(a0, a1, z0, z1)
                continue
            zs = {z0, z1}
            for g in covered:
                zs.add(max(z0, g[3]))
                zs.add(min(z1, g[4]))
            zs = sorted(z for z in zs if z0 <= z <= z1)
            for k in range(len(zs) - 1):
                c0, c1 = zs[k], zs[k + 1]
                cmid = (c0 + c1) / 2
                if any(g[3] <= cmid <= g[4] for g in covered):
                    continue
                piece(a0, a1, c0, c1)
    return out


def fort_geometry(mirrored):
    """One fort: four walls with real openings, a floor, a roof, a parapet, stairs.

    Every wall is a walls() call, so every opening is a real hole rather than a
    missing wall -- the failure that made the old map's flag room enterable only by
    walking on top of it.

    Three ways in, which is what makes it a fort rather than a block:
      * the bridge door on the channel side, at ground level
      * the gate on the map's outer side, at ground level
      * the underwater passage into the bottom, which is how a team gets in
        without coming through the front
    """
    T = FORTS_WALL_T
    x0, y0 = 64, 192
    x1, y1 = x0 + FORTS_FORT_W, y0 + FORTS_FORT_D
    fz = FORTS_BED_Z            # walls from the bed, so the passage is enclosed
    top = FORTS_ROOF_Z

    def X(v):
        return (FORTS_LEN - v) if mirrored else v

    # Interior extents, mirrored: the walls sit outside them.
    def wall_x(lo, hi):
        """A wall's x span, in ascending order whichever side we are on.

        X() alone gives (LEN-hi, LEN-lo) when mirrored, which is DESCENDING, and
        walls() assumes x0 < x1 -- so without the sort the mirrored fort was built
        from 96 back to 64, on the wrong side of its own interior, and
        is_symmetric() caught it:
          FATAL: the forts are not symmetric about mid-x
        """
        a, b = X(hi), X(lo)
        return (min(a, b), max(a, b))

    ix0, ix1 = wall_x(x0 + T, x1 - T)      # interior in x, ordered
    iy0, iy1 = y0 + T, y1 - T
    B = []

    # Four sides, each spanning exactly its own strip, so they TILE and cannot
    # overlap. The first version gave the two long walls the full y range including
    # the corners and the two short walls the full x range including the corners,
    # so all four shared their corner volumes: 30 overlapping pairs, which the
    # generation-time guard refused to write out:
    #   FATAL: 30 solid brush pairs overlap in volume, e.g.
    #     (80, 192, -96, 96, 832, 224) and (80, 192, -96, 96, 224, 224)
    #
    # East/west take the full y and the inner x; north/south take the inner x and
    # their own 32 of y. Each is a walls() call, so its openings are real holes.
    # One ring() call, so the four sides are emitted by construction rather than by
    # four spans I have to keep consistent.
    #
    # Doorways: the bridge door and, below it, the underwater passage mouth in the
    # channel-side wall; the gate in the outer wall.
    # ring() takes ABSOLUTE spans and puts the walls outside them, so the
    # arguments have to be mirrored: passing the raw local x0/x1 built fort B's
    # walls at fort A's coordinates, which is_symmetric() reported as
    # "the forts are not symmetric about mid-x" (15 boxes that demirror to
    # nothing). The doorway SIDE names then have to flip with the mirror, since
    # ring() sees only the mirrored span.
    chan_side = "x1" if not mirrored else "x0"
    out_side = "x0" if not mirrored else "x1"
    iy0, iy1 = y0 + T, y1 - T
    # THE BANK DOOR (reviewer, 2026-10-09: "the bank must not be a dead end").
    # The water ramp's steps put a player on the bank top north of the fort, and
    # until now that bank was a shelf with no way back into the game: every wall
    # was solid from the bed to the roof, so the only exits from the water were
    # ramps onto a ledge that leads nowhere, which is the owner's "fall in and
    # stuck" wearing a coat of paint. So the north wall -- the wall the bank
    # stands against -- gets a doorway into the hall, at the end NEAREST the
    # steps: local x from the vault flight's east end (FORTS_STAIR_X[1]) to the
    # interior's east edge (x1 - T), 64 design = 128 world wide, sill at bank-top
    # level (0 design, so the bank top and the hall floor are one continuous
    # walk) and 64 design = 128 world tall. It opens onto the hall's strip east
    # of the stairwell's mouth, which is floor the whole way south to the bridge
    # door. wall_x() mirrors the span, the way the walls themselves are mirrored.
    nd0, nd1 = wall_x(FORTS_STAIR_X[1], x1 - T)
    B += ring(ix0, iy0, ix1, iy1, fz, top, T, TEX_WALL,
              gaps=[# THE PASSAGE MOUTH, cut at the passage's OWN span. It was at
                    # y 416..480 while the passage runs 448..576, so the opening
                    # overlapped the passage's interior by 32 and the other 96 of
                    # the passage's width was walled off: the underwater way in was
                    # 64 world units wide, half a hull, and the passage's side wall
                    # (432..448) was behind most of the opening. That is the owner's
                    # "fall in and stuck".
                    (chan_side, FORTS_PASSAGE_Y[0], FORTS_PASSAGE_Y[1], fz,
                     FORTS_PASSAGE_Z + FORTS_PASSAGE_H),
                    # THE BRIDGE DOOR, cut at the crossing's own y span
                    # (FORTS_BRIDGE_Y) so the deck and the opening agree.
                    #
                    # It used to be cut at y 448..560 while the deck has moved to
                    # 288..416, and 448..560 is UNDER THE SHAFT: the hole in the
                    # fort's ground floor is y 432..784, so the floor in front of
                    # the door was gone and the only way in was to fall into the
                    # shaft. That is the owner's "fall in and stuck" (0246).
                    #
                    # Cut from the bed up to ground + 96: 224 of clear height above
                    # a deck that is LEVEL with the fort floor, which is 0246's
                    # rule (at least 128 above the higher floor, cut from at or
                    # below both) with the two floors flush, so there is no step to
                    # climb at the threshold either.
                    (chan_side, FORTS_BRIDGE_Y[0], FORTS_BRIDGE_Y[1], fz,
                     FORTS_GROUND_Z + 96),
                    # THE BANK DOOR, in the north wall: sill at the bank top, so
                    # the two floors are one walk and there is no step at all.
                    ("y1", nd0, nd1, FORTS_GROUND_Z, FORTS_GROUND_Z + 64),
                    #
                    # NO GAP IN THE OUTER WALL. There was one, y 480..608 cut
                    # from the bed up to bed+96, and it opened onto SOLID ROCK:
                    # west of the outer wall is the 64-wide ground strip along the
                    # map's edge, which is not a route to anywhere. It was a hole
                    # with no far side. tests/test_forts_map.py's door check
                    # catches that class now: a gap with no standable floor on the
                    # far side is not a door.
                    ])

    # The roof, spanning the interior only so it cannot overlap a wall. The FLOOR
    # is forts_ground()'s: it is the ground the fort stands on, cut for the
    # passage. Adding one here too interpenetrated the hull slab, which is what
    # the guard caught as the last 2 of the 20 pairs -- the slab's top IS fz, so
    # the ground already is the fort's floor.
    # Four strips around the stairwell (see the stairs() call below), tiling the
    # interior exactly once between them so the overlap guard stays satisfied.
    # In LOCAL x, measured from the fort's own west (outer) wall, and mirrored
    # once here. Deriving it from ix0 instead ("ix0 + 32") looks symmetric and is
    # not: for fort B ix0 is the mirrored left edge, so +32 steps back toward
    # mid-x rather than away from the outer wall, putting B's stairwell at
    # 1632..1696 where A's mirror 1856..1920 would be. is_symmetric() reported
    # every roof strip and every merlon as unmatched.
    # Clear of ix0 by 32, so the "west of it" roof strip is 32 wide rather than
    # zero. At x0+32 it landed exactly on ix0 = x0 + T and the strip collapsed to
    # no width at all: a box with two equal x faces, which qbsp rejects as
    # "Brush plane with no normal".
    # The SAME stairwell the flight below uses: x 384..448, the east end of
    # the hall. These two assignments -- this one for the roof strips, that one
    # for the treads -- were the same number written twice, and when the
    # flight moved east this one stayed behind: 12 overlapping pairs, the roof
    # strip running straight over the flight.
    sx0, sx1 = wall_x(*FORTS_PARAPET_X)
    # The stairwell's y run is what a flight of stairs costs. At FORTS_SCALE 2.0 the
    # climb from the fort floor to the parapet is 480 of WORLD rise, a step may not
    # rise more than PLAYER_RISE = 18, so the flight needs at least 27 steps -- and
    # 27 treads of the 32 a hull can stand on is 864 of run. The old run,
    # iy0+192..iy1-32 = 416..768, is 704 of world run, which cannot buy that at any
    # legal tread: it comes out 26 deep, below the hull.
    #
    # So the run starts at iy0+64 instead of iy0+192: 992 of world run for 27 steps
    # is 36.7 of tread and 17.8 of rise, both legal. This is the one place the scale
    # does NOT make something bigger -- a stair is a fixed height per step and a
    # fixed depth per tread, so a bigger map gets a LONGER stairwell instead (see
    # FORTS_SCALE). The roof strips below tile around the new run.
    sy0, sy1 = FORTS_PARAPET_Y
    # ... and the strip west of it, for the same reason: wall_x() sorts the span, so
    # which side of the stairwell each of these two strips is on DEPENDS ON THE FORT.
    # A's stairwell is against the interior's east wall and B's against its west one,
    # so exactly one of the two strips is degenerate in each fort -- and which one is
    # why this guard has to be on both, not just one.
    if ix0 < sx0:
        B.append(box(ix0, iy0, top, sx0, iy1, top + T, TEX_CEIL))      # west of it
    # The strip east of the stairwell only exists if the stairwell is not against the
    # wall, for the reason the west one gives: qbsp drops a box with two coincident
    # faces, but it is still in the emitted list, and it made the .map and the
    # generator disagree about how many solids there are -- which is the count
    # tests/test_forts_map.py's new guard compares.
    if sx1 < ix1:
        B.append(box(sx1, iy0, top, ix1, iy1, top + T, TEX_CEIL))      # east of it
    B.append(box(sx0, iy0, top, sx1, sy0, top + T, TEX_CEIL))          # south of it
    B.append(box(sx0, sy1, top, sx1, iy1, top + T, TEX_CEIL))          # north of it

    # Light PANELS on the underside of the roof, in the hall. These are the surfaces
    # the _surface emitter in forts_lights() turns into real lights, so they exist
    # to be lit rather than to look as though they are -- which is the difference
    # the owner asked for (0217).
    #
    # Thin slabs hung BELOW the roof rather than face selections on it: a panel box
    # cannot interpenetrate the roof (it is 8 below it) and it is a face the engine
    # can find by texture. Panels are 48x48, spaced clear of the walls.
    # pz is the roof's TOP (top+T). A panel of thickness 8 hanging below it spans
    # pz-16..pz-8, which is INSIDE the roof slab (top..top+T) -- the 8 overlapping
    # pairs the guard refused. So the ceiling height is what has to move, not the
    # panel: pz is used and the panels sit below the roof's underside instead.
    pz = top + T
    # The stairwell (the flight runs x 128..192, y 288..784) gets no panel; it has
    # its own fill lights in forts_lights(). The two that used to sit at (160, 336)
    # and (160, 512) were exactly that -- one of them landed on a tread, 2
    # overlapping pairs -- and the stairwell is now TALLER (see sy0 below), so both
    # moved off the x=160 column entirely rather than being nudged.
    # All of them over SOLID roof, and none of them over either stairwell: the two at
    # x=400 were over the parapet's flight after it moved east (4 overlapping pairs --
    # a panel hanging where a tread is), and x=200 is over the roof strip between the
    # two stairwells.
    # (200, 336) and (200, 688) used to be at x=200, i.e. x 176..224, which is inside
    # the battlement ramp's new rail at x 160..192 -- two overlapping pairs, and the
    # guard was right to refuse the map. They moved east to 240, clear of the rail and
    # still over solid roof.
    for (px, py) in ((320, 336), (320, 512), (320, 688),
                     (240, 336), (240, 688)):
        a, b = sorted((X(px - 24), X(px + 24)))
        B.append((a, py - 24, top - 8, b, py + 24, top, TEX_LIGHT))

    # The parapet: merlons along the roof's edge, with GAPS between them, so a
    # defender can shoot through the gaps and duck behind them. Which is the whole
    # point of a crenellation and the reason it is modelled rather than painted.
    #
    # Merlons are 32 tall, split and standing ON the roof (top+T..top+T+32), never
    # overlapping it. The gap pattern is 32 of merlon, 32 of gap, so half the
    # parapet is shootable.
    pt = top + T
    mh = FORTS_MERLON_H
    # Built in LOCAL coordinates (x0..x1, y0..y1) and mirrored afterwards, like
    # everything else in this function. Placing them from wall_x() directly made
    # fort B's parapet sit at fort A's coordinates: is_symmetric() caught it as
    # "the forts are not symmetric about mid-x", with A holding 23 boxes and B
    # only 11.
    # Merlons are built in LOCAL coordinates and mirrored once, exactly like the
    # wall ring. Feeding them the mirrored ix0/ix1 (A: 96..448, B: 1600..1952) and
    # then mirroring the boxes again gave fort B a parapet that was A's pattern
    # shifted by one 64 pitch -- A's merlons at 96,160,224,288,352 but B's at
    # 160,224,288,352,416 -- and is_symmetric() listed all 34 as unmatched.
    # LOCAL x only, from the outer (west) wall inward.
    # Inset by one 64 pitch at each end: an "x" run and a "y" run otherwise both
    # place a merlon on the same corner post, which is an overlap. Insetting means
    # the corner is simply left to the wall itself.
    PITCH = 64
    lo_x0, lo_x1 = x0 + T + PITCH, x1 - T - PITCH
    m_local = []
    for edge, along in ((y0 + T, "x"), (y1 - T, "x")):
        for e in crenellations(lo_x0, lo_x1, edge, pt, mh, along):
            a, b = sorted((X(e[0]), X(e[3])))
            m_local.append((a, e[1], e[2], b, e[4], e[5], e[6]))
    for edge in (x0 + T, x1 - T):
        for e in crenellations(iy0 + PITCH, iy1 - PITCH, edge, pt, mh, "y"):
            a, b = sorted((X(e[0]), X(e[3])))
            m_local.append((a, e[1], e[2], b, e[4], e[5], e[6]))
    B += m_local

    # Stairs from the fort floor up to the roof, so the top is reachable from
    # inside. ix0/iy0 are already mirrored, so this mirrors for free.
    #
    # The run has to be in a hole in the roof, or it climbs to the underside of
    # the roof and stops: the roof is solid from top..top+T over the whole
    # interior. The first version put the run at ix0..ix0+64 against the west
    # wall with the roof unbroken above it, so there was no way onto the parapet.
    # The roof is therefore emitted as FOUR strips around a stairwell at the
    # mirrored west end, rather than one slab.
    # The MIRRORED span, the same one the roof strips above used: with
    # along="y" stairs() no longer flips x itself, so it must be handed a span
    # that is already mirrored. Passing the local x0+64 gave fort B's flight
    # x 128..192 -- the same place as fort A's -- so both forts had a stairwell
    # in the same place and is_symmetric() reported 12 unmatched treads.
    # THE PARAPET'S STAIRWELL MOVED TO THE EAST END of the hall.
    #
    # It was at design x 128..192, y 288..784 -- and the new vault stairwell is at
    # x 96..384, y 592..704, so the two flights shared the same volume: the parapet's
    # treads at y 619..652, z 0..185 were standing inside the new stairwell's shaft.
    # That is what the reverse fill was hitting: it reached the stairwell's columns
    # at z=394 (a tread of the OTHER staircase) and never got down to the treads at
    # z=-40..-264 underneath them, so it could not find a way out of the vault.
    #
    # x 384..448 is the only 64-wide strip of the hall left clear of the vault
    # stairwell, and 64 design IS the parapet stairwell's width. The roof strips and
    # the light panels are all derived from sx0/sx1, so they follow it.
    sx0, sx1 = wall_x(*FORTS_PARAPET_X)
    # The SAME run the roof strips were cut around above, and it has to be: the
    # flight climbs through the hole in the roof, and a hole somewhere else is a
    # flight that arrives at the underside of a slab. sy0 was iy0+192 and is now
    # iy0+64, because 27 steps of 32-deep tread need 864 of world run and the old
    # run only had 704 (see the note above the roof strips).
    sy0, sy1 = FORTS_PARAPET_Y
    # From GROUND, not from the bed: stairs() starts each step 16 below its own
    # first tread, so starting at fz = FORTS_BED_Z = -144 put the bottom of the
    # run at -160, which is inside the hull's floor slab (-176..-144). The guard
    # caught 24 such pairs. The fort's floor is the ground at FORTS_GROUND_Z.
    # From the ground UP: stairs() starts each step 16 below its own first tread,
    # so the run's bottom is always `z_from - 16`. z_from = FORTS_GROUND_Z puts
    # that at -16, inside the ground slab (-144..0) and inside the fort wall
    # (x 64..96), which the guard reported as 24 then 18 overlapping pairs.
    # Starting the run at ground + 16 rests the whole flight ON the ground and on
    # nothing else.
    # 24 steps, not 6, and each tread 64 deep in y rather than split in x.
    #
    # The run was 64 wide in x over 6 steps: each tread came out 10.7 wide and
    # 40 TALL. A player cannot climb that: the hull is 32 wide, so it cannot sit
    # on a 10.7-wide tread at all, and a 40 rise is above Quake's ~32 step-up.
    # map_route refused the roof with "the closest reachable cell is 96u from the
    # target", which is what a stair you cannot walk up looks like.
    #
    # Now: 64 deep per tread along y, rising 10 each. Both well inside what a
    # player walks up without jumping, which is the point.
    # along="y" needs no mirror: y is never mirrored, so the treads' x span is
    # already the one stairs() was given (wall_x), and flip_x would move them off
    # the stairwell. is_symmetric() reported the mismatch.
    #
    # `world_scale` is what makes the step COUNT grow instead of the step HEIGHT:
    # 12 steps of design rise becomes as many steps of world rise as PLAYER_RISE
    # allows (27 at scale 2.0), and the run was lengthened above to pay for them.
    # forts_mirrored is passed even though along="y" never flips x: it is how the
    # flight record knows which fort it belongs to (FORTS_FLIGHTS), and a record
    # that says "fort A" for fort B's flight makes a checker measure fort A twice.
    # THE BATTLEMENT IS A RAMP (0341 item 2, 0395). One solid wedge from the hall floor
    # to the parapet: 480 of design run for 256 of rise is 28.1 degrees, inside the
    # owner's 30, and 128 world wide against the 128 asked for. It replaces 27 treads of
    # 33 world, which the hull always overlapped -- and the foot, which used to be a
    # whole riser ABOVE the hall floor because every tread was a slab resting on the one
    # below, is now flush with it.
    #
    # IT IS SOLID FROM THE BED. It stands on the hall floor, so a wedge with thickness
    # only at its low end would leave the wedge's own underside open to the basement; and
    # a hollow ramp over a hole in the floor is the owner's "fall in and stuck" with a
    # new coat on. The floor is cut for its footprint (forts_ground reads
    # FORTS_PARAPET_X for exactly that) and this fills the whole of what was cut.
    #
    # The low end is one riser above the hall floor, for the reason in forts_stairwell: a
    # surface that meets its own underside is a knife edge and a knife edge is not a
    # brush. 16 world, inside PLAYER_RISE.
    _riser = 16 / FORTS_SCALE
    # sx0/sx1, NOT the constant: they are wall_x()'s, so they are already the mirrored
    # span, which is what every other piece of this function uses. Built from the
    # constant instead, fort_geometry(True) put its ramp at x 96..160 -- fort A's
    # ramp -- and the symmetry check named it: "3 boxes in A and 3 in B have no mirror,
    # e.g. (96, 288, -144, 160, 768, 272)".
    B.append(ramp_box(sx0, sy0, FORTS_BED_Z, sx1, sy1,
                      FORTS_GROUND_Z + _riser, FORTS_TOP_Z,
                      TEX_FLOOR, along="y"))
    # THE RAMP'S OPEN SIDE IS WALLED (0341: "walled or railed on their open sides").
    # West is the fort's own wall; east is the hall, and a ramp 113 above the floor with
    # nothing beside it is a fall anyone takes by accident. It is a full wall rather than
    # a rail because the flight is 128 wide: a rail would stand on the ramp's own slope,
    # which is another slope, and the ramp would lose clear width to it.
    #
    # It stops at FORTS_ROOF_Z, the roof's own underside: the roof strip already covers
    # x sx1..ix1 over this y range, so a wall to FORTS_TOP_Z would be 32 of solid inside
    # the roof and the overlap guard would refuse the map.
    # IN TWO PIECES, because the stairwell already builds its own rail in the middle of
    # this span at exactly this x: forts_stairwell's west rail is x 160..192, y 592..704,
    # and one wall from 288 to 768 would be 112x64 of solid inside it -- two overlapping
    # pairs, refused. The barrier is continuous either way; it is just built by two walls
    # that each own their own length, which is the rule this whole map is built on.
    # ON THE SIDE FACING THE HALL, which is a DIFFERENT SIDE on each fort: the ramp is
    # against the outer wall, so for fort A the hall is east of it and for fort B west.
    # Written as "east of sx1" it put fort B's rail outside its own wall, and the
    # symmetry check named the box: "2 boxes in A and 2 in B have no mirror, e.g.
    # (160, 288, 0, 192, 592, 224)".
    _hall_east = (ix0 + ix1) / 2.0 > (sx0 + sx1) / 2.0
    _rx0, _rx1 = ((sx1, sx1 + FORTS_STAIR_WALL) if _hall_east
                  else (sx0 - FORTS_STAIR_WALL, sx0))
    _gap0 = FORTS_STAIR_Y[0]
    _gap1 = FORTS_STAIR_Y[1] + FORTS_STAIR_WALL
    for (_y0, _y1) in ((FORTS_PARAPET_Y[0], _gap0), (_gap1, FORTS_PARAPET_Y[1])):
        if _y1 > _y0:
            B.append(box(_rx0, _y0, FORTS_GROUND_Z,
                         _rx1, _y1, FORTS_ROOF_Z, TEX_WALL))
    FORTS_FLIGHTS.append({
        "name": "parapet ramp",
        "ramp": True,
        "n": 1,
        "width": (sx1 - sx0) * FORTS_SCALE,
        "run": (sy1 - sy0) * FORTS_SCALE,
        "rise": (FORTS_TOP_Z - FORTS_GROUND_Z - _riser) * FORTS_SCALE,
        "box": (min(sx0, sx1), sy0, max(sx0, sx1), sy1,
                FORTS_GROUND_Z, FORTS_TOP_Z),
        "tread_axis": "y",
        "mirrored": mirrored,
    })
    return B


def crenellations(a0, a1, b, base, mh, along="x", merlon=32, gap=32):  # noqa: E501
    """Merlons along one edge: `merlon` of wall, `gap` of opening, repeating.

    Each merlon is its own box standing on `base`, so no two share volume -- the
    overlap guard is the arbiter of this whole file and it would (and did) refuse
    a map built any other way.
    """
    out = []
    span = a1 - a0
    if span <= 0:
        return out
    pitch = merlon + gap
    n = max(1, int(span // pitch))
    for i in range(n):
        a = a0 + i * pitch
        e = min(a + merlon, a1)
        if e - a <= 0:
            continue
        # 16 thick, INSIDE the edge b: a merlon centred on the wall line would
        # sit half in the wall, which is an overlap, not a decoration.
        if along == "x":
            out.append((a, b, base, e, b + 16, base + mh, TEX_WALL))
        else:
            out.append((b, a, base, b + 16, e, base + mh, TEX_WALL))
    # Drop anything degenerate rather than emit it: a box with two equal faces has
    # no normal on one plane, and qbsp then hangs in ProcessMapBrushes with
    # "Brush plane with no normal" instead of failing cleanly.
    return [b for b in out if b[0] < b[3] and b[1] < b[4] and b[2] < b[5]]


def forts_vault(mirrored):
    """The basement key vault, at the deep end of each fort's underwater passage.

    This replaces vault_geometry(), which was written for the OLD map and is not
    called there either. It is here because the forts already have the thing the
    vault needs: a way down from inside the fort to a level below it. The passage
    IS the descent, so the vault is the room at the bottom of it rather than a
    second hole in the ground with its own pit-prone stair.

    Two ways in, per GAME-DESIGN.md "each team's key sits in a vault in its
    castle's basement ... one main way in plus one narrower one, so it can be
    defended but not sealed":
      * the passage itself, the main way in
      * a narrow crawl from the channel bed, so a defender who holds the passage
        is not holding the key

    Everything is built in LOCAL x and mirrored here, like the fort.
    """
    B = []
    z = FORTS_VAULT_Z

    def X(v):
        return (FORTS_LEN - v) if mirrored else v

    def box_l(x0, y0, z0, x1, y1, z1, tex):
        """A box in local x, mirrored."""
        a, b = sorted((X(x0), X(x1)))
        return (a, y0, z0, b, y1, z1, tex)

    # The vault room, x 208..432 y 448..512, at the passage's own level. The
    # passage already brings you to z from -128 (its floor) so the room is at that
    # level and there is no new hole in the ground to get wrong.
    vx0, vx1 = 208, 432
    vy0, vy1 = 448, 512

    # The room's floor and ceiling are the passage's own slabs, so neither is
    # emitted: a second one would interpenetrate them and the overlap guard would
    # refuse the map. What the vault adds is what the passage does not have -- a
    # second way in.
    #
    # The pedestal, so the key is not lying on the floor in the open. 48 tall, in
    # the middle of the room, clear of both side walls by 64 so a player can walk
    # round it.
    # NO PEDESTAL. There was a 48-tall plinth at x 304..352, and the key sits at
    # x 328 -- inside it. So the plinth was not scenery, it was a wall across the
    # only path to the key: a player walking +x along the vault floor at z -104 has
    # their hull at -128..-80, which is inside a box spanning -128..-80. The key was
    # unreachable on foot, in both vaults, and the in-engine walk stopped dead at
    # x 232 with the key 96 units away.
    #
    # It also fought the item path: a 32-tall key resting on a 48-tall plinth in a
    # 48-tall room has nowhere to be. The key is a pickup lying on the floor, which
    # is what a pickup in a vault is.

    # The second way in: a narrow stair from the fort floor down into the vault,
    # running in y beside the passage rather than through it. The shaft is
    # FORTS_PASSAGE_Y wide (128) for exactly this: the passage takes 448..512 and
    # this takes 512..576.
    #
    # The first attempt ran it in +x out of the passage end, which put it straight
    # through the fort's channel-side wall (x 448..480) -- 26 overlapping pairs.
    # There is no way out of the fort's bottom in +x at all: the wall is solid from
    # the bed at -144 to the roof.
    # The stair bay, in the shaft's second half. The passage keeps 448..512; this
    # takes 512..736, so the flight has 224 of run for its 128 of rise. It was
    # 512..576 -- 64 of run -- and the flight came out with 9.1-deep treads, which a
    # 32-deep hull cannot stand on (0226 C, the "compressed stairs").
    # The bay starts where the passage ENDS, not at a hardcoded 512: the passage is
    # now 128 wide (448..576) to make the vault a room (0226 D), and a bay starting
    # at 512 would be inside the passage.
    # The bay runs to 784, not to the shaft's end at 800: the fort floor keeps a
    # 16-wide lip north of the shaft so the two do not meet in a zero-depth box, and
    # the flight's top tread has to arrive BELOW that lip, or it is inside the floor.
    # 16 rather than 32 because the lip's width is run the stair does not get: at a
    # 32-wide lip the bay had 192 of run and 6 steps gave 21.3 of rise, over the 20 a
    # player steps up. A 16-wide lip gives 208, so 6 steps give 34.7 of tread and
    # 21.3 -- still 21.3. 7 steps of 208 is 29.7 of tread. So the answer is the
    # shaft: keep the lip at 16 and run the flight over the PASSAGE as well.
    # NO DOG-LEG (reviewer 0270: "don't squeeze the stair into the old bay ... the
    # bay is a leftover of the old design, and nothing about it is fixed"). What
    # replaces it is forts_stairwell(): one straight flight, 18 steps, walled both
    # sides, and the corridor floor is flat again because the flight ENDS on it
    # instead of starting from it.
    cy0, cy1 = FORTS_PASSAGE_Y[1], 784
    # At the passage's OUTER end (x 384..448), which is where the passage's side
    # walls have been cut back. At the inner end (x 208) the stair was behind that
    # wall, which spans 144..384 -- 26 overlapping pairs.
    sx_a = FORTS_PASSAGE_X[1] - FORTS_VAULT_STAIR_W
    # The flight, from the vault floor up to the fort floor: 224 of run for 128 of
    # rise over 7 steps is 32 of tread and 18.3 of rise.
    #
    # It was 11 steps over 64 of run -- 5.8-deep treads rising 11.6 -- which is not a
    # staircase but a ladder, and a 32-deep player hull cannot climb it. That is the
    # owner's "I can't get out of the basement because the stairs are compressed"
    # (0226 C). 11 was chosen because 11.6 and 11 "looked like" walkable numbers
    # against a 48-tall hull; against the real 56 with a 32-deep tread it is not.
    #
    # No separate landing at the bottom: the flight's first step rests on the vault
    # floor and a landing box on top of it was 18 overlapping pairs.
    # THE DOG-LEG IS GONE (reviewer 0270). It was here because the bay could not
    # hold a compliant single flight: 448 of world run for 288 of rise is 14 steps
    # by tread and 18 by rise, so the flight had to turn, and the turn is what the
    # owner kept falling into -- its top tread landed 48 short of the fort floor, so
    # a player at the top of the stair had one way out and it was a jump.
    #
    # What replaces it is forts_stairwell(): a straight flight of 18 steps in a
    # walled shaft that ENDS on the corridor floor, so this room is a flat-floored
    # corridor again and the way in and the way out are the same stair. The vault
    # keeps its two ways in: that stair and the underwater passage.
    return B


def forts_stairwell(mirrored):
    """The straight stairwell: 18 treads from the fort floor down to the corridor.

    One flight, walled on both sides, open above, and it ENDS flush with the corridor
    floor so the last step onto it is a step and not a drop. Every number here is the
    arithmetic in FORTS_STAIR_X's comment; nothing is a fudge:

      18 treads x 16 design of run  = 288, the whole run, with no remainder
      18 steps  x 8 design of rise   = 144, the whole drop, bed to ground
      80 design of width            = 160 world, over the 128 asked for

    The treads are SLABS 16 thick, not solid masses. That is what leaves the shaft
    open above each one: a solid staircase would put the fort floor's own underside
    16 above the second tread, and the player would be walking with their head in
    the slab. Slabs also cannot overlap -- consecutive treads share a face at an
    x edge and nothing else -- which the generation-time guard confirms.
    """
    B = []
    T = FORTS_STAIR_WALL
    sx0, sx1 = FORTS_STAIR_X
    sy0, sy1 = FORTS_STAIR_Y

    def X(v):
        return (FORTS_LEN - v) if mirrored else v

    def bx(x0, y0, z0, x1, y1, z1, tex):
        a, b = sorted((X(x0), X(x1)))
        return box(a, y0, z0, b, y1, z1, tex)

    # The north wall, from the bed to the fort floor, over the WHOLE run.
    #
    # It stopped one tread short of the flight's east end, on the theory that the gap
    # was "the MOUTH -- the normal door at the top". It is not: the mouth is the
    # flight's EAST side, where its top tread stands flush with the fort's own floor
    # at x 576 and a player steps off it in one stride. The gap this left was on the
    # NORTH side, and the hall floor is cut away over the whole shaft, so it was a
    # 32 x 32 hole in the floor with nothing under it but the sealed void beneath the
    # flight: a player who walked north off the top tread fell 288 into a pocket whose
    # only way out is back up the flight. 192 of those cells were the last of what the
    # trap check reported. So the wall runs the whole run and the mouth is the east.
    B.append(bx(sx0, sy1, FORTS_BED_Z, sx1, sy1 + T, FORTS_GROUND_Z,
                TEX_WALL))
    # BOTH long sides, bed to ceiling (0311 item 2, 0318 item 1). There was one wall,
    # on the north side only, so the shaft was open along its whole south face: the
    # spawn walk went north up the hall at x=480 and dropped straight through it
    # (480,1207,2.6 -> 480,1201,-51 -> 480,1178,-231 -> bed), and a player could walk
    # off a tread sideways into the channel. The only openings now are the top landing
    # at the flight's east end and the bottom door at the landing.
    #
    # The south wall runs the landing's length as well as the flight's, so the landing
    # is a room and not a shelf.
    # NOT a south wall here: the passage's own north wall IS the shaft's south side
    # (both occupy y 560..592), and emitting a second one is 4 overlapping pairs. What
    # the shaft's south side still needs is for that wall to run the shaft's whole
    # length -- it stops at x=512, where the vault's stair begins, leaving 512..576 of
    # the flight's north... south side open. That is fixed in forts_passage, not here.
    # ... and the north wall over the landing too, for the same reason: without it the
    # landing opens straight off the hall floor with nothing at all between.
    B.append(bx(FORTS_STAIR_LANDING_X[0], sy1, FORTS_BED_Z,
                FORTS_STAIR_LANDING_X[1], sy1 + T, FORTS_GROUND_Z, TEX_WALL))
    # A RAIL ON THE HALL FLOOR, which is the only thing that stops a walker (0324).
    # The walls above are all BELOW z=0: they wall the shaft from the corridor, not
    # from the hall, and the trace showed the difference exactly -- the spawn walk went
    # north at x=480 and stepped straight off the hall floor's edge into the shaft
    # (480,1207,2.6 -> 480,1201,-51 -> 480,1178,-231 -> bed). A wall that protects a
    # walker has to stand where the walker is.
    #
    # Three sides: south, north and west, 64 tall (a parapet rail, not a wall to the
    # roof -- the shaft is open above and the fort is open to the sky, so a full wall
    # would be a roof with no light in it). The FOURTH side, the east, is the mouth:
    # the landing at floor level, and the flight's top tread flush with it. That is the
    # only way in, and it is a walk, not a step.
    #
    # They sit ON the slab (z 0..64), so they share only the plane z=0 with the walls
    # below and cannot overlap them.
    rx0 = FORTS_STAIR_LANDING_X[0] - T
    rx1 = sx1
    ry0, ry1 = sy0, sy1 + T
    RAIL = 64
    B.append(bx(rx0, ry0 - T, FORTS_GROUND_Z, rx1, ry0, RAIL, TEX_WALL))
    B.append(bx(rx0, ry1, FORTS_GROUND_Z, rx1, ry1 + T, RAIL, TEX_WALL))
    B.append(bx(rx0 - T, ry0, FORTS_GROUND_Z, rx0, ry1, RAIL, TEX_WALL))
    # The landing's west end, so the shaft is a room with two openings rather than a
    # corridor into the void under the hall floor.
    B.append(bx(FORTS_STAIR_LANDING_X[0] - T, sy0, FORTS_BED_Z,
                FORTS_STAIR_LANDING_X[0], sy1 + T, FORTS_GROUND_Z, TEX_WALL))
    # No end wall at the bottom: the run now ENDS at the door (x 336..384, with the
    # flight's last tread at 368..384 under it), so the wall there would be the
    # passage's own wall corner. And none at the top either -- that end is the mouth,
    # against the fort's west wall, which is what the player walks away from.

    # THE FLIGHT IS A RAMP (0341 item 2, 0395). One wedge, from the bed at its low end
    # to the fort floor at its high end, 288 of design run for 144 of rise -- 26.6
    # degrees, inside the owner's 30, and 160 world wide against the 128 asked for.
    #
    # It was 18 treads of 32 world, and the owner's complaint about it was never the
    # look of it: a 32-deep hull on a 32-deep tread always overlaps the next one, so
    # the stair rule and the engine legs disagreed about the same corner pair, and the
    # parapet's foot came out a STEP UP off the hall floor. A slope has no treads to
    # miss, and there is nothing for a hull to clip.
    #
    # It is ONE solid wedge from the bed, not a slab with air under it. The treads were
    # slabs standing on the bed, so between them there was a wedge of space 256 deep at
    # the top end and nothing at all at the bottom, SEALED at both ends and both sides
    # -- 48 cells a side that the no-traps check called "a place they can fall into and
    # not get out of". Solid from the bed is the same mass of world and no pocket.
    #
    # Rising with x: the foot is at sx0, on the landing, which is the bed; the head is
    # at sx1, flush with the fort floor, so walking off it is a stride and not a step.
    # The FOOT IS ONE RISER ABOVE THE BED, and that is forced, not chosen. A ramp whose
    # surface meets its own underside has a knife edge there, and a knife edge is not a
    # brush: the end face's three points include two identical ones, every plane through
    # them is collinear, and qbsp says "Brush plane with no normal" four times. The only
    # way out is for the wedge to have thickness at its low end, and the space under the
    # bed is the hull's own slab, so the thickness has to come from ABOVE: the surface
    # starts one riser up.
    #
    # One riser is 16 world, which is inside PLAYER_RISE (18) -- the same 16 the bottom
    # tread of the staircase this replaced stood at, so nothing the owner could walk
    # before has become unwalkable. The HEAD is genuinely flush: the ramp's surface at
    # sx1 is 0, the fort floor's top at x 576..640 is 0, and the two are the same plane.
    _riser = 16 / FORTS_SCALE
    B.append(ramp_box(sx0, sy0, FORTS_BED_Z, sx1, sy1,
                      FORTS_BED_Z + _riser, FORTS_GROUND_Z, TEX_FLOOR, along="x"))
    # Say what this flight IS, the way stairs() does for the other two. This one is
    # emitted by hand, so it never registered itself, and FORTS_FLIGHTS claimed the map
    # had two flights when it has three. The checks read that list to decide what is a
    # ramp and what is a ledge, so with it missing they reason about a map with no
    # stairwell in it.
    _rrun = (sx1 - sx0) * FORTS_SCALE
    FORTS_FLIGHTS.append({
        "name": "vault ramp",
        "ramp": True,
        "n": 1,
        "width": (sy1 - sy0) * FORTS_SCALE,
        "run": _rrun,
        "rise": (FORTS_GROUND_Z - FORTS_BED_Z) * FORTS_SCALE,
        "box": (sx0, sy0, sx1, sy1, FORTS_BED_Z, FORTS_GROUND_Z),
        "tread_axis": "x",
        "mirrored": mirrored,
    })
    return B


def forts_water_steps():
    """One flight of steps out of the channel per fort, on the north bank.

    The owner's "fall off the bridge and have to find a tunnel" is 0246's complaint
    about the water, and 0330 settled it: falling off the bridge must not be a trap.
    The answer is the passage, which is open at both ends of the channel and is the
    design's own "underwater way in", and this flight, which gives a swimmer
    somewhere to stand out of the water on the same bank.

    Two numbers decide everything here:

      * The water's surface is `FORTS_WATER_TOP` = -24 design, and a swimmer can step
        out onto a bank no more than **24 world** above it. So a flight that ends flush
        with the ground (0) is **48** above the surface and is NOT an exit -- which is
        why the first version of these, climbing to the ground, would have looked right
        and been a trap. The top of each flight is a LANDING at **-16 design**, 16
        world clear of the limit.
      * The flight climbs the bank **along y**, because the bank is long in y and short
        in x: a run 64 wide in x over 6 steps is a ladder, not a staircase (treads 21
        deep, rising 45) and no player can climb it.

    The landing is walled on its channel-facing side, so a swimmer cannot walk into the
    flight from the side and off the bottom of it, and the flight's foot stands on the
    bed where the swimmer already is. Why there is one flight and not two, and why it
    is on the north bank, is the arithmetic below rather than a preference.
    """
    B = []
    T = FORTS_WALL_T
    bed = FORTS_BED_Z
    bx1 = FORTS_FORT_X1
    cx0 = bx1                              # the flight stands against the bank
    width = 64                             # 128 world, the reviewer's figure
    # -16, not -8. The check's own swim rule (0330) is that a swimmer escapes by
    # stepping onto a bank no more than **24 WORLD** above the surface, and the
    # surface is at -24 design, so the top tread's top has to be at -12 design or
    # lower. At -8 it was 32 world up, which is outside the rule: the flight's top
    # tread was a ledge in the middle of the channel that a swimmer could climb to
    # and not get anything from. -16 design is 16 world clear of the limit.
    land_z = -16
    by0, by1 = FORTS_BRIDGE_Y
    # 256 of run over 16 steps is 32 of world tread and 16 of rise: both legal. The
    # first version ran 192 and the generator said so ("24.0 of world tread, under the
    # 32 a hull can stand on"), and it is worth saying why more steps is the wrong cure:
    # more steps over the same run makes each tread SHALLOWER.
    #
    # ONE flight, on the north bank, and the arithmetic for why there is not a second
    # one is worth keeping because it was measured rather than preferred:
    #
    #   a flight has to clear the bed (256 of world rise) to a landing within 24 of
    #   the surface, so it needs >= 15 steps, and >= 32 of world tread each, so >= 240
    #   of design run. Its foot must be in OPEN water, and its top tread must be clear
    #   of anything above it -- a hull standing on a tread reaches 16 of y past it.
    #
    # The north bank, y 576..832, is 256 of run with open water at its foot (the
    # channel north of the passage mouth) and nothing overhead at its top. It fits
    # exactly. It also used to start at by1+32 = 448, which is FORTS_PASSAGE_Y[0]
    # exactly: it ran over the top of the underwater way in from one end to the other
    # and, being solid from the bed to its landing, it was a wall across the channel in
    # front of the mouth. A swimmer at the bed could not reach the doorway at
    # x 640..672 at all, which was most of the trap count.
    #
    # The south bank cannot hold one, and that is not a preference. South of the
    # bridge the bank runs y 16..272 between the hull's south wall and the bridge's
    # own railing, which is where the railing is: it sits at by0-16..by0, on the deck's
    # south edge. 272 of run needs a foot clear of the hull wall (16) and a top tread
    # clear of the railing by a hull (16), so it needs 240 of run between y 32 and
    # y 256 -- and 240 of run is 15 steps of exactly 32.0 of world tread, on the limit
    # rather than over it, with the top tread at y 240..256 whose player's hull reaches
    # y 272 and so is inside the railing. Taking the rail instead of the wall does not
    # help: the flight then ends under the deck, whose underside at -16 is exactly the
    # tread's top, so the tread is not a surface a hull can stand on. There is no legal
    # flight there.
    #
    # So the south half of the channel has no steps, and it does not need them: the
    # passage mouth is the channel's exit, it is open, and it is on the same water.
    # What the south steps were really costing is in the trap count -- a flight whose
    # foot is against the hull wall and whose channel side is walled off is a sealed
    # pocket of water, and a player who drops off the bridge's railing falls into it.
    assert FORTS_PASSAGE_Y[1] + 256 <= 832, (
        f"the north water flight would run off the bank: "
        f"{FORTS_PASSAGE_Y[1]}..{FORTS_PASSAGE_Y[1] + 256} against a fort whose "
        f"channel-side wall ends at y 832")
    # The landing and the steps run NORTH of the flight's own run, in the open
    # water north of the fort: they have to stay inside the map's own width.
    assert FORTS_PASSAGE_Y[1] + 256 + 128 <= FORTS_WID, (
        f"the water ramp's landing and steps would run off the map: "
        f"{FORTS_PASSAGE_Y[1] + 256}..{FORTS_PASSAGE_Y[1] + 256 + 128} against an "
        f"interior that ends at y {FORTS_WID}")
    for (y0, _y1) in ((FORTS_PASSAGE_Y[1], FORTS_PASSAGE_Y[1] + 256),):
        # A RAMP, one solid wedge from the bed (0341 item 2). 256 of design run for
        # land_z - (bed + one riser) = 136 of rise is 28.0 degrees, and it is 128 world
        # wide. It replaces 16 steps whose treads were exactly the hull's width, so a
        # 32-deep hull always overlapped the next one -- the same complaint as the vault
        # flight, and the same cure.
        #
        # One riser at the FOOT, for the reason in forts_stairwell: a wedge whose surface
        # meets its own underside is a knife edge, and a knife edge is not a brush. Here
        # the swimmer arrives on the bed, so the riser is the first thing they step up
        # onto -- 16 world, inside PLAYER_RISE.
        _riser = 16 / FORTS_SCALE
        B.append(ramp_box(cx0, y0, bed, cx0 + width, y0 + 256,
                          bed + _riser, land_z, TEX_FLOOR, along="y"))
        FORTS_FLIGHTS.append({
            "name": "water ramp",
            "ramp": True,
            "n": 1,
            "width": width * FORTS_SCALE,
            "run": 256 * FORTS_SCALE,
            "rise": (land_z - bed - _riser) * FORTS_SCALE,
            "box": (cx0, y0, cx0 + width, y0 + 256, bed, land_z),
            "tread_axis": "y",
            "mirrored": False,          # forts_map() mirrors this one itself
        })
        # THE LANDING, LENGTHENED ALONG Y (owner, 2026-10-09: "the side ramp out
        # of the water should work"). The ramp's top WAS the landing: a slope
        # that touched -16 design only at its own last row, a shelf 32 world
        # below the bank top, which a swimmer could stand on and do nothing
        # with. So the landing is a flat tread now, 64 design = 128 world of it,
        # at the same -16 the swim-exit rule is written against -- the swimmer
        # gets OUT of the water here exactly as before, and now has somewhere to
        # stand while they decide what is next.
        land_run = 64
        B.append(box(cx0, y0 + 256, bed, cx0 + width, y0 + 256 + land_run,
                     land_z, TEX_FLOOR))
        # THE TWO STEPS, from the landing onto the bank top: -16 -> -8 and
        # -8 -> 0 design, 16 world of rise each -- a step, not a jump -- and
        # treads 32 design = 64 world deep, twice the 32 a hull needs to stand
        # on. Solid from the bed like the ramp is: standing IN the water, these
        # are piers, which the overlap guard allows by design (the water is not
        # solid), and a pocket nobody should be in does not get built under
        # them. The bank's own top is at 0 and its east face stands at x = cx0,
        # so the last step is FLUSH with it: the player walks west onto the
        # bank, and the whole climb out of the channel is steps and a ramp.
        B.append(box(cx0, y0 + 256 + land_run, bed, cx0 + width,
                     y0 + 256 + land_run + 32, -8, TEX_FLOOR))
        B.append(box(cx0, y0 + 256 + land_run + 32, bed, cx0 + width,
                     y0 + 256 + land_run + 64, FORTS_GROUND_Z, TEX_FLOOR))
        # Walled on the side that faces the channel -- the flight's OPEN side -- so a
        # swimmer cannot walk sideways into the flight off a tread and off the bottom
        # of it. Its top tread IS the exit: at land_z it stands 16 world clear of the
        # water's surface, which is the check's swim rule, and open water lies north
        # of it, so a player on the top tread can step off it into the channel and a
        # swimmer can climb to it and stand out of the water.
        # The wall runs the landing's and the steps' length as well: they are the
        # flight's own top now, and the same rule shields them -- a swimmer in the
        # channel meets a wall, not a step, on this whole face.
        B.append(box(cx0 + width, y0, bed, cx0 + width + T,
                     y0 + 256 + land_run + 64, FORTS_GROUND_Z, TEX_WALL))
    return B


def forts_channel():
    """The water channel, and the bridge over it.

    The water is one *water brush spanning x 480..1568 -- between the two forts --
    and y the full width, from z -80 (the passage floor) to z 0. It overlaps no
    solid brush: the forts' channel-side walls stop at x=480 and start again at
    1568, and the slab is at -96..-80.

    The bridge is a walkway over it at ground level. It is solid and it overlaps
    nothing, because the water is not solid.
    """
    B = []
    # From the BED, not from -80: water that does not reach the floor is a lid
    # the player walks under (0142).
    B.append((FORTS_FORT_X1, 0, FORTS_BED_Z, FORTS_LEN - FORTS_FORT_X1,
              FORTS_WID, FORTS_WATER_TOP,
              TEX_WATER))
    # The deck is level with the ground, so stepping off it drops you into the water
    # and walking on to it is not a step at all (see FORTS_BRIDGE_Z).
    by0, by1 = FORTS_BRIDGE_Y
    # BUILT DOWNWARD from the walking surface, so its TOP is FORTS_BRIDGE_Z. It was
    # built upward from it, which put the deck you walk on 16 above the ground on
    # both sides -- a 32-unit step out of the fort and onto the bridge, over the 18
    # a player walks up. The door check calls that by name: "the two floors are one
    # continuous walk".
    #
    # And it starts at the wall's INNER face (448), not at the channel's edge (480):
    # the wall is 32 thick and the door is cut clean through it, so a deck starting
    # at 480 left the whole threshold open to the bed 352 below. The floor inside
    # stops at the wall and the deck started 64 further on, and the way onto the
    # bridge was to step off an edge. The deck fills the threshold, which the wall's
    # own gap leaves empty -- so it overlaps nothing (the guard still reports 0).
    # The wall's INNER face, derived: it was the literal 448, which is 128 short of
    # where the wall now is, so widening the fort left the deck starting inside the
    # fort's own floor -- one overlapping pair, which is what the guard reported.
    bx0, bx1 = FORTS_FORT_X1 - FORTS_WALL_T, FORTS_LEN - (FORTS_FORT_X1 - FORTS_WALL_T)
    B.append(box(bx0, by0, FORTS_BRIDGE_Z - 16, bx1, by1,
                 FORTS_BRIDGE_Z, TEX_FLOOR))
    # THE THRESHOLD IS FILLED SOLID, from the bed up to the deck (0325, option 1).
    # The wall's doorway is a hole clean through the wall, and the deck sits at the top
    # of it, so between the bed and the deck's underside there was a dry pocket the
    # width of the wall that a swimmer could reach from the channel and could not leave:
    # the deck is 288 above them. That was every remaining trap cell. Filling it is
    # better than walling it -- a pocket nobody should be in should not exist -- and it
    # leaves the water's way into the fort as the underwater passage alone.
    #
    # The standing rule this encodes: every place a swimmer can reach is water, or the
    # underwater passage, or has a walkable exit. No dry pockets at the bed.
    # ... at BOTH ends of the channel, not one (0403). The check "the map is side A plus
    # mirror_half(A)" named this exact brush: (640,288,-144,672,416,-16) had no mirror
    # twin. forts_channel() is the one function that is not per-side -- it owns the water
    # and the deck, which span the gap -- so a fill written here once is at ONE fort's
    # threshold only. One fort's water entrance was solid and the other's was not, which
    # is the owner's last real bug ("one fort working and the other not") in a new coat.
    # The two spans are the wall's thickness measured INWARD from each fort's outer
    # face: 640..672 and 1760..1792. Writing the second as `_fx1 - T .. _fx1` put it at
    # 1728..1760, which is 32 short of its own mirror -- the check caught that too, which
    # is the second time in this commit that naming the brush found the mistake.
    for _a, _b in ((FORTS_FORT_X1 - FORTS_WALL_T, FORTS_FORT_X1),
                   (FORTS_LEN - FORTS_FORT_X1, FORTS_LEN - FORTS_FORT_X1 + FORTS_WALL_T)):
        B.append(box(_a, by0, FORTS_BED_Z, _b, by1, FORTS_BRIDGE_Z - 16, TEX_FLOOR))
    # Railings, so it reads as a bridge. Two boxes, split rather than overlapping
    # the deck. The railings start at the channel's edge (480), not at the wall's
    # inner face: the fort's own wall is already there, at the same height, for the
    # last 32.
    #
    # THE RAIL IS A RAIL AND NOT A WALL (reviewer 0527 item 3). It was 48 DESIGN
    # units, which is 96 world at FORTS_SCALE 2 -- and 96 is more than a Quake jump
    # clears (~45 of rise at 270 initial velocity against 800 of gravity), so the
    # bridge's edge was a wall you could not get over. The owner asked for the
    # opposite: "a player can jump into the water". GAME-DESIGN.md's swim rule is
    # that the channel is a place you can be put in on purpose, and the only way in
    # from the deck was to walk off the END of the bridge inside a fort.
    #
    # So the rail is 12 design = 24 world, which is the band the reviewer set: above
    # 18 so it still reads as a rail and still stops a walking player from stepping
    # straight off the side, and at or below 32 so a jump clears it with room to
    # spare. 24 is the arithmetic, not a guess: the jump peaks at 45.6, so a 24-high
    # rail is crossed at about half the air time, with ~100 world of horizontal
    # travel still available to cross the rail's own 32 of thickness.
    #
    # What this gives up is on purpose: the walk leg in tests/walk_routes.js used to
    # assert "the player cannot walk off the bridge" at each rail, which this rail
    # made true by being a wall. That claim is now the wrong claim for the bridge
    # (and still the right one for the battlement's merlons), and the leg says so
    # instead: over the rail is into the water, and the water is a way out.
    B.append(box(FORTS_FORT_X1, by0 - 16, FORTS_BRIDGE_Z,
                 FORTS_LEN - FORTS_FORT_X1, by0,
                 FORTS_BRIDGE_Z + FORTS_BRIDGE_RAIL, TEX_WALL))
    B.append(box(FORTS_FORT_X1, by1, FORTS_BRIDGE_Z,
                 FORTS_LEN - FORTS_FORT_X1, by1 + 16,
                 FORTS_BRIDGE_Z + FORTS_BRIDGE_RAIL, TEX_WALL))
    return B


def forts_passage(mirrored):
    """The underwater passage into one fort's bottom.

    Built as SPACE between two wall brushes, never as a fill with a hole cut in it.
    That distinction is the whole lesson of this map: the old layout's under-floor
    stack was a solid fill with holes cut in it, and it carried 116 overlapping
    brush pairs and came within one map of hanging qbsp (maps/SKY-ATTEMPT.md).
    """
    B = []
    T = 16
    y0, y1 = FORTS_PASSAGE_Y
    # z0 is the BED, and it is also the walking surface: see the note on the missing
    # floor slab. z1 is the ceiling, FORTS_PASSAGE_H above it.
    z0, z1 = FORTS_PASSAGE_Z, FORTS_PASSAGE_Z + FORTS_PASSAGE_H
    def X(v):
        return (FORTS_LEN - v) if mirrored else v
    ax, bx = FORTS_PASSAGE_X if not mirrored else (
        FORTS_LEN - FORTS_PASSAGE_X[1], FORTS_LEN - FORTS_PASSAGE_X[0])
    # The corridor's run: from its own inner end all the way to the channel-side
    # wall's INNER face. It stopped at the end of its own boxes (FORTS_PASSAGE_X[1],
    # 576) and the ground slab's band across the last 64 was solid from the bed to the
    # ground -- so the corridor's outer end was a wall of rock, the wall's own doorway
    # opened onto that wall, and the underwater way in was a sealed tunnel on BOTH
    # forts. The door check named it: "gap x1 896..1152: there is a floor on BOTH
    # sides of it ... inside []". The corridor now reaches the wall, so its mouth is a
    # door and not a hole.
    #
    # The side walls run the WHOLE length with it, mouth included. They used to be cut
    # back FORTS_VAULT_STAIR_W at the outer end to leave room for the vault's second
    # stair, and that stair was deleted in 0270 -- so what the cut-back left was 64 of
    # corridor with no wall beside it, which is the slot the corridor check reports as
    # "narrowest 32.0" at (264,424,-80).
    def wx0():
        return X(FORTS_PASSAGE_X[0])
    def wx1():
        # The wall's inner face, in LOCAL coordinates so it mirrors with the rest of
        # this function.
        return X(FORTS_PASSAGE_X1)
    a0, a1 = sorted((wx0(), wx1()))
    # These walls run to the HALL FLOOR, not to the passage's own ceiling (0302).
    # Stopping them at the ceiling left their tops at z=-64 world -- a surface a hull
    # fits on, 224 above the corridor floor and 32 wide, with a sheer drop either
    # side. A player could fall onto one and not get off it on foot, which is the
    # owner's "fall in and stuck" again and was 4805 of the trap cells: every one at
    # z=-40 is an origin standing on exactly that top. Raising them to the floor level
    # makes the top continuous walk with the hall floor beside it, so it is floor and
    # not a ledge. It cannot overlap the ground slab, which is cut out for the whole
    # passage band.
    wtop = FORTS_GROUND_Z
    B.append(box(a0, y0 - T, FORTS_BED_Z, a1, y0, wtop, TEX_WALL))       # side
    # THE OWNER'S OBSTRUCTION (2026-10-09): a solid wall across the passage at
    # its OUTER end, flush against the inner face of the fort's channel-side
    # wall, so nobody swims from the channel into the vault. The owner's words:
    # "just put in an obstruction on the entrance to the key room so one can't go
    # through it for now." The vault stays reachable from INSIDE the fort by the
    # stairwell, and the water ramp onto the bank stays the swimmer's way out of
    # the water. What the mouth becomes is a short dead-end pocket -- the
    # doorway's own volume, the wall's thickness deep -- which a swimmer backs
    # out of; that is not a trap, because its floor is the bed and open water is
    # one stride east of it.
    #
    # The face is DERIVED (FORTS_PASSAGE_X1, the wall's inner face the corridor
    # already runs to) and the thickness is the passage's own wall thickness, so
    # the wall stays flush if either number moves: one number, one place. It
    # spans the passage's own y band and runs from the bed to the passage's
    # ceiling, so the mouth is sealed edge to edge and nothing stands ON it (the
    # ceiling is directly above its top face; there is no surface a hull fits
    # on).
    wa, wb = sorted((X(FORTS_PASSAGE_X1 - FORTS_PASSAGE_WALL_T), X(FORTS_PASSAGE_X1)))
    B.append(box(wa, y0, z0, wb, y1, z1, TEX_WALL))
    # The north side, with THE DOOR at the bottom of the stairwell (0270): the
    # flight's last tread is flush with this corridor's floor, and this is the way
    # in. 96 world wide, which is the door minimum the checks assert, and cut from
    # the bed up to the corridor's own ceiling -- so it is an opening in a wall, not a
    # hole in a floor.
    d0, d1 = FORTS_STAIR_DOOR
    # Both ends LOCAL and mirrored through X(), like everything else in this
    # function. Mirroring the constants by hand put fort B's door at
    # FORTS_LEN - d1 .. FORTS_LEN - d0 while a1 stayed mirrored, so the two wall
    # pieces overlapped each other by 16 -- one overlapping pair, refused.
    # a0/a1 are ALREADY mirrored -- they come out of wx0()/wx1(), which call X() --
    # so mirroring them again is what produced a wall piece from x 384 to 1888 and
    # three overlapping pairs. Only the door's own constants need mirroring here.
    d0, d1 = sorted((X(FORTS_STAIR_DOOR[0]), X(FORTS_STAIR_DOOR[1])))
    # ... and the piece west of it only if the wall starts before the door. BOTH of
    # these guards are needed and neither is enough: the door is at the wall's own end,
    # so exactly one of the two pieces is degenerate -- the east one in fort A and the
    # west one in fort B, because mirroring reverses which end of the wall the door
    # lands on. A box with two coincident faces is what qbsp calls "Brush with duplicate
    # plane", and it is what stopped it cold (forts.map line 1432, then nothing).
    if a0 < min(d0, d1):
        B.append(box(a0, y1, FORTS_BED_Z, min(d0, d1), y1 + T, wtop, TEX_WALL))
    if max(d0, d1) < a1:
        B.append(box(max(d0, d1), y1, FORTS_BED_Z, a1, y1 + T, wtop, TEX_WALL))
    # NOTHING FILLS THE MOUTH. 0325 put a solid box here -- "the pocket beyond the
    # passage's outer end", from x 640 to 672, y 448..576, z -144..-32 -- to kill a
    # dry pocket a swimmer could reach and not leave, and every cell of it was at world
    # x=1312. But that volume IS the wall's own doorway: ring() cuts the channel-side
    # wall at exactly FORTS_PASSAGE_Y from the bed up to the passage ceiling, which is
    # x 640..672, y 448..576, z -144..-32. Filling it sealed the underwater entrance on
    # both forts and made the door check's "a gap with no far side is a hole, not a
    # door" true for the way in that matters most.
    #
    # The pocket is not back, and nothing is needed in its place: the mouth is now the
    # corridor's own last 32 of run, walled both sides and roofed, with its floor the
    # bed and its far end the channel. A swimmer in it walks west into the corridor.
    # That is 0325's own rule honoured in the right place -- a place a swimmer can
    # reach is water, the passage, or has a walkable exit -- instead of filled.
    # NO FLOOR SLAB OF ITS OWN: the hull's bed already is the floor here, and the
    # slab that used to sit on it (z0..z0+T, so its walking surface was 16 above the
    # bed) made the passage a 32-unit ledge above the channel. A swimmer at the bed
    # could not get out of the water into the passage -- 32 is over the 18 a player
    # steps up, and the owner reported exactly that: "fall in and stuck" (0246). A
    # passage whose floor is the bed is flush with the water it comes in under, and
    # the drop out of the water is then a drop DOWN, which is always legal.
    # (Removing it also cannot overlap anything: the bed slab is the hull's, and
    # nothing else is below z = FORTS_BED_Z anywhere under the fort.)
    # Its ceiling stops short of the inner end, where the stairs come up. A
    # ceiling across the whole passage and stairs starting inside it is an
    # overlap, which is what the last 6 pairs were:
    #   (144, 448, -80, 480, 512, -64) and (144, 448, -112, 157, 512, -77)
    # The ceiling now stops SHORT of the stairwell's door. It used to run the whole
    # length of the passage, and where it passes over the new doorway it made the
    # door un-walkable: a player under it is in a corridor 224 tall whose top is
    # 224 above their head, but the cell in the doorway has the ceiling's own top as
    # its only standable surface, and the on-foot fill could not get from the flight
    # into the corridor through it (5189 traps). The door needs sky above it.
    # LOCAL x, mirrored once, like everything else here. Doing the arithmetic on
    # already-mirrored ax/bx put the mirrored fort's ceiling at x 336..1840 and it
    # interposed with the fort's own ground -- 3 overlapping pairs.
    # It runs from the stairwell DOOR east to the vault end, and both ends are
    # DERIVED. They were written as PASSAGE_X[0] + 64 and STAIR_DOOR[0], which only
    # worked while the door was east of the passage's inner end; moving the flight and
    # the passage put them the other way round, and sorted() then turned an inverted
    # interval into a perfectly valid box in the wrong place -- 2 overlapping pairs
    # with the floor, refused.
    # Wall to wall, the WHOLE length of the passage (0303's plan view). It used to run
    # from the door to the vault end, which left the two ends of the corridor uncovered
    # -- world x 448..576 and 1056..1152 -- and those are HOLES IN THE HALL FLOOR: the
    # ground is cut for the passage's whole span, so an uncovered end drops 288 to the
    # bed. The engine walked the spawn's first corner straight into the west one and
    # stalled at (480,912,-264). Nothing short of the full length closes them, because
    # the cut is the full length.
    # cx1 is the WALL's inner face, not the end of the corridor's own boxes: the mouth
    # is part of the corridor and it needs a ceiling as much as the corridor does.
    # Without it the mouth is open to the hall floor above it, and a player in the
    # hall walks over x 576..640 at floor level with nothing between them and the
    # channel -- which is the "fall in and stuck" the rails in forts_stairwell exist
    # to prevent, one bay further east.
    cx0 = FORTS_PASSAGE_X[0]
    cx1 = FORTS_PASSAGE_X1
    a, b = sorted((X(cx0), X(cx1)))
    if b - a > 0:
        # ... and it is built UP TO THE HALL FLOOR, not 16 thick. A 16-thick slab
        # with the ground slab cut away above it left its own top exposed: a
        # 224 x 128 ledge 32 below the hall floor, reachable by dropping off it and
        # impossible to climb back onto, which is what the raised walls handed us in
        # place of the ledge they removed (0302's z=-40 traps became z=-8 ones).
        # Filling to the floor makes the top continuous walk and costs nothing: the
        # corridor's headroom is unchanged, because this is all above its ceiling.
        B.append(box(a, y0, z1, b, y1, FORTS_GROUND_Z, TEX_CEIL))
    # NO FLIGHT HERE, and there never was a working one.
    #
    # There used to be a stairs() call at the passage's inner end, climbing from the
    # passage's CEILING level (FORTS_PASSAGE_Z + FORTS_PASSAGE_H) up to the fort
    # floor. Measuring it in world units is what finally showed what it was: the
    # passage's floor top is -256 and the bottom tread's underside is -96, so the
    # flight hung in mid-air 160 above the floor, inside the shaft, reachable from
    # nowhere. At FORTS_SCALE 1.0 the same gap was 80. Nothing routed through it and
    # no check looked at it, which is why it survived a year of the map being walked
    # and driven; the route checks all start on the fort floor, which is the only end
    # of this flight that touches anything.
    #
    # A flight from the passage floor up to the fort floor does not FIT here, and
    # that is worth writing down rather than rediscovering: the climb is 256 of
    # world rise, which is 15 steps at PLAYER_RISE, and 15 treads of the 32 a hull
    # can stand on is 480 of run. The shaft's bay is 208 of design run = 416 of
    # world, and the corridor it would have to cross is the vault itself.
    #
    # So the way out of the passage is the vault's dog-leg, which is 64 further
    # along and climbs the same 256 with the run it has. The passage is the
    # UNDERWATER way in (the design's "one main way in"), the dog-leg is the way
    # out, and tests/test_forts_map.py routes the channel bed -> passage -> vault ->
    # dog-leg -> fort floor as one walk to keep that true.
    return B


def forts_lights(mirrored):
    """Every light on the map, and WHY each one is there.

    Two kinds, and the distinction is the whole of 0217:

      * SURFACE lights, for the panels. `_surface TEX_LIGHT` tells ericw-tools to
        place an emitter on EVERY face of that texture in the map, so the yellow
        panels in the ceiling actually light the room. `_surface_offset` lifts the
        emitter off the face so it is not inside the geometry.
      * POINT lights, for fill. The sun cannot reach the inside of a fort at all
        (the roof is a slab), and it cannot reach the bottom of a 144-deep channel
        because a gorge has no sky. Those spaces need real lights.

    The owner's complaint was that a panel which looks like a light did not behave
    like one, so the check in tests/test_forts_map.py asserts both: that the
    panels exist as faces, AND that a _surface emitter exists for that texture. A
    panel with no emitter fails.
    """
    E = []

    def X(v):
        return (FORTS_LEN - v) if mirrored else v

    # ONE surface emitter lights every panel in the map, so it does not need to be
    # per-fort. It still has to exist twice over because _surface is per-map, not
    # per-area, and a second one is the belt to the one pair of braces: if the key
    # is ever dropped by a light compile setting, the check catches it and there is
    # a second chance it is not.
    if not mirrored:
        E.append(["light", org(1024, 512, 256),
                  f'"_surface" "{TEX_LIGHT}"',
                  f'"_surface_offset" "{sc(2)}"',
                  '"light" "250"',
                  '"targetname" "panel_emitter"'])

    # FILL, in the spaces the sun cannot reach. All of these are inside a fort or
    # under the map, so none of them is a substitute for a working panel.
    z_hall = 176
    for (lx, ly) in ((240, 336), (240, 640), (160, 640), (240, 480)):
        E.append(["light", org(X(lx), ly, z_hall), '"light" "350"'])

    # The stairs up to the parapet, so climbing is lit.
    for (lx, ly, lz) in ((160, 500, 120), (160, 700, 200)):
        E.append(["light", org(X(lx), ly, lz), '"light" "300"'])

    # The battlement, at parapet height.
    E.append(["light", org(X(240), 512, 300), '"light" "400"'])

    # The passage and the vault. Under the map and inside a trench: no sky at all.
    for (lx, lz, lt) in ((300, -56, "150"), (328, -80, "220")):
        E.append(["light", org(X(lx), 480, lz), f'"light" "{lt}"'])
        E.append(["light", org(X(lx), 544, lz), f'"light" "{lt}"'])

    # The bridge, down in the channel.
    for lx in (560, 880, 1200, 1520):
        E.append(["light", org(lx, 512, 72), '"light" "300"'])

    return E


def forts_entities(mirrored):
    """Spawns, a light and the passage mouth, for one fort."""
    E = []
    def X(v):
        return (FORTS_LEN - v) if mirrored else v
    team = "blue" if mirrored else "red"
    # FOUR SPAWNS A SIDE, all SOUTH of the hole in the floor and facing into the
    # room, because a spawn you fall out of is a spawn that is broken (0259).
    #
    # They used to run y 288..672, and the hole in the fort's ground floor is
    # x 144..448, y 432..784 -- so three of the four stood over it. A player who
    # spawned and walked forward fell 352 into the shaft, which is the owner's
    # "fall in and stuck" from a completely different direction than the one I had
    # been chasing. I found it by reading the spawn ORIGINS instead of assuming
    # where the room was, which is the sixth time that has been the fix.
    #
    # The floor south of the hole is y 224..432: 416 world deep, and the northernmost
    # spawn at y 364 still has 136 of solid floor in front of it before the hole
    # (>= 128, the reviewer's figure). 56 apart in design units is 112 in the world,
    # so no two spawns share a hull's width and two players cannot spawn inside each
    # other.
    #
    # The angle: 90 for BOTH forts, which MEASURED is +y (face 90 -> dy +116
    # in-engine), so the players look north up the hall. It was 270, which is the
    # same line the other way -- at the wall 32 behind them.
    #
    # NOT mirrored, which is the point: the forts are mirror images about X, so y is
    # the same in both and both halls run the same way. Mirroring the angle made
    # fort B's southernmost spawn face the wall, and the spawn check caught it:
    # "spawn 0 of fort B ... no floor at [(3616, 436), (3616, 420) ...]".
    for i, (dx, dy) in enumerate([(240, 250), (240, 288), (240, 326), (240, 364)]):
        face = "90"
        E.append(["info_player_deathmatch",
                  org_off(X(dx), dy, FORTS_GROUND_Z, 24), f'"angle" "{face}"',
                  f'"targetname" "spawn_{i}"'])
    # Interior lights. The sun does not reach inside a fort at all: the roof is a
    # solid slab from top..top+T, so an in-engine view inside the hall was near
    # black even with _sunlight 200 and _sunlight2 60.
    #
    # Two per fort -- one at each end of the hall -- plus one over the stairs, so
    # climbing to the parapet is lit too. 350 each: the hall is 352 x 576, and a
    # single light at the middle left the corners unreadable.
    for (lx, ly) in ((240, 336), (240, 640), (160, 640)):
        E.append(["light", org(X(lx), ly, 176), '"light" "350"'])
    # Lamps along the bridge. The channel is a 144-deep cut, so the sun cannot
    # reach the bottom of it at all -- which is correct, not a lighting bug, and
    # it is why the bridge shot came out dim. A bridge over a gorge gets lamps, so
    # this one does too: four down the deck, at the balustrade height, spaced along
    # the span so the whole crossing is lit rather than one pool of light.
    for lx in (560, 880, 1200, 1520):
        E.append(["light", org(lx, 512, 72), '"light" "300"'])

    # The key, on the pedestal in the vault. The OBJECTIVE here is a key, not a
    # flag (the owner's revision, 0086 / M4a), so this is where it lives until
    # M4b gives it rules.
    # item_qwtf_key, NOT item_key: that classname does not exist in LibreQuake's
    # QuakeC (it has item_key1 and item_key2, the single-player keys) and an
    # unknown classname is dropped when the map loads, so the vault was empty in
    # the engine while the .map text still said the key was there (0167).
    # spawnflags 2 is red, 4 is blue -- see item_qwtf_key in qwtf/probe.qc.
    # 16 above the vault floor. It was at +48, on top of a plinth that is now gone
    # (and that walled the key off from the only approach).
    # 16 above the vault floor, not 48: the item is a 32-tall cube (see
    # item_qwtf_key in qwtf/ctf.qc) and PlaceItem's droptofloor removes an item
    # that cannot find floor. At +48 the 56-tall key was embedded in the plinth and
    # was REMOVED on every map load -- "Bonus item fell out of level".
    kx = FORTS_KEY_X
    flags = "4" if mirrored else "2"
    E.append(["item_qwtf_key",
              org_off(X(kx), 480, FORTS_VAULT_Z, 16),
              f'"spawnflags" "{flags}"', f'"targetname" "key_{team}"'])
    # The STAND is the same spot, as its own classname. Capture is a touch on this,
    # not a poll: the engine calls it when a carrier walks onto it. See
    # item_qwtf_stand in qwtf/ctf.qc.
    # The STAND IS BESIDE THE KEY, 96 units along x, not on it (0226 B). Co-located,
    # a carrier walking into the vault touched the key and its stand in the same
    # frame, so "take" and "capture" were indistinguishable and the capture fired
    # where it must never fire.
    E.append(["item_qwtf_stand",
              org_off(X(kx + FORTS_STAND_OFFSET), 480, FORTS_VAULT_Z, 16),
              f'"spawnflags" "{flags}"', f'"targetname" "stand_{team}"'])
    E.append(["light", org(X(kx), 480, FORTS_VAULT_Z + 56), '"light" "180"'])
    # THE PAD LIGHT (owner, 2026-10-09: "perhaps a glowing block"). A bright,
    # team-coloured light directly above the turn-in pad, so the capture point
    # reads from across the room. The value is authored at 100 and
    # scale_light_field() emits 400 at this map's scale, the same way every
    # light on this map is written -- the number the map carries is what the
    # brief asks for.
    color = "0.2 0.4 1" if mirrored else "1 0.2 0.2"
    E.append(["light", org(X(kx + FORTS_STAND_OFFSET), 480, FORTS_VAULT_Z + 48),
              '"light" "100"', f'"_color" "{color}"',
              f'"targetname" "pad_{team}"'])

    # A light in the underwater passage, so it is not pitch black.
    px = 448 if not mirrored else FORTS_LEN - 448
    E.append(["light", org(px, 480, -56), '"light" "60 90 120"'])
    return E


def mirror_half(brushes, entities=(), length=None):
    """The other side of the map, from this one. The ONLY place mirroring happens.

    Owner's rule (0314): build one side, then mirror it whole. Every brush is
    reflected about mid-x -- each box's x pair swapped and re-sorted -- and every
    entity origin is reflected the same way, with its yaw turned to match. Team keys
    are swapped, so the two halves are red and blue rather than two reds.

    Why it is a function and not a `mirrored` flag: with a flag, every feature
    decides for itself how to mirror, and each of those decisions is a chance to get
    it wrong. This map has shipped a mirror done twice (a box recorded in already
    mirrored coordinates and then mirrored again), a mirror done by hand on
    already-mirrored bounds, a span written in an order that only held for one side,
    and a roof strip that existed in one fort and not the other -- and the owner
    found the result in a build: **the blue basement could be escaped and the red one
    could not.** None of those are caught by a symmetry check that is itself written
    in terms of the same flag; they are all caught by there being only one way to
    mirror, and by the check that the map equals A + mirror(A).

    Angles: a yaw of a becomes 180 - a, which is what reflecting a direction about a
    vertical mirror line does. It is applied to the numeric value only; the entity
    field is left as it is found, so a key's or light's own flags are untouched.

    `length` is the map's own length and it defaults to FORTS_LEN, because every
    caller but one is the forts map. THE CTF CALLER HAS TO PASS CTF_LEN, and until it
    did, this function reflected the CTF entities about the FORTS length:

        FORTS_LEN - CTF_LEN = 2432 - 2048 = 384

    So every entity of base B landed 384 east of where it belonged, which put base
    B's flag at x=2288 and its six spawns at x=2096..2160 -- all of them OUTSIDE a map
    that ends at 2048. qbsp reported it as a leak, and not a subtle one:

        WARNING: Reached occupant "info_ctf_flag" at (2288 208 40),
                 no filling performed.
        4 portals written to leak/ctf.leak.prt

    Four portals for the whole map: with the flag and the spawns outside, the tree
    collapsed. The GEOMETRY was mirrored correctly all along -- ctf_map() builds base
    B with mirror_boxes() at CTF_LEN -- which is why is_symmetric() never saw it,
    because it only looks at brushes. An entity outside the map is not a hole in the
    world; it is a thing in the wrong place, and only qbsp's occupant check noticed.
    """
    L = FORTS_LEN if length is None else length
    def mx(v):
        return L - v
    out = [mirror_brush_one(b, L) for b in brushes]
    ents = []
    for e in entities:
        kind, rest = e[0], e[1:]
        fields = []
        for item in rest:
            if isinstance(item, str) and item.startswith('"origin"'):
                pre, _, vals = item.partition(" ")
                v = [float(t) for t in vals.strip('"').split()]
                item = f'"origin" "{mx(v[0]):.1f} {v[1]:.1f} {v[2]:.1f}"'
            elif isinstance(item, str) and item.startswith('"angle"'):
                pre, _, vals = item.partition(" ")
                item = f'"angle" "{180.0 - float(vals.strip(chr(34))):.1f}"'
            elif isinstance(item, str):
                item = (item.replace('"red"', '"blue"').replace('"blue"', '"red"')
                        if '"red"' in item or '"blue"' in item else item)
            fields.append(item)
        ents.append([kind] + fields)
    return out, ents


def forts_map():
    """The forts map: hull, two forts, water, bridge, two underwater passages
    into a key vault at the bottom of each."""
    # ONE side, built, and the other side MIRRORED from it (0314). Every geometry
    # function below is called with mirrored=False and nothing else; the calls that
    # used to pass True are gone, and mirror_half() is the only thing that knows how
    # to reflect. The owner found what the flag was costing in a build: the blue
    # basement could be escaped and the red one could not.
    ground_a = forts_ground(False)
    fort_a = fort_geometry(False) + ground_a
    pass_a = forts_passage(False) + forts_stairwell(False)
    vault_a = forts_vault(False)
    _side_a = fort_a + pass_a + vault_a
    fort_b, _ = mirror_half(fort_a)
    pass_b, _ = mirror_half(pass_a)
    vault_b, _ = mirror_half(vault_a)
    ground_b, _ = mirror_half(ground_a)
    hull = forts_hull()
    channel = forts_channel()
    steps_a = forts_water_steps()
    steps_b, _ = mirror_half(steps_a)
    # The mirrored half's flight record has to say so, or the world-scale check
    # measures fort A's ramp and calls it the map's only one.
    for _f in list(FORTS_FLIGHTS):
        if _f["name"] == "water ramp" and not _f["mirrored"]:
            _b = dict(_f)
            _b["mirrored"] = True
            _b["box"] = (FORTS_LEN - _f["box"][2], _f["box"][1],
                         FORTS_LEN - _f["box"][0], _f["box"][3],
                         _f["box"][4], _f["box"][5])
            FORTS_FLIGHTS.append(_b)
    solid = (fort_a + fort_b + pass_a + pass_b + vault_a + vault_b + hull
             + channel + steps_a + steps_b)

    # THE TURN-IN PADS (owner, 2026-10-09: "there is no visual indicator as to
    # where the key turn in is located (perhaps a glowing block)"). A low pad
    # under each team's stand: 128 x 128 of plan, 8 world thick -- a step a
    # player walks onto, never one they climb -- in the team's own trim texture,
    # under the pad light forts_entities() puts above it. The light is the glow;
    # this is the block.
    #
    # EMITTED PER SIDE, and not through mirror_half(), on purpose:
    # mirror_half() copies a brush's texture verbatim, and the pad's whole point
    # is that its texture names the team. The GEOMETRY is still the mirror pair
    # every symmetry check expects -- each pad is the other one reflected about
    # mid-x, which is exactly what solids_are_the_map's side-A-plus-mirror check
    # measures.
    pads = []
    for mirrored in (False, True):
        _sx = ((FORTS_LEN if mirrored else 0)
               + (FORTS_KEY_X + FORTS_STAND_OFFSET) * (-1 if mirrored else 1))
        pads.append(box(_sx - 32, 480 - 32, FORTS_VAULT_Z,
                        _sx + 32, 480 + 32, FORTS_VAULT_Z + 4,
                        TEX_TRIM_BLUE if mirrored else TEX_TRIM_RED))
    solid += pads

    if not is_symmetric(fort_a + fort_b, FORTS_LEN):
        _dbg = [t for t in fort_a if (FORTS_LEN - t[3], t[1], t[2], FORTS_LEN - t[0],
                                      t[4], t[5]) not in
                {(u[0], u[1], u[2], u[3], u[4], u[5]) for u in fort_b}]
        raise SystemExit(f"FATAL: the forts are not symmetric about mid-x; "
                         f"{len(_dbg)} of fort A's boxes have no mirror, e.g. "
                         f"{[t[:6] for t in _dbg[:3]]}")
    if not is_symmetric(vault_a + vault_b, FORTS_LEN):
        raise SystemExit("FATAL: the two key vaults are not mirror images")

    L = ["// Generated by scripts/gen_map.py --forts: two forts across water, a",
         "// bridge, and an underwater passage into each fort's bottom.",
         "// Built out of non-overlapping brushes; see forts_hull() for why that",
         "// is the whole design constraint.",
         f"// FORTS_SCALE {FORTS_SCALE}: authored in design units, emitted at this",
         "// size. The player, stair rises and item offsets above their floor do NOT",
         "// scale; see FORTS_SCALE in scripts/gen_map.py.",
         "{",
         '"classname" "worldspawn"',
         '"wad" "our.wad"',
         '"message" "forts - two forts, a bridge, two underwater passages"',
         # The sun. Without it an outdoor map compiles and runs and is PITCH
         # BLACK outside: the one point light per fort hall only reached the hall.
         # The reviewer loaded this and saw black ground, a horizon and sky, with
         # no fort anywhere in the frame (0146). ericw-tools keys these off
         # worldspawn, not off a light entity:
         #   _sunlight   the direct sun
         #   _sun_mangle its direction
         #   _sunlight2  the sky dome's fill light
         #   _minlight   a floor so nothing is ever fully black
         '"light" "0"',
         # Angled, not overhead. "_sun_mangle 0 -60 0" points the sun almost
         # straight down, so every VERTICAL surface -- the fort walls, the bridge
         # balustrade, the channel sides, which is most of what a player looks at
         # -- got no direct light at all and read as flat ambient grey. The
         # fort-front screenshot came out dim and green-grey for exactly that
         # reason (0154). A southern sun at about 55 degrees lights the faces.
         '"_sunlight" "220"',
         '"_sun_mangle" "-60 -55 -45"',
         '"_sunlight2" "55"',
         # 16 was still too low to read an interior wall: with the roof solid, a
         # fort hall relies on minlight for everything the lamps miss.
         '"_minlight" "32"']
    for tag, brushes in (("water steps", steps_a + steps_b),
                         ("hull", hull), ("fort A", fort_a), ("fort B", fort_b),
                         ("passage A", pass_a), ("passage B", pass_b),
                         ("vault A", vault_a), ("vault B", vault_b),
                         ("turn-in pads", pads),
                         ("channel", channel)):
        L.append(f"// --- {tag} ---")
        for b in brushes:
            x0, y0, z0, x1, y1, z1, tex = b[:7]
            # A ramp is a box with a slope on its top face, and it is a DIFFERENT set of
            # six planes, so it gets its own writer. Unpacked as a 7-tuple it silently
            # drops the slope field and emits a 256-tall box where the ramp should be --
            # and the mirror check cannot see that, because the tuple it compares IS the
            # ramp's.
            if len(b) > 7 and isinstance(b[7], tuple) and b[7][0] == "ramp":
                # b[7][2] and b[7][3] are the surface at the brush's LOW and HIGH
                # coordinate ends. Passing b[5] as the high one works only while the
                # ramp rises with its axis: b[5] is the MAX of the two ends, so a ramp
                # that FALLS with x -- which is what a mirror makes of every ramp on
                # this map -- was written with a flat top at its own maximum, and read
                # back as a box.
                L += ramp_brush(b[0], b[1], b[2], b[3], b[4], b[7][2], b[7][3],
                                tex, along=b[7][1], scale=FORTS_SCALE)
            else:
                L += box_brush(x0, y0, z0, x1, y1, z1, tex, scale=FORTS_SCALE)
    L.append("}")
    for fields in forts_lights(False):
        L.append("{")
        L.append(f'"classname" "{fields[0]}"')
        L += [scale_light_field(f) for f in fields[1:]]
        L.append("}")
    for mirrored in (False, True):
        for fields in forts_entities(mirrored):
            L.append("{")
            L.append(f'"classname" "{fields[0]}"')
            L += [scale_light_field(f) for f in fields[1:]]
            L.append("}")
    # No closing brace here: the world entity was already closed above, before the
    # entity list. Emitting one more left the file with 32 "}" and 31 "{", and qbsp
    # stopped on the last line:
    #   parse: forts.map[line 230]: Invalid entity format, { not found
    desc = (f"forts: hull {sc(FORTS_LEN)}x{sc(FORTS_WID)} at scale "
            f"{FORTS_SCALE}, sky at {sc(FORTS_SKY_Z)}, "
            f"{len(solid)} solid brushes, water channel x "
            f"{sc(FORTS_FORT_X1)}..{sc(FORTS_LEN - FORTS_FORT_X1)}, "
            f"bridge at y {sc(448)}..{sc(560)}")
    return L, desc, solid


def is_symmetric(boxes, length=None):
    """True when every box has a mirror twin at LENGTH - x.

    `length` is the map's own length, and it has to be passed: this defaulted to
    CTF_LEN, so a forts map built at any length other than 2048 came back
    "78 of fort A's boxes have no mirror" for boxes that are perfectly symmetric
    about THEIR OWN map's middle -- the mirror of x 64..608 on a 2304 map is
    1696..2240, not 1440..1984.

    Compares GEOMETRY only, not textures: the mirrored base is deliberately given
    the other team's wall texture, so including the texture in the comparison
    would fail on a correctly built map. What must match is the shape, the size
    and the position of every box -- that is what "neither side has an advantage"
    means.
    """
    L = CTF_LEN if length is None else length
    # The KEY of a brush is its shape, and for a ramp the shape is the PLANE: mirroring
    # a ramp reflects x, so a ramp rising with x becomes one falling with it. Comparing
    # corners alone would call every ramp asymmetric and comparing slopes naively would
    # call every pair of them symmetric, so the key carries the slope with its sign
    # flipped when the mirror reverses the axis it runs along (0395).
    def key(b):
        # GEOMETRY AND SLOPE, NEVER TEXTURE.
        #
        # This was `tuple(b)`, which includes the texture, and that contradicted the
        # three lines above it: mirror_boxes deliberately gives base B the OTHER team's
        # wall texture, so mirroring an A brush and looking for that mirror in a set full
        # of B brushes can never match. Every box "had no mirror twin" and:
        #
        #   * test_ctf_map.py reported the map as asymmetric when its own boxes are
        #     symmetric -- confirmed by comparing corners only, which finds 0 orphans;
        #   * worse, gen_map --ctf aborted outright with "FATAL: CTF geometry is not
        #     symmetric about x", so maps/ctf.map could NOT BE REGENERATED. The .map in
        #     the repo and the .bsp in web/ were built by an older generator and were
        #     stale, and build_maps.sh dies on that path.
        #
        # b[:6] is the six corners, b[6] is the texture (dropped), and b[7:] is the ramp
        # tag, which IS geometry: a ramp's plane is part of its shape.
        return tuple(b[:6]) + (tuple(b[7:]),)

    have = {key(b) for b in boxes}
    for b in boxes:
        # mirror_brush_one is the same function mirror_half uses, so this check and the
        # map's own mirroring cannot disagree about what a ramp's mirror is.
        if key(mirror_brush_one(b, L)) not in have:
            return False
    return True


def ctf_map():
    """The M4a map: two mirrored bases, three routes each, shared midfield."""
    base_a = base_geometry()
    base_b = mirror_boxes(base_a, TEX_RED, TEX_BLUE)
    mid = midfield_geometry()
    shell = shell_geometry()

    # Refuse to emit an unbalanced map rather than shipping it.
    if not is_symmetric(base_a + base_b):
        raise SystemExit("FATAL: CTF geometry is not symmetric about x")

    L = ["// Generated by scripts/gen_map.py -- CTF map (M4a, GAME-DESIGN.md Map 1).",
         "// Our own two-base layout: three routes per base, no moat and no single",
         "// bridge. Mirrored on x, so the two bases are identical by construction.",
         "{",
         '"classname" "worldspawn"',
         # Without this qbsp never opens our.wad and reports "unable to find
         # texture" for every texture in the map, while still writing a BSP.
         '"wad" "our.wad"',
         '"message" "ctf - two bases, three routes"',
         '"light" "0"',
         '"_ambient" "20"']
    for tag, brushes in [("shell", shell), ("base A", base_a),
                         ("base B", base_b), ("midfield", mid)]:
        L.append(f"// --- {tag} ---")
        for x0, y0, z0, x1, y1, z1, tex in brushes:
            L += box_brush(x0, y0, z0, x1, y1, z1, tex)
    L.append("}")

    ents = []
    # CTF_LEN, not the default FORTS_LEN -- see mirror_half's docstring. Without it
    # base B's flag and spawns were 384 east of the map.
    _ent_a, _ent_b = mirror_half([], base_entities(False), CTF_LEN)
    for group in (base_entities(False), _ent_b):
        for fields in group:
            L.append("{")
            L.append(f'"classname" "{fields[0]}"')
            L += fields[1:]
            L.append("}")

    # Neutral midfield lighting.
    my = CTF_MID_Y
    for x in (CTF_MID, 820, 1228):
        L.append("{")
        L.append('"classname" "light"')
        L.append(f'"origin" "{x} {my} {CTF_H - 40}"')
        L.append('"light" "200"')
        L.append("}")

    desc = (f"x 0..{CTF_LEN}, y {CTF_Y0}..{CTF_Y1}, 3 routes per base, "
            f"tunnel floor {CTF_TUNNEL_Z}, walkway {CTF_UPPER}, "
            f"{len(base_a)} boxes per base")
    return L, desc


if __name__ == "__main__":
    main()

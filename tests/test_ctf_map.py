#!/usr/bin/env python3
"""M4a structural checks on the CTF map.

GAME-DESIGN.md Map 1 asks for specific properties. This asserts them against the
geometry rather than trusting a screenshot:

  * the map is symmetric about its mid-x, so neither side has an advantage;
  * each base has exactly three routes out, and they are at three heights
    (main hall, upper walkway, lower tunnel) -- the thing that makes a held
    doorway not the whole defence;
  * six spawns a side (M4a's own done-when, added after the duel fixture kept
    telefragging two clients);
  * nothing is placed inside solid geometry: spawns, flags and pickups;
  * pickups are on the routes, not in the flag room;
  * it is WALKABLE: a flood fill of the hull-sized free space reaches each key,
    each courtyard and each route mouth, at ground level. Two doors that were
    unusable got through the checks above, because a sealed door is not a buried
    entity -- see the notes on the reachability block;
  * the map compiles: qbsp writes a .prt (not a .leak.prt), then vis and light
    succeed and produce a .bsp with light data.

The symmetry and spawn checks import the generator, so they cannot drift from
what is built. The compile check runs the real tools, because "the generator
emitted something" is not "there is a map".

    python3 tests/test_ctf_map.py
"""

import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The map the NAMES come from. This suite measures generator geometry (boxes()) and only
# writes a .map later, for the compile, into a temp dir -- but report.where() reads
# entity names out of a FILE, and that is the right place to read them from. So it reads
# the committed maps/ctf.map for names only: the targetnames come from the same generator
# that produced the boxes being measured. If the committed map is stale the NAMES could
# be, and that is worth knowing about rather than papering over -- the geometry in the
# report is never taken from this file.
MAP = os.path.join(ROOT, "maps", "ctf.map")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import report  # noqa: E402
import gen_map as g  # noqa: E402

EW = os.path.join(ROOT, "third_party/ericw-tools/build-linux")
FAILED = []


def check(ok, what, detail="", at=None):
    """Print one check. `at` is a coordinate, and it makes the failure a report.

    The same idea and the same helper as tests/test_forts_map.py's check(), so a failure
    reads the same way whichever suite it came from -- a coordinate, the nearest thing the
    owner NAMED, and the cause. `at` is optional because a check about the whole map has
    no place to point at, and inventing one would be a report pointing confidently at
    something that is not there.
    """
    print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    if not ok:
        if detail and at is not None:
            print(f"         {report.where(MAP, at[0], at[1], at[2])}: {detail}")
        elif detail:
            print(f"         {detail}")
        FAILED.append(what)


def boxes():
    return (g.shell_geometry()
            + g.base_geometry()
            + g.mirror_boxes(g.base_geometry(), g.TEX_RED, g.TEX_BLUE)
            + g.midfield_geometry())


def inside_solid(bs, x, y, z, pad=0):
    for x0, y0, z0, x1, y1, z1, _t in bs:
        if (x0 - pad) <= x <= (x1 + pad) and (y0 - pad) <= y <= (y1 + pad) \
                and (z0 - pad) <= z <= (z1 + pad):
            return True
    return False


# A QuakeWorld player's hull: mins -16 -16 -24, maxs 16 16 24. Movement is
# asserted with the hull, not with a point, because the difference is exactly
# what these checks exist for.
# The real hull, from gen_map: LibreQuake's VEC_HULL_MIN/MAX (defs.qc:362), 56
# tall and asymmetric about the origin. The symmetric 16 16 24 that was here
# is 8 units short both ways and modelled a player who can fit places the real
# player cannot (0213).
HULL_XY = g.HULL_MAX_XY
HULL_MIN_Z, HULL_MAX_Z = g.HULL_MIN_Z, g.HULL_MAX_Z

# How high the flood fill looks.
#
# The map is open to the sky now (CTF_SKY_Z = 1024, reviewer 0114), so filling all
# the way up is filling the sky: it found the volume a player cannot reach and the
# test stopped finishing inside its timeout (rc=124). The ceiling is the battlement
# walkway plus a generous jump, which is everything a player can stand on.
FLOOD_CEIL = g.CTF_WALK_Z + 200


def hull_blocked(bs, x, y, z):
    """Would a player hull centred here intersect solid geometry?"""
    return inside_solid(bs, x, y, z, pad=0) or any(
        x0 < x + HULL_XY and x1 > x - HULL_XY
        and y0 < y + HULL_XY and y1 > y - HULL_XY
        and z0 < z + HULL_MAX_Z and z1 > z - HULL_MIN_Z
        for x0, y0, z0, x1, y1, z1, _t in bs)


def reachable(bs, start, step=32):
    """Grid flood fill of the hull-sized free space, from `start`.

    Step 32, which is exactly a hull's width -- the coarsest step that can still
    find any passage a player could use. Every opening in this map is at least 64
    units across, so nothing here depends on the finer step, and the fill finishes
    in seconds instead of minutes: the map is now open to the sky, so the volume
    the fill covers grew by a factor of four and at step 16 the test stopped
    finishing inside its timeout (rc=124, with no output at all, because python
    buffers stdout when it is not a terminal and loses it on the signal).
    """
    from collections import deque
    seen = {start}
    q = deque([start])
    while q:
        cx, cy, cz = q.popleft()
        for dx, dy, dz in ((step, 0, 0), (-step, 0, 0), (0, step, 0),
                           (0, -step, 0), (0, 0, step), (0, 0, -step)):
            p = (cx + dx, cy + dy, cz + dz)
            if p[0] < 0 or p[0] > g.CTF_LEN:
                continue
            if p[1] < g.CTF_Y0 - 16 or p[1] > g.CTF_Y1 + 16:
                continue
            if p[2] < g.CTF_TUNNEL_Z - 32 or p[2] > FLOOD_CEIL:
                continue
            if p in seen or hull_blocked(bs, *p):
                continue
            seen.add(p)
            q.append(p)
    return seen


def nearest(seen, target):
    """The reachable cell closest to `target`, and how far off it is."""
    tx, ty, tz = target
    best = min(seen, key=lambda p: (p[0] - tx) ** 2 + (p[1] - ty) ** 2 + (p[2] - tz) ** 2)
    return best, ((best[0] - tx) ** 2 + (best[1] - ty) ** 2 + (best[2] - tz) ** 2) ** 0.5


def record_walls():
    """Every walls() call base_geometry() makes, with its arguments.

    walls() is wrapped rather than the source parsed, so this cannot go stale:
    it records what the generator actually asks for, including anything a future
    edit adds.
    """
    calls = []
    real = g.walls

    def spy(x0, y0, z0, x1, y1, z1, tex, gaps=(), skip=()):
        calls.append(((x0, y0, z0, x1, y1, z1), list(gaps), tuple(skip)))
        return real(x0, y0, z0, x1, y1, z1, tex, gaps, skip)

    g.walls = spy
    try:
        g.base_geometry()
    finally:
        g.walls = real
    return calls


def entities():
    out = []
    for mirrored in (False, True):
        for fields in g.base_entities(mirrored):
            name = fields[0]
            origin = next((f for f in fields if f.startswith('"origin"')), None)
            if origin:
                p = origin.split('"')[3].split()
                out.append((name, float(p[0]), float(p[1]), float(p[2])))
    return out


def main():
    bs = boxes()
    ents = entities()

    # -- symmetry ------------------------------------------------------------
    base_a = g.base_geometry()
    base_b = g.mirror_boxes(base_a, g.TEX_RED, g.TEX_BLUE)
    check(g.is_symmetric(base_a + base_b),
          "the map is symmetric about its mid-x",
          "base B has no mirror twin for some of base A's boxes")

    # -- three routes, at three heights -------------------------------------
    gaps = []
    for side, a0, a1, gz0, gz1 in ROUTE_GAPS:
        if side == "x0":
            gaps.append((a0, a1, gz0, gz1))
    check(len(gaps) == 3,
          "each base has exactly three ways out",
          f"found {len(gaps)} openings in the dividing wall: {gaps}")
    heights = sorted((gz0 + gz1) // 2 for _a0, _a1, gz0, gz1 in gaps)
    check(len(set(heights)) == 3,
          "the three routes are at three different heights",
          f"mid-heights were {heights}, so the routes are distinguishable")

    # -- spawns --------------------------------------------------------------
    spawns = [e for e in ents if e[0] == "info_player_deathmatch"]
    check(len(spawns) == 12,
          "there are 6 spawns a side",
          f"found {len(spawns)} deathmatch spawns in total")
    red = [s for s in spawns if s[1] < g.CTF_MID]
    blue = [s for s in spawns if s[1] >= g.CTF_MID]
    check(len(red) == 6 and len(blue) == 6,
          "spawns are split evenly between the bases",
          f"red side {len(red)}, blue side {len(blue)}")
    stuck = [s for s in spawns if inside_solid(bs, s[1], s[2], s[3])]
    check(not stuck,
          "no spawn point is inside solid geometry",
          f"stuck spawns: {stuck}")

    # -- flags ---------------------------------------------------------------
    flags = [e for e in ents if e[0] == "info_ctf_flag"]
    check(len(flags) == 2, "each base has a flag", f"found {len(flags)}")
    buried = [f for f in flags if inside_solid(bs, f[1], f[2], f[3])]
    check(not buried, "no flag is inside solid geometry", f"buried: {buried}")

    # -- pickups on the routes ----------------------------------------------
    pickups = [e for e in ents if e[0].startswith("item_")]
    check(len(pickups) >= 8, "the routes carry health and armour",
          f"found {len(pickups)} pickups")
    buried = [p for p in pickups if inside_solid(bs, p[1], p[2], p[3])]
    check(not buried, "no pickup is inside solid geometry", f"buried: {buried}")
    in_flag_room = [p for p in pickups
                    if (48 - 16) <= p[1] <= (240 + 16) and (g.CTF_Y0 - 16) <= p[2] <= 288]
    check(not in_flag_room,
          "no pickup is in a flag room (they belong on the routes)",
          f"pickups inside a flag room: {in_flag_room}")

    # -- it is walkable, at player-hull size ----------------------------------
    #
    # This is the check whose absence let two real bugs through, and both were
    # found by driving the map with qwtf/probe.qc and reading the server's own
    # positions, not by looking at it:
    #
    #   * The spawn room's door was 96 wide (my-48..my+48) while the spawns sat
    #     at my-96/my-32/my+32. With a 16-unit hull either side of the origin,
    #     the my-96 spawn was outside the door and the other two were flush
    #     against a jamb. Measured: a player ran 112 units and then stopped dead
    #     against the door for the rest of the run.
    #   * The flag room's door was declared at y 288..336, but that room's own y
    #     range is 128..288, so walls() clamped the opening away and built a
    #     SOLID wall. The key was then reachable only by climbing to z=168 and
    #     walking in along the tops of the walls.
    #
    # "Not inside solid geometry" passes for both: a sealed door is not a buried
    # entity. So the property asserted here is reachability, by flood fill.
    my = g.CTF_MID_Y
    spawn_a = min((s for s in spawns if s[1] < g.CTF_MID),
                  key=lambda s: abs(s[1] - g.CTF_MID_Y))
    step = 32
    reach = reachable(bs, (int(spawn_a[1]), int(spawn_a[2]), int(spawn_a[3])), step=step)
    check(len(reach) > 1000,
          "the free space around a spawn is large (the flood fill found a map)",
          f"only {len(reach)} hull-sized cells reachable from {spawn_a}")

    # Every spawn must be able to leave the room, or a player spawns stuck.
    stuck_spawns = []
    for s in spawns:
        if all(hull_blocked(bs, s[1] + dx, s[2] + dy, s[3] + dz)
               for dx, dy, dz in ((step, 0, 0), (-step, 0, 0),
                                  (0, step, 0), (0, -step, 0))):
            stuck_spawns.append(s)
    check(not stuck_spawns,
          "every spawn has somewhere to walk to",
          f"spawns walled in on all four sides: {stuck_spawns}")

    # Each key, each courtyard and each route mouth must be reachable.
    targets = [("key A", (144, g.CTF_Y0 + 80, 40)),
               ("key B", (g.CTF_LEN - 144, g.CTF_Y0 + 80, 40)),
               ("courtyard A", (300, my, 24)),
               ("courtyard B", (g.CTF_LEN - 300, my, 24)),
               ("main hall A", (440, my, 24)),
               ("main hall B", (g.CTF_LEN - 440, my, 24)),
               ("upper walkway A", (600, 320, g.CTF_UPPER + 24)),
               ("tunnel A", (600, 728, g.CTF_TUNNEL_Z + 24)),
               ("the tunnel's midfield end A", (g.CTF_TUNNEL_EXIT - 32, 728, 24))]
    for name, t in targets:
        cell, off = nearest(reach, t)
        check(off <= 24,
              f"{name} is reachable on foot",
              f"the closest reachable cell is {off:.0f}u away, at {cell}")

    # A player must be able to get OUT of the lower tunnel as well as in. The
    # tunnel used to be a pit: the floor hole ran its whole length, so a player
    # who walked over the courtyard fell in and the only way out was back along
    # the passage to the stairs behind them. Measured through the probe: the run
    # finished at z=-3, which is below the ground floor.
    for name, t in (("tunnel A's midfield exit", (g.CTF_TUNNEL_EXIT - 32, 728, 24)),
                    ("tunnel B's midfield exit",
                     (g.CTF_LEN - g.CTF_TUNNEL_EXIT + 32, 728, 24))):
        cell, off = nearest(reach, t)
        check(off <= 24, f"{name} is walkable from the tunnel",
              f"the closest reachable cell is {off:.0f}u away, at {cell}")

    # The routes must be reachable at ground level, not by climbing the walls.
    # The old climb-over route went to z=168 and dropped into the key room, so
    # this is what separates "reachable" from "reachable if you can jump 176
    # units up onto a wall top".
    low = [c for c in reach if c[2] <= 40]
    for name, t in (("key A", (144, g.CTF_Y0 + 80, 40)),
                    ("key B", (g.CTF_LEN - 144, g.CTF_Y0 + 80, 40))):
        cell, off = nearest(low, t)
        check(off <= 24,
              f"{name} is reachable at ground level (no climbing on top of walls)",
              f"the closest ground-level cell is {off:.0f}u away, at {cell}")

    # -- every declared opening is a real hole -------------------------------
    #
    # walls() clamps an opening to the side it is named on and discards it when
    # nothing is left ("if ga0 >= ga1: continue"). That is silent: no error, no
    # warning, and the wall comes out solid where the map said there was a door.
    # It happened here: the flag room declared gaps=[("x1", 288, 336, 0, 112)]
    # while the room's own y range is 128..288, so the whole opening fell outside
    # it and the face came out as one box (240, 128, 0, 256, 288, 176).
    #
    # The openings are read out of the generator's own calls rather than
    # restated here, because a restatement cannot fail: it would just be this
    # test agreeing with itself. walls() is wrapped to record what base_geometry
    # asks for, and every opening is then checked against the wall it is cut into.
    calls = record_walls()
    dropped = []
    for (x0, y0, z0, x1, y1, z1), gaps, skip in calls:
        for side, a0, a1, gz0, gz1 in gaps:
            if side in ("x0", "x1"):
                lo, hi = y0, y1
            else:
                lo, hi = x0, x1
            if max(lo, a0) >= min(hi, a1):
                dropped.append(f"walls({x0},{y0},{z0},{x1},{y1},{z1}) declares a "
                               f"{side} opening at {a0}..{a1}, outside the wall's "
                               f"own {lo}..{hi}")
            elif max(z0, gz0) >= min(z1, gz1):
                dropped.append(f"walls({x0},{y0},{z0},{x1},{y1},{z1}) declares a "
                               f"{side} opening at z {gz0}..{gz1}, which does not "
                               f"overlap the wall's z {z0}..{z1}")
    check(not dropped,
          f"all {sum(len(g) for _b, g, _s in calls)} declared openings lie inside "
          f"the wall they are cut into",
          "; ".join(dropped))

    # And the doorway is open in the geometry that came out, not merely declared.
    for name, vol in DOORWAYS.items():
        solid = [b[:6] for b in bs
                 if b[0] < vol[3] and b[3] > vol[0] and b[1] < vol[4] and b[4] > vol[1]
                 and b[2] < vol[5] and b[5] > vol[2]]
        check(not solid,
              f"{name} is actually open in the built geometry",
              f"still solid: {solid}")

    # -- the battlements (owner checkpoint 1, 0086) ---------------------------
    my = g.CTF_MID_Y
    walk = g.CTF_WALK_Z
    # A walkable walkway all round the castle top: the three walls the castle has,
    # sampled along their length every 32 units -- exactly a hull's width, so a
    # gap between samples cannot hide a hole. Tested with the hull, not a point,
    # because a walkway that is 16 wide would pass a point test and still be
    # unwalkable.
    # Sampled at walk + 24, which is where a player's ORIGIN sits when standing on
    # a floor at `walk` (the hull is 24 above its origin). Sampling at walk + 8 put
    # the point inside the lookout platforms, which are 16 thick, and reported five
    # of nineteen points solid when the walkway was fine.
    walk_samples = 0
    walk_bad = []
    # Sample line 40 in from the outer edge, because the merlons occupy the outer
    # 16 of a 64-deep run and a hull is 32 wide: at +24 the hull spans 8..40 and
    # fouls the merlons, at +40 it spans 24..56 and clears them.
    #
    # Points inside a lookout's footprint are skipped: the lookouts ARE the wall's
    # turns, they are a step up, and they are asserted separately below. Counting
    # them as walkway failures would be measuring the wrong thing.
    look_rects = ((160, 368, 256, 464), (160, 576, 256, 672))
    def in_lookout(x, y):
        return any(a <= x <= c and b <= y <= d for a, b, c, d in look_rects)

    for (x0, y0, x1, y1) in ((16, 368, 192, 432), (16, 608, 192, 672),
                             (160, 368, 224, 672)):
        if x1 - x0 >= y1 - y0:      # a run along x
            for x in range(x0 + 16, x1 - 16, 32):
                if in_lookout(x, y0 + 40):
                    continue
                walk_samples += 1
                if hull_blocked(bs, x, y0 + 40, walk + 24):
                    walk_bad.append((x, y0 + 40))
        else:                       # a run along y
            for y in range(y0 + 16, y1 - 16, 32):
                if in_lookout(x0 + 40, y):
                    continue
                walk_samples += 1
                if hull_blocked(bs, x0 + 40, y, walk + 24):
                    walk_bad.append((x0 + 40, y))
    check(walk_samples >= 11 and not walk_bad,
          f"the battlement walkway is walkable all round ({walk_samples} points)",
          f"{len(walk_bad)} of {walk_samples} sample points are solid: {walk_bad[:5]}")

    # Crenellations: merlons AND gaps. A battlement with no gaps is a wall, and one
    # with no merlons is a shelf.
    merlons = [b for b in base_a if b[2] >= walk and b[5] > walk + 16 and
               (b[5] - b[2]) <= g.CTF_MERLON_H + 1]
    check(len(merlons) >= 8,
          f"the battlements have merlons to shoot through ({len(merlons)} found)",
          "expected at least 8; a walkway with no merlons is a shelf")

    # Two lookouts, at the wall's turns, each open on more than one side.
    lookouts = [(160, 368, 256, 464), (160, 576, 256, 672)]
    lookout_ok = []
    for (lx0, ly0, lx1, ly1) in lookouts:
        mid_x, mid_y = (lx0 + lx1) // 2, (ly0 + ly1) // 2
        # Standable, and there is sky above it: not a roofed alcove.
        standable = not inside_solid(bs, mid_x, mid_y, walk + 24)
        # Open towards the courtyard: a step of free space in +x.
        open_out = not any(inside_solid(bs, lx1 + 16, mid_y, walk + 24)
                           for _ in [0]) and not inside_solid(bs, lx1, mid_y, walk + 24)
        lookout_ok.append(standable and open_out)
    check(all(lookout_ok) and len(lookout_ok) == 2,
          "there is a lookout at each of the two wall turns",
          f"standable-and-open per corner: {lookout_ok}")

    # -- no two solid brushes overlap ----------------------------------------
    #
    # THE qbsp-hang guard. Overlapping solid brushes are the family of bug that
    # broke this map twice: the first version sent the BSP to 119136 nodes from
    # 116 brushes, and the sky attempt (maps/SKY-ATTEMPT.md) never finished qbsp
    # at all -- 2m00s wall, 4m of CPU, killed in ProcessMapBrushes, where the
    # committed map takes 0.47s.
    #
    # The reviewer measured that a sealed sky box of the SAME footprint (2080 x
    # 928, lid at z=1024), a floor and two simple forts compiles in 0.035 s, so
    # the sky volume is innocent and the brush structure is not. This check is that
    # guard: touching faces are fine, volume is not, because volume is what qbsp has
    # to resolve with splits.
    overlaps = []
    for i in range(len(bs)):
        for j in range(i + 1, len(bs)):
            a, b = bs[i], bs[j]
            ox = min(a[3], b[3]) - max(a[0], b[0])
            oy = min(a[4], b[4]) - max(a[1], b[1])
            oz = min(a[5], b[5]) - max(a[2], b[2])
            if ox > 0 and oy > 0 and oz > 0:
                overlaps.append((a[:6], b[:6], ox * oy * oz))
    # The largest first, said as a PLACE. report.overlaps() is the same helper
    # tests/test_forts_map.py uses, so there is one phrasing for an overlap in this repo
    # -- and the old message was two tuples and no location, which is the least useful
    # form a failure can take.
    #
    # REWORDING IS NOT FIXING. The verdict is unchanged and still FAIL: the pairs are
    # still there. This makes the report say WHERE, which is the half that does not
    # depend on the decision about whether to rebuild CTF's walls in the forts style.
    _ov = sorted(overlaps, key=lambda t: -t[2])
    _big = _ov[0] if _ov else None
    check(not overlaps,
          f"no two solid brushes overlap in volume ({len(bs)} brushes)",
          f"{len(overlaps)} overlapping pairs; the largest is "
          + (report.overlaps(_big[0], _big[1], _big[2]) if _big else "none")
          + ("; and " + str(len(_ov) - 1) + " more" if len(_ov) > 1 else ""),
          at=tuple(_big[0][:3]) if _big else None)

    # -- it compiles ---------------------------------------------------------
    with tempfile.TemporaryDirectory() as work:
        src = os.path.join(work, "ctf.map")
        with open(src, "w") as f:
            f.write("\n".join(g.ctf_map()[0]) + "\n")
        bsp = os.path.join(work, "ctf.bsp")
        r = subprocess.run([os.path.join(EW, "qbsp/qbsp"), "-wadpath",
                            os.path.join(ROOT, "web/id1"), src, bsp],
                           capture_output=True, text=True)
        check(r.returncode == 0, "qbsp compiles the map",
              (r.stdout + r.stderr)[-300:])
        check(os.path.exists(os.path.join(work, "ctf.prt")),
              "qbsp wrote a portal file (the map does not leak)",
              "only ctf.leak.prt exists: the map leaks to the outside")
        if os.path.exists(os.path.join(work, "ctf.prt")):
            r = subprocess.run(["./vis", "-level", "4", "-fast", bsp], cwd=os.path.join(EW, "vis"),
                               capture_output=True, text=True)
            check(r.returncode == 0, "vis runs", (r.stdout + r.stderr)[-300:])
            r = subprocess.run(["./light", "-bounce", "4", bsp], cwd=os.path.join(EW, "light"),
                               capture_output=True, text=True)
            check(r.returncode == 0, "light runs", (r.stdout + r.stderr)[-300:])
        # 0479 (owner decision): the alt maps are NOT in the browser's
        # pre-engine manifest -- only forts.bsp ships in web/id1/maps, and the
        # others live in tests/fixtures/maps/ for the server's lazy
        # connect-time download. This check follows the file.
        check(os.path.exists(os.path.join(ROOT, "tests/fixtures/maps/ctf.bsp")),
              "tests/fixtures/maps/ctf.bsp exists (the map is shipped, not skipped)")
        check(not os.path.exists(os.path.join(ROOT, "web/id1/maps/ctf.bsp")),
              "web/id1/maps/ctf.bsp is gone (alt maps are not pre-fetched by the page)")

    print()
    if FAILED:
        print(f"CTF: FAIL: {len(FAILED)} checks did not hold")
        return 1
    print("CTF: PASS")
    return 0


# Volumes that must be walkable air once the geometry is built. Each is a doorway
# plus enough room either side for a 32-wide hull.
DOORWAYS = {
    "the spawn room's team door": (150, g.CTF_MID_Y - 40, 0, 220, g.CTF_MID_Y + 40, 80),
    "the flag room's door":       (210, 208, 0, 290, 272, 80),
}

# The dividing wall's three openings, restated here so the test does not depend on
# the generator's internals: if the layout changes, this fails loudly.
ROUTE_GAPS = [
    ("x0", g.CTF_MID_Y - 128, g.CTF_MID_Y + 128, 0, g.CTF_H),
    ("x0", 288, 352, g.CTF_UPPER, g.CTF_UPPER + 120),
    ("x0", 704, 752, g.CTF_TUNNEL_Z, g.CTF_TUNNEL_TOP),
]

if __name__ == "__main__":
    sys.exit(main())
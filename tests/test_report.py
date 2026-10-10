#!/usr/bin/env python3
"""Tests for scripts/report.py -- the failure report the owner reads (0308).

    python3 tests/test_report.py

0308 asks that every failure give "a coordinate, the nearest named thing (entity or
room), and a plain-English cause". That is three claims about a string, and each of them
is the kind that passes by accident:

  * the COORDINATE has to be the place and not a vertex, or the owner looks up a corner;
  * the NEAREST NAMED THING has to be a name someone chose. "near light" is a light the
    generator placed, and pointing a human at it is worse than saying nothing -- the first
    version ranked by distance alone and did exactly that;
  * the CAUSE has to contain BOTH numbers, the measured one and the needed one. "fails"
    is not a sentence anyone can act on.

So each is asserted here, against a .map that exists, and the "says nothing rather than
guessing" case is asserted too: a report that invents a location is worse than one that
admits it does not know.
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import report  # noqa: E402

MAPS = os.path.join(ROOT, "maps")
FORTS = os.path.join(MAPS, "forts.map")

FAILED = []


def check(ok, what, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    if not ok:
        if detail:
            print(f"         {detail}")
        FAILED.append(what)


def named_ents(path=FORTS):
    return {n for n, _c, _o in report.entities(path) if n}


def main():
    if not os.path.exists(FORTS):
        print("no maps/forts.map -- the report tests need a real map to read")
        return 1

    # ---- the entities come out of the FILE ---------------------------------
    ents = report.entities(FORTS)
    check(len(ents) > 0, f"the .map's entities are read out of the file ({len(ents)})")
    check(all(o is None or len(o) == 3 for _n, _c, o in ents),
          "every entity that has an origin has three numbers")

    # The names the owner typed, read back from the map rather than remembered.
    names = named_ents()
    for want in ("key_red", "key_blue", "stand_red", "stand_blue"):
        check(want in names, f"the map has {want}, read from the file not from memory")
    check(any(n.startswith("spawn_") for n in names),
          "the map has spawns, found by their targetname")

    # ---- a NAME beats a classname, at any distance -------------------------
    # forts.map has lights placed by the generator and keys named by hand. A report
    # that ranked by distance alone said "near light" for a spot beside a key.
    near = report.nearest(FORTS, 656, 960, -272)
    check(near is not None and near[0] == "key_red",
          "the spot ON the key names the key",
          f"got {near}")
    mid = report.where(FORTS, 416, 1120, 152, what="the ledge")
    check("light" not in mid or "near light" not in mid,
          "a generated light is not offered as the nearest NAME",
          mid)

    # ---- it says nothing rather than guessing ------------------------------
    far = report.nearest(FORTS, 100000, 100000, 100000)
    check(far is None,
          "a spot with nothing named near it returns None, not the far side of the map",
          f"got {far}")
    line = report.where(FORTS, 100000, 100000, 100000, what="the spot")
    check("nothing named" in line,
          "and the sentence SAYS there is nothing named, rather than inventing one",
          line)

    # ---- the three parts, in order ----------------------------------------
    one = report.line(FORTS, 656, 960, -272, report.doorway_is(96), what="the doorway")
    check(one.index("656") < one.index("key_red") < one.index("needs 128"),
          "coordinate first, then the name, then the cause", one)
    check("96" in one and "128" in one,
          "the cause carries BOTH the measured number and the needed one", one)

    # ---- the causes say what and what is needed ----------------------------
    for cause, need in ((report.doorway_is(96, 128), "128"),
                        (report.height_is(96, 128), "128"),
                        (report.tread_is(16, 32), "32"),
                        (report.passage_is(48, 64), "64")):
        check(need in cause and "needs" in cause,
              f"the cause names the number it needs: {cause[:48]}", cause)
    check("a wall" in report.step_is(24),
          "a step taller than the player says so in words, not just 'FAIL'",
          report.step_is(24))
    check("walkable" in report.step_is(16),
          "and a legal step says so too", report.step_is(16))

    # ---- an overlap is a PLACE, not two tuples -----------------------------
    ov = report.overlaps((-16, 112, -80, 256, 912, -16),
                         (-16, 112, -112, 0, 912, 256), 819200)
    check("overlaps" in ov and "819200" in ov,
          "two overlapping brushes read as a place and an amount of overlap", ov)
    check("(" not in ov,
          "and not as a pair of tuples, which is what the check printed before", ov)

    # ---- it works on a map the owner drew, not only on ours ----------------
    kit = os.path.join(ROOT, "tools", "trenchbroom", "scale-references.map")
    if os.path.exists(kit):
        kitnames = named_ents(kit)
        check("key_red" in kitnames and "stand_blue" in kitnames,
              "and on the TEMPLATE, so an owner-drawn map gets the same report",
              str(sorted(kitnames))[:120])
        r = report.line(kit, 2432, 64, 24, report.doorway_is(96), what="the doorway")
        check("spawn_0" in r,
              "naming the template's own spawn, not one of ours", r)
    else:
        check(False, "the TrenchBroom template exists to be reported on")

    print()
    if FAILED:
        print(f"report: {len(FAILED)} check(s) FAILED:")
        for f in FAILED:
            print(f"  - {f}")
        return 1
    print("report: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
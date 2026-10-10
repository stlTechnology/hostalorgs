#!/usr/bin/env python3
"""Write the content manifest into web/index.html.

FTE's web client takes its filesystem as a literal JS object in the page, and
that list has to match web/id1 exactly or the client silently boots with an
empty game.  Hand-maintaining it drifted (default.cfg was listed but FTE never
reads it under DOMIT_QCC), so the block between the manifest markers is
generated here instead.

What is LISTED is what the browser fetches before any engine code runs.
0479 (owner decision via reviewer) moved three things out of the list, and
measured what happened:

- maps other than forts (ctf, corridor, duel) -- NOT listed, and NOT in
  web/id1 at all: scripts/build_maps.sh puts their BSPs in
  tests/fixtures/maps/. A server running one serves it to the client at
  connect... which is ALSO broken (see below), so the test suites that need
  those maps stage their own page with the map back in the manifest
  (mp_smoke's stageGamedir).
- progs.dat and qwprogs.dat -- the browser always connects to OUR server
  (instant play through the gate), so the game code runs server-side; both
  stay in web/id1 because run_server.sh's gamedir IS web/. Proven by
  mp_combat (spawn, move, fire) with the files absent from the fetch list.
- sounds.pak -- listed AGAIN, deliberately. Taking it out made the client
  ask for each sound at connect, the server served every one of them over
  the game connection, and then the client NEVER SPAWNED: measured three
  ways, the web build wedges after any successful game-connection download
  (black canvas for a minute after the download queue drains; also true
  with every download succeeding, so it is not the six missing monster
  sounds; also true with the client-side fs_dlURL HTTP fallback set). The
  old design -- sounds in the manifest, cl_downloads 0 -- is the only one
  measured working. The wedge is recorded in STATE.md for an engine-level
  look; until then the 1.58 MB stays on the first-load wire.

Everything listed is produced by scripts/build_maps.sh (our.wad, gfx.wad, the
map BSPs, quake.rc) and scripts/build_progs.sh (the GPL v2 progs).  Nothing
from id/Valve or Team Fortress; see ASSETS-CREDITS.md.

Usage: gen_manifest.py [--check]
  --check  verify the page is already up to date; exit 1 if it is not.
"""

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
PAGE = os.path.join(WEB, "index.html")
ID1 = os.path.join(WEB, "id1")

BEGIN = "\t\t/* ---- BEGIN GENERATED MANIFEST (scripts/gen_manifest.py) ---- */"
END = "\t\t/* ---- END GENERATED MANIFEST ---- */"

# Fixed entries first, then everything else found in web/id1, so the important
# files are always at the top of the list and the diff stays readable.
#
# NOT here, on purpose (0479): progs.dat and qwprogs.dat -- the browser is
# always a client of OUR server, so the game code runs server-side (mp_combat
# proves play without them in the fetch list). The files stay in web/id1
# (run_server.sh's gamedir IS web/). sounds.pak went out and came BACK: the
# connect-download path wedges the web build (see the docstring); until that
# is fixed engine-side, the pak is pre-fetched and cl_downloads stays 0.
FIXED = [
    ("id1/our.wad", "textures (LibreQuake PNGs, BSD-3)"),
    ("id1/gfx.wad", "sprites and pics"),
    ("id1/models.pak", "player models, weapons, pickups (BSD-3)"),
    ("id1/sounds.pak", "gameplay sounds, Ogg Vorbis (BSD-3)"),
    ("id1/quake.rc", "autoexec: bind, cl_downloads 0, f_startup connect"),
]


def wanted():
    """Files to put in the page manifest.

    Listed = fetched before any engine code runs. NOT listed does not mean
    absent from the game: sounds and progs are downloaded at connect
    (quake.rc cl_downloads 1) and the alt maps are served by whatever server
    runs them, which is the lazy path the <= 8 MB first-load row asks for.
    scripts/gen_manifest.py --check fails if this drifts from web/id1.
    """
    out = []
    for rel, note in FIXED:
        if os.path.exists(os.path.join(WEB, rel)):
            out.append((rel, note))
    maps = os.path.join(ID1, "maps")
    if os.path.isdir(maps):
        for bsp in sorted(os.listdir(maps)):
            if bsp.endswith(".bsp"):
                out.append((f"id1/maps/{bsp}", "our map, compiled by ericw-tools"))
    return out


def block():
    lines = [BEGIN,
             "\t\t/* Our content, pre-engine. The alt maps are NOT listed and",
             "\t\t * NOT shipped (0479); progs arrive server-side. Nothing",
             "\t\t * proprietary: LibreQuake assets (BSD-3) and id's GPL QuakeC.",
             "\t\t * See ASSETS-CREDITS.md. */"]
    for rel, note in wanted():
        lines.append(f'\t\t"{rel}": "{rel}",'.ljust(56) + f"/* {note} */")
    lines.append(END)
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    html = open(PAGE, encoding="utf-8").read()
    try:
        i = html.index(BEGIN)
        j = html.index(END)
    except ValueError:
        print(f"FATAL: {PAGE} has no manifest markers", file=sys.stderr)
        return 2
    new = html[:i] + block() + html[j + len(END):]

    if args.check:
        if new != html:
            print("FATAL: web/index.html manifest is stale; "
                  "run scripts/gen_manifest.py", file=sys.stderr)
            return 1
        print(f"manifest up to date ({len(wanted())} files)")
        return 0

    if new != html:
        open(PAGE, "w", encoding="utf-8").write(new)
        print(f"wrote manifest for {len(wanted())} files into web/index.html")
    else:
        print(f"manifest already current ({len(wanted())} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
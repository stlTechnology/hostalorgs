#!/usr/bin/env python3
"""Generate web/SOURCE.md: the GPL v2 source offer for what web/ serves.

GPL v2 section 3 requires that anyone given a binary can get its source.  What
web/ serves includes two GPL v2 binaries we did not write:

  * ftewebgl.{js,wasm}   FTEQW, the engine
  * progs.dat, qwprogs.dat  id's QuakeC, via LibreQuake

so the page has to point at exact upstream revisions plus the recipe needed to
reproduce our build.  This generates that file from the actual pins in
scripts/fetch_third_party.sh and the actual commits in third_party/, rather
than from hand-typed text that would silently go stale.

The same obligation covers our own QuakeC once M4 adds game/progs.src; that is
why our own code is listed here too.

Usage: gen_source_md.py [--check]
"""

import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FETCH = os.path.join(ROOT, "scripts", "fetch_third_party.sh")
OUT = os.path.join(ROOT, "web", "SOURCE.md")
BEGIN = "<!-- BEGIN GENERATED (scripts/gen_source_md.py) -->"
END = "<!-- END GENERATED -->"


def sh(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True).stdout.strip()


def pins():
    """Read the pin table out of the fetch script: url|name|commit|sub."""
    txt = open(FETCH, encoding="utf-8").read()
    out = []
    for m in re.finditer(r'"(https://[^"]+)\|([\w.-]+)\|([0-9a-f]{40})\|?([\w]*)"', txt):
        out.append(dict(url=m.group(1), name=m.group(2),
                        commit=m.group(3), sub=m.group(4)))
    return out


def head_commit(name):
    d = os.path.join(ROOT, "third_party", name)
    if not os.path.isdir(d):
        return None
    return sh("git", "-C", d, "rev-parse", "HEAD") or None


def body():
    L = [BEGIN, ""]
    L.append("# Source for the software served from this directory")
    L.append("")
    L.append("This game is served as compiled binaries. Under the GNU General Public")
    L.append("License version 2, which governs the engine and the QuakeC code it runs,")
    L.append("you are entitled to the corresponding source. This page is that offer; the")
    L.append("reproduction instructions are below and the exact upstream revisions are")
    L.append("listed in the table.")
    L.append("")
    L.append("Everything here is either GPL v2 or, for the assets, BSD-3-Clause. The")
    L.append("asset licences and credits are in [`licences/`](licences/) and the full")
    L.append("inventory is in [`../ASSETS-CREDITS.md`](../ASSETS-CREDITS.md).")
    L.append("")
    L.append("## GPL components served from this directory")
    L.append("")
    L.append("| Served file | Component | Licence |")
    L.append("|---|---|---|")
    L.append("| `ftewebgl.js`, `ftewebgl.wasm` | FTEQW engine (WebGL client) | GPL v2 |")
    L.append("| `id1/progs.dat`, `id1/qwprogs.dat` | id's QuakeC, from LibreQuake | GPL v2 |")
    if os.path.isdir(os.path.join(ROOT, "game")):
        L.append("| `id1/progs.dat` (ours, from M4) | our game code | GPL v2 |")
    L.append("")
    L.append("No id/Valve or Team Fortress code or data is present. The QuakeC is id's")
    L.append("GPL deathmatch progs as redistributed by LibreQuake; our own game code is")
    L.append("written from scratch on top of them.")
    L.append("")
    L.append("## Upstream revisions")
    L.append("")
    L.append("Fetched by `scripts/fetch_third_party.sh`, which is idempotent:")
    L.append("")
    L.append("```")
    L.append("git clone <url> && git -C <dir> checkout <commit>")
    L.append("```")
    L.append("")
    L.append("| Directory | Upstream | Commit |")
    L.append("|---|---|---|")
    for p in pins():
        have = head_commit(p["name"])
        mark = "" if have == p["commit"] else f" (checked out: {have})"
        sub = " (with submodules)" if p["sub"] == "sub" else ""
        L.append(f"| `third_party/{p['name']}` | {p['url']} | `{p['commit']}`{sub}{mark} |")
    L.append("")
    L.append("## Reproducing the binaries")
    L.append("")
    L.append("From a checkout of this repository, on Linux, with `python3`, `node`,")
    L.append("`gcc` and an Emscripten SDK installed:")
    L.append("")
    L.append("```sh")
    L.append("scripts/fetch_third_party.sh          # the revisions above")
    L.append("")
    L.append("scripts/build_fte_web.sh             # -> web/ftewebgl.{html,js,wasm}")
    L.append("scripts/build_fte_server.sh          # -> build/fteqw-sv")
    L.append("scripts/build_progs.sh               # -> web/id1/{progs,qwprogs}.dat")
    L.append("scripts/build_models_wad.sh          # -> web/id1/models.pak")
    L.append("scripts/build_sounds.py              # -> web/id1/sounds.pak (Ogg)")
    L.append("scripts/build_maps.sh                # -> web/id1/our.wad, maps/forts.bsp"
             " (the alt maps go to tests/fixtures/maps/, 0479)")
    L.append("scripts/precompress_web.sh           # -> a .gz sibling per content file;"
             " the servers serve these, so the download row measures gzipped bytes")
    L.append("")
    L.append("node tools/serve.js --port 8200 --root web")
    L.append("```")
    L.append("All of these are required rather than cosmetic:")
    L.append("")
    L.append("```sh")
    L.append("# scripts/build_fte_web.sh")
    L.append('WEB_EXTRA_LDFLAGS="-sEXPORTED_RUNTIME_METHODS=addRunDependency,removeRunDependency \\')
    L.append('                  -sEXPORTED_FUNCTIONS=_main,_malloc,_free"')
    L.append('make gl-rel FTE_TARGET=web CC=emcc LDFLAGS="$WEB_EXTRA_LDFLAGS"')
    L.append("```")
    L.append("")
    L.append("- `addRunDependency` / `removeRunDependency`: FTE's web glue")
    L.append("  (`engine/web/prejs.js`) calls them in its `Module['files']` loaders.")
    L.append("  Emscripten 3.1.58 and later only emit them when something requests")
    L.append("  them, and `--pre-js` code does not count as a request, so without")
    L.append("  this every file fetch throws at startup.")
    L.append("- `_malloc` / `_free`: FTE's clipboard code and the Emscripten OpenAL")
    L.append("  shim call them, so playing any sound throws")
    L.append("  `ReferenceError: _free is not defined`. `EXPORTED_RUNTIME_METHODS`")
    L.append("  rejects them, so they go in `EXPORTED_FUNCTIONS`.")
    L.append("- `_main`: must be listed explicitly. FTE's Makefile sets no")
    L.append("  `EXPORTED_FUNCTIONS`, so emcc's default applies, and that default is")
    L.append("  exactly `[_main]`, the program entry point. `EXPORTED_FUNCTIONS`")
    L.append("  *replaces* the list rather than extending it, so omitting `_main`")
    L.append("  removed the only root keeping the engine alive and the linker")
    L.append("  dead-stripped nearly everything: a 5.8 MB wasm came out at 9225 bytes")
    L.append("  with exit status 0.")
    L.append("")
    L.append("FTE's Makefile never assigns `LDFLAGS` and `gl-tmp` forwards it onto the")
    L.append("link, which is why the flags are passed that way rather than by patching")
    L.append("the vendored tree.")
    L.append("")
    L.append("The build uses `gl-rel` rather than `web-rel`, because `web-rel` ends")
    L.append("with `gzip -kf` on its own output and `gzip -kf X` rewrites `X` as it")
    L.append("compresses -- the engine came out truncated, silently. The build")
    L.append("verifies every artefact with `zcat X.gz | cmp - X`.")
    L.append("")
    L.append("The remaining Emscripten settings come from FTE's own Makefile")
    L.append("(`engine/Makefile`, the `FTE_TARGET=web` block) and are unchanged.")
    L.append("(`engine/Makefile`, the `FTE_TARGET=web` block) and are unchanged.")
    L.append("")
    L.append("The QuakeC is compiled with `fteqcc`, built from the same FTEQW revision,")
    L.append("using LibreQuake's own source list and options:")
    L.append("")
    L.append("```sh")
    L.append("cd third_party/LibreQuake/qcsrc")
    L.append("../../fteqw/engine/release/fteqcc progs.src -D__LIBREQUAKE__ -O2 -o progs.dat")
    L.append("../../fteqw/engine/release/fteqcc progs.src -D__LIBREQUAKE__ -D__QW__ -O2 -o qwprogs.dat")
    L.append("```")
    L.append("")
    L.append("`scripts/build_progs.sh` does exactly this.")
    L.append("")
    L.append("## This project's own source")
    L.append("")
    L.append("| Path | What |")
    L.append("|---|---|")
    L.append("| `scripts/` | every build and pack step, plus the server launcher |")
    L.append("| `maps/corridor.map` | our map source (generated by `scripts/gen_map.py`) |")
    L.append("| `game/` | our QuakeC, from M4 onwards |")
    L.append("| `tests/` | the test suite, including the headless-browser harness |")
    L.append("")
    L.append("The build scripts are the authoritative source for how each artefact was")
    L.append("produced; nothing under `web/` is edited by hand except `index.html`,")
    L.append("whose content list is generated by `scripts/gen_manifest.py`.")
    L.append("")
    L.append(END)
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    new = body()
    old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else None

    if args.check:
        if old != new:
            print("FATAL: web/SOURCE.md is stale; run scripts/gen_source_md.py",
                  file=sys.stderr)
            return 1
        print("web/SOURCE.md up to date")
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(new)
    print(f"wrote web/SOURCE.md ({len(new)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
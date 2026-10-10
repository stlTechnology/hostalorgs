# Licensing

Hostalorgs uses three licences, chosen per part. Third-party files always keep
their own licence; those are listed in `ASSETS-CREDITS.md` and shipped in
`web/licences/`.

| Part | Paths | Licence | File |
|---|---|---|---|
| Game code (QuakeC game rules) | `qwtf/` and the compiled `web/id1/progs.dat`, `web/id1/qwprogs.dat` | GPL-2.0-or-later | `LICENSE` |
| Engine page | `web/index.html` (adapted from FTE's web page), the FTE engine build in `web/` | GPL-2.0 (FTE's licence) | `LICENSE` |
| Our art | `maps/` (the forts maps), `assets/` (sounds), our textures in `web/id1/our.wad` (the ones drawn by `scripts/mk_textures.py`), the generated `.bsp` maps | CC BY 4.0 | `LICENSE-CC-BY-4.0.txt` |
| Everything else we wrote | `scripts/`, `tools/`, `tests/`, `server/`, `deploy/`, `docker/`, `site/`, `web/menu.js`, `web/help.js`, `web/landing/`, the docs | MIT | `LICENSE-MIT.txt` |

Why the game code is GPL: it is built on id Software's QuakeC, released under
GPL version 2 or any later version, and compiled together with our code into
one program. The engine (FTEQW) is GPL-2.0 and its source is public at
https://github.com/fte-team/fteqw.

CC BY 4.0 credit line for reuse of the art: "Hostalorgs by Sheebie Game".

Copyright (c) 2026 Sheebie Game.

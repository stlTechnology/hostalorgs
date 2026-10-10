# Hostalorgs

A free, instant-play, multiplayer, class-based team shooter that runs in the
browser. Two forts, two teams, six classes: grab the enemy key from their
basement vault and carry it up to the turn-in on your own fort's roof.

It runs on the [FTE QuakeWorld engine](https://www.fteqw.org/) compiled to
WebAssembly, with our own game rules (QuakeC in `qwtf/`), our own map and
textures, and [LibreQuake](https://github.com/lavenderdotpet/LibreQuake)'s
openly licensed models and sounds. No id Software or Valve game data is used.
Every third-party file and its licence is listed in `ASSETS-CREDITS.md`.

## Play

Open the site, press **Play**, pick a class (a team is picked for you, or
choose one), and you spawn.

| Key | Action |
|---|---|
| `W` `A` `S` `D`, mouse | move, look |
| `Space` / `Shift` | jump / walk |
| `Mouse1` or `Ctrl` | fire |
| `1`–`8`, mouse wheel | weapons |
| right mouse | Sniper scope (hold) |
| `G` / `F` | grenades |
| `V` / `B` | Demolitions: sticky mode / detonate |
| `Esc` | team, class and settings menu |
| `Tab` | scores |
| `H` | show or hide the controls panel |

Classes: Scout, Sniper, Soldier, Demolitions, Heavy, Medic. The panel at the
top right shows your class and its weapons. Full rules: `GAME-DESIGN.md`.

## Run it yourself

The simplest way is the container (game server + web front door, one port):

    docker build -t hostalorgs .
    docker run -p 8080:8080 -e GATE_SECRET=$(openssl rand -hex 32) -e QWTF_MAP=forts2 hostalorgs

then open http://localhost:8080/.

To host it on Azure (one small VM, HTTPS, a budget alert), run this in Azure
Cloud Shell:

    git clone https://github.com/stlTechnology/hostalorgs.git && cd hostalorgs
    REPO_URL=https://github.com/stlTechnology/hostalorgs.git bash deploy/azure/setup.sh

See the comments at the top of `deploy/azure/setup.sh` for the settings.

## Building from source

- `scripts/fetch_third_party.sh` fetches FTEQW, LibreQuake and ericw-tools.
- `scripts/build_fte_server.sh`, `scripts/build_fte_web.sh` build the engine.
- `scripts/build_progs.sh` compiles the game rules into `web/id1/`.
- `scripts/build_maps.sh --map forts2` compiles a map (`maps/*.map`).
- Maps are edited in TrenchBroom; the kit and its guide are in `tools/trenchbroom/`.

Tests live in `tests/` (real servers and headless browsers; e.g.
`node tests/test_lobby.js`, `node tests/ctf_rules.js`).

## Licence

GPL-2.0 (see `LICENSE`), the same as the engine. Third-party content keeps its
own licence; see `ASSETS-CREDITS.md` and `web/licences/`.

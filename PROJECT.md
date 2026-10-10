# Project goal and asset policy

Set by the project owner on 2026-10-03. This file overrides any other doc
where they disagree. Read it before START-HERE.md.

## Goal

A **legal**, browser-based, class-based team shooter in the spirit of QuakeWorld
Team Fortress:

- **Instant play:** open a URL and you're in. No login, no install, no
  downloads beyond the page.
- **Multiplayer:** everyone who hits the server plays together, on teams,
  against each other.
- **The gameplay experience matters, not exact detail:** classes with distinct
  roles, team objectives (capture the flag), fast QuakeWorld-style movement
  and combat. Fidelity to the original's exact numbers, models or maps is
  *not* a goal.

Judge work by how far it moves toward "several people in browsers playing a
class-based team game together", not by how closely it matches the original.

Gameplay design (classes, CTF rules, map) is in `GAME-DESIGN.md`.

## Requirements (measurable; tests should check them)

| Area | Requirement |
|---|---|
| Time to play | Cold cache, LAN: URL opened → controlling a player in **≤ 10 s**. Warm cache **≤ 3 s**. |
| Download size | First load **≤ 8 MB** gzipped in total (engine + content). Content beyond that loads lazily. |
| Frame rate | **≥ 60 fps** at 1080p on integrated graphics (Intel UHD class), measured with FTE's `showfps`; **≥ 30 fps** under SwiftShader at 800×600, as a CI sanity floor. |
| Players | **16 concurrent players** on one server without server frame-time spikes over 10 ms (the server runs at 72 Hz or more). |
| Network | Playable at 100 ms RTT and 1% packet loss (client-side prediction on). Each player uses ≤ 30 KB/s down. |
| Browsers | Current Chrome, Firefox and Edge on desktop. Safari and mobile/touch are stretch goals. |
| Input | Keyboard + mouse with pointer lock. Rebindable keys through FTE's binds. Mouse sensitivity setting. |
| Server ops | One command to start (`scripts/run_server.sh`), auto-restart on crash (a systemd unit), and logs to a file. No outbound connections to master servers or brokers. |
| Abuse/safety | Front door per the section below (bot defence). The server is authoritative (clients never decide hits or positions). Name length and character filter. Per-IP connection limit. No personal data collected. |
| Privacy | No analytics, no third-party requests from the page. Everything is served from our own host. |

## Front door: bot defence (owner requirement, 2026-10-04)

A scanner or bot that finds this web server must get **one small, boring
static page and nothing else**. It must not cause game downloads, game-server
connections, process creation or meaningful CPU work. Only a person who
deliberately continues gets the game, then the connection, then the lobby.

| Stage | Who reaches it | What it costs us |
|---|---|---|
| 1. Landing `/` | anyone | One static HTML file, ≤ 10 KB, no engine script, no third-party requests. A neutral title and a **Play** button. Unknown paths get a tiny 404 with no listing. |
| 2. Play click | a person | The page fetches `POST /api/session`. The server answers with a short-lived signed token: HMAC-SHA256 over expiry, nonce and client IP, valid 5 min to start loading. Optional proof-of-work (the client finds a SHA-256 hash with N leading zero bits, about 0.5–1 s on a laptop; the server checks it in O(1)), with N adjustable and 0 allowed. |
| 3. Game load | holders of a valid token | Engine and content (`/play/...`: wasm, js, paks, maps) are served **only** with a valid session cookie. Without it: 403 with a tiny body; the wasm is never streamed. |
| 4. Game connection | holders of a valid token | The browser opens `wss://<origin>/play/ws` to **our gate** (same origin and port as the page; no game port is ever exposed). The gate checks the token on the HTTP upgrade *before* touching the game server, then pipes the bytes to FTE. FTE listens on **127.0.0.1 only**, so it can't be reached from the network directly. |
| 5. Lobby | connected players | As in GAME-DESIGN.md. |

**Single origin, single port (owner, 2026-10-04).** The game server is
**internal only**. Nobody connects to it except through our gate, after
loading our client. Everything a browser does happens over one HTTPS origin:

```
browser --HTTPS/WSS :443--> [platform TLS] --> gate (:8080 in the container)
                                                 |-- /            landing (static)
                                                 |-- /api/session token
                                                 |-- /play/...    gated assets
                                                 `-- /play/ws     gated WebSocket --> FTE 127.0.0.1:27500
```
- FTE exposes **no** network port: its TCP/WebSocket listener is bound to
  127.0.0.1, and its UDP listener is disabled or bound to 127.0.0.1. The
  browser client never dials FTE's port; it connects to `wss://<origin>/play/ws`
  and the gate pipes the bytes.
- Locally (LAN dev) the same gate serves plain http/ws on one port. TLS is the
  platform's job in production.
- **Deployment target:** a single container image (gate + FTE + snapshot of
  web/) on **Azure Container Apps or App Service** (both support long-lived
  WebSockets). Firebase Hosting can't run the game server; if Google is
  preferred, Cloud Run is the equivalent. Choose at M6 with the owner.
- Production notes:
  - one replica per match (the game server is stateful; no autoscale-out
    across a running match);
  - if the platform load-balances, use session affinity;
  - set the WebSocket idle timeout above the gate's 60 s idle close;
  - keep the server secret (the HMAC key) in the platform's secret store,
    not in the image.

Hard rules for the deployed gate:
- **No process creation** per request, ever. No uploads, no directory
  listings, no debug endpoints. (`tools/serve.js` is a dev tool with an
  upload endpoint that spawns Python; it must never be the public server.)
- Per-IP limits: ≤ 10 session tokens/min and ≤ 2 concurrent game
  WebSockets. A global cap equals the server's maxclients. Excess gets 429
  with a tiny body.
- Timeouts: 5 s for request headers, 1 KB body limit on the API, idle
  WebSocket closed after 60 s without game traffic.
- `robots.txt` disallows everything. No version banners, no `Server:`
  header detail, no stack traces in responses.
- Logs: one line per session issued or refused (time, IP prefix, reason);
  no request bodies.

## Asset and licensing policy

Not legal advice. These are the working rules until the owner gets real advice.

| Thing | Status | Rule |
|---|---|---|
| Quake / QuakeWorld engine **source code** (id, 1999) and GPL engines derived from it (FTEQW, ezQuake, MVDSV) | GPL v2 | OK to use and modify; our engine code must then be GPL too |
| Quake **game data** (`pak0.pak`, `pak1.pak`: models, textures, sounds, maps) | Copyright id / ZeniMax / Microsoft | **Never** in `static/`, never in git. The shareware `pak0.pak` may be used **locally** as a test oracle (it contains real BSP29 maps like e1m1) |
| Team Fortress mod (`qwprogs.dat`, its models, sounds and maps incl. 2fort5) | Copyright Team Fortress Software, acquired by Valve; free to download but no open licence known | Never shipped, never copied. Don't port its QuakeC. |
| Names "Team Fortress", "TF", "2fort" | Valve trademarks / identifiable works | Not for anything public. Pick our own game, class and map names before release. |
| Open assets (e.g. LibreQuake, CC-BY/CC0 art) | Per their licence | OK, with attribution recorded in `ASSETS-CREDITS.md` |
| Generated assets (`scripts/gen_assets.js`) | Ours | OK. The generated map must become our own design, not a recreation of 2fort |

Practical rules:

- Anything under `static/` is served to every visitor, so it is
  **distribution**. Only ours, GPL or openly licensed content goes there.
- The owner's original game files stay offline and are not given to agents.
  Do not ask for them; use shareware `pak0.pak` or open assets as the
  reference instead.
- If any proprietary file is ever used locally, it lives in `local-assets/`
  (git-ignored), read-only, and is never copied into `static/`, `build/` or
  a commit.
- Players may load their own legally owned paks into their own browser
  (`AssetStore.mount` in `static/js/input.js`). Those files never touch our
  server, so that path is fine to keep.

## Review checklist (applied to every round of work)

1. **Goal:** does this change move toward multiplayer, instant-play,
   class-based team play? If it's polishing a subsystem the goal doesn't
   need yet, say so.
2. **Legal:** no proprietary assets, code or names were added to `static/`,
   git or anything public-facing.
3. **Evidence:** claims are backed by measurements, recordings
   (`tools/README.md`) or tests that were shown to fail when the bug is
   reintroduced. Fixes are confirmed by replaying the same recording before
   and after.
4. **Real path:** tested through the path a real player uses (real browser
   input, connected to a server), not only through test APIs.
5. **State recorded:** committed to git, START-HERE.md updated briefly, and
   running servers restarted when their code changed.

## Engine decision (owner, 2026-10-03): FTEQW

Build on GPL FTEQW (WebGL client + dedicated server). Our effort goes into our
own gameplay QuakeC (fteqcc), our own maps (ericw-tools) and open-licensed
assets. The from-scratch engine in `client/` is retired and kept for
reference (git tag `custom-engine-final`). Plan: `.team/PLAN.md`; worker and
reviewer process: `.team/PROTOCOL.md`.

# Game design (working draft)

The gameplay spec for M4–M5. Written by the reviewer from the owner's goal
(`PROJECT.md`); the owner can change anything here. Everything is our own
design: no Team Fortress names, numbers, code or map layouts.
**Working title:** *Keepfall*. This is a placeholder; the owner picks the
real name before anything goes public.

## Pillars, in priority order

1. **In within 10 seconds.** Open the URL and you're in the lobby; Enter twice
   (team, class) and you're playing. No login, no install.
2. **A reason to work as a team:** distinct class roles, and team objectives
   that one player can't win alone.
3. **QuakeWorld feel:** fast movement, air control, rocket/grenade jumps,
   hitscan plus projectile weapons, short time-to-kill.
4. **Readable:** team colours on players, flags and base architecture, so you
   always know where you are and who's who.

## Session flow (matches the owner's reference experience)

The owner's description of how joining worked:
- a lobby on join,
- an empty team gets you automatically,
- you could switch team only if the teams were even,
- you then picked a class,
- you spawned in your team's spawn, in one of the castles.

Ours, kept within the 10-second instant-play target:

1. Open the URL. The page connects automatically and shows the **lobby**
   (an in-game menu over the live map view, not a separate page).
2. **Team step:**
   - If a team is **empty**, or one team is **smaller**, you're placed on
     it automatically and the step is skipped.
   - If the teams are **even**, you choose Red or Blue. The suggested team
     is preselected, so Enter accepts it.
   - Switching team later is only allowed when it wouldn't leave the teams
     uneven (the same rule).
3. **Class step:** pick a class with keys 1-6 or a click. It's required, as
   in the original. The last-used class is preselected (Soldier for new
   players), so Enter accepts it.
4. You spawn in your team's spawn room inside your team's castle.
5. After death: respawn delay 3 s, same class. A class change from the menu
   applies at the next respawn.
6. Name: generated (`Player-1234`) unless set; can be changed in the lobby.
   Leaving is just closing the tab.

Budget: a first-time visitor who presses Enter twice is playing within the
10 s target.

## Menus (owner request, 2026-10-04): minimal, for our purpose only

Strip FTE's stock menus entirely: no single player, no server
browser/multiplayer setup, no "new game", no mods list, and none of the long
option pages. Players should never see them. ESC opens **our** menu, which
has only:

1. **Resume**
2. **Change team** (obeys the even-teams rule; greyed out with the reason
   when switching would unbalance the teams)
3. **Change class** (the six classes; applies at the next respawn)
4. **Settings**, a small panel: mouse sensitivity, invert mouse, volume.
   Nothing else.
   The menu footer shows a small **build stamp**: build date/time and the
   short commit (e.g. `build 2026-10-05 14:32 CDT · 4ab31a8`), so the owner can
   tell which deploy is live when reporting a problem.
5. **Reconnect** (reconnects to *our* server; there's no address field) and
   **Leave** (back to the landing page)

The same menu is the **lobby** on join: team step, then class step (see
Session flow). Recommended implementation: an HTML overlay in our page that
sends console commands to FTE through a small JS bridge (`team`/`changeclass`
impulses, `reconnect`, cvars). FTE's own menu is disabled (ESC rebound to our
overlay, menu QuakeC not shipped). FTE's console stays reachable only by a
dev key or URL flag in test builds.

## Match rules: capture the key (CTF)

The objective item is a **key** (the owner's original had keys kept in a
basement), team-coloured. Everywhere below, "flag" means this key.

- **2 teams:** Red and Blue. Auto-balance on join; never more than 1 player
  of difference when someone joins.
- **Flags:** each team has a flag in its base's flag room.
  - Touch the enemy flag to carry it.
  - **Capture:** bring it to your own flag stand while your own flag is at
    home. +10 team points, +5 to the capper. The flag resets.
  - **Dropped flag** (carrier dies): it stays where it fell. It returns home
    after **20 s** (owner, 2026-10-08), or immediately if a defender touches it. An attacker can
    pick it up.
  - The carrier can't use movement abilities that would trivialise the run
    (balance knob; see classes).
- **Match end:** 5 captures or a 20-minute time limit, then a 10-second
  scoreboard and the next match on the same map.
- **Spawn rooms:** the enemy team can't enter; doors only open for the owning
  team. This stops spawn camping.
- **Friendly fire:** off. Self-damage is on, reduced to 50% (keeps
  rocket/grenade jumps).
- **Scoring (scoreboard):** frags, captures, flag returns, heals (medic).

## Classes (6, matching the owner's roster; no engineer)

The owner played: scout, sniper, demoman, soldier, hwguy and medic, without
the engineer (it came later with an auto-cannon, and the owner's version
didn't have it). We keep those **six roles**. Generic role names are fine;
the TF-specific coinages ("Demoman", "HWGuy") are replaced. Stats and
abilities are **our own numbers**, not TF's, and get tuned by play-testing.
Base movement is QuakeWorld (`sv_maxspeed 320`).

| # | Class | Role | Speed | Health / armour | Weapons | Grenades (2 kinds) / ability |
|---|---|---|---|---|---|---|
| 1 | **Scout** | Flag runner, recon | 1.35× | 75 / 50 light | Shotgun, nail pistol | Concussion grenade (knockback, also self-boost); flash grenade |
| 2 | **Sniper** | Long range, defence | 0.95× | 90 / 50 light | Charged sniper rifle (damage grows with hold time, zoom), auto-rifle | Hand grenade; flare (lights an area) |
| 3 | **Soldier** (default) | All-round assault | 0.8× | 100 / 200 combat | Super shotgun, rocket launcher | Hand grenade; nail grenade (spray) |
| 4 | **Demolitions** | Area denial, breaching | 0.9× | 90 / 120 combat | Shotgun, grenade launcher (bounce mode and sticky remote charges, max 6) | Hand grenade; timed demolition charge (big blast, 5 s fuse, once per life) |
| 5 | **Heavy** | Anchor, defence | 0.7× | 100 / 300 heavy | Shotgun, rotary cannon (spin-up, high damage, slows you while firing) | Hand grenade; shock grenade |
| 6 | **Medic** | Support, sustain | 1.1× | 90 / 100 light | Super shotgun, super nailgun, medkit melee (heals teammates, damages enemies over time) | Concussion grenade; hand grenade |

Grenades: 2 types per class, limited stock (e.g. 4 + 2), restocked at
spawn-room and base resupply points. Keys: G = grenade 1, F = grenade 2.

Balance targets for play-testing:
- A Soldier beats a Scout one-on-one at mid range.
- A Scout outruns everyone carrying the flag and dies fast if caught.
- A Heavy holding a choke point needs two attackers, or a Demolitions
  player, to break it.
- A charged Sniper shot kills a Scout or Medic, but not a full-armour
  Soldier or Heavy.
- A Medic plus a Soldier beats two Soldiers.
- Demolitions sticky charges are visible and can be shot.

Delivery order (PLAN.md M5): Soldier, Scout, Medic and Demolitions first
(M5a), then Heavy and Sniper (M5b). Engineer/turrets are **out of scope**.

## Map 1: two-fort CTF map (our own layout)

Build it from code (`scripts/gen_map.py`, brush primitives), the same way
as the corridor. Sized for **6–16 players**.

- **Symmetric** (mirror on one axis) so neither side has an advantage.
- **Each base has:**
  - a spawn room with team-only doors,
  - a flag room deep inside the base,
  - **routes out to the other fort:** the **bridge** (exposed, fast), the
    **water** (jump/fall in, then swim) and the **underwater passage** into
    the fort's bottom. Inside each fort, at least two internal ways between
    the key vault and the fort's front, so one held corridor isn't the whole
    defence.
  - a defensive high point overlooking the main entrance,
  - health and armour pickups on the routes, not in the flag room.
- **Between the forts:** the water channel and the bridge (see Layout).
  Long sightlines between the battlements are part of the design; the
  underwater route is the way across that avoids them.
- **Team identity:** red-tinted textures and lights in one base, blue in the
  other, neutral midfield.
- Flag room to flag room is about 20–30 seconds of running at Soldier speed.
- **Battlements (owner request):** each castle has a walkable battlement
  walk around its top. It has crenellations (merlons and gaps) to shoot
  through and duck behind, and **lookout spots at the wall's turns**
  (corner towers or bastions). From those you can watch the approach,
  midfield and the other castle's battlements. Reach them by stairs from
  inside the castle. Snipers and defenders live here.
- **Basement key room (owner request):** each team's key sits in a vault in
  its castle's basement. Reach it by a stair/ramp down from inside the
  castle. The vault itself has one main way in plus one narrower one, so it
  can be defended but not sealed. The underwater passage surfaces near
  this level. **Turn-in pad (owner request, 2026-10-09):** under each team's
  capture stand there is a low pad (128×128, 8 tall) in that team's trim
  colour, with a bright team-coloured light above it, so the turn-in reads
  as a glowing block from across the room.
- **Layout (owner decision, 2026-10-04): two forts facing each other across
  water, with a bridge between them, and an underwater way into each fort.**
  - A water channel (swimmable, Quake water) separates the two forts. One
    bridge crosses it between the fronts of the forts. The bridge is the
    exposed main route, watched from both sets of battlements.
  - Jumping or falling into the water is not a dead end. **(Changed
    2026-10-09, owner: "just put in an obstruction on the entrance to the key
    room so one can't go through it for now.")** The underwater passage into
    each fort's bottom is walled off at the channel end, so the water is no
    longer a direct line to the key. What a swimmer gets instead is a **water
    ramp** on each fort's side of the channel: a slope out of the water to a
    landing, then two steps up onto the bank top -- out of the water, on foot,
    no jump. Getting back into a fort from there means the bridge door, like
    anyone else.
  - Battlements on each fort face the other fort across the water, with
    lookouts at the wall turns.
  - Spawns are inside each fort; the key vault is in each fort's basement.
  - **Distance from the original:** the owner's description is the brief.
    Don't use the original map's files, screenshots or measurements. Our own
    dimensions, interior rooms, routes inside the forts, textures and name.
    The shared ideas (forts, bridge, water, underwater entrance) are generic.
    The specific arrangement and proportions are ours. (Not legal advice; the
    owner has accepted this as their decision.)

## Map 1 v2: inside each fort (owner request, 2026-10-05)

The owner read public descriptions of the classic two-fort layout and wants
"the basics of the layout"; the map itself can be our own. Below is that
basic shape in our words: rooms and how they connect. It's a graph, not a
floor plan. The research stays out of git and isn't copied: no names,
images or measurements. Our own proportions, textures and room shapes.

Per fort, three levels, every connection walkable on foot (stairs or
ramps, no jumps needed) and enclosed, so you can't fall off:

**Ramps over stairs (owner, 2026-10-05: "ramps, more than stairs"):** level
changes are ramps by default. Use a gentle slope, about 30° or less (Quake
walks up to about 45°). Ramps are walled or railed on their open sides.
Stairs are the exception, kept for places like the winding stair down to the
key, where close-quarters turns are the point.

- **Ground floor (front):**
  - **Two doorways** from the bridge end into a short **entrance hall**,
    which splits left and right (a T).
  - **Left:** a stair down to the **water tunnels**, plus a narrow corridor
    toward the courtyard.
  - **Right:** a medium room with a door through to the **courtyard**, the
    busy direct route.
- **Courtyard:** an open-air yard inside the fort walls, linking the ground
  floor routes. A wide **ramp** goes up from the ground floor to the upper
  floor. It's a main choke point.
- **Upper floor:**
  - An **upstairs hub** just outside the main **spawn room**. It opens onto
    the **battlements** at the front.
  - The battlements have a **roofed centre bunker** with a big open window
    facing the other fort. The **capture point** is in that bunker.
  - Lookouts at the wall turns stay as in Map 1.
- **Down to the key:** from the upstairs hub, a **winding stair** (several
  short flights with landings, turning one way, close quarters) goes down
  to the **basement**.
  - The basement has a small **resupply** room (health and ammo) and the
    **key room**.
  - The key room has a second, narrower way in, so it can be defended but
    not sealed.
- **Drop shortcut:** a grate or hatch near the top of the winding stair
  drops you into the entrance hall.
  - It's one-way down, a fast escape for a key carrier, and lands on open
    floor.
  - It's the only intended drop inside a fort. Mark it so it isn't
    mistaken for a hole.
- **Water tunnels:** from the channel under the bridge, long underwater
  tunnels lead to the **ground floor near the entrance**, through the
  left-hand stair. This replaces "the underwater passage surfaces at the
  vault".
- **Routes to the key:** at least two, sharing as little as possible.
  - Via the bridge: entrance hall, courtyard, ramp, hub, then the winding
    stair down.
  - Via the water: tunnels, entrance hall, then the same route, or the
    courtyard route.
- **The capture, as the owner played it (2026-10-05):**
  > "the key turn in, is in the center of the battlement that overlooks the
  > front of the base and is accessable from the other base by the sniper
  > when zoomed in, or by a grenade or a rocket."
  - **Turn-in point:** the centre of your own front battlement. It must be
    **exposed**: in clear line of sight from the enemy battlements (a sniper
    zoomed in can hit you), and in reach of a lobbed grenade or a rocket.
    The bunker roof can shade it, but its front must be open toward the
    enemy fort. A test proves the line of sight: a trace from the enemy
    battlement to a player standing on the turn-in point is clear.
  - **The run:**
    - Get into the enemy fort, then up to its second floor.
    - Go down the winding stair to the basement and take the key.
    - Climb back up to the second floor and get out.
    - Cross (bridge or water) and enter your own fort.
    - Climb to your second floor by one of **two paths**, then go back out
      to the centre of your battlement to turn in.
  - **The basement is only reachable from the second floor**, never
    straight from the ground floor or the water. That's what makes the run
    long.
  - **Each fort has two ground-to-second-floor paths:** the ramp, plus one
    other.
- **Rule change for v2:** a capture is made by bringing the enemy key to
  the turn-in point at the centre of your own battlement, while your own key
  is at home. It replaces "your own flag stand" in the match rules once v2
  ships.
- **Sizes stay as the pathing rules say:** corridors and doors at least
  128 world units wide, and at least 128 of headroom; steps rise 18 or
  less. The `traps`, `doors` and `corridors` checks and the engine walk
  test (`walk_routes`) must pass on every route above.

## Owner playtest, 2026-10-08 (build e07306d): requirements

> "This is a much better map so far ... overall it's still fast and shaping up nicely."

1. **The key must work (critical, core loop).** "I couldn't 'grab' a key. there appears to be
   no action when walking or passing through them."
   - Each key is coloured in its team's colour.
   - Running through the ENEMY key picks it up: it disappears from its stand.
   - **The carrier is visibly marked:** brighter, with a glow in the key's team colour, so
     everyone can see who has it (QW effects: dimlight/brightlight plus the team colour).
   - **Death drops it** where the carrier died. It stays there **20 s** (this replaces the 30 s
     in the match rules), then returns to its key room. A defender touching it returns it at once.
2. **The bridge must let you jump into the water.** The bridge sides are currently too high
   to jump over, so the water can only be reached from the battlements. Keep a rail you can't
   simply *walk* off (higher than a step, 18), but low enough to *jump* over (about 32 high or
   less), or leave jumpable gaps.
   - **DONE (2026-10-08, reviewer 0527 item 3):** the rail is **24 world** above the deck
     (`FORTS_BRIDGE_RAIL = 12` design at `FORTS_SCALE 2`), which is the band this item asks
     for: above the 18 step so a walking player still cannot step off, and under the ~45.6 a
     Quake jump clears, so you can hop the rail from the deck. `tests/test_forts_map.py`
     asserts the band off the map, and the `drop` leg of `tests/walk_routes.js` walks the
     player at both rails and asserts they end up **in the water** (waterlevel > 0) rather
     than stopped by a wall. The battlement merlons are untouched at 32 and the same leg
     still asserts you cannot walk off those.
3. **Drowning:** after about **15 s** fully underwater, the player takes damage at intervals,
   with a gasping/drowning sound each time.
   - **DONE (2026-10-08, reviewer 0527 item 4):** `qwtf/drown.qc` owns the whole breath,
     wrapped onto LibreQuake's own `WaterMove`: **15 s** fully underwater (`waterlevel` 3,
     so waist-deep never drowns) and then a damage tick **every 1 s**, 2 rising by 2 to a
     cap of 10, each tick playing `player/drown1.wav` / `player/drown2.wav` alternately and
     surfacing playing a gasp. Vanilla's 12 s drowning is suppressed rather than left to
     run beside it, and `tests/drown.js` proves that by measuring that NOTHING at all is
     lost in the first 14.5 s. One thing to know when playing it: **armour absorbs drowning
     first**, exactly as it absorbs everything else in Quake, so a Soldier (100 health, 200
     armour at 0.6) spends about eighteen seconds of air on armour before bleeding. Bots
     are exempt (the underwater passage is a long swim and a bot that drowned there lost
     the key).
4. **HUD help:** an on-screen key reference, so players know which buttons do what (fire,
   jump, the Esc menu, class special, and so on). Small, unobtrusive, toggleable.
5. **More guns, more classes, with each class's guns assigned** (the six classes in "Classes"
   above, each with its own fixed loadout).

The water itself works: you can climb out and ramp up to the middle floor.

## Easter eggs (owner request, 2026-10-04)

Hidden references to: **Jason Wolff** (the owner), **Claude Code**,
**Opus 5.5**, **OpenCode**, **space bunny**, **OpenRouter** and **Nemotron**
(the local model that built the easter eggs; owner, 2026-10-06).
- **Text only, no logos or brand artwork.** Names in our own generated
  lettering on our own textures (PIL -> WAD like the other textures).
- **Hidden, not in the way of play.** Ideas:
  - a secret credits room in each fort behind a shootable panel (a
    standard secret door) with a stone plaque reading roughly "Built by Jason
    Wolff, with Claude Code (Opus 5.5), OpenCode (space bunny, via
    OpenRouter) and Nemotron";
  - a small bunny sprite (ours, generated) tucked somewhere hard to spot,
    e.g. in the underwater passage or behind a battlement merlon;
  - a centre-print message when the secret is found.
- **Build stamp (owner request):** the plaque also shows the build date and
  time, e.g. "Built 2026-10-05 14:32 CDT", stamped onto the plaque texture
  when the map is built (local time, America/Chicago, with zone).
- **One build switch** (e.g. `QWTF_EASTER_EGGS=0`) strips all of it, in case
  the owner later publishes and wants product names out.
- Must not affect symmetry or balance: identical secrets in both forts.

## Art and audio needed (open-licensed or our own)

- **Key model:** LibreQuake has none suitable as the team objective. Build
  a simple key `.mdl` from code, skin-coloured per team, ours.
- **Team colours on players:** use QuakeWorld's top/bottom colour shirts on
  `player.mdl` (red 4/4, blue 13/13).
- **Sounds:** ship only the gameplay subset (weapons, player, items, misc;
  about 5.6 MB of wav) converted to Ogg, about 1 MB. Plus our own short cues:
  key taken, key dropped, captured.
- **HUD:** team score, key status (home / taken / dropped) for both teams,
  class, health/armour/ammo.

## Not in scope (until the owner asks)

Accounts, persistent stats, matchmaking, voice, cosmetics, more than one
server, public hosting. Bots are listed as an option in PLAN.md (so a lone
visitor has someone to play).

## Owner reference notes (2026-10-04)

The lobby, team and class flow and the six-class roster come from the
owner's description of the version they played. More detail on what made
rounds fun or annoying is still welcome.

## Owner input that would change this doc

Which original classes you actually played and liked, what made a good
round, and what annoyed you. Drop notes in `/data` or tell the reviewer; this
doc is updated from them.

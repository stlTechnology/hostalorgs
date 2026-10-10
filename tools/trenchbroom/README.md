# The TrenchBroom kit

Everything you need to draw **our** map in TrenchBroom on Windows, and every number in
it is a number the tests already check. If a size here disagrees with your map, the map
is wrong — that is the whole point of the file.

Read `scale-references.map` first. Open it, look at the things in it, and you have a
ruler.

## What is in here

| file | what it is |
|---|---|
| `qwtf.fgd` | our entities, and only ours, so the editor knows what a key is |
| `scale-references.map` | one of each thing whose size matters, to measure against |
| `README-WINDOWS.md` | the copy of the guide that ships in the kit zip |
| `make_scale_references.py` | what generated the above (you do not need this) |
| `../../scripts/make_tb_kit.sh` | builds the owner's zip: fgd + template + our `id1/` + README-WINDOWS.md, into `/data/quake-maps/qwtf-trenchbroom-kit.zip`, with a fresh-unzip qbsp compile proof every time |

The owner never reads this folder directly; they get the zip. This folder is where the
zip's contents live and where the deep version of every rule is written.

## Setting TrenchBroom up

**1. Install TrenchBroom.** It is free and open source — get it from its own site
rather than from me, so you have the current version. Windows is fine.

**2. Set up the game config in Preferences.** In TrenchBroom: *Preferences → Games*, select
**Quake**, set **Game Path** to the unzipped `qwtf-kit` folder (the one that contains
`id1/`).

**3. Create a new map for Quake.** *File → New map*. In the **Entity inspector**, under
**Entity Definitions**, choose **Browse** and pick `qwtf.fgd` from the kit folder.

**4. Make sure the map's textures come from the kit.** Worldspawn's `wad` key names
`id1/our.wad`. If textures don't show, add `id1/our.wad` in the **Face inspector**'s
texture collections.

**5. Open `scale-references.map`.** Now the entity list has our things in it and the
reference geometry is on screen.

**Do NOT point at your original Quake installation.** Everything TrenchBroom needs —
textures (`our.wad`) and entity models (`models.pak`) — is inside the kit's own `id1/`
folder. Pointing at your original Quake would pull id's assets into our map, and
PROJECT.md's licensing rules mean we cannot ship anything that touches them. If
TrenchBroom ever complains it cannot find `our.wad`, the answer is the kit's `id1/`
folder, never an install of Quake.

## The five rules

Every number below is one a test measures. None of them is a matter of taste.

### 1. Doorways at least 128 × 128

A player's hull is **32 wide**. A 128 gap leaves 48 either side; a 96 gap leaves 32,
which is the hull exactly, with no margin at all — and the corridor test asks for 96 of
clear width **including** the hull, so 96 total is not enough. Measure the **gap**, not
the wall.

### 2. Steps 16 or less

Quake's step-up is **18** and that is a hard limit, not a guideline. Our own flights use
**16**. Also: a tread at least **32** deep, or a 32-wide hull has nothing to stand on and
you are sliding rather than climbing.

If you want a gentler slope than steps, use a **ramp** — that is what our three flights
are now. The reference map has a 1:4 one and a 30-degree one (29.74°, railed), and
**the owner's ramp rule** is: ramps preferred over steps, slope **30° or less**, at
least **128 wide**, and every **open side railed** so you cannot roll off it. The
template's 30-degree ramp shows all four: two walls ride the slope 32 above its
surface, past the 18 step-up, so nobody walks through a rail.

### 3. No hole without a wall around it

Every opening a player could fall through needs something around it. This sounds obvious
and is the rule that catches everyone, because the failure is a ledge you did not think
about rather than a hole you drew.

### 4. Every room has a way out on foot

This is the one that costs the most time, and the one to read carefully:

- A **ledge you can fall off** is fine. You get out by walking off it.
- A **ledge you can only be put on by falling** is a trap. Nothing gets you back up.

If a player can land somewhere, they must be able to leave it by walking. Our map
passes this with **0 traps out of 62314 reachable cells**, and the question that used to
be open under it — whether "get out" includes dropping off a ledge — is settled and
measured: dropping off counts, and the test prints the stricter reading beside it
(`2212 reachable only by jumping`) so you can see both numbers at once.

### 5. The turn-in centre of the battlement is exposed to the enemy battlement

Put the turn-in where the enemy can see it. It passes every structural check either way,
which is exactly why it has to be a rule rather than a hope.

## Saving your map where we can build it

**Compiling is our job, not yours.** You do not run qbsp, vis or light, and you do not
need this repository.

Save your map and put it in the shared drop folder:

```
/data/quake-maps/incoming/<name>.map
```

The folder already exists on the box. Reach it however you move files between your
machine and the box today — the same way the kit zip reached you. Use any name that is
not `forts`, `ctf`, `duel` or `corridor`: those are ours, generated from code, and
rebuilding them would overwrite whatever you dropped in.

When your map lands in `incoming/`, we run `scripts/build_maps.sh --map <name>` on it
(qbsp → vis → light) and put the `.bsp` on the server. If the compile finds something
wrong, the report you get back names a coordinate, the nearest thing you drew, and a
plain-English cause — the same format as every check below.

## When something is wrong

Every failure we report gives you three things: **a coordinate**, **the nearest named
thing** (an entity or a room), and **a plain-English cause**. For example:

> doorway at 1792, 960 is 96 wide; needs 128

That format is the point. If a report ever gives you a bare number with no place and no
reason, it is a bug in the reporting and worth saying so.

## Things that will bite you, and why

**`spawnflags` is not optional.** On both `item_qwtf_key` and `item_qwtf_stand`,
`spawnflags` **2 is the red team and 4 is the blue team**. Zero is neither team's, the
map does not work, and **the entity still draws perfectly in the editor** — so there is
nothing on screen to tell you. The `.fgd` makes it a dropdown with the zero option
labelled BROKEN for exactly this reason.

**A comment cannot go inside an entity block.** qbsp refuses the file:
`parse_token: Line is incomplete`. Put it above the block.

**Every brush goes inside the `worldspawn` block**, with the entities after it. qbsp reads
a `{ }` that does not start with `(` or `{` as an *entity*, so a brush after the close
comes back as `expected second { at beginning of brush, got "classname"`. That one cost
us a while.

**A 48-tall passage is unusable.** It is exactly a player's height, so the hull touches
the ceiling and the floor at once, collides, and the route is closed. Passages want 64.
This one was in our tunnel and the fix was 64.

**A ramp's low end wants a landing**, not the floor. With the low end at zero the shape
collapses to a face with no normal. Our three flights all start on a landing.

**Braces inside comments are fine.** We checked, because it seemed unlikely.

## If you would rather not draw it

Say so. The alternative is that I keep building it in `scripts/gen_map.py`, which is
what has happened so far — but the reason this kit exists is that building a map by
writing code about it is how you end up with a map nobody has looked at. Your map, your
editor, and the tests will tell you exactly where it is wrong.
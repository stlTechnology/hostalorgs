# The QWTF TrenchBroom kit — for Windows

Everything you need to draw a map for our game in TrenchBroom, and everything in this
kit is ours: LibreQuake textures (BSD-3-Clause), our models, our sounds. There is no
id Software content in it at all, and none may be added to it.

## What you get

```
qwtf-kit/
  README-WINDOWS.md        <- this file
  qwtf.fgd                 our entities, so the editor knows what a key is
  scale-references.map     a sheet of reference sizes to measure against
  id1/
    our.wad                our textures (this is what the .map's "wad" key names)
    gfx.wad                console/UI textures
    models.pak             the entity models, so keys and stands draw in the editor
    sounds.pak             the game sounds (the editor does not use them; they ride
                           along so the folder is a complete id1)
```

## Setting up

1. Install TrenchBroom. It is free and open source — get the current version from its
   own site (Windows build).
2. Unzip this file anywhere you like, e.g. `C:\Games\`. You get a `qwtf-kit` folder.
   Leave `id1/` inside it — the map's textures are looked up there.
3. In TrenchBroom: *Preferences → Games*, select **Quake**, set **Game Path** to the
   unzipped `qwtf-kit` folder (the one that contains `id1/`).

**4. Open the game's map.** *File → Open*, pick `forts.map` from the kit folder. If
TrenchBroom asks, the game is **Quake** and the map format is **Standard**. This is the
real map you play: two forts, the water, the bridge. (`scale-references.map` is NOT the
game map: it is a sheet of loose example pieces, a correct door, stair and ramp, for
measuring against.)

**5. Load our entity file (qwtf.fgd).** It is set per map, in the right-hand panel:
- The right-hand panel has three tabs at its top: **Map**, **Entity**, **Face**. If you
  do not see the panel at all, turn it back on from the **View** menu.
- Click the **Entity** tab. At the very BOTTOM of that tab is a section called
  **Entity Definitions** (it may be collapsed: click its title bar to open it).
- It lists TrenchBroom's built-in files, and below them **External** with a
  **Browse...** button. Click Browse and pick `qwtf.fgd` from the kit folder.
- The keys and turn-ins (`item_qwtf_key`, `item_qwtf_stand`) now draw as our items
  instead of as unknown boxes.

**6. Textures.** They come from `id1/our.wad` in the kit; `forts.map` already names it.
If faces show as missing textures, click the **Face** tab, find **Texture Collections**
(called **Material Collections** in newer versions) at its bottom, and add `id1/our.wad`.

**Do NOT point at your original Quake installation.** Everything TrenchBroom needs —
textures and entity models — is in this kit's own `id1/` folder. Pointing at your
original Quake would pull id's assets into our map, and we cannot ship those. If
TrenchBroom ever complains it cannot find `our.wad`, the answer is the kit's `id1/`
folder, not an install of Quake.

7. For measuring, you can also open `scale-references.map` from the kit folder. The entity list now has our things
   in it (`item_qwtf_key`, `item_qwtf_stand`, …) and the reference geometry is on
   screen. Start your own map with *File → Save As* from there, so you inherit the
   reference sizes as neighbours you can measure against.

The textures come from the worldspawn key `"wad" "our.wad"` — a relative path, so the
same file works on the box that compiles it and on your machine, as long as `our.wad`
stays in `id1/`.

## The rules the tests enforce

Every number below is a number a test measures. None of them is taste.

- **Doorways at least 128 × 128.** The player hull is 32 wide; a 96 gap is the hull
  exactly, with no margin.
- **Steps: rise 16 or less, tread at least 32 deep.** Quake's step-up is 18 and that is
  a hard limit.
- **Ramps are preferred over steps.** The rule for a ramp: **slope 30° or less, at
  least 128 wide, and every open side railed** so you cannot roll off it. The template
  has a railed ramp at 29.74° — the steepest with clean numbers under the limit — next
  to a gentler 1:4 one. Copy the rails.
- **No hole without a wall around it.** The failure is a ledge you did not think about,
  not a hole you drew.
- **Every room has a way out on foot.** A ledge you can fall off is fine — you get out
  by walking off it. A ledge you can only be put on by falling is a trap.
- **`item_qwtf_key` and `item_qwtf_stand`: spawnflags 2 = red, 4 = blue.** 0 draws
  perfectly in the editor and is broken in the game — there is nothing on screen to
  warn you.
- **Brushes go inside the `worldspawn` block; entities after it. Comments above a
  block, never inside one.** Both mistakes are qbsp refusals; the reference sheet's
  own header shows the exact error text for each.

## Handing your map over

Save your map and put it in our shared drop folder:

```
/data/quake-maps/incoming/<name>.map
```

Move it there however you move files to the box today — the same way this zip reached
you. Use any name except `forts`, `ctf`, `duel` or `corridor`; those are ours and get
rebuilt from code.

**Compiling is our job, not yours.** You do not run qbsp, vis or light. We compile
what lands in `incoming/` and put the `.bsp` on the server. If the compile finds
something wrong you get a report with three things in it: **a coordinate**, **the
nearest named thing**, and **a plain-English cause** — for example:

> doorway at 1792, 960 is 96 wide; needs 128

If a report ever gives you a bare number with no place and no reason, that is a bug in
the reporting and worth saying so.

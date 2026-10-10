# What the SKY attempt was, and why it is not in the map

Reviewer 0114, for owner checkpoint 1:

> ctf.map has NO sky. Every face is conc1_1/tek_wall4_1/brick/light, and the
> shell is a sealed box with a concrete ceiling at z=224. So the "castles" are
> rooms inside a big room, and the battlements are a ledge 48 units under a
> concrete ceiling. The owner's picture (two castles, battlements with lookouts
> over the approach) is OUTDOORS.

Correct, and it is the right thing to want. Here is what I tried, what it cost,
and what is left, so the next attempt starts from the measurements rather than
from the idea.

## What I changed

1. `TEX_SKY = "sky5_blu"`, and `build_maps.sh` copies
   `third_party/LibreQuake/texture-wads/lq_liquidsky/sky5_blu.png` into `our.wad`
   (BSD-3, like the rest of LibreQuake). The name starts with `sky`, which is how
   Quake's renderers decide a brush is sky rather than a surface: not lit, not
   drawn as a wall, scrolled to the camera angle.
2. `CTF_SKY_Z = 1024`: the shell's ceiling brush moves from z=224 to z=1024 and
   takes the sky texture. A sky brush seals the map exactly as well as a solid one,
   so this does not touch the leak/vis property.
3. A roof over each castle's interior rooms, stopping short of the wall tops, so
   the battlement walkway is open to the sky. The spawn room's roof has a hole
   where the staircase arrives.
4. The spawn room's walls raised from z=144 to the walkway's z=176, because the
   walkway floor sits at 160..176 and the roof at 176..192; at 144 they were all
   floating.

## What happened

qbsp never finished. On the map as committed, qbsp compiles the same file in
**0.47s**. With the sky and the roof:

```
real	2m0.002s
user	3m59.957s
sys	0.02s
rc=124        (killed at the timeout, stuck in ---- ProcessMapBrushes ----)
```

and before the wall-height fix, `3m20s` wall / `10m` of CPU. So the change costs
between 400x and 1200x the compile time and does not terminate in any reasonable
time. I reverted it: `git checkout -- scripts/gen_map.py scripts/build_maps.sh`,
and confirmed the committed map still compiles in 0.47s and passes all 37
structural checks.

## What I know about the cause, and what I do not

Two things are floating in that build, and I did not isolate which one qbsp hates:

- **The roof over the flag room.** The flag room's walls are `walls(48, 128, 0,
  240, 288, 176)` -- they reach z=176, so a roof at 176..192 rests on them. That
  one looks sound.
- **The roof over the spawn room.** I set it to x 16..160, y 384..640 at z
  176..192, because at x 16..176 it OVERLAPPED the lookouts (which occupy x
  160..256 at the same z). Overlapping solid brushes have already cost this map
  once -- the BSP went to 119136 nodes from 116 brushes -- so I pulled the roof in
  rather than ship the overlap. The overlap was therefore not the cause of the
  hang, since it still hung afterwards.

I did not get to bisect it, and I would rather say that than guess at a fix I
cannot compile. The honest next step is to add the sky WITHOUT the roofs first:
one brush changed, from `box(X0, Y0, CTF_H, X1, Y1, CTF_H + T, TEX_CEIL)` to the
same box at `CTF_SKY_Z` with `TEX_SKY`. If that compiles in the same 0.47s, the
roofs are the problem and can be designed against that; if it does not, the sky
brush's size is the problem and the ceiling has to be a proper dome or a set of
stair-stepped sky brushes instead of one 2080x928 lid.

## The flood fill needs a ceiling either way

Worth knowing before the next attempt, because it bit me: with the sky at 1024,
`tests/test_ctf_map.py`'s hull-sized flood fill had to fill the whole open volume
and stopped finishing inside its timeout (rc=124, and with no output at all,
because python buffers stdout when it is not a terminal and loses it on the
signal). Two changes, both committed and both needed whatever the sky turns out
to be:

- `FLOOD_CEIL = CTF_WALK_Z + 200` in both `tests/test_ctf_map.py` and
  `scripts/map_route.py`: the fill stops at the battlement walkway plus a generous
  jump, which is everything a player can stand on. Filling to the sky brush only
  fills the sky.
- The fill's step is 32, exactly a hull's width and the coarsest that can still
  find any passage a player could use. Every opening in this map is at least 64
  units across, so nothing here depends on a finer step, and the fill finishes in
  seconds instead of minutes.
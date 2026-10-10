// qwtf/classes.qc -- the class system and the lobby rules (M5a).
//
// GAMEPLAY, the same standing as qwtf/ctf.qc: this file never reads
// qwtf_trace and never calls into qwtf/probe.qc. A rule that only exists
// while a test watches was the REJECT 0172 lesson; everything here is on the
// hook it belongs to:
//
//   class apply     PutClientInServer, which the engine calls on every spawn
//   team spawn      SelectSpawnPoint, which the engine calls from
//                   PutClientInServer before the player is placed
//   grenades        ImpulseCommands, which W_WeaponFrame calls once per frame
//   medkit/sticky   W_Attack, which the fire button calls
//   poison/flash    PlayerPreThink, per frame
//   lobby commands  SV_ParseClientCommand, which the engine calls with every
//                   client console command it did not handle itself
//   friendly fire   T_Damage, the one door every damage walks through
//
// QWTF_EVENT lines print ALWAYS. dprint itself needs `developer 1` to be
// visible in the server's stdout -- that is the test reader's switch, and it
// gates the READING, never the behaviour.
//
// GAME-DESIGN.md "Classes": six roles; delivery order Soldier, Scout, Medic,
// Demolitions first (M5a), then Heavy and Sniper (M5b). Heavy and Sniper are
// REFUSED by qwtf_setclass until M5b rather than half-shipped: a class that
// spawns with the wrong stats is worse than one that does not spawn. The
// stats table below is the design's, and the numbers are our own -- the
// design says so explicitly -- tuned by play-testing.
//
// Include position: AFTER qwtf/bots.qc (this file uses forceinfokey, which
// bots.qc declares, and spikes/GrenadeExplode/W_SetCurrentAmmo from
// weapons.qc) and BEFORE qwtf/probe.qc. It reads ctf.qc's team constants and
// fields, which are earlier still.
//
// QW ONLY, like qwtf/bots.qc: progs.dat (the NQ-flavoured build, which ships
// as a fallback) compiles none of this, exactly as it compiles none of the
// bots. The game runs qwprogs.dat.

#ifdef __QW__

// ---------------------------------------------------------------------------
// FTE builtins LibreQuake's defs.qc does not declare. Numbers from
// server/pr_cmds.c (KRIMZON_SV_PARSECLIENTCOMMAND): a mod that defines
// SV_ParseClientCommand receives EVERY client command the engine's own table
// does not eat, and the contract (pr_cmds.c:13352) is that unrecognised ones
// MUST go back through clientcommand.
void(entity e, string s) clientcommand = #440;
float(string s) tokenize = #441;
string(float n) argv = #442;

// ---------------------------------------------------------------------------
// Class ids. The order is GAME-DESIGN.md's table; Soldier is the default.
float QWTF_CLASS_NONE = 0;
float QWTF_CLASS_SCOUT = 1;
float QWTF_CLASS_SNIPER = 2;
float QWTF_CLASS_SOLDIER = 3;
float QWTF_CLASS_DEMOLITIONS = 4;
float QWTF_CLASS_HEAVY = 5;
float QWTF_CLASS_MEDIC = 6;

// Grenade kinds (the design: two per class, keys G = grenade 1 and
// F = grenade 2).
float QWTF_G_HAND = 1;
float QWTF_G_CONC = 2;
float QWTF_G_FLASH = 3;
float QWTF_G_NAIL = 4;
float QWTF_G_CHARGE = 5;

// THE FIELDS. A field cannot be added to an edict class from a later file --
// "Unknown field qwtf_carry in class entity" -- so they are declared here at
// file scope, the only place a field can be introduced in this dialect (same
// as ctf.qc).
.float qwtf_class;            // the class in effect
.float qwtf_class_pending;    // picked mid-life; applies at the next respawn
.float qwtf_class_chosen;     // has this client ever picked a class
.float qwtf_g1;               // grenade stock, key G
.float qwtf_g2;               // grenade stock, key F
.float qwtf_gl_sticky;        // demolitions: launcher mode, 0 bounce / 1 sticky
.float qwtf_gl_out;           // demolitions: sticky charges in the world (max 6)
.float qwtf_flash_until;      // flash grenade: blinded and slow until this time
.float qwtf_poison_until;     // medkit: poisoned until this time
.float qwtf_poison_next;      // medkit: next poison tick
.float qwtf_overheal_next;    // medkit: next overheal drain
.entity qwtf_poison_from;     // who poisoned us (the frag goes to them)
.float qwtf_nade_kind;        // on a thrown grenade: which burst its think runs
float QWTF_IN_SELFDMG;        // re-entrancy guard for the self-damage wrap

// ---------------------------------------------------------------------------
// The class table. One question per function, all of them switch-free
// if-chains, because a stats table that needs a second file to read is not a
// table.

string(float id) QWTF_class_name =
{
    if (id == QWTF_CLASS_SCOUT) return "scout";
    if (id == QWTF_CLASS_SNIPER) return "sniper";
    if (id == QWTF_CLASS_SOLDIER) return "soldier";
    if (id == QWTF_CLASS_DEMOLITIONS) return "demolitions";
    if (id == QWTF_CLASS_HEAVY) return "heavy";
    if (id == QWTF_CLASS_MEDIC) return "medic";
    return "none";
};

float(string name) QWTF_class_id =
{
    if (name == "scout") return QWTF_CLASS_SCOUT;
    if (name == "sniper") return QWTF_CLASS_SNIPER;
    if (name == "soldier") return QWTF_CLASS_SOLDIER;
    if (name == "demolitions") return QWTF_CLASS_DEMOLITIONS;
    if (name == "heavy") return QWTF_CLASS_HEAVY;
    if (name == "medic") return QWTF_CLASS_MEDIC;
    return QWTF_CLASS_NONE;
};

// M5a ships Soldier, Scout, Medic, Demolitions. Heavy and Sniper wait for
// M5b -- qwtf_setclass refuses them, so the menu's six buttons never spawn a
// class with invented stats.
float(float id) QWTF_class_available =
{
    // All six since M5b (qwtf/sniper.qc, qwtf/heavy.qc).
    return id >= QWTF_CLASS_SCOUT && id <= QWTF_CLASS_MEDIC;
};

// Speed: the design multiplies QW's base (sv_maxspeed 320). FTE reads
// .maxspeed per client on every move (sv_user.c reads ent->xv->maxspeed), so
// this is a real per-player speed, not a server-wide cvar.
float(float id) QWTF_class_speed =
{
    if (id == QWTF_CLASS_SCOUT) return 432;      // 1.35x
    if (id == QWTF_CLASS_SOLDIER) return 256;    // 0.8x
    if (id == QWTF_CLASS_DEMOLITIONS) return 288; // 0.9x
    if (id == QWTF_CLASS_MEDIC) return 352;      // 1.1x
    if (id == QWTF_CLASS_SNIPER) return 304;     // 0.95x
    if (id == QWTF_CLASS_HEAVY) return 224;      // 0.7x
    return 320;
};

float(float id) QWTF_class_health =
{
    if (id == QWTF_CLASS_SCOUT) return 75;
    if (id == QWTF_CLASS_SOLDIER) return 100;
    if (id == QWTF_CLASS_DEMOLITIONS) return 90;
    if (id == QWTF_CLASS_MEDIC) return 90;
    if (id == QWTF_CLASS_SNIPER) return 90;
    if (id == QWTF_CLASS_HEAVY) return 100;
    return 100;
};

// Armour points and the absorb fraction. Green is light (0.3), yellow is
// combat (0.6), red is heavy (0.8) -- Quake's own armour types, which the
// design's "light / combat / heavy" map onto.
float(float id) QWTF_class_armour =
{
    if (id == QWTF_CLASS_SCOUT) return 50;
    if (id == QWTF_CLASS_SOLDIER) return 200;
    if (id == QWTF_CLASS_DEMOLITIONS) return 120;
    if (id == QWTF_CLASS_MEDIC) return 100;
    if (id == QWTF_CLASS_SNIPER) return 50;
    if (id == QWTF_CLASS_HEAVY) return 300;
    return 0;
};

float(float id) QWTF_class_absorb =
{
    if (id == QWTF_CLASS_SOLDIER || id == QWTF_CLASS_DEMOLITIONS) return 0.6;
    if (id == QWTF_CLASS_HEAVY) return 0.8;
    if (id == QWTF_CLASS_SCOUT || id == QWTF_CLASS_MEDIC) return 0.3;
    return 0.3;
};

// The weapon loadout as Quake item bits, the start weapon, and the ammo.
// The design's weapons are Quake's own guns except the medkit (the axe slot,
// replaced per-class in W_Attack) and the charged rifle and rotary cannon,
// which are M5b. M5b SLOTS (fixed here so the two M5b lanes never edit this table):
//   Sniper: super-shotgun slot (key 3) = charged rifle, shells;
//           nailgun slot (key 4) = auto-rifle, nails.     -> qwtf/sniper.qc
//   Heavy:  super-nailgun slot (key 5) = rotary cannon, nails. -> qwtf/heavy.qc
float(float id) QWTF_class_weapons =
{
    if (id == QWTF_CLASS_SCOUT) return IT_SHOTGUN | IT_NAILGUN;
    if (id == QWTF_CLASS_SOLDIER) return IT_SUPER_SHOTGUN | IT_ROCKET_LAUNCHER;
    if (id == QWTF_CLASS_DEMOLITIONS) return IT_SHOTGUN | IT_GRENADE_LAUNCHER;
    if (id == QWTF_CLASS_MEDIC) return IT_SUPER_SHOTGUN | IT_SUPER_NAILGUN;
    // The Sniper also carries the plain shotgun (owner, 2026-10-09).
    if (id == QWTF_CLASS_SNIPER) return IT_SHOTGUN | IT_SUPER_SHOTGUN | IT_NAILGUN;
    if (id == QWTF_CLASS_HEAVY) return IT_SHOTGUN | IT_SUPER_NAILGUN;
    return IT_SHOTGUN;
};

// Every class spawns holding the weapon it is known for (owner, 2026-10-09:
// "the weapon the class is known for should be loaded initially").
float(float id) QWTF_class_start =
{
    if (id == QWTF_CLASS_SCOUT) return IT_NAILGUN;
    if (id == QWTF_CLASS_SOLDIER) return IT_ROCKET_LAUNCHER;
    if (id == QWTF_CLASS_DEMOLITIONS) return IT_GRENADE_LAUNCHER;
    if (id == QWTF_CLASS_MEDIC) return IT_SUPER_NAILGUN;
    if (id == QWTF_CLASS_SNIPER) return IT_SUPER_SHOTGUN;     // the sniper rifle's slot
    if (id == QWTF_CLASS_HEAVY) return IT_SUPER_NAILGUN;      // the rotary cannon's slot
    return IT_SHOTGUN;
};

float(float id) QWTF_class_shells =
{
    if (id == QWTF_CLASS_SCOUT) return 50;
    if (id == QWTF_CLASS_SOLDIER) return 40;
    if (id == QWTF_CLASS_DEMOLITIONS) return 50;
    if (id == QWTF_CLASS_MEDIC) return 40;
    if (id == QWTF_CLASS_SNIPER) return 60;
    if (id == QWTF_CLASS_HEAVY) return 50;
    return 50;
};

float(float id) QWTF_class_nails =
{
    if (id == QWTF_CLASS_SCOUT) return 100;
    if (id == QWTF_CLASS_MEDIC) return 150;
    if (id == QWTF_CLASS_SNIPER) return 100;
    if (id == QWTF_CLASS_HEAVY) return 200;
    return 0;
};

float(float id) QWTF_class_rockets =
{
    if (id == QWTF_CLASS_SOLDIER) return 25;
    if (id == QWTF_CLASS_DEMOLITIONS) return 25;
    return 0;
};

// Grenade kinds per class, in the design table's order: grenade 1 (key G)
// and grenade 2 (key F).
float(float id) QWTF_class_g1 =
{
    if (id == QWTF_CLASS_SCOUT || id == QWTF_CLASS_MEDIC) return QWTF_G_CONC;
    return QWTF_G_HAND;
};

float(float id) QWTF_class_g2 =
{
    if (id == QWTF_CLASS_SCOUT) return QWTF_G_FLASH;
    if (id == QWTF_CLASS_SOLDIER) return QWTF_G_NAIL;
    if (id == QWTF_CLASS_DEMOLITIONS) return QWTF_G_CHARGE;
    return QWTF_G_HAND;
};

// Stock. The design's example is "limited stock (e.g. 4 + 2)"; the timed
// demolition charge is "once per life", so its stock is 1.
float(float kind) QWTF_grenade_stock =
{
    if (kind == QWTF_G_CHARGE) return 1;
    if (kind == QWTF_G_HAND || kind == QWTF_G_CONC) return 4;
    return 2;
};

// ---------------------------------------------------------------------------
// The event print comes from qwtf/ctf.qc (QWTF_event / QWTF_event_who), which
// is included before this file and prints with the same ALWAYS-on rule.

// ---------------------------------------------------------------------------
// Applying a class at a spawn. This is the only place health, armour, items,
// ammo, speed and grenade stock are written for a spawn, so the stats trail
// below is authoritative for the test's "read server-side" check.
void(float id) QWTF_class_apply =
{
    local float ar, ab, w;
    local float g1k, g2k;

    self.qwtf_class = id;
    // qwtf_class_chosen is deliberately NOT set here. The default spawn is the
    // design's Enter-to-accept default, not a pick: the first qwtf_setclass a
    // player ever sends must still take the lobby's immediate branch (measured:
    // with the flag set by the default spawn, the first pick answered "applies
    // at your next respawn" and the 10 s budget had no respawn coming).

    self.health = QWTF_class_health(id);
    self.max_health = self.health;

    ar = QWTF_class_armour(id);
    ab = QWTF_class_absorb(id);
    self.armorvalue = ar;
    self.armortype = ab;
    self.items = self.items - (self.items & (IT_ARMOR1 | IT_ARMOR2 | IT_ARMOR3));
    if (ar > 0)
    {
        if (ab <= 0.3)
            self.items = self.items | IT_ARMOR1;
        else if (ab <= 0.6)
            self.items = self.items | IT_ARMOR2;
        else
            self.items = self.items | IT_ARMOR3;
    }

    // Only the class's guns and the axe (the medkit slot on a medic). Stock
    // pickups still work -- a dropped item adds its bit back like it always
    // did.
    w = QWTF_class_weapons(id);
    self.items = self.items -
        (self.items & (IT_SHOTGUN | IT_SUPER_SHOTGUN | IT_NAILGUN |
                       IT_SUPER_NAILGUN | IT_GRENADE_LAUNCHER |
                       IT_ROCKET_LAUNCHER | IT_LIGHTNING));
    self.items = self.items | w | IT_AXE;

    self.ammo_shells = QWTF_class_shells(id);
    self.ammo_nails = QWTF_class_nails(id);
    self.ammo_rockets = QWTF_class_rockets(id);
    self.ammo_cells = 0;

    g1k = QWTF_class_g1(id);
    g2k = QWTF_class_g2(id);
    self.qwtf_g1 = QWTF_grenade_stock(g1k);
    self.qwtf_g2 = QWTF_grenade_stock(g2k);

    // Launcher mode and any charges out reset with the life; so do the
    // medkit's poison and the flash blind.
    self.qwtf_gl_sticky = 0;
    self.qwtf_gl_out = 0;
    self.qwtf_poison_until = 0;
    self.qwtf_poison_next = 0;
    self.qwtf_poison_from = world;
    self.qwtf_flash_until = 0;

    self.maxspeed = QWTF_class_speed(id);
    self.weapon = QWTF_class_start(id);
    self.impulse = 0;
    W_SetCurrentAmmo();
    dprint("QWTF_EVENT class_weapon ");
    dprint(self.netname);
    dprint(" weapon=");
    dprint(ftos(self.weapon));
    dprint("\n");

    // THE TRAIL the tests read. Server-side, one line per spawn, the whole
    // design table for this class in it.
    dprint("QWTF_EVENT class_stats ");
    dprint(self.netname);
    dprint(" class=");
    dprint(QWTF_class_name(id));
    dprint(" speed=");
    dprint(ftos(self.maxspeed));
    dprint(" hp=");
    dprint(ftos(self.health));
    dprint(" armour=");
    dprint(ftos(ar));
    dprint(" absorb=");
    dprint(ftos(ab));
    dprint(" shells=");
    dprint(ftos(self.ammo_shells));
    dprint(" nails=");
    dprint(ftos(self.ammo_nails));
    dprint(" rockets=");
    dprint(ftos(self.ammo_rockets));
    dprint(" g1=");
    dprint(ftos(self.qwtf_g1));
    dprint(" g2=");
    dprint(ftos(self.qwtf_g2));
    dprint("\n");
};

// ---------------------------------------------------------------------------
// Team-aware spawn. The vanilla SelectSpawnPoint picks at random among ALL
// free deathmatch spots, so a red player could spawn inside the blue fort --
// which is exactly the spawn-camping the design's spawn-room rule exists to
// stop. This wrap filters the free spots to the player's OWN half of the map.
//
// The half is measured from the spawn points themselves: the fort map is
// symmetric by construction, so the spawn set's midpoint IS the mid-x the
// tests use (2432 at scale 2). No map edit, no new entity.
//
// With the M4 telefrag rule intact: only spots with no player within 84
// units (the original's own filter) qualify, and each side has six.
//
// If a client is spawning with no team yet, the lobby's auto-place rule runs
// HERE rather than waiting for PlayerPreThink -- the engine spawns a client
// before its first PreThink, so this is the only way the FIRST spawn lands
// in the player's own castle. The trail is byte-identical to ctf.qc's, so a
// test reading "QWTFPROBE QWTF_TEAM" sees one line either way.
wrap entity() SelectSpawnPoint =
{
    local entity spot, spots, chosen, thing;
    local float mine, count, minx, maxx, midx, freecount, pick, onmyleft, pcount;

    mine = self.qwtf_team;
    if (mine == 0)
    {
        mine = QWTF_team_of_player(self);
        self.qwtf_team = mine;
        forceinfokey(self, "team", "red");
        if (mine == QWTF_TEAM_BLUE)
            forceinfokey(self, "team", "blue");
        dprint("QWTFPROBE QWTF_TEAM ");
        dprint(self.netname);
        dprint(" -> ");
        dprint(ftos(mine));
        dprint("\n");
    }

    count = 0;
    minx = 0;
    maxx = 0;
    spot = find(world, classname, "info_player_deathmatch");
    while (spot)
    {
        if (count == 0)
        {
            minx = spot.origin_x;
            maxx = spot.origin_x;
        }
        else
        {
            if (spot.origin_x < minx)
                minx = spot.origin_x;
            if (spot.origin_x > maxx)
                maxx = spot.origin_x;
        }
        count = count + 1;
        spot = find(spot, classname, "info_player_deathmatch");
    }

    // One spawn point (or none) says nothing about sides: leave it to the
    // original.
    if (count < 2)
        return prior();

    midx = (minx + maxx) * 0.5;

    // The free spots on my side, chained through .goalentity exactly as the
    // original does, then one random pick among them.
    spots = world;
    freecount = 0;
    spot = find(world, classname, "info_player_deathmatch");
    while (spot)
    {
        onmyleft = spot.origin_x < midx;
        if (mine == QWTF_TEAM_BLUE)
            onmyleft = spot.origin_x > midx;

        if (onmyleft)
        {
            // SELF DOES NOT OCCUPY A SPOT. The spawner's own body is within 84
            // of its side's spot on every respawn: alive on a menu pick (the
            // first qwtf_setclass and a team switch call respawn() on a LIVING
            // player, and CopyToBodyQueue copies the body out but leaves self
            // standing at the old origin until PutClientInServer moves it), a
            // corpse on a death respawn (findradius counts it -- measured: a
            // dead body made vanilla's own 84 filter reject every spot). With
            // one spot per side (the duel fixture) counting self made
            // freecount 0 on EVERY respawn, so every spawn fell back to
            // prior(), which -- also seeing no free spot -- picks a RANDOM
            // spot among ALL of them: half the time onto the other player
            // (spawn_tdeath telefrag: "alpha was telefragged by bravo"), half
            // onto the own corpse spot, right on top of the death backpack
            // (PlayerDie drops it in deathmatch), which instantly re-armed the
            // spawner. Both measured in tests/artifacts/run-sniper-1562184:
            // shells 59,58,57,56, then after the telefrag 99,98,97,96 (the
            // 56-shell backpack plus its own 56, capped at 100) and the
            // auto-rifle's nails 199 (100 + 100, capped at 200).
            pcount = 0;
            thing = findradius(spot.origin, 84);
            while (thing)
            {
                if (thing != self && thing.classname == "player")
                    pcount = pcount + 1;
                thing = thing.chain;
            }
            if (pcount == 0)
            {
                spot.goalentity = spots;
                spots = spot;
                freecount = freecount + 1;
            }
        }
        spot = find(spot, classname, "info_player_deathmatch");
    }

    // Nobody free on my side: fall back to the original rule rather than
    // erroring -- a side that is over-full spawns its players anywhere
    // instead of refusing to spawn them.
    if (freecount == 0)
        return prior();

    pick = rint(random() * (freecount - 1));
    chosen = spots;
    while (pick > 0)
    {
        chosen = chosen.goalentity;
        pick = pick - 1;
    }
    return chosen;
};

// ---------------------------------------------------------------------------
// Grenades. Two per class on keys G (impulse 20) and F (impulse 21), stock
// counted per player, restocked at every spawn (the design's spawn-room
// resupply; base resupply points are a map change that comes with the
// resupply entity, not with this file).
//
// The thrown entity is the stock grenade's shape (W_FireGrenade), but the
// BURST is per kind and lives in the think function, so a grenade that hits
// a player pops that kind's burst immediately (the touch just pulls the fuse
// to now) and a grenade that bounces pops on the fuse.

void() QWTF_nade_hand_boom =
{
    if (self.voided)
        return;
    self.voided = 1;
    T_RadiusDamage(self, self.owner, 120, world, "grenade");
    QWTF_event_who(self.owner, "grenade_boom");
    MissileExplode();
};

// Concussion: knockback only, no damage, and the thrower is included when
// they are inside the burst -- that is the design's "also self-boost", the
// rocket-jump-style mobility move. Same-team players are knocked too: a
// concussion wave does not choose sides.
void() QWTF_nade_conc_boom =
{
    local entity e;
    local vector dir;
    local float dist, power;

    if (self.voided)
        return;
    self.voided = 1;

    e = findradius(self.origin, 300);
    while (e)
    {
        if (e.classname == "player" && e.deadflag == DEAD_NO)
        {
            dir = e.origin - self.origin;
            dist = vlen(dir);
            if (dist < 1)
            {
                dir = '0 0 1';
                dist = 1;
            }
            dir = normalize(dir);
            power = 550 * (1 - dist / 300);
            if (power > 0)
            {
                e.velocity = e.velocity + dir * power;
                e.velocity_z = e.velocity_z + power * 0.4;
                QWTF_event_who(e, "conc_burst");
            }
        }
        e = e.chain;
    }
    MissileExplode();
};

// Flash: enemies in range are blinded -- a screen flash (the client's own
// `bf` background flash) and 2 s of crawl speed -- and so is the thrower if
// they are in range of their own pop. Teammates are spared; friendly fire is
// off everywhere else in this file and this grenade is not an exception.
void() QWTF_nade_flash_boom =
{
    local entity e;
    local float dist;

    if (self.voided)
        return;
    self.voided = 1;

    e = findradius(self.origin, 400);
    while (e)
    {
        if (e.classname == "player" && e.deadflag == DEAD_NO)
        {
            dist = vlen(e.origin - self.origin);
            if (dist < 400 &&
                (e == self.owner || e.qwtf_team != self.owner.qwtf_team))
            {
                e.qwtf_flash_until = time + 2;
                stuffcmd(e, "bf\n");
                sound(e, CHAN_AUTO, "items/damage3.wav", 1, ATTN_NORM);
                QWTF_event_who(e, "flash_blinded");
            }
        }
        e = e.chain;
    }
    MissileExplode();
};

// Nail grenade: a small blast that sprays twelve spikes in random
// directions. The spikes are the stock ones (spike_touch), owned by the
// thrower, so the frag credit lands on whoever threw it.
void() QWTF_nade_nail_boom =
{
    local entity m;
    local vector d;
    local float i;

    if (self.voided)
        return;
    self.voided = 1;

    T_RadiusDamage(self, self.owner, 60, world, "grenade");
    QWTF_event_who(self.owner, "nail_spray");

    i = 0;
    while (i < 12)
    {
        d_x = crandom();
        d_y = crandom();
        d_z = crandom();
        d = normalize(d) * 700;
        d_z = d_z * 0.5 + 200;

        m = spawn();
        m.owner = self.owner;
        m.movetype = MOVETYPE_FLYMISSILE;
        m.solid = SOLID_BBOX;
        m.angles = vectoangles(d);
        m.touch = spike_touch;
        m.classname = "spike";
        m.think = SUB_Remove;
        m.nextthink = time + 4;
        setmodel(m, "progs/spike.mdl");
        setsize(m, VEC_ORIGIN, VEC_ORIGIN);
        setorigin(m, self.origin);
        m.velocity = d;

        i = i + 1;
    }
    MissileExplode();
};

// The timed demolition charge: the design's big blast, 5 s fuse, once per
// life (its stock is 1).
void() QWTF_nade_charge_boom =
{
    if (self.voided)
        return;
    self.voided = 1;
    T_RadiusDamage(self, self.owner, 250, world, "grenade");
    QWTF_event_who(self.owner, "charge_boom");
    MissileExplode();
};

// Sticky charges: fired from the launcher's second mode, they stick where
// they land and wait for the detonate command (impulse 23). Six out at a
// time, per the design. Each is a small bomb; the whole batch goes at once.
void() QWTF_sticky_boom =
{
    local entity own;

    if (self.voided)
        return;
    self.voided = 1;

    own = self.owner;
    if (own && own.qwtf_gl_out > 0)
        own.qwtf_gl_out = own.qwtf_gl_out - 1;
    T_RadiusDamage(self, own, 60, world, "grenade");
    QWTF_event_who(own, "sticky_boom");
    MissileExplode();
};

void() QWTF_sticky_touch =
{
    if (other == self.owner)
        return;

    // A body in the way pops it right there -- the charges are visible and
    // dangerous on touch, which is half of the design's "can be shot" rule.
    if (other.takedamage == DAMAGE_AIM)
    {
        QWTF_sticky_boom();
        return;
    }

    // Stick: no more moving, no more bounce sound, no more touch.
    self.velocity = '0 0 0';
    self.avelocity = '0 0 0';
    self.movetype = MOVETYPE_NONE;
    self.touch = SUB_Null;
};

// The touch every thrown grenade shares: on a body, pop now (the kind's
// think runs on the next frame via nextthink = time); on anything else it is
// a bounce, with the stock bounce sound.
void() QWTF_nade_touch =
{
    if (other == self.owner)
        return;

    if (other.takedamage == DAMAGE_AIM)
    {
        self.nextthink = time;
        return;
    }

    if (!self.count || time - self.count > 0.05)
        sound(self, CHAN_WEAPON, "weapons/bounce.wav", 1, ATTN_NORM);
    self.count = time;

    if (self.velocity == '0 0 0')
        self.avelocity = '0 0 0';
};

// The throw itself. One shape, five bursts. Returns the missile so the
// sticky path can give it its own touch.
entity(float kind, float fuse) QWTF_nade_spawn =
{
    local entity m;

    m = spawn();
    m.owner = self;
    m.classname = "qwtf_nade";
    m.movetype = MOVETYPE_BOUNCE;
    m.solid = SOLID_BBOX;
    m.qwtf_nade_kind = kind;

    makevectors(self.v_angle);
    m.velocity = v_forward * 600 + v_up * 200 + crandom() * v_right * 10 +
                 crandom() * v_up * 10;
    m.avelocity = '300 300 300';
    m.angles = vectoangles(m.velocity);

    m.touch = QWTF_nade_touch;
    m.nextthink = time + fuse;
    if (kind == QWTF_G_HAND)
        m.think = QWTF_nade_hand_boom;
    else if (kind == QWTF_G_CONC)
        m.think = QWTF_nade_conc_boom;
    else if (kind == QWTF_G_FLASH)
        m.think = QWTF_nade_flash_boom;
    else if (kind == QWTF_G_NAIL)
        m.think = QWTF_nade_nail_boom;
    else
        m.think = QWTF_nade_charge_boom;

    setmodel(m, "progs/grenade.mdl");
    setsize(m, '0 0 0', '0 0 0');
    setorigin(m, self.origin);

    return m;
};

// Impulse 20 = grenade 1 (key G), impulse 21 = grenade 2 (key F). The rate
// limit is W_WeaponFrame's own attack_finished gate -- the same rhythm the
// guns keep.
void(float slot) QWTF_throw_grenade =
{
    local float kind, fuse;

    if (self.deadflag != DEAD_NO)
        return;

    if (slot == 1)
        kind = QWTF_class_g1(self.qwtf_class);
    else
        kind = QWTF_class_g2(self.qwtf_class);

    if (slot == 1)
    {
        if (self.qwtf_g1 < 1)
        {
            sprint(self, PRINT_HIGH, "out of that grenade\n");
            return;
        }
        self.qwtf_g1 = self.qwtf_g1 - 1;
    }
    else
    {
        if (self.qwtf_g2 < 1)
        {
            sprint(self, PRINT_HIGH, "out of that grenade\n");
            return;
        }
        self.qwtf_g2 = self.qwtf_g2 - 1;
    }

    fuse = 2.5;
    if (kind == QWTF_G_CONC || kind == QWTF_G_FLASH)
        fuse = 2;
    else if (kind == QWTF_G_CHARGE)
        fuse = 5;

    sound(self, CHAN_WEAPON, "weapons/grenade.wav", 1, ATTN_NORM);
    SmallKick();

    QWTF_nade_spawn(kind, fuse);

    dprint("QWTF_EVENT grenade_throw kind=");
    dprint(ftos(kind));
    dprint(" slot=");
    dprint(ftos(slot));
    dprint(" by ");
    dprint(self.netname);
    dprint("\n");
};

// ---------------------------------------------------------------------------
// The medkit (the medic's axe slot): aim at someone within 64 units and fire.
//
//   teammate  +20 health per hit, up to QWTF_MEDKIT_OVERHEAL (150) even past
//             the class's max; the extra drains back by 1 a second (owner,
//             2026-10-09: "healed past 100, up to 150 the team-mates")
//   enemy     5 damage now and the VIRUS: 4 more per second until a medic of
//             the victim's own team heals them, or they die. It spreads to the
//             victim's teammates who stand next to them; medics are immune.
//             The frag for a virus kill goes to the medic who started it.
float QWTF_MEDKIT_OVERHEAL = 150;
float QWTF_VIRUS_DAMAGE = 4;

// Start (or keep) the virus on a player. A virus has no end time of its own:
// qwtf_poison_until is pushed far out and only a heal or a respawn clears it.
void(entity victim, entity medic) QWTF_infect =
{
    if (victim.qwtf_poison_until <= time)
        victim.qwtf_poison_next = time + 1;
    if (victim.qwtf_poison_until <= time && !victim.qwtf_isbot)
        centerprint(victim, "You are infected!\nGet a hit from your own Medic to cure it");
    victim.qwtf_poison_until = time + 100000;
    victim.qwtf_poison_from = medic;
    QWTF_event_who(victim, "virus_infected");
};

// One medkit heal on a teammate: +20 up to the overheal cap, and a cure.
void(entity hit) QWTF_medkit_heal =
{
    if (hit.health < QWTF_MEDKIT_OVERHEAL)
    {
        hit.health = hit.health + 20;
        if (hit.health > QWTF_MEDKIT_OVERHEAL)
            hit.health = QWTF_MEDKIT_OVERHEAL;
    }
    // A heal is not a hit: it cures the virus.
    hit.qwtf_poison_until = 0;
    hit.qwtf_poison_next = 0;
    hit.qwtf_poison_from = world;
    sound(hit, CHAN_ITEM, "items/r_item1.wav", 1, ATTN_NORM);
    QWTF_event_who(hit, "medkit_heal");
};

void() QWTF_medkit_attack =
{
    local vector eye, dest;
    local entity hit;

    if (time < self.attack_finished)
        return;

    eye = self.origin + self.view_ofs;
    makevectors(self.v_angle);
    dest = eye + v_forward * 64;
    traceline(eye, dest, FALSE, self);
    hit = trace_ent;

    self.attack_finished = time + 0.4;
    player_axe1();          // the swing: the medkit is the axe slot, so it animates like one

    if (!hit || hit.classname != "player" || hit.deadflag != DEAD_NO)
    {
        sound(self, CHAN_WEAPON, "weapons/ax1.wav", 1, ATTN_NORM);
        return;
    }

    if (hit.qwtf_team == self.qwtf_team && hit != self)
    {
        QWTF_medkit_heal(hit);
        return;
    }

    if (hit == self)
        return;                         // the medic cannot self-medkit

    // Enemy: a small hit plus the virus, which lasts until cured or death.
    sound(hit, CHAN_WEAPON, "player/axhit1.wav", 1, ATTN_NORM);
    if (hit.qwtf_class != QWTF_CLASS_MEDIC)
        QWTF_infect(hit, self);
    T_Damage(hit, self, self, 5);
    QWTF_event_who(hit, "medkit_hit");
};

// ---------------------------------------------------------------------------
// W_Attack, intercepted for the two class-owned weapons. Everything else --
// every stock gun -- goes through prior() untouched.
wrap void() W_Attack =
{
    // The demolitions launcher in sticky mode fires charges instead of
    // bouncing grenades.
    if (self.qwtf_class == QWTF_CLASS_DEMOLITIONS &&
        self.weapon == IT_GRENADE_LAUNCHER && self.qwtf_gl_sticky)
    {
        if (time < self.attack_finished)
            return;
        if (self.deadflag != DEAD_NO)
            return;
        if (self.ammo_rockets < 1)
        {
            sprint(self, PRINT_HIGH, "no rockets for a charge\n");
            return;
        }
        if (self.qwtf_gl_out >= 6)
        {
            sprint(self, PRINT_HIGH, "six charges out - detonate them first\n");
            return;
        }
        self.ammo_rockets = self.ammo_rockets - 1;
        self.currentammo = self.ammo_rockets;
        sound(self, CHAN_WEAPON, "weapons/grenade.wav", 1, ATTN_NORM);
        SmallKick();
        player_rocket1();

        // The charge flies out like a grenade but its touch sticks it, and
        // its own failsafe pops it after 30 s if nobody detonates it.
        self = QWTF_nade_spawn(QWTF_G_HAND, 30);
        self.classname = "qwtf_sticky";
        self.touch = QWTF_sticky_touch;
        self.think = QWTF_sticky_boom;

        // Back to the player, count the charge out, done.
        self = self.owner;
        self.qwtf_gl_out = self.qwtf_gl_out + 1;
        self.attack_finished = time + 0.6;
        QWTF_event_who(self, "sticky_fired");
        return;
    }

    // The medic's axe slot is the medkit.
    if (self.qwtf_class == QWTF_CLASS_MEDIC && self.weapon == IT_AXE)
    {
        QWTF_medkit_attack();
        return;
    }

    prior();
};

// ---------------------------------------------------------------------------
// ImpulseCommands, intercepted for the grenade keys and the demolitions
// launcher's controls. Impulses 1-12 stay the stock weapon/cycle ones; 20-23
// are ours:
//   20  grenade 1 (bound to G)
//   21  grenade 2 (bound to F)
//   22  launcher mode toggle (bound to V): bouncing grenades <-> sticky
//       charges (demolitions only)
//   23  detonate the sticky charges (bound to B)
// BACKPACKS keep you in your class (owner, 2026-10-10: "the backpacks are
// changing the class"). The stock pickup hands over every weapon in the pack
// and switches to the best one, so a Medic who walked over a Soldier's pack
// came out with rockets. After the stock pickup: weapons outside the class are
// taken away again, ammo the class has no gun for goes back to what it was, and
// a gun the pack switched to that the class does not carry goes back to the
// class's own. A pack from the same class is a plain refill.
wrap void() BackpackTouch =
{
    local entity p, was;
    local float w, all, extra, sh, na, ro, ce;

    p = other;
    if (p.classname != "player" || !p.qwtf_class)
    {
        prior();
        return;
    }
    w = QWTF_class_weapons(p.qwtf_class) | IT_AXE;
    sh = p.ammo_shells;
    na = p.ammo_nails;
    ro = p.ammo_rockets;
    ce = p.ammo_cells;

    prior();                                 // the stock pickup; removes the pack

    all = IT_SHOTGUN | IT_SUPER_SHOTGUN | IT_NAILGUN | IT_SUPER_NAILGUN |
          IT_GRENADE_LAUNCHER | IT_ROCKET_LAUNCHER | IT_LIGHTNING;
    extra = (p.items & all) - (p.items & all & w);
    p.items = p.items - extra;
    if (!(w & (IT_SHOTGUN | IT_SUPER_SHOTGUN)))
        p.ammo_shells = sh;
    if (!(w & (IT_NAILGUN | IT_SUPER_NAILGUN)))
        p.ammo_nails = na;
    if (!(w & (IT_GRENADE_LAUNCHER | IT_ROCKET_LAUNCHER)))
        p.ammo_rockets = ro;
    if (!(w & IT_LIGHTNING))
        p.ammo_cells = ce;

    was = self;
    self = p;
    if (!(self.items & self.weapon))
    {
        self.weapon = QWTF_class_start(self.qwtf_class);
        if (!(self.items & self.weapon))
            self.weapon = W_BestWeapon();
    }
    W_SetCurrentAmmo();
    self = was;
};

// The stock weapon cycle loops until it finds a weapon the player holds, so a
// player holding none (a lobby waiter, a body mid-respawn) spins forever and
// the server dies with "runaway loop error". With nothing to cycle to, the
// wheel does nothing.
float() QWTF_has_weapon =
{
    return self.items & (IT_AXE | IT_SHOTGUN | IT_SUPER_SHOTGUN | IT_NAILGUN |
                         IT_SUPER_NAILGUN | IT_GRENADE_LAUNCHER |
                         IT_ROCKET_LAUNCHER | IT_LIGHTNING);
};

wrap void() CycleWeaponCommand =
{
    if (QWTF_has_weapon())
        prior();
};

wrap void() CycleWeaponReverseCommand =
{
    if (QWTF_has_weapon())
        prior();
};

wrap void() ImpulseCommands =
{
    if (self.impulse == 20)
    {
        self.impulse = 0;
        QWTF_throw_grenade(1);
        return;
    }
    if (self.impulse == 21)
    {
        self.impulse = 0;
        QWTF_throw_grenade(2);
        return;
    }
    if (self.impulse == 22)
    {
        self.impulse = 0;
        if (self.qwtf_class == QWTF_CLASS_DEMOLITIONS && self.deadflag == DEAD_NO)
        {
            self.qwtf_gl_sticky = 1 - self.qwtf_gl_sticky;
            if (self.qwtf_gl_sticky)
                sprint(self, PRINT_HIGH, "launcher: sticky charges\n");
            else
                sprint(self, PRINT_HIGH, "launcher: bouncing grenades\n");
            QWTF_event_who(self, "gl_mode");
        }
        return;
    }
    if (self.impulse == 23)
    {
        local entity st, nextst, was;
        local float n;

        self.impulse = 0;
        if (self.qwtf_class == QWTF_CLASS_DEMOLITIONS && self.deadflag == DEAD_NO)
        {
            n = 0;
            st = find(world, classname, "qwtf_sticky");
            while (st)
            {
                // The next one FIRST: the burst removes the entity.
                nextst = find(st, classname, "qwtf_sticky");
                if (st.owner == self)
                {
                    was = self;
                    self = st;
                    QWTF_sticky_boom();
                    self = was;
                    n = n + 1;
                }
                st = nextst;
            }
            if (n == 0)
                sprint(self, PRINT_HIGH, "no charges out\n");
            else
            {
                dprint("QWTF_EVENT sticky_detonate n=");
                dprint(ftos(n));
                dprint(" by ");
                dprint(self.netname);
                dprint("\n");
            }
        }
        return;
    }
    prior();
};

// ---------------------------------------------------------------------------
// Per-frame upkeep: the flash blind's speed and the medkit's poison tick.
// This runs AFTER prior() so ctf.qc's team assignment has already happened.
wrap void() PlayerPreThink =
{
    prior();

    if (self.classname != "player")
        return;
    if (self.deadflag != DEAD_NO)
        return;

    if (self.qwtf_flash_until > time)
        self.maxspeed = 40;
    else if (self.maxspeed < QWTF_class_speed(self.qwtf_class))
        self.maxspeed = QWTF_class_speed(self.qwtf_class);

    if (self.qwtf_poison_until > time && time >= self.qwtf_poison_next)
    {
        local entity near;

        self.qwtf_poison_next = time + 1;
        // The virus drains HEALTH, past armour (owner, 2026-10-10: "a steady
        // slow drain on their health"): through T_Damage, a Soldier's armour
        // took 3 of every 4 and the drain was invisible. The killing tick still
        // goes through T_Damage, so the death and the frag are the medic's.
        if (self.health > QWTF_VIRUS_DAMAGE)
            self.health = self.health - QWTF_VIRUS_DAMAGE;
        else
            T_Damage(self, world, self.qwtf_poison_from, 1000);
        QWTF_event_who(self, "poison_tick");

        // The virus spreads to the carrier's own teammates standing next to
        // them (not to medics), once a tick.
        near = findradius(self.origin, 64);
        while (near)
        {
            if (near != self && near.classname == "player" &&
                near.deadflag == DEAD_NO && near.qwtf_team == self.qwtf_team &&
                near.qwtf_class != QWTF_CLASS_MEDIC && near.qwtf_poison_until <= time)
                QWTF_infect(near, self.qwtf_poison_from);
            near = near.chain;
        }
    }

    // Overheal drains back to the class's max, 1 health a second.
    if (self.health > self.max_health && time >= self.qwtf_overheal_next)
    {
        self.qwtf_overheal_next = time + 1;
        self.health = self.health - 1;
    }
};

// ---------------------------------------------------------------------------
// Friendly fire and self-damage, at the one door every damage walks through.
// GAME-DESIGN.md: "Friendly fire: off. Self-damage is on, reduced to 50%
// (keeps rocket/grenade jumps)."
//
// Teammates are the qwtf_team field's pair (0 = not assigned yet -- the
// auto-assign has not run -- so an unassigned client still takes damage and
// still deals it). Self-damage halves by re-entering T_Damage with half the
// number; the guard makes the second pass fall through to prior().
wrap void(entity targ, entity inflictor, entity attacker, float damage) T_Damage =
{
    if (!QWTF_IN_SELFDMG)
    {
        if (attacker != targ && attacker.classname == "player" &&
            targ.classname == "player" && attacker.qwtf_team != 0 &&
            attacker.qwtf_team == targ.qwtf_team)
            return;

        if (attacker == targ && attacker.classname == "player")
        {
            QWTF_IN_SELFDMG = 1;
            T_Damage(targ, inflictor, attacker, damage * 0.5);
            QWTF_IN_SELFDMG = 0;
            return;
        }
    }
    prior(targ, inflictor, attacker, damage);
};

// ---------------------------------------------------------------------------
// The heal sound is only precached by a rotten health box spawning (items.qc
// picks its noise per kind), and the duel and corridor fixtures spawn no
// health at all. Precache what this file may fire on any map, here where
// precaching is legal.
//
wrap void() worldspawn =
{
    precache_sound("items/r_item1.wav");
    prior();
};

// ---------------------------------------------------------------------------
// The spawn wrap: the base puts the client in the server (health 100, the
// parms' shotgun, a random-or-team spawn), then the class replaces the
// stats. This runs for bots too -- a bot with no chosen class is a Soldier,
// which is exactly what a player who never opened the menu is.
wrap void() PutClientInServer =
{
    local float id;

    prior();

    if (self.qwtf_class_pending)
    {
        id = self.qwtf_class_pending;
        self.qwtf_class_pending = 0;
    }
    else if (self.qwtf_class)
        id = self.qwtf_class;
    else
        id = QWTF_CLASS_SOLDIER;

    QWTF_class_apply(id);
};

// ---------------------------------------------------------------------------
// The lobby commands. The menu overlay sends `qwtf_setteam red|blue|auto`
// and `qwtf_setclass <name>` as client console commands; the engine hands
// every command it does not handle itself to this function, self being the
// client that typed it.
//
// (qwtf/lobby.qc, compiled after this file, wraps SV_ParseClientCommand to
// answer `cmd qwtf_who` ahead of this handler; everything else passes on.)

// Forward declarations into qwtf/lobby.qc (same standing as bots.qc's
// QWTF_key_drop): the one-line lobby state the menu overlay reads off the
// client's console.
void(entity who) QWTF_lobby_you;

// The centerprint a class pick answers with. One string per class, because
// this dialect has no strcat.
string(float id) QWTF_class_pickmsg =
{
    if (id == QWTF_CLASS_SCOUT) return "You are now a Scout";
    if (id == QWTF_CLASS_SNIPER) return "You are now a Sniper";
    if (id == QWTF_CLASS_SOLDIER) return "You are now a Soldier";
    if (id == QWTF_CLASS_DEMOLITIONS) return "You are now a Demolitions expert";
    if (id == QWTF_CLASS_HEAVY) return "You are now a Heavy";
    if (id == QWTF_CLASS_MEDIC) return "You are now a Medic";
    return "You are now a Soldier";
};

void(float want) QWTF_team_pickmsg =
{
    if (want == QWTF_TEAM_BLUE)
        centerprint(self, "Joined Blue team");
    else
        centerprint(self, "Joined Red team");
};

void(string name) QWTF_cmd_setclass =
{
    local float id;

    id = QWTF_class_id(name);
    if (id == QWTF_CLASS_NONE)
    {
        sprint(self, PRINT_HIGH, "no such class\n");
        return;
    }
    if (!QWTF_class_available(id))
    {
        sprint(self, PRINT_HIGH, "that class is not in the game yet\n");
        return;
    }

    if (self.qwtf_class_chosen && self.qwtf_class == id)
    {
        // Silent: the menu re-sends its picks to make sure they arrive, and
        // every repeat printed this line over the screen (owner, 2026-10-10).
        return;
    }

    // EVERY pick applies NOW. The owner's 2026-10-09 playtest: "I select and
    // the weapon doesn't change" -- a change that waits for a respawn the
    // player cannot see (the old "applies at your next respawn" sprint went
    // to the console they never open) is a pick that did nothing. A first
    // pick and a change take the same road: the class is in effect from this
    // command on, and a live body respawns into it immediately.
    if (!self.qwtf_class_chosen)
        QWTF_event_who(self, "setclass_first");
    else
        QWTF_event_who(self, "setclass_now");
    self.qwtf_class_chosen = 1;
    self.qwtf_class = id;
    self.qwtf_class_pending = 0;
    centerprint(self, QWTF_class_pickmsg(id));
    QWTF_lobby_you(self);

    // A body in the world respawns at its team's spawn as the new class, with
    // no frag penalty (respawn() keeps the score) -- and a carrier does not
    // carry the key through the change. A waiter still picking has no body
    // and no team yet: their spawn comes with the second pick. A dead player's
    // own respawn is already coming and picks the class up there.
    if (self.qwtf_team != 0 && self.deadflag == DEAD_NO)
    {
        if (self.qwtf_carry)
            QWTF_key_drop(self);
        respawn();
    }
};

void(string side) QWTF_cmd_setteam =
{
    local float want, red, blue, lead;
    local entity e;

    if (side == "red")
        want = QWTF_TEAM_RED;
    else if (side == "blue")
        want = QWTF_TEAM_BLUE;
    else if (side == "auto")
        want = QWTF_team_of_player(self);
    else
    {
        sprint(self, PRINT_HIGH, "qwtf_setteam takes red, blue or auto\n");
        return;
    }

    // The switch rule: after the switch, no side may lead by more than one
    // (the design's "only allowed when it wouldn't leave the teams uneven",
    // the same 1-difference the join rule keeps). It governs a FIRST pick of
    // red or blue just as much: the owner's 2026-10-09 playtest had a first
    // "Red team" click land on blue, because the no-team path ignored `want`
    // and auto-placed. Only `auto` auto-places now.
    red = 0;
    blue = 0;
    e = find(world, classname, "player");
    while (e)
    {
        if (e != self)
        {
            if (e.qwtf_team == QWTF_TEAM_RED)
                red = red + 1;
            else if (e.qwtf_team == QWTF_TEAM_BLUE)
                blue = blue + 1;
        }
        e = find(e, classname, "player");
    }
    lead = red;
    if (want == QWTF_TEAM_BLUE)
        lead = blue;

    if (self.qwtf_team != 0 && want == self.qwtf_team)
    {
        // Silent, for the same reason as the class repeat above.
        return;
    }

    if (lead + 1 - (red + blue - lead) > 1)
    {
        QWTF_event_who(self, "setteam_refused");
        sprint(self, PRINT_HIGH, "that switch would unbalance the teams\n");
        centerprint(self, "That switch would unbalance the teams");
        return;
    }

    // A carrier switching sides does not steal the key across the lines.
    if (self.qwtf_carry)
        QWTF_key_drop(self);

    self.qwtf_team = want;
    forceinfokey(self, "team", "red");
    if (want == QWTF_TEAM_BLUE)
        forceinfokey(self, "team", "blue");
    if (side == "auto")
        QWTF_event_who(self, "setteam_auto");
    else
        QWTF_event_who(self, "setteam_accepted");
    QWTF_team_pickmsg(want);
    QWTF_lobby_you(self);
    respawn();
};

void(string cmd) SV_ParseClientCommand =
{
    local string c;

    tokenize(cmd);
    c = argv(0);

    if (c == "qwtf_setteam")
    {
        QWTF_cmd_setteam(argv(1));
        return;
    }
    if (c == "qwtf_setclass")
    {
        QWTF_cmd_setclass(argv(1));
        return;
    }

    // The contract: everything the engine already handles -- say, kill,
    // pause, name and the rest -- goes back through clientcommand, which
    // re-runs it as if the client had sent it.
    clientcommand(self, cmd);
};

#endif

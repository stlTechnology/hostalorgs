// qwtf/sniper.qc -- the Sniper's two guns (M5b, GAME-DESIGN.md "Classes" row 2):
//
//   charged sniper rifle  the super-shotgun slot (key 3, shells). Hold fire to
//                         charge; the shot fires ON RELEASE. Damage is
//                         20 + 30 per second of charge, capped at 110 after
//                         3 s. Zoom (fov 40) while charging, back to 90 on
//                         release, death or weapon change. 1.5 s between
//                         shots, 1 shell per shot.
//   auto-rifle            the nailgun slot (key 4, nails). A hitscan bullet
//                         every 0.1 s, 8 damage a hit, 1 nail a shot, a small
//                         spread.
//
// WHY A WRAP AND NOT AN EDIT. Both guns replace a SLOT'S fire for one class,
// exactly as the medic's medkit (the axe slot) and the demolitions' sticky
// charges (the launcher slot) do in qwtf/classes.qc's W_Attack wrap. The slot
// table itself lives in classes.qc (the "M5b SLOTS" comment fixes it there "so
// the two M5b lanes never edit this table") and this lane must not edit that
// file, so this file wraps on top of classes.qc's wraps instead: this file is
// compiled AFTER classes.qc, so its wrap W_Attack runs FIRST and hands
// everything that is not a sniper's slot fire to prior() -- the demolitions'
// launcher, the medic's medkit and every stock gun keep behaving exactly as
// they did.
//
// THE SHOT FIRES ON RELEASE, so W_Attack alone cannot do the charged rifle:
// W_WeaponFrame (qcsrc/weapons.qc:1493) calls W_Attack only while button0 is
// held, and a release is by definition a frame where it is NOT. The brief says
// to track button0 in a PlayerPreThink wrap, and that is where the release
// lives. While charging, W_Attack returns WITHOUT firing and WITHOUT prior(),
// so the stock super shotgun never fires instead of the charged rifle.
//
// THE ZOOM IS stuffcmd, not a server-side fov write: there is no server field
// the engine reads for a client's fov in this dialect, and the design's zoom is
// the client's own fov cvar. stuffcmd is how the game talks to that cvar
// (qcsrc/client.qc stuffs "bf\n" for the invisp flash the same way).
//
// THE RATE LIMITS live in attack_finished, the same clock stock guns use
// (W_WeaponFrame returns before W_Attack while it is in the future): 1.5 s for
// the charged rifle, 0.1 s for the auto-rifle. The charged rifle's check is in
// the release path, because the release path is NOT behind W_WeaponFrame's
// gate -- PlayerPreThink runs every frame.
//
// THE EVENTS. QWTF_EVENT lines, printed ALWAYS (the same standing as ctf.qc's
// and drown.qc's: qwtf_trace gates the probe, never a rule). The brief names
// the shot event's shape: "QWTF_EVENT sniper_shot <name> charge=<s> dmg=<n>".
// The hit lines carry the victim's name, the damage and the victim's health
// and armour AFTER T_Damage, which is how a test sees the damage land and how
// it sees a kill or a survival without the 4 Hz probe -- the whole test runs
// with qwtf_trace OFF (tests/drown.js's pattern).
//
// Include position: AFTER qwtf/classes.qc (this file wraps its W_Attack,
// PlayerPreThink, QWTF_class_apply and T_Damage, and reads its QWTF_CLASS_*
// constants), and BEFORE qwtf/drown.qc and qwtf/probe.qc. QW ONLY, like
// classes.qc: progs.dat compiles none of this; the game runs qwprogs.dat.

#ifdef __QW__

// ---------------------------------------------------------------------------
// The design's numbers, named at one place the way drown.qc names its own: the
// test reads these out of the file rather than restating them.
float QWTF_SNIPER_BASE = 20;        // damage at zero charge
float QWTF_SNIPER_PER_SEC = 30;     // damage added per second held
// The cap value is the arithmetic's own: BASE + PER_SEC * CAP_TIME =
// 20 + 30*3 = 110, and the test asserts it against GAME-DESIGN.md's number.
float QWTF_SNIPER_CAP_TIME = 3;     // seconds of hold that reaches the cap
float QWTF_SNIPER_REFIRE = 1.5;     // s between charged shots
float QWTF_SNIPER_AUTO_RATE = 0.1;  // s between auto-rifle bullets
// The auto-rifle's 8 is at its one call site (the fire below), beside the
// brief's own spread; a named constant nobody reads twice is noise here.

// THE FIELDS, at file scope: a field cannot be introduced inside a function
// body in this dialect (drown.qc's header says why).
.float qwtf_sn_charge;      // the time the charge STARTED; 0 = not charging
.float qwtf_sn_wav;         // alternates the two fire samples, like drown's
.float qwtf_sn_zoom;        // 1 while the scope is up (MOUSE2 held)

#define QWTF_SNIPER_WAV_ODD "qwtf/rifle.wav"
#define QWTF_SNIPER_WAV_EVEN "qwtf/rifle.wav"

// The zoom, on the client's own cvar. One door for it so every path (charge
// start, release, death, weapon change, spawn) says the same thing.
//
// The commands are LITERALS, the brief's own spellings ("stuffcmd(self,
// \"fov 40\\n\")"), and not built with string +: nothing in this tree
// concatenates strings (LibreQuake's qcsrc has no strcat, and every string in
// qwtf/ is pieced with separate dprint calls), so the one mechanism the whole
// tree trusts is the one used here. Two values, two literals; a zoom that is
// not one of them is a change to this file, in one place.
#define QWTF_SNIPER_FOV_CMD "fov 30\n"
#define QWTF_SNIPER_FOV_BACK_CMD "fov 90\n"

// THE SCOPE (owner, 2026-10-09: "scope when the right mouse button is held").
// MOUSE2 is bound in quake.rc to +qwtf_zoom / -qwtf_zoom, which send impulse 30
// and 31 (the wrap at the end of this file). Charging no longer zooms by itself.
void(float zoomed) QWTF_sn_fov =
{
    self.qwtf_sn_zoom = zoomed;
    if (zoomed)
        stuffcmd(self, QWTF_SNIPER_FOV_CMD);
    else
        stuffcmd(self, QWTF_SNIPER_FOV_BACK_CMD);
};

// Reset the charge and give the client its eye back. Called for: the shot, a
// death, a weapon change, and a sniper spawn. Idempotent: charging 0 is a
// no-op except the fov, and a second fov write is harmless.
void() QWTF_sn_reset =
{
    self.qwtf_sn_charge = 0;
};

// One hitscan shot, on the stock bullet path: traceline, then TraceAttack --
// which does the blood-or-puff split every stock gun's bullets get AND marks
// the target's deathtype -- and ApplyMultiDamage, which is the call that
// turns the hit into T_Damage (qcsrc/weapons.qc:225:
// T_Damage(multi_ent, self, self, multi_damage)). The deathtype is what the
// T_Damage wrap below keys its hit event on.
void(float dmg, string dtype, vector src) QWTF_sn_fire_hitscan =
{
    local vector dir;

    makevectors(self.v_angle);
    dir = aim(self, 100000);
    traceline(src, src + dir * 2048, FALSE, self);
    if (trace_fraction != 1.0)
    {
        ClearMultiDamage();
        TraceAttack(dmg, dir, dtype);
        ApplyMultiDamage();
    }
};

// The charged rifle's shot: the damage the design gives for the charge that
// was held, one shell, the sound, and the events. `held` is seconds of button0
// read on the server's own clock.
void(float held) QWTF_sn_fire_charged =
{
    local float dmg;
    local string wav;

    // The cap is a CAP: a hold past 3 s is 3 s (the test asserts 110, not
    // "more than 110").
    if (held > QWTF_SNIPER_CAP_TIME)
        held = QWTF_SNIPER_CAP_TIME;
    dmg = QWTF_SNIPER_BASE + QWTF_SNIPER_PER_SEC * held;

    // One shell per shot. No shell, no shot: the gun does not dry-fire into an
    // event line. W_BestWeapon switches away from the empty slot the way stock
    // guns do (W_FireSpikes: qcsrc/weapons.qc:792).
    if (self.ammo_shells < 1)
    {
        self.weapon = W_BestWeapon();
        W_SetCurrentAmmo();
        return;
    }
    if (!deathmatch_unlimited_ammo())
        self.ammo_shells = self.ammo_shells - 1;
    self.currentammo = self.ammo_shells;

    // Two samples, alternating, so a rapid sequence is not one sound in a loop
    // (drown.qc's reason, measured there).
    if (self.qwtf_sn_wav)
        wav = QWTF_SNIPER_WAV_ODD;
    else
        wav = QWTF_SNIPER_WAV_EVEN;
    self.qwtf_sn_wav = 1 - self.qwtf_sn_wav;
    sound(self, CHAN_WEAPON, wav, 1, ATTN_NORM);
    SmallKick();
    player_shot1();          // the stock SSG's fire anim and muzzle flash

    // THE EVENT THE BRIEF NAMES, BEFORE the shot's own hit line: a reader of
    // the log pairs every sniper_hit with the shot line just above it (the hit
    // is printed from the T_Damage wrap, inside the fire below). The charge is
    // in SECONDS and the damage is what this shot will deal, and the clock is
    // on its own line (ctf.qc's QWTF_event_at pattern -- the log is flushed
    // asynchronously, so an interval must be two numbers the rule printed).
    // The shell count is APPENDED after the named fields (probe.qc's doctrine:
    // parsers match a prefix, so nothing that reads charge= or dmg= can
    // break), which is how the test sees the 1-shell cost with the trace off.
    dprint("QWTF_EVENT sniper_shot ");
    dprint(self.netname);
    dprint(" charge=");
    dprint(ftos(held));
    dprint(" dmg=");
    dprint(ftos(dmg));
    dprint(" shells=");
    dprint(ftos(self.ammo_shells));
    dprint("\n");
    dprint("QWTF_EVENT sniper_shot_at ");
    dprint(ftos(time));
    dprint("\n");

    QWTF_sn_fire_hitscan(dmg, "sniper_rifle", self.origin + self.view_ofs);

    self.attack_finished = time + QWTF_SNIPER_REFIRE;
};

// What the victim's side of a hit looks like in the log, so the test can see
// damage land and a kill or a survival with the trace off. A killing blow's
// health is negative, and THAT is the evidence of the kill.
void(entity hit, float dmg) QWTF_sn_event_hit =
{
    dprint("QWTF_EVENT sniper_hit ");
    dprint(hit.netname);
    dprint(" dmg=");
    dprint(ftos(dmg));
    dprint(" health=");
    dprint(ftos(hit.health));
    dprint(" armour=");
    dprint(ftos(hit.armorvalue));
    dprint("\n");
};

// ---------------------------------------------------------------------------
// THE CHARGE CLOCK AND THE RELEASE. PlayerPreThink is the hook the brief
// names: it runs every frame for every client (sv_phys.c), before
// PlayerPostThink's W_WeaponFrame, so a release this frame fires before the
// next W_Attack could re-see button0 as held.
//
// prior() FIRST: ctf.qc's, bots.qc's and classes.qc's PreThink wraps run in
// there (team assignment, bot steering, the flash blind, the poison tick), and
// the vanilla movement code is in the bottom-most one.
wrap void() PlayerPreThink =
{
    local float held;

    prior();

    // Between maps the game keeps ticking and the client keeps sending
    // buttons; a shot during an intermission is nobody's design. The charge a
    // player held across the map end is dropped, and the spawn's own apply
    // (below) gives the eye back.
    if (intermission_running)
        return;

    if (self.classname != "player")
        return;

    // A sniper who is not alive does not keep a charge, and gives the eye
    // back: death mid-charge must not leave the client zoomed through the
    // respawn.
    if (self.qwtf_class == QWTF_CLASS_SNIPER &&
        (self.deadflag != DEAD_NO || self.health <= 0))
    {
        if (self.qwtf_sn_charge)
            QWTF_sn_reset();
        if (self.qwtf_sn_zoom)
            QWTF_sn_fov(0);
        return;
    }
    if (self.deadflag != DEAD_NO || self.health <= 0)
        return;

    // The rifle is a single-barrel gun: it must not show the double-barrel
    // model its slot would otherwise get. W_SetCurrentAmmo writes the slot's
    // model on every switch, so this is re-asserted each frame. Away from the
    // rifle, the scope comes down.
    if (self.qwtf_class == QWTF_CLASS_SNIPER)
    {
        if (self.weapon == IT_SUPER_SHOTGUN)
        {
            if (self.weaponmodel != "progs/v_shot.mdl")
                self.weaponmodel = "progs/v_shot.mdl";
        }
        else if (self.qwtf_sn_zoom)
            QWTF_sn_fov(0);
    }

    // The charged rifle is the super-shotgun slot of a sniper, and nothing
    // else. A non-sniper holding that slot fires the stock super shotgun; a
    // sniper who has switched to another weapon has ended the charge.
    if (self.qwtf_class == QWTF_CLASS_SNIPER && self.weapon == IT_SUPER_SHOTGUN)
    {
        if (self.button0)
        {
            // The charge starts on the FIRST held frame, with the zoom on --
            // and not for an empty slot: no shells, no charge, no zoom. The
            // empty slot switches away (W_Attack below), the same answer
            // stock guns give.
            if (!self.qwtf_sn_charge && self.ammo_shells >= 1)
                self.qwtf_sn_charge = time;
            // While held, W_Attack (below) is the no-op; the charge accrues
            // by just being held.
        }
        else if (self.qwtf_sn_charge)
        {
            // THE RELEASE. The charge is always ended here -- a charge never
            // survives its own release, so a nervous tapper cannot bank an
            // old start time and cash it later as a 110. The shot fires now
            // unless the 1.5 s refire window from the PREVIOUS shot is still
            // open, in which case this tap is simply discarded (one shot per
            // 1.5 s is what the limit means).
            held = time - self.qwtf_sn_charge;
            QWTF_sn_reset();
            if (time >= self.attack_finished)
                QWTF_sn_fire_charged(held);
        }
    }
    else if (self.qwtf_class == QWTF_CLASS_SNIPER && self.qwtf_sn_charge)
    {
        // Weapon changed while charging (impulse, empty slot): the charge is
        // gone and the eye comes back.
        QWTF_sn_reset();
    }
};

// ---------------------------------------------------------------------------
// THE SLOT FIRE. Everything that is not a sniper's slot goes to prior() --
// classes.qc's W_Attack wrap (the demolitions' sticky charges, the medic's
// medkit) and then the stock guns.
//
// IT_SUPER_SHOTGUN, a sniper: the charged rifle fires ON RELEASE (above), so
// while the button is down this is the no-op that keeps the stock super
// shotgun quiet. A frame where the button is NOT down never reaches W_Attack
// at all (W_WeaponFrame: qcsrc/weapons.qc:1501), which is why the release is
// in the PreThink wrap.
//
// IT_NAILGUN, a sniper: the auto-rifle. W_WeaponFrame calls W_Attack every
// frame while button0 is held, and attack_finished -- 0.1 s -- is the rate;
// that is the same shape the stock nailgun's W_FireSpikes uses
// (qcsrc/weapons.qc:802: "self.attack_finished = time + 0.2"). One nail a
// shot, one hitscan bullet, no spike projectile: the design's auto-rifle is a
// BULLET gun.
wrap void() W_Attack =
{
    if (self.qwtf_class == QWTF_CLASS_SNIPER && self.deadflag == DEAD_NO)
    {
        if (self.weapon == IT_SUPER_SHOTGUN)
        {
            // Holding: charge (the PreThink wrap started it). The release
            // never gets here. An empty slot switches away, as stock guns do
            // when they fire on empty.
            if (self.ammo_shells < 1)
            {
                self.weapon = W_BestWeapon();
                W_SetCurrentAmmo();
            }
            return;
        }
        if (self.weapon == IT_NAILGUN)
        {
            if (time < self.attack_finished)
                return;
            if (self.ammo_nails < 1)
            {
                self.weapon = W_BestWeapon();
                W_SetCurrentAmmo();
                return;
            }
            if (!deathmatch_unlimited_ammo())
                self.ammo_nails = self.ammo_nails - 1;
            self.currentammo = self.ammo_nails;
            // The bullet's event, BEFORE its hit line (the pairing doctrine
            // above), with the nail count AFTER this shot's decrement
            // appended: the test's "nails go down by 1 per shot" is a
            // statement about consecutive lines.
            dprint("QWTF_EVENT sniper_auto ");
            dprint(self.netname);
            dprint(" nails=");
            dprint(ftos(self.ammo_nails));
            dprint("\n");
            QWTF_sn_fire_hitscan(8, "sniper_auto",
                                 self.origin + v_forward * 10 + '0 0 22');
            sound(self, CHAN_WEAPON, "weapons/rocket1i.wav", 1, ATTN_NORM);
            muzzleflash();
            SmallKick();
            // The stock nail anim steps the frame 1..8 (player_nail1); step
            // it here without its fire function, which would launch spikes.
            self.weaponframe = self.weaponframe + 1;
            if (self.weaponframe == 9)
                self.weaponframe = 1;
            self.attack_finished = time + QWTF_SNIPER_AUTO_RATE;
            return;
        }
    }

    prior();
};

// ---------------------------------------------------------------------------
// SPAWN AND LIFE RESETS, at the one door every class's per-life state goes
// through. classes.qc's apply runs first (prior()), writing the whole design
// table; then the sniper's own clock and the client's eye are reset, so a
// respawn mid-charge or mid-zoom starts clean.
wrap void(float id) QWTF_class_apply =
{
    prior(id);

    if (id == QWTF_CLASS_SNIPER)
    {
        self.qwtf_sn_charge = 0;
        self.qwtf_sn_wav = 0;
        QWTF_sn_fov(0);
    }
    else if (self.qwtf_sn_charge)
    {
        // A class change away from the sniper mid-charge (the pending pick
        // applies at the respawn): the charge dies with the class and the
        // eye comes back. The dead-branch reset normally did this already;
        // this is the belt for the paths that did not die cleanly.
        self.qwtf_sn_charge = 0;
        QWTF_sn_fov(0);
    }
};

// The hit events, on the one door every damage walks through, AFTER prior()
// (which is classes.qc's friendly-fire and self-damage wrap and then the real
// T_Damage): whatever the rules did, the victim's fields are the result. The
// damage is this call's OWN number (the damage the shot asked for), printed
// with what it left. The class and deathtype checks keep every other gun's
// damage off these lines: only a sniper's shot sets "sniper_rifle" or
// "sniper_auto" on the target, and only in the same call that damages.
wrap void(entity targ, entity inflictor, entity attacker, float damage) T_Damage =
{
    local float ours;

    ours = 0;
    if (attacker.classname == "player" && attacker.qwtf_class == QWTF_CLASS_SNIPER &&
        targ.classname == "player" && targ != attacker &&
        (targ.deathtype == "sniper_rifle" || targ.deathtype == "sniper_auto"))
        ours = 1;

    prior(targ, inflictor, attacker, damage);

    if (ours)
    {
        QWTF_sn_event_hit(targ, damage);
        // THE MARK IS CONSUMED. deathtype is a field the engine reads at the
        // NEXT death too (ClientObituary flavours the message from it), and a
        // survivor of a charged shot would otherwise carry "sniper_rifle"
        // into every later death -- including one caused by this same
        // attacker's grenade, which would print a false sniper_hit line here
        // and a false "killed by" there. Every hit re-marks its target, so
        // clearing after the event keeps the mark true for exactly one
        // damage call.
        targ.deathtype = "";
    }
};

// ---------------------------------------------------------------------------
// The scope's two impulses (quake.rc: MOUSE2 -> +qwtf_zoom / -qwtf_zoom).
// Only a living Sniper holding the rifle can raise it; lowering always works.
wrap void() ImpulseCommands =
{
    if (self.impulse == 30)
    {
        self.impulse = 0;
        if (self.qwtf_class == QWTF_CLASS_SNIPER && self.deadflag == DEAD_NO &&
            self.weapon == IT_SUPER_SHOTGUN)
        {
            QWTF_sn_fov(1);
            QWTF_event_who(self, "sniper_scope_up");
        }
        return;
    }
    if (self.impulse == 31)
    {
        self.impulse = 0;
        if (self.qwtf_sn_zoom)
        {
            QWTF_sn_fov(0);
            QWTF_event_who(self, "sniper_scope_down");
        }
        return;
    }
    prior();
};

wrap void() worldspawn =
{
    prior();
    precache_sound("qwtf/rifle.wav");     // ours: scripts/mk_sounds.py
};

#endif

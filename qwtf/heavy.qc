// qwtf/heavy.qc -- the Heavy's rotary cannon (M5b, GAME-DESIGN.md "Classes"
// row 5): "Shotgun, rotary cannon (spin-up, high damage, slows you while
// firing)".
//
//   THE GUN. The super-nailgun slot (key 5, nails) of a Heavy fires bullets,
//   not spikes: hold fire, the first 0.6 s shoots nothing (the spin-up, and
//   `weapons/spike2.wav` plays once), then every 0.1 s a pull of 2 pellets at
//   '0.05 0.05 0' spread, 6 damage a pellet, 1 nail a shot. While the hold
//   lasts the Heavy's speed is 112 -- half of classes.qc's 224 for the class;
//   on release the class speed comes back.
//
// WHY A WRAP AND NOT AN EDIT. The cannon replaces a SLOT'S fire for one
// class, exactly as the medic's medkit and the demolitions' sticky charges do
// in qwtf/classes.qc's W_Attack wrap, and as qwtf/sniper.qc's two guns do on
// top of that. The slot table itself lives in classes.qc (the "M5b SLOTS"
// comment fixes it there "so the two M5b lanes never edit this table"), and
// this lane must not edit that file, so this file wraps on top of the wraps:
// it is compiled AFTER classes.qc and sniper.qc, so its wrap W_Attack and
// wrap PlayerPreThink run FIRST and hand everything that is not a heavy's
// cannon fire to prior() -- the sniper's guns, the medic's medkit, the
// demolitions' launcher and every stock gun keep behaving exactly as they
// did.
//
// THE CLOCK IS SPLIT ACROSS THE TWO HOOKS, for the same reason sniper.qc's
// are. W_WeaponFrame (qcsrc/weapons.qc:1493) calls W_Attack only while
// button0 is held AND attack_finished is past, so W_Attack alone can never
// see a release: the release lives in PlayerPreThink, which the ENGINE calls
// every frame for every client (sv_phys.c) with no gate at all. So:
//   - PlayerPreThink starts the hold (the spin-up's first frame), slows the
//     player for every frame of the hold, and ends the hold on release,
//     death, a weapon change or a class change;
//   - W_Attack, while the hold is older than the spin-up, fires one pull per
//     0.1 s on attack_finished -- the same clock stock guns use
//     (W_WeaponFrame returns before W_Attack while it is in the future).
//
// THE SPEED OVERIDE IS AFTER prior(), the brief's own instruction, and it has
// to be: classes.qc's PlayerPreThink wrap (inside prior()) re-writes maxspeed
// to the class speed every frame, so an override written before prior() would
// be overwritten in the same frame. On release the override stops, and
// classes.qc's own floor (`self.maxspeed < QWTF_class_speed(...)` -> the class
// speed) is what restores 224: a release frame reads 224 without this file
// writing it, so the flash blind's 40 (classes.qc, also inside prior()) is
// never fought with a hard 224.
//
// THE PELLETS ARE NOT STOCK FireBullets. FireBullets (qcsrc/weapons.qc:290)
// hardcodes TraceAttack(4, ...) -- every stock bullet gun's pellets are 4
// damage. The cannon's pull is 6 damage a pellet, which stock FireBullets
// cannot say, and third_party is gitignored (probe.qc's header: an edit there
// is lost on the next fetch and is never reviewed). So QWTF_hv_fire_pellets
// below is FireBullets' own body -- makevectors, src, the crandom spread
// terms, traceline, TraceAttack, ApplyMultiDamage -- with the damage and the
// dtype as its own numbers.
//
// THE RATE IS attack_finished, the stock clock, set to time + 0.1 per shot
// (W_FireSpikes' own "self.attack_finished = time + 0.2" is the precedent,
// qcsrc/weapons.qc:800). W_WeaponFrame then keeps W_Attack away between
// pulls, and the belt check inside keeps a direct call honest.
//
// THE EVENTS. QWTF_EVENT lines, printed ALWAYS (the same standing as ctf.qc's
// and drown.qc's: qwtf_trace gates the probe, never a rule). The brief names
// the shapes: "QWTF_EVENT heavy_spin <name>" when the spin-up starts and
// "QWTF_EVENT heavy_shot <name> nails=<n>" on every shot. Each event is
// followed by its own *_at line with the server's clock on it (ctf.qc's
// QWTF_event_at doctrine: the log is flushed asynchronously, so an interval
// must be two numbers the rule printed). The nail count is AFTER this shot's
// decrement (probe.qc's doctrine: parsers match a prefix, and the test's
// "nails drop by 1 per shot" is a statement about consecutive lines).
//
// Include position: AFTER qwtf/classes.qc and qwtf/sniper.qc (this file
// wraps their W_Attack and PlayerPreThink, and reads classes.qc's
// QWTF_CLASS_* constants), and BEFORE qwtf/drown.qc and qwtf/probe.qc. QW
// ONLY, like classes.qc: progs.dat compiles none of this; the game runs
// qwprogs.dat.

#ifdef __QW__

// ---------------------------------------------------------------------------
// The design's numbers, named at one place the way sniper.qc names its own:
// the test reads these out of the file rather than restating them.
float QWTF_HV_SPINUP = 0.6;    // s of holding fire that shoots nothing
float QWTF_HV_RATE = 0.1;      // s between shots once the spin-up is done
float QWTF_HV_SPEED = 112;     // the Heavy's speed while firing (half of 224)
vector QWTF_HV_SPREAD = '0.05 0.05 0';   // the pull's pellet spread
// The pellets-per-pull (2) and the damage-per-pellet (6) live at their one
// call site (QWTF_hv_fire_pellets, below), beside the brief's own spread.

// THE FIELDS, at file scope: a field cannot be introduced inside a function
// body in this dialect (drown.qc's header says why).
.float qwtf_hv_start;      // when THIS hold's spin-up began; 0 = not holding
.float qwtf_hv_wav;        // alternates the two fire samples, like drown's

#define QWTF_HV_WAV_ODD "weapons/rocket1i.wav"
#define QWTF_HV_WAV_EVEN "weapons/guncock.wav"

// One trigger pull: 2 pellets, QWTF_HV_SPREAD spread, 6 damage a pellet, on
// the stock bullet path. FireBullets' own body (qcsrc/weapons.qc:290) with
// the damage as this file's own number -- the header above says why the copy
// is the honest form.
void() QWTF_hv_fire_pellets =
{
    local vector dir, direction, src;
    local float pellets;

    makevectors(self.v_angle);
    dir = aim(self, 100000);
    src = self.origin + v_forward * 10 + '0 0 22';

    ClearMultiDamage();
    pellets = 2;
    while (pellets > 0)
    {
        direction = dir + crandom() * QWTF_HV_SPREAD_x * v_right +
                    crandom() * QWTF_HV_SPREAD_y * v_up;
        traceline(src, src + direction * 2048, FALSE, self);
        if (trace_fraction != 1.0)
            TraceAttack(6, direction, "heavy_cannon");
        pellets = pellets - 1;
    }
    ApplyMultiDamage();
};

// ---------------------------------------------------------------------------
// THE HOLD: start, slow, release. PlayerPreThink is the hook the brief names:
// it runs every frame for every client (sv_phys.c), with no button or
// attack_finished gate, so it is the one place that sees a release.
//
// prior() FIRST: ctf.qc's, bots.qc's, classes.qc's and sniper.qc's PreThink
// wraps run in there (team assignment, bot steering, the flash blind, the
// poison tick, the sniper's charge), and the vanilla movement code is in the
// bottom-most one. The brief: this wrap's speed write "runs AFTER prior(), so
// it wins over the class speed".
wrap void() PlayerPreThink =
{
    prior();

    // Between maps the game keeps ticking and the client keeps sending
    // buttons; a spin-up during an intermission is nobody's design.
    if (intermission_running)
    {
        self.qwtf_hv_start = 0;
        return;
    }

    if (self.classname != "player")
        return;

    // A heavy who is not alive does not keep a hold, and drops the slow:
    // death mid-hold must not leave the next life at 112.
    if (self.qwtf_class == QWTF_CLASS_HEAVY &&
        (self.deadflag != DEAD_NO || self.health <= 0))
    {
        self.qwtf_hv_start = 0;
        return;
    }
    if (self.deadflag != DEAD_NO || self.health <= 0)
        return;

    if (self.qwtf_class == QWTF_CLASS_HEAVY && self.weapon == IT_SUPER_NAILGUN)
    {
        if (self.button0)
        {
            // THE HOLD STARTS on the first held frame, with the spin-up sound
            // ONCE -- and not for an empty slot: no nails, no spin, no sound.
            // The empty slot switches away (W_Attack below), the same answer
            // stock guns give (W_FireSpikes: qcsrc/weapons.qc:795).
            if (!self.qwtf_hv_start && self.ammo_nails >= 1)
            {
                self.qwtf_hv_start = time;
                sound(self, CHAN_WEAPON, "weapons/spike2.wav", 1, ATTN_NORM);

                // THE EVENT THE BRIEF NAMES, at the spin-up's first frame.
                dprint("QWTF_EVENT heavy_spin ");
                dprint(self.netname);
                dprint("\n");
                dprint("QWTF_EVENT heavy_spin_at ");
                dprint(ftos(time));
                dprint("\n");
            }
            // WHILE THE HOLD LASTS: the firing speed, written AFTER prior()
            // so classes.qc's class-speed write (inside prior()) is already
            // done -- this is the write that wins, this frame.
            if (self.qwtf_hv_start)
                self.maxspeed = QWTF_HV_SPEED;
        }
        else if (self.qwtf_hv_start)
        {
            // THE RELEASE. A hold never survives its own release, so a
            // nervous tapper cannot bank an old start time and cash it later
            // as an instant burst. The class speed comes back through
            // classes.qc's floor, which ran inside prior() THIS frame (112
            // < 224 -> 224): no write here, so the flash blind's 40 is never
            // fought with a hard 224.
            self.qwtf_hv_start = 0;
        }
    }
    else if (self.qwtf_hv_start)
    {
        // Weapon changed while holding (impulse, empty slot) or the class is
        // gone: the hold dies with the slot.
        self.qwtf_hv_start = 0;
    }
};

// ---------------------------------------------------------------------------
// THE SLOT FIRE. Everything that is not a heavy's cannon goes to prior() --
// sniper.qc's guns, classes.qc's medkit and sticky charges, and then the
// stock guns.
//
// IT_SUPER_NAILGUN, a heavy, alive: the cannon. W_WeaponFrame calls W_Attack
// every frame while button0 is held and attack_finished is past; the hold
// itself was opened by PlayerPreThink (above), which runs before
// W_WeaponFrame in the same frame (sv_phys.c: PreThink, physics, PostThink ->
// W_WeaponFrame), so the first held frame's W_Attack sees the hold.
wrap void() W_Attack =
{
    if (self.qwtf_class == QWTF_CLASS_HEAVY && self.deadflag == DEAD_NO &&
        self.weapon == IT_SUPER_NAILGUN)
    {
        // No hold (PreThink has not opened one -- e.g. an empty slot): the
        // stock super nailgun must stay quiet, so return WITHOUT prior().
        if (!self.qwtf_hv_start)
            return;

        // SPIN-UP: the first 0.6 s of the hold shoots nothing. The spin-up
        // sound played once, at the hold's start (PreThink above).
        if (time - self.qwtf_hv_start < QWTF_HV_SPINUP)
            return;

        // The 0.1 s rate, on the stock clock: W_WeaponFrame already keeps
        // W_Attack away while this is in the future; the belt is for a
        // direct call.
        if (time < self.attack_finished)
            return;

        // Out of nails mid-hold: switch away, the hold dies with the slot,
        // the same answer stock guns give.
        if (self.ammo_nails < 1)
        {
            self.qwtf_hv_start = 0;
            self.weapon = W_BestWeapon();
            W_SetCurrentAmmo();
            return;
        }

        // 1 nail per shot, counted AFTER the decrement: the test's "nails
        // drop by 1 per shot" is a statement about consecutive lines.
        if (!deathmatch_unlimited_ammo())
            self.ammo_nails = self.ammo_nails - 1;
        self.currentammo = self.ammo_nails;

        // THE EVENT THE BRIEF NAMES, before the pull's own hit lines (the
        // pairing doctrine: a reader of the log pairs every hit with the
        // shot line just above it), with the nail count after the decrement.
        dprint("QWTF_EVENT heavy_shot ");
        dprint(self.netname);
        dprint(" nails=");
        dprint(ftos(self.ammo_nails));
        dprint("\n");
        dprint("QWTF_EVENT heavy_shot_at ");
        dprint(ftos(time));
        dprint("\n");

        // Two samples, alternating, so a rapid sequence is not one sound in
        // a loop (drown.qc's reason, measured there). 10 shots a second is
        // exactly the case the alternation exists for.
        if (self.qwtf_hv_wav)
            sound(self, CHAN_WEAPON, QWTF_HV_WAV_ODD, 1, ATTN_NORM);
        else
            sound(self, CHAN_WEAPON, QWTF_HV_WAV_EVEN, 1, ATTN_NORM);
        self.qwtf_hv_wav = 1 - self.qwtf_hv_wav;

        QWTF_hv_fire_pellets();
        muzzleflash();
        SmallKick();
        // The stock nail anim steps the frame 1..8 (player_nail1); step it
        // here WITHOUT calling player_nail1 -- the anim state's own body
        // calls W_FireSpikes, which would launch spikes (sniper.qc's reason,
        // measured there).
        self.weaponframe = self.weaponframe + 1;
        if (self.weaponframe == 9)
            self.weaponframe = 1;
        self.attack_finished = time + QWTF_HV_RATE;
        return;
    }

    prior();
};

// ---------------------------------------------------------------------------
// SPAWN AND LIFE RESETS, at the one door every class's per-life state goes
// through. classes.qc's apply runs first (prior()), writing the whole design
// table; then the heavy's own hold is reset, so a respawn mid-hold starts
// clean (classes.qc's class speed stands again from the apply itself).
wrap void(float id) QWTF_class_apply =
{
    prior(id);

    if (id == QWTF_CLASS_HEAVY)
    {
        self.qwtf_hv_start = 0;
        self.qwtf_hv_wav = 0;
    }
    else if (self.qwtf_hv_start)
    {
        // A class change away from the heavy (the pending pick applies at the
        // respawn): the hold dies with the class.
        self.qwtf_hv_start = 0;
    }
};

#endif

// qwtf/drown.qc -- drowning: the design's 15 s under water, then damage and a
// sound on every tick (GAME-DESIGN.md, owner playtest 2026-10-08 item 3:
// "Drowning: after about 15 s fully underwater, the player takes damage at
// intervals, with a gasping/drowning sound each time").
//
// GAMEPLAY, the same standing as qwtf/ctf.qc: this file never reads qwtf_trace
// and never calls into qwtf/probe.qc. A rule that only exists while a test
// watches was the REJECT 0172 lesson. QWTF_EVENT prints unconditionally, exactly
// as ctf.qc's do -- drowning is a few lines a second for one player in trouble,
// which is no more than a match's worth of obituary spam.
//
// WHY A WRAP AND NOT AN EDIT. LibreQuake's WaterMove (qcsrc/client.qc:1016) has
// drowning already: 12 s of air, 2 damage a second rising to a cap of 10, and no
// sound of its own -- the drowning wavs are precached (qcsrc/world.qc:215-216) and
// then never played by anything in that tree. third_party/ is gitignored, so an
// edit there is lost on the next fetch and is never reviewed; `wrap` adds to the
// function without touching it (probe.qc's header has the fteqcc spellings and the
// two that do not work).
//
// THE HOOK IS WaterMove, NOT PlayerPostThink. WaterMove is where the vanilla air
// clock lives, so wrapping it means one rule owns the whole breath: our clock and
// the clock we suppress. PlayerPostThink would be a poll -- a tick that notices
// the player is drowning, up to a quarter second late, and which is also the hook
// the 4 Hz probe owns.
//
// WHY 15 AND NOT 12. The design says "about 15 s fully underwater", and the vanilla
// number is 12 (client.qc:1031, `self.air_finished = time + 12`). Fifteen is also
// the friendlier reading of the map: the underwater tunnels between the forts
// (GAME-DESIGN.md "Water tunnels") are a long swim, and 12 s of air turned a
// carrier's swim across into a race against the clock.
//
// The counters are our OWN fields and not `air_finished`. Two reasons, both
// measured in the tree above: `air_finished` is written by four other places
// (client.qc:600 at spawn, :1026-1031 on surfacing, :1356 in the respawn frame,
// bots.qc:573 for bots), so a rule that read it would be reading something any of
// them can move; and the suppression below has to write it anyway, so the one
// number we trust should not be the one we are borrowing.
//
// Include position: AFTER qwtf/bots.qc (it exempts bot clients, and qwtf_isbot
// is declared there) and after qwtf/classes.qc, and BEFORE qwtf/probe.qc. It
// reuses ctf.qc's event printers and declares its own fields at file scope the
// way ctf.qc does. QW ONLY, like bots.qc and classes.qc: progs.dat compiles
// none of this; the game runs qwprogs.dat.

#ifdef __QW__

// ---------------------------------------------------------------------------
// The design's numbers. Named, and not typed at the use site, because the test
// asserts on these (tests/drown.js reads them out of the log the rule prints and
// against the file, so "the rule is 15 s" is a statement about one place).
float QWTF_DROWN_TIME = 15;        // s fully underwater before the first tick
float QWTF_DROWN_TICK = 1;         // s between damage ticks ("at intervals")
float QWTF_DROWN_DMG_MIN = 2;      // the first tick
float QWTF_DROWN_DMG_STEP = 2;     // each tick hurts more, vanilla's ramp
float QWTF_DROWN_DMG_MAX = 10;     // and then no more, vanilla's cap

// THE FIELDS, at file scope: a field cannot be introduced inside a function
// body in this dialect (ctf.qc's header says why, and got it wrong once).
.float qwtf_breath;        // the time the head last went under; 0 = head is out
.float qwtf_drown_next;    // when the next tick is due; 0 = not drowning
.float qwtf_drown_dmg;     // what the next tick will cost
.float qwtf_drown_tick;    // ticks taken on this dive, for the log
.float qwtf_drown_alt;     // which of the two drowning samples is next

// THE DROWNING VOICE. Two wavs, alternating, so a player on their last 30 health
// does not hear one sample six times in six seconds. Both are LibreQuake's own,
// both are already in web/id1/sounds.pak (build_sounds.py takes its list from the
// compiled progs' precache strings, and world.qc:215-216 precaches both), and
// both are precached on the server, so the client has them without this file
// having to say anything -- which is why precaching is not repeated here.
#define QWTF_DROWN_WAV_ODD "player/drown1.wav"
#define QWTF_DROWN_WAV_EVEN "player/drown2.wav"

// A short human line of our own, plus the events the tests read.
//
// Printed ALWAYS (see the header). One dprint set per tick is a few dozen lines
// in a whole match, and it is the only way a test can see the rule with the trace
// off. The clock is the server's own `time`, printed on its own _at line, which
// is the pattern ctf.qc's QWTF_event_at established: the log is flushed
// asynchronously, so two Date.now() readings in Node measure the write, not the
// rule. The _at lines are the only timing evidence in the file and they are what
// "15 s, then every 1 s" is asserted against.
void(string what, float at) QWTF_drown_event_at =
{
    dprint("QWTF_EVENT ");
    dprint(what);
    dprint("_at ");
    dprint(ftos(at));
    dprint("\n");
};

void() QWTF_drown_under =
{
    dprint("QWTF_EVENT dive ");
    dprint(self.netname);
    dprint("\n");
    QWTF_drown_event_at("dive", time);
    self.qwtf_breath = time;
    self.qwtf_drown_next = time + QWTF_DROWN_TIME;
    self.qwtf_drown_dmg = QWTF_DROWN_DMG_MIN;
    self.qwtf_drown_tick = 0;
};

void() QWTF_drown_surface =
{
    dprint("QWTF_EVENT surface ");
    dprint(self.netname);
    dprint("\n");
    QWTF_drown_event_at("surface", time);
    // The gasp on the way up. Vanilla plays gasp1/gasp2 from WaterMove (client.qc:
    // 1026-1030) off the same `air_finished` test this file has to keep satisfied
    // to suppress the 12 s rule, so a diver surfacing here gets silence where
    // vanilla gives a gasp. One line puts it back, and h2odeath is not used:
    // the drown ticks are the death now, and the obituary says drowning.
    sound(self, CHAN_VOICE, "player/gasp2.wav", 1, ATTN_NORM);
    self.qwtf_breath = 0;
    self.qwtf_drown_next = 0;
    self.qwtf_drown_dmg = QWTF_DROWN_DMG_MIN;
    self.qwtf_drown_tick = 0;
};

// One dive's damage tick.
void() QWTF_drown_tick_now =
{
    local float dmg;
    local string wav;

    dmg = self.qwtf_drown_dmg;
    self.qwtf_drown_dmg = self.qwtf_drown_dmg + QWTF_DROWN_DMG_STEP;
    if (self.qwtf_drown_dmg > QWTF_DROWN_DMG_MAX)
        self.qwtf_drown_dmg = QWTF_DROWN_DMG_MAX;
    self.qwtf_drown_tick = self.qwtf_drown_tick + 1;
    self.qwtf_drown_next = time + QWTF_DROWN_TICK;

    // The alternation, done with a toggle rather than a modulus: fteqcc has no
    // `%` binary operator (there is no op_modulus anywhere in
    // third_party/fteqw/engine/qclib), and `%` in this dialect is the print
    // directive's own character, so `n % 2` is a parse error, not a remainder.
    if (self.qwtf_drown_alt)
        wav = QWTF_DROWN_WAV_ODD;
    else
        wav = QWTF_DROWN_WAV_EVEN;
    self.qwtf_drown_alt = 1 - self.qwtf_drown_alt;

    dprint("QWTF_EVENT drown ");
    dprint(self.netname);
    dprint("\n");
    QWTF_drown_event_at("drown", time);
    dprint("QWTF_DROWN ");
    dprint(self.netname);
    dprint(" dmg=");
    dprint(ftos(dmg));
    dprint(" health=");
    dprint(ftos(self.health));
    dprint(" tick=");
    dprint(ftos(self.qwtf_drown_tick));
    dprint(" sound=");
    dprint(wav);
    dprint("\n");

    // The sound BEFORE the damage, so a tick that kills is still heard.
    sound(self, CHAN_VOICE, wav, 1, ATTN_NORM);

    // inflictor and attacker BOTH world, for the reason the probe's kill hook
    // gives at length (probe.qc): T_Damage returns before it has touched a
    // point of health when target and attacker share a team and teamplay is on,
    // and world is on no team. Passing world as the inflictor also skips the
    // momentum branch, so a drowning player is not launched by their own lungs.
    // The death is still REAL: armour absorbs, the obituary prints and
    // PlayerDie runs, which is what drops a carried key (ctf.qc).
    self.deathtype = "drowning";
    T_Damage(self, world, world, dmg);
};

// The whole rule, once per client per frame. WaterMove is called from
// PlayerPreThink (client.qc:1166), which the engine calls for every client
// every frame with `self` set (sv_phys.c:2231), and the engine has already
// recomputed waterlevel from the frame's own movement (sv_user.c:7854,
// `sv_player->v->waterlevel = pmove.waterlevel`) -- so "the head is under" is
// this frame's answer, not the last one's.
void() QWTF_drown_think =
{
    if (self.classname != "player")
        return;

    // The dead do not drown, and neither does anything that is not a live
    // player. A spectator's fields are not ours to write.
    if (self.deadflag != DEAD_NO || self.health <= 0)
    {
        self.qwtf_breath = 0;
        self.qwtf_drown_next = 0;
        return;
    }

    // BOTS DO NOT DROWN, and the exemption is here rather than in bots.qc because
    // the clocks being cleared are this file's. bots.qc already clears vanilla's
    // `air_finished` while a bot is wet (bots.qc:582) for exactly this reason: the
    // underwater passage is a long swim, and a bot that fought in the middle of it
    // ran the clock out and drowned with the key ("Bot Blue ran out of air",
    // measured). Under the design's 15 s rule that bug would simply move, so a bot
    // client's clock is cleared while it is WET AT ALL -- waist-deep included,
    // where nobody is drowning -- which is what makes the exemption total.
    if (self.qwtf_isbot)
    {
        if (self.waterlevel > 0)
        {
            self.qwtf_breath = 0;
            self.qwtf_drown_next = 0;
        }
        return;
    }

    if (self.waterlevel < 3)
    {
        // The head is out of the water: the breath starts again.
        if (self.qwtf_breath)
            QWTF_drown_surface();
        return;
    }

    // Waist-deep is not drowning. The design says "fully underwater", and
    // waterlevel is 1 feet / 2 waist / 3 eyes (defs.qc:213), so 3 is the only
    // level that counts -- which is also the level vanilla uses (client.qc:1035).

    if (!self.qwtf_breath)
    {
        QWTF_drown_under();
        return;                 // 15 s of nothing at all, by construction
    }

    if (time < self.qwtf_breath + QWTF_DROWN_TIME)
        return;

    if (time < self.qwtf_drown_next)
        return;

    QWTF_drown_tick_now();
};

// ---------------------------------------------------------------------------
// The wrap. Order inside it is the whole design:
//
//   1. suppress vanilla's 12 s drowning by keeping its clock satisfied
//   2. run vanilla's movement code unchanged
//   3. run our clock
//
// Step 1 is the price of not editing third_party/: `air_finished` is checked by
// vanilla's drown branch (client.qc:1035), and there is no way to veto that
// branch from outside it, so the one thing to do is keep it from ever being
// true. Step 2 is why the wrap calls prior() at all -- WaterMove is also the
// in-water friction, the enter/leave-water sounds and lava/slime damage, and a
// wrapper that forgot prior() would delete every one of them.
wrap void() WaterMove =
{
    if (self.classname == "player" && self.health > 0 && self.deadflag == DEAD_NO &&
        self.waterlevel == 3)
        self.air_finished = time + QWTF_DROWN_TIME;

    prior();

    QWTF_drown_think();
};

#endif
// qwtf/probe.qc -- server-side player positions, for tests.
//
// The authoritative answer to "where is this player", from the server, for
// M4a's flag-to-flag run and M4b's carrier tests. It closes reviewer 0043
// item 2, where movement was asserted from canvas bytes: those change when the
// OTHER client moves, so they could not tell a player walking from the view
// changing. This reads the server's own copy of the player entity.
//
// Why PlayerPostThink and not findchain (reviewer 0084): LibreQuake's QuakeC
// has none of FTE's entity-walking builtins -- findchain and edict_num both
// report "Unknown value" (measured) -- while PlayerPostThink is called by the
// ENGINE for each client every frame with `self` already set to that player
// (third_party/fteqw/engine/server/sv_phys.c:2374). Wrapping it gives a
// per-player, per-frame hook with no enumeration at all, using only builtins
// that exist in every QuakeC dialect.
//
// How it is wrapped: fteqcc's `wrap` keyword (qcc_pr_comp.c, PIF_WRAP) moves
// the original function's slot to the end and hands it to the wrapper as the
// local `prior`. That is what lets us add code to a function defined in
// LibreQuake's tree without editing that tree, which matters because
// third_party/ is gitignored: an edit there is lost on the next fetch and is
// never reviewed. scripts/build_progs.sh stages a copy of qcsrc and appends
// this file just before #endlist.
//
// Two spellings that do NOT work, both measured on the pinned fteqcc
// (git-6729-f937b9d88), which is why they are written down:
//
//   __wrap void() PlayerPostThink = ...   -> error: "PlayerPostThink" is not a type
//                                           (the compiler reads __wrap as the
//                                           return type; it is a KEYWORD,
//                                           QCC_PR_CheckKeyword(keyword_wrap))
//   void() wrap PlayerPostThink = ...     -> the same error
//
// `wrap` goes BEFORE the return type: `wrap void() PlayerPostThink`.
//
// `prior();` is called FIRST, so LibreQuake's landing sounds and the rest of
// PlayerPostThink happen exactly as before. A wrapper that forgot it would
// silently delete all of it.

#ifdef __QW__

// Off unless the server sets the cvar, because printing four lines a second
// per player to a real server's console is not something to leave on. The test
// server runs with +serverinfo qwtf_trace 1, which is also the only dialect
// where infokey exists: LibreQuake guards it with #ifdef __QW__ (defs.qc:793)
// because NQ has no infokeys, and the server runs qwprogs.dat.
.float QWTF_TRACE_NEXT;

// Declared HERE, in the test file, because this is the file that reads them: the
// probe prints a player's team, what they are carrying and their scores, and a
// field cannot be introduced twice. qwtf/ctf.qc sets them; nothing below depends
// on qwtf/ctf.qc existing, it only prints numbers, which is 0 for everything on a
// server with no CTF rules loaded.
.float qwtf_team;
.entity qwtf_carry;
.float qwtf_state;
.float QWTF_GOTO_SEQ;      // last qwtf_gseq applied to this player
.float QWTF_WP_SEQ;        // last waypoint seq this player was told about
.float QWTF_WP_X;
.float QWTF_WP_Z;          // the waypoint's HEIGHT, which is how a swimmer knows
                                // to surface: the steering sets yaw alone and a yaw cannot
                                // swim upwards (0338). Read from qwtf_wz, and absent means
                                // "level with me", so nothing changes for the walking legs.
.float QWTF_WP_X_UNUSED;   // and the waypoint itself, kept per player because the
.float QWTF_WP_Y;          // cvars are global and two players would fight over them
.float QWTF_WP_ARRIVED;    // 1 once that waypoint has been reported, until the
                           // next seq arrives
.float qwtf_captures;
.float team_score_red;
.float team_score_blue;
.float QWTF_HURT_SEQ;       // last qwtf_hurtseq applied to this player
.float QWTF_HURT_TIME;     // on WORLD, so no respawn can reset it (see the hook)
// ---------------------------------------------------------------------------
// Server-side steering, so a test can walk a client without a browser
// (reviewer 0091 item 2).
//
// The problem it solves, measured: a headless client cannot turn. Headless Chrome
// never grants pointer lock -- document.pointerLockElement is NONE after the
// canvas click -- so mouse-look is off, and FTE's web glue drops the arrow keys,
// so only W reaches the engine. Three ways of turning were tried and all three
// left v_angle unchanged: ArrowLeft held 2.5 s, forty dispatched mouseMoved
// events, and the same after faking pointerLockElement and firing
// pointerlockchange so Browser.pointerLock read true. Walking the length of a
// two-castle map needs turning, so the run could not be asserted.
//
// The fix does not touch input at all: the test already owns the server's stdin,
// and the server is authoritative over the player entity. It writes
//
//     serverinfo qwtf_face <yaw>
//
// and this wrapper faces the player that way.
//
// It also does the same for POSITION, on qwtf_gx / qwtf_gy / qwtf_gz, which
// teleport the player. A screenshot of a viewpoint needs the camera THERE, and
// walking there takes minutes and stalls in corners; the server is authoritative
// over the player entity, so a teleport photographs the real server's view of
// the real map rather than a client-side fiction. Three cvars and not one "x y z"
// string, because splitting a triple out of a serverinfo value needs strrstring
// and a pile of offsets, and each of those is a way to read the wrong axis --
// which looks exactly like being teleported somewhere impossible.
//
// These are SAFE in the owner's deploy, and the reason is in FTE's command
// dispatcher rather than in this file: a command runs only when its restriction
// level is <= Cmd_ExecLevel (cmd.c:1463); serverinfo is registered with
// Cmd_AddCommand (sv_ccmds.c:3531), so its restriction is rcon_level; rcon_level
// defaults to 20 (cmd.c:27); and a client's own commands run at Cmd_ExecLevel = 1
// (sv_user.c:6763, SV_ExecuteUserCommand). 20 > 1, so a client typing
// "serverinfo qwtf_gx 1200" is refused before SV_Serverinfo_f is reached. Only the
// server console and rcon (which executes at rcon_level) can use these. I tried
// it from a connected client and the server log never printed the command.
//
// The client still holds W, so the movement, the collision and the position all
// come from the normal path; only the heading is dictated.
//
// PlayerPreThink is the hook, not PlayerPostThink: FTE calls it BEFORE the
// player's input commands are processed (pr_cmds.c:10461 "With Prediction:
// Called before the player's input commands are processed"), so the angle is set
// on the same tick the forward command is applied. Setting it afterwards would
// turn the player a frame late, which on a 16-unit grid at 400 u/s is 6 units of
// overshoot per frame.
//
// fixangle is what makes it stick: without it the server corrects the view back
// towards the client's own angles on the next update, and the client's angle --
// which the test cannot change -- wins. The test asserts that v_angle follows,
// so a silent failure here shows up as an unchanged yaw rather than as a walk
// that mysteriously goes the wrong way.
//
// Empty string means "stop steering", so the same cvar is how the test hands
// control back.
// Auto-balance on join, per GAME-DESIGN.md: "2 teams: Red and Blue.

wrap void() PlayerPreThink =
{
    local string face;
    local vector dest;

    // 0 is "never set" and must be assigned; anything else is already decided.
    face = infokey(world, "qwtf_face");
    if (face != "")
    {
        self.angles_y = stof(face);
        self.v_angle_y = self.angles_y;
        self.fixangle = TRUE;
    }

    // ONE-SHOT, via a sequence number (0203).
    //
    // While qwtf_gx/gy stayed set this re-applied setorigin(dest) and zeroed the
    // velocity on EVERY frame, because PlayerPreThink runs per frame. So a player
    // was pinned at the teleport target forever: holding W could never move it, and
    // that is exactly "x is 232 on every one of 21 samples" -- which I spent four
    // rounds blaming on focus, on burst length and on the client.
    //
    // qwtf_gseq is a counter the test increments once per requested teleport. The
    // probe remembers the last seq it applied to this player and acts only when it
    // has CHANGED. Race-free, and unlike clearing the keys from the test side it
    // cannot be lost between the set and the next frame.
    //
    // qwtf_face deliberately has no such guard: holding the heading set is how
    // steering works, and steer() clears it when it is done.
    if (infokey(world, "qwtf_gx") != "" && infokey(world, "qwtf_gy") != "")
    {
        local float seq;
        seq = stof(infokey(world, "qwtf_gseq"));
        if (seq != self.QWTF_GOTO_SEQ)
        {
            self.QWTF_GOTO_SEQ = seq;
            dest_x = stof(infokey(world, "qwtf_gx"));
            dest_y = stof(infokey(world, "qwtf_gy"));
            dest_z = stof(infokey(world, "qwtf_gz"));
            setorigin(self, dest);
            // Zero the velocity as well: a player who arrives with 400 u/s of
            // horizontal speed from the walk that led here keeps going and slides
            // off the viewpoint before the screenshot is taken.
            self.velocity_x = 0; self.velocity_y = 0; self.velocity_z = 0;
        }
    }

    // WAYPOINT STEERING, ON THE SERVER (reviewer 0252).
    //
    // The test used to compute a heading in a loop: it read the player's position
    // from the 4 Hz probe, decided a yaw, and wrote it back through serverinfo.
    // That is a control loop with the probe's period, the console write and the
    // serverinfo round trip in it, and the player covers 77 units between two
    // samples -- so the heading was always computed for a position the player had
    // already left. Measured: he walked a straight line to x=400 and oscillated
    // 457, 350, 403, 509, 600, 638, never once north, because the loop was aiming
    // at a point 80 units away.
    //
    // Here it is per server frame, with no loop and no latency: the test names a
    // waypoint and this faces the player at it until it is reached. The test never
    // computes an angle; it only hands over the next waypoint when this one is
    // announced.
    //
    //   serverinfo qwtf_wx/qwtf_wy  the waypoint (z is ignored: it is a heading)
    //   serverinfo qwtf_wseq        bumped by the test for each new waypoint
    //   serverinfo qwtf_wjump 1     hold JUMP while steering (off by default; the
    //                               routes are stairs and ramps, and a jump is
    //                               fragile for a new player)
    //
    // Arrival is announced once per waypoint, as
    //   QWTFWP <seq> <x> <y> <z>
    // at 48 of horizontal distance -- inside the 32-wide hull plus a margin, and
    // inside the route's own cell (32), so it cannot be missed by a player walking
    // through it. The seq makes it one-shot: the same guard as qwtf_gseq, because a
    // player standing on the spot would otherwise print it every frame.
    local float wseq;
    local vector wtarget;
    local float wjump;
    if (infokey(world, "qwtf_wx") != "" && infokey(world, "qwtf_wy") != "")
    {
        wseq = stof(infokey(world, "qwtf_wseq"));
        if (wseq != self.QWTF_WP_SEQ)
        {
            self.QWTF_WP_SEQ = wseq;
            self.QWTF_WP_X = stof(infokey(world, "qwtf_wx"));
            self.QWTF_WP_Z = stof(infokey(world, "qwtf_wz"));
            self.QWTF_WP_Y = stof(infokey(world, "qwtf_wy"));
            self.QWTF_WP_ARRIVED = 0;
        }
        wtarget_x = self.QWTF_WP_X - self.origin_x;
        wtarget_y = self.QWTF_WP_Y - self.origin_y;
        if (self.QWTF_WP_ARRIVED == 0 &&
            wtarget_x * wtarget_x + wtarget_y * wtarget_y < 48 * 48)
        {
            self.QWTF_WP_ARRIVED = 1;
            dprint("QWTFWP ");
            dprint(ftos(wseq));
            dprint(" ");
            dprint(ftos(self.origin_x));
            dprint(" ");
            dprint(ftos(self.origin_y));
            dprint(" ");
            dprint(ftos(self.origin_z));
            dprint("\n");
        }
        // z is ignored on purpose: this is a heading, and a route's waypoints are
        // on the floor a player is already standing on. vectoyaw() takes a VECTOR
        // (defs.qc:677) -- passing three floats is an implicit cast and a warning
        // that says the last two arguments are ignored, which would have aimed every
        // waypoint along +x.
        wtarget_z = 0;
        self.angles_y = vectoyaw(wtarget);
        self.v_angle_y = self.angles_y;
        self.fixangle = TRUE;

        // A SWIMMER HAS TO SURFACE, AND A YAW ALONE CANNOT DO IT (0338). The steering
        // sets yaw and nothing else, so a player in the channel swam along the bed for
        // ever: leg (c) stalled at (2432,750,-264), which is the channel's mid-x on the
        // bed, a long way from the steps it was aiming at. Swimming up in Quake needs
        // pitch or jump; a yaw cannot express either.
        //
        // So: while the waypoint is meaningfully ABOVE the player, hold jump. That is
        // the same +jump the wjump userinfo already asks for, applied when it is what
        // the route needs rather than when the test remembers to ask.
        if (self.waterlevel > 0 && self.QWTF_WP_Z > self.origin_z + 24)
            self.button2 = 1;

        wjump = stof(infokey(world, "qwtf_wjump"));
        if (wjump != 0)
            self.button2 = 1;         // +jump
    }

    // ---------------------------------------------------------------------------
    // LETHAL DAMAGE, ON PURPOSE. A test hook, and the only way a headless client
    // can die: the alternative candidates were all measured or read.
    //
    //   kill             SV_Kill_f runs the progs' ClientKill, which in
    //                    LibreQuake's client.qc calls set_suicide_frame and
    //                    respawn() and NEVER PlayerDie -- so a suicide is not a
    //                    death as far as ctf.qc's drop-on-death wrapper is
    //                    concerned, and the rule under test would never run.
    //   shooting itself   a headless client cannot aim (see above), and the one
    //                    thing it CAN be made to do is walk and be hit.
    //   falling           the map has no fall damage and no pit to fall into.
    //
    //   serverinfo qwtf_hurtseq <n>   bump the counter to hurt that player once
    //   serverinfo qwtf_hurt <amount>  how much; 0 or unset means "enough"
    //
    // WHY T_Damage AND NOT `self.health = 0`. The whole point of the hook is that
    // the DEATH IS REAL: T_Damage is the path a rocket takes, so armour absorbs,
    // the death message is printed, respawn is scheduled, PlayerDie is called --
    // and ctf.qc's PlayerDie wrapper drops the key exactly as it does when the
    // owner is shot in the channel. Zeroing health fires no death at all, and a
    // check that passes on that is measuring the hook instead of the rule.
    //
    // It is one-shot per sequence number for the same reason the teleport is
    // (0203): PlayerPreThink runs every frame, so a cvar left set would kill the
    // player again on the frame after they respawn, forever.
    //
    // The belt to that braces is world.QWTF_HURT_TIME, not another per-player
    // field: PutClientInServer clears the fields it lists and leaves the rest
    // (client.qc:597-619 -- I read it), so the per-player counter does survive a
    // respawn, but if it ever did not, the loop would be a spawn loop and the log
    // would simply be full of deaths. The world's own field cannot be reset by a
    // respawn, so a second call for the same sequence is refused whatever happens
    // to the player's fields.
    //
    // Safe in the owner's deploy for the reason the other hooks are: serverinfo is
    // registered at rcon_level and a client's own commands run at Cmd_ExecLevel 1
    // (see the note above), so only the server console or an rcon can set it.
    local float hseq;
    if (infokey(world, "qwtf_hurtseq") != "")
    {
        hseq = stof(infokey(world, "qwtf_hurtseq"));
        if (hseq != self.QWTF_HURT_SEQ && self.health > 0 &&
            time > world.QWTF_HURT_TIME + 1)
        {
            local float hamt;
            self.QWTF_HURT_SEQ = hseq;
            world.QWTF_HURT_TIME = time;
            hamt = stof(infokey(world, "qwtf_hurt"));
            if (hamt <= 0)
                hamt = 1000;           // a player has 100 and no armour value at spawn
            dprint("QWTFHURT ");
            dprint(self.netname);
            dprint(" ");
            dprint(ftos(hamt));
            dprint(" health=");
            dprint(ftos(self.health));
            dprint("\n");
            // The inflictor and the attacker are BOTH world, and that is not
            // laziness: T_Damage refuses same-team damage when teamplay is on
            // (combat.qc:230), and a player hurting themselves is the definition
            // of same-team -- with teamplay 1 or 3 the call returns before it has
            // reduced a single point of health and the hook is a silent no-op. The
            // world is on no team, so the damage always lands, whatever the server
            // thinks teamplay is. Passing world as the inflictor also skips the
            // momentum branch (it is guarded by inflictor != world), so the player
            // is not launched across the vault by their own death.
            T_Damage(self, world, world, hamt);
        }
    }

    prior();
};

// ---------------------------------------------------------------------------

void() QWTF_probe_one =
{
    dprint("QWTFPOS [");
    dprint(self.netname);
    // health is here because a player that stops responding to input mid-run needs
// to be distinguishable from one that is stuck on geometry: a dead player stops
// accepting movement and its origin stays put, which looks identical from
// outside without it.
//
// ftos per coordinate, not vtos: vtos takes a VECTOR, so printing
    // self.origin_x through it is an implicit float->vector cast, which is
    // exactly what FTE's F314 warnings in this file were about.
    dprint("] ");
    dprint(ftos(self.origin_x));
    dprint(" ");
    dprint(ftos(self.origin_y));
    dprint(" ");
    dprint(ftos(self.origin_z));
    dprint(" ");
    dprint(ftos(self.v_angle_y));
    dprint(" ");
    dprint(ftos(self.health));
    // waterlevel, because "the channel is water" is a claim and this is how it is
    // checked: qbsp gives a brush CONTENTS_WATER from a texture name starting with
    // '*', and only a player standing in it reports waterlevel > 0 (reviewer 0138).
    // A func_water1 entity would NOT do it: that is not a classname this QuakeC
    // knows, so the entity is removed at spawn and the channel is empty.
    dprint(" ");
    dprint(ftos(self.waterlevel));
    // The team, the carried key's state and the capture count, because the M4b
    // rules cannot be asserted from position: a player standing in the enemy
    // vault and a player standing on their own stand are the same seven numbers.
    dprint(" ");
    dprint(ftos(self.qwtf_team));
    dprint(" ");
    dprint(self.qwtf_carry ? ftos(self.qwtf_carry.qwtf_state) : "-");
    dprint(" ");
    dprint(ftos(self.qwtf_captures));
    dprint(" ");
    dprint(ftos(self.team_score_red));
    dprint(" ");
    dprint(ftos(self.team_score_blue));
    // The weapon in hand and the ammo in it, LAST so every existing parser (which
    // matches a prefix of this line) is unaffected.
    //
    // This is here because two of the class weapons are armed by a WEAPON SLOT,
    // not by a key of their own: the medic's medkit is the axe slot (IT_AXE) and
    // the demolitions' sticky charges are the launcher slot
    // (IT_GRENADE_LAUNCHER). "The medkit did nothing" and "the medkit was never
    // selected" are the same log without this field -- measured on the duel
    // fixture, where the phase spent 40 s asserting on a weapon nobody had picked
    // (both players spawn holding the super shotgun: the fixture's `have_nailgun`
    // plus the server's `deathmatch` string).
    dprint(" ");
    dprint(ftos(self.weapon));
    dprint(" ");
    dprint(ftos(self.currentammo));
    // Armour points, and the server's own clock, appended AFTER everything above,
    // and both of them are here for the drowning checks (qwtf/drown.qc,
    // tests/drown.js). Appended, never inserted: every parser in the repo matches
    // a PREFIX of this line (ctf_rules.js's regexes, flag_run.js's, and the
    // position readers walk_routes.js uses), so two more fields at the end cannot
    // move a column anything reads.
    //
    // armour because a drowning tick is SMALL (2, then 4, 6, 8, then 10) and
    // T_Damage spends armour first (combat.qc:168-177, `save = ceil(armortype *
    // damage)`), so the Soldier's 200 points of armour at 0.6 absorb roughly
    // eighteen seconds of drowning BEFORE health moves at all. A test that could
    // only read health would see "15 s of drowning, no damage" and call the rule
    // broken; with armour it sees the whole 30 points go somewhere.
    //
    // the clock because the log is flushed asynchronously: a Node Date.now() next
    // to a log line measures when the line surfaced, not when the rule ran, which
    // is the whole reason ctf.qc's return_timeout exists on its own _at line.
    // Each sample carries the time it was taken at, so "health was still full at
    // t=14.2 and down at t=15.3" is a statement about the server's clock.
    dprint(" ");
    dprint(ftos(self.armorvalue));
    dprint(" ");
    dprint(ftos(time));
    dprint("\n");
};

// 4 Hz per player. Not per-tick: the test needs "distance travelled" and
// "visited both flags", and 4 Hz is plenty for both while costing a quarter as
// much as every frame.
wrap void() PlayerPostThink =
{
    prior();

    // dprint only reaches the server's stdout when developer is set, which the
    // test server does.
    if (infokey(world, "qwtf_trace") == "1")
    {
        if (time >= self.QWTF_TRACE_NEXT)
        {
            self.QWTF_TRACE_NEXT = time + 0.25;
            // The rules are NOT here. They were, and that was a REJECT (0172): a
            // drop-on-death and a 30 s return inside this file only run while
            // qwtf_trace is 1, which is true in tests and false on the owner's
            // server. qwtf/ctf.qc owns them, on the real hooks.
            QWTF_probe_one();
        }
    }
};

#else

// The deathmatch build. No infokey here (defs.qc:793 guards it behind __QW__),
// and nothing needs the probe on that server, so the overlay compiles to
// nothing rather than not compiling. Saying so beats a mystery blank.
void() QWTF_probe_unavailable =
{
    dprint("QWTFPOS: the position probe needs the QW progs (qwprogs.dat)\n");
};

#endif
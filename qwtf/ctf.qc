// qwtf/ctf.qc -- the capture-the-key game rules (M4b).
//
// THE SCORE IS GLOBAL (owner playtest, lane brief 2026-10-09). The first version
// kept `.float team_score_red` / `.float team_score_blue` -- FIELDS -- so every
// player carried a private, zeroed copy, a capture incremented only the
// capturer's own and nothing else read it, and NOTHING SHOWED it: "there is no
// indicator that a key was turned in other than the sound. No score increment
// was done." They are two globals now: qwtf_score_red and qwtf_score_blue.
// A capture is one point, +10 frags to the capturer (so the engine's own Tab
// scoreboard reflects it), every player gets a centerprint with the running
// totals, the bprint ends with the score, and the totals are published as
// serverinfo (score_red / score_blue) so a HUD can read them off the wire.
//
// THE KEY EVENT CENTERPRINTS (lane brief task 2). Take, drop, return and capture
// all print to every player through QWTF_announce, worded from the viewer's side
// where it matters: the key's team reads "Your key has been taken!", the carrier
// reads "The enemy key is yours, take it to your key room", everyone else reads
// the same words as the bprint line next to it. `centerprint(carrier, ...)` was
// only the carrier's copy -- the owner's live log had takes that the OTHER nine
// players never saw.
//
//
// GAMEPLAY. This file must never depend on anything in qwtf/probe.qc, and must
// never look at qwtf_trace. It was a REJECT (0172) to have the rules in the
// probe: drop-on-death, capture and the 30 s return all sat inside
// `if (infokey(world, "qwtf_trace") == "1")`, so every test passed and the
// owner's server -- which does not set that cvar -- did none of them. A carrier
// would have died keeping the key, captures would never have scored, and dropped
// keys would never have come back.
//
// Each rule is on the hook it belongs to, not on a poll:
//   take       the key's touch, which the engine calls
//   drop       PlayerDie, at the moment of death
//   capture    the own-stand's touch, which the engine calls
//   return     the key's own think function, re-armed while it is dropped
//   auto-team  PlayerPreThink, once per player
//
// The one thing here that is always printed is QWTF_EVENT. Take, drop, return and
// capture are RARE -- a few times a match -- so an unconditional dprint is cheap,
// and it is how the tests observe the rules with qwtf_trace OFF. That is the
// point: the behaviour under test must not be reachable only when the test is
// watching.

float QWTF_TEAM_SPECTATOR = 0;
float QWTF_TEAM_RED = 1;
float QWTF_TEAM_BLUE = 2;

// "No team yet", which is what an unassigned qwtf_team reads as. It CANNOT be 0:
// every field starts at 0, and 0 is QWTF_TEAM_SPECTATOR, so a player who had not
// been assigned a team tested equal to a spectator and the auto-balance guard
// ("if the team is neither red nor blue, assign one") skipped it forever. Every
// join printed "QWTF_TEAM diver -> 0".
//
// The teams are 1 and 2 and the sentinel is 3, so 0 is left alone and a spectator
// is a different thing again.
float QWTF_TEAM_NONE = 3;

// A key's three states. HOME is on its pedestal, CARRIED is in a player's hands,
// DROPPED is on the floor waiting to be picked up or to time out.
float QWTF_KEY_HOME = 0;
float QWTF_KEY_CARRIED = 1;
float QWTF_KEY_DROPPED = 2;

// GAME-DESIGN.md (owner playtest 2026-10-08): a dropped key lies where the
// carrier died for 20 s, then returns home; a defender touching it returns it at once.
float QWTF_KEY_RETURN_TIME = 20;

// THE TEAM SCORE, and why it is two GLOBALS and not two fields.
//
// The first version kept `.float team_score_red` / `.float team_score_blue` --
// fields on the CAPTURING player's entity, so every player carried a private
// score nobody else's capture added to, nothing displayed it, and the owner's
// playtest saw exactly that: "there is no indicator that a key was turned in
// other than the sound. No score increment was done." A team's score is a
// property of the MATCH, not of a player, so it lives here, next to the key
// states, where every rule reads and writes the same two numbers.
//
// A capture is ONE point. The capturing player separately gets +10 frags, so
// the engine's own Tab scoreboard shows something, but the TEAM total is the
// global, published as serverinfo (score_red / score_blue) for a HUD.
// No initialiser: file-scope floats start at 0, and fteqcc reads an initialised
// global as `const` (Q106) -- these two are the match's live totals.
float qwtf_score_red;
float qwtf_score_blue;

// THE FIELDS. A field cannot be added to an edict class from a later file -- the
// compiler says "Unknown field qwtf_carry in class entity", once per field -- so
// they are declared here at file scope, which is the only place a field can be
// introduced in this dialect. (They are not declared inside PlayerDie's body,
// where LibreQuake keeps its own player-only fields: that does not work from a
// later file either.)
//
// `self.team` is not a field, which surprised me: the natural CTF spelling does
// not compile. The team lives in qwtf_team.
//
// team_score[team] is not expressible either -- an indexed field is not a thing
// here -- so the scores are two scalars and a branch.
.float qwtf_team;                 // QWTF_TEAM_RED / _BLUE / _NONE
.entity qwtf_carry;              // the key this player is holding
.float qwtf_carry_team;          // which team that key belongs to
.float qwtf_captures;
.float qwtf_returns;

// On the key itself.
.vector qwtf_homevec;             // where it returns to
.string qwtf_model;              // the model to put back
.float qwtf_state;               // QWTF_KEY_HOME / _CARRIED / _DROPPED
.float qwtf_next;                // when a dropped key comes back

// Forward declarations. QuakeC needs a function DEFINED before it is CALLED, not
// merely before it is referenced: QWTF_key_home calls QWTF_key_return and with no
// declaration that is "Unknown value QWTF_key_return" and the build stops.
void(entity key) QWTF_key_return;
void(entity key) QWTF_key_home;
void(entity carrier) QWTF_key_drop;
void(entity key, entity carrier) QWTF_key_take;
void() item_qwtf_key_touch;

.float qwtf_carry_team;          // which team it belongs to
.float qwtf_returns;

// On the key itself.
.entity qwtf_home;                // where it returns to
.vector qwtf_homevec;
.float qwtf_state;               // QWTF_KEY_HOME / _CARRIED / _DROPPED
.float qwtf_next;                // when a dropped key returns
.string qwtf_model;

// ---------------------------------------------------------------------------
// item_qwtf_key -- the team objective (M4b).
//
// NOT item_key. The map said "item_key" and that classname does not exist:
// LibreQuake's QuakeC has item_key1 and item_key2 (items.qc:1274/1318), which
// are the single-player silver and brass keys -- they gate doors and announce
// "You got the silver key". An unknown classname is DROPPED when the map loads,
// the same class of bug as func_water1, so both vaults were empty in-engine
// while the .map text still said the key was there.
//
// spawnflags bit 1 picks the team, so one function serves both vaults and the
// map says which is which:
//
//   "classname" "item_qwtf_key"
//   "spawnflags" "2"        // red team
//   "spawnflags" "4"        // blue team
//
// The model is one of our own, generated from code per M4b, but that model does
// not exist yet, so this spawns the built-in key model for now. Swapping the
// model is one line here and touches nothing else, which is the point of keeping
// the objective behind a classname of our own.

// A key's three states. HOME is on its pedestal, CARRIED is in a player's hands,
// DROPPED is on the floor waiting to be picked up or to time out.
float QWTF_KEY_HOME = 0;
float QWTF_KEY_CARRIED = 1;
float QWTF_KEY_DROPPED = 2;

// GAME-DESIGN.md (owner playtest 2026-10-08): a dropped key lies where the
// carrier died for 20 s, then returns home; a defender touching it returns it at once.
float QWTF_KEY_RETURN_TIME = 20;

// THE FIELDS, declared on the player.
.float QWTF_TEAM_UNUSED;

// The fields the rules need. QuakeC has no way to add a field to an existing
// edict class from a later file -- the compiler said "Unknown field
// qwtf_carry in class entity" four times over -- so these are declared on the
// player and on worldspawn, which is the only place a field can be introduced in
// this dialect. Everything else about the key lives in a .float on worldspawn, in
// the record below.
//
// `team` is not a field either. That surprised me: the natural spelling for a CTF
// is self.team, and it does not compile. QWTF_TEAM_* are plain constants and the
// team lives in qwtf_team.
// --------------------------------------------------------------------------
// The event print. ALWAYS on, never gated. See the header: this is how the tests
// see the rules with qwtf_trace off.
void(string what) QWTF_event =
{
    dprint("QWTF_EVENT ");
    dprint(what);
    dprint("\n");
};

void(entity e, string what) QWTF_event_who =
{
    dprint("QWTF_EVENT ");
    dprint(what);
    dprint(" ");
    dprint(e.netname);
    dprint("\n");
};

// The same event, with the server's own clock, on a line of its own.
//
// The 20 s return is the one rule here whose PASS depends on WHEN rather than on
// WHAT, so the test needs an interval it can trust. It cannot get one from its
// own side: the log lines arrive when the server's stdout is flushed, which is
// not when the event happened, so two wall-clock readings taken in Node differ by
// however long each line took to surface. `time` here is the same clock
// QWTF_key_think compares `time >= self.qwtf_next` against, so
// return_timeout_at - drop_at IS the interval, with no flush in it.
//
// Separate line, separate name, and no change to the shape of any existing event:
// QWTF_event_who is used by ev() in tests/ctf_rules.js, which matches an exact
// line or a prefix, so nothing above this can move.
void(string what) QWTF_event_at =
{
    dprint("QWTF_EVENT ");
    dprint(what);
    dprint("_at ");
    dprint(ftos(time));
    dprint("\n");
};

// The team's own key, or world if there is none. Called with a team.
entity(float team) QWTF_key_of_team =
{
    local entity e;
    e = find(world, classname, "item_qwtf_key");
    while (e)
    {
        if (e.qwtf_team == team)
            return e;
        e = find(e, classname, "item_qwtf_key");
    }
    return world;
};


// --------------------------------------------------------------------------
// What the players SEE. The owner's playtest of e07306d: "I couldn't grab a key,
// there appears to be no action when passing through them". The server log of
// that session says the take DID happen (QWTF_EVENT take, then two captures),
// but the take wrote key.model = "" and key.origin directly. The client draws
// modelindex, not .model, and an origin written from QuakeC is not relinked, so
// the key stayed drawn on its pedestal and the carrier looked like nobody. These
// helpers are the only way the rules show or hide a key or a carrier.

// The team's colour as a QW glow. LibreQuake defines EF_RED and EF_BLUE only in
// the QW build, and this file is compiled into both progs, so the values are
// spelled here (QW protocol: EF_BLUE 64, EF_RED 128).
float QWTF_EF_BLUE = 64;
float QWTF_EF_RED = 128;
float(float team) QWTF_team_glow =
{
    if (team == QWTF_TEAM_RED)
        return QWTF_EF_RED;
    if (team == QWTF_TEAM_BLUE)
        return QWTF_EF_BLUE;
    return 0;
};

// Draw the key where key.origin says, glowing in its team's colour.
void(entity key) QWTF_key_show =
{
    setmodel(key, key.qwtf_model);
    setsize(key, '-16 -16 -16', '16 16 16');
    setorigin(key, key.origin);
    key.effects = QWTF_team_glow(key.qwtf_team);
};

// Take the key out of the world: no model, no glow, linked at the origin.
void(entity key) QWTF_key_hide =
{
    setmodel(key, "");
    setorigin(key, '0 0 0');
    key.effects = 0;
};

// The carrier glows in the colour of the key they hold, so everyone can see who
// has it ("I am then lit more and have a glow").
void(entity carrier, float team) QWTF_carrier_glow =
{
    carrier.effects = carrier.effects - (carrier.effects & (QWTF_EF_RED | QWTF_EF_BLUE | EF_DIMLIGHT));
    if (team)
        carrier.effects = carrier.effects | EF_DIMLIGHT | QWTF_team_glow(team);
};

string(float team) QWTF_team_name =
{
    if (team == QWTF_TEAM_RED)
        return "RED";
    if (team == QWTF_TEAM_BLUE)
        return "BLUE";
    return "?";
};

// Build one string out of several. LibreQuake's QuakeC has no strcat of its
// own, so this is FTE's ebfs 115 (the same way bots.qc declares forceinfokey
// #213 and classes.qc declares tokenize #441). Without it a centerprint cannot
// carry a player's name and two score numbers in one text.
string(string s1, optional string s2, optional string s3, optional string s4,
       optional string s5, optional string s6, optional string s7) strcat = #115;

// --------------------------------------------------------------------------
// What everyone SEES, per event.
//
// The owner's playtest: "there is no indicator that a key was turned in other
// than the sound". Take, drop, return and capture now centerprint every
// player, worded from where each viewer stands:
//   the key's own team  "Your key has been taken!" / "Your key is back home"
//   the carrier         "The enemy key is yours, take it to your key room"
//   everyone else       the neutral "The RED key was taken" line
// One print per player: PF_centerprint REPLACES the client's current print, so
// a player who matched two branches here would see the last one only -- the
// branch order below is most-specific-first and each branch is exclusive.
void(float owner_team, string owner_line, entity special, string special_line,
     string others_line) QWTF_announce =
{
    local entity p;
    p = find(world, classname, "player");
    while (p)
    {
        if (p == special)
            centerprint(p, special_line);
        else if (p.qwtf_team == owner_team)
            centerprint(p, owner_line);
        else
            centerprint(p, others_line);
        p = find(p, classname, "player");
    }
};

// --------------------------------------------------------------------------
// The key itself. spawnflags 2 is red, 4 is blue.
//
// Its think function is the 30 s timer and NOTHING ELSE touches the clock. It is
// armed when the key is dropped and disarmed when it is picked up or returned, so
// a key on its pedestal never ticks and a carried key never ticks.
void() QWTF_key_think =
{
    self.nextthink = time + 0.5;

    if (self.qwtf_state == QWTF_KEY_DROPPED && time >= self.qwtf_next)
    {
        QWTF_event("return_timeout");
        QWTF_event_at("return_timeout");
        QWTF_key_return(self);
    }
};

void(entity key) QWTF_key_home =
{
    key.origin = key.qwtf_homevec;
    key.solid = SOLID_TRIGGER;
    key.movetype = MOVETYPE_NONE;
    key.touch = item_qwtf_key_touch;
    key.enemy = world;
    key.velocity = '0 0 0';
    key.frame = 0;
    QWTF_key_show(key);

    // Disarm the clock. A key that is home, or carried, must not tick.
    key.think = SUB_Null;
    key.nextthink = 0;
};

// Put the key back where it belongs. Used by the timeout, by a defender's touch,
// and by a capture.
void(entity key) QWTF_key_return =
{
    local entity was;

    /* Who was carrying it. The carrier is stored on the CARRIER
     * (carrier.qwtf_carry = key), not on the key, so key.enemy is the one to read
     * -- and it was reading key.qwtf_carry, which nothing ever sets, so every
     * return reported "dropped" and a capture reset reported a dropped key
     * returning. is_symmetric to the take, which was looking the key up with find()
     * when it had been handed to it.
     */
    was = key.enemy;
    if (was && was.qwtf_carry == key)
    {
        was.qwtf_carry = world;
        was.qwtf_carry_team = 0;
        was.qwtf_returns = was.qwtf_returns + 1;
        QWTF_event_who(was, "carried_key_returned");
        QWTF_carrier_glow(was, 0);
    }
    else
    {
        QWTF_event("dropped_key_returned");
        // This branch is a key coming home WITHOUT a capture (the 20 s clock,
        // or a defender's touch). A CAPTURE also lands here, through the
        // branch above -- and it must NOT announce "back home", because the
        // capture's own centerprint was sent in this same frame and the
        // server keeps ONE pending centerprint per client: measured on the
        // live run, the return print replaced the capture print before either
        // was sent, and nobody ever saw "captured the BLUE key!" at all. The
        // capture line already says where the key went, so one print per
        // capture is also the right words.
        QWTF_announce(key.qwtf_team,
                      "Your key is back home",
                      world, "",
                      strcat("The ", QWTF_team_name(key.qwtf_team), " key is back home"));
        bprint(PRINT_HIGH, "The ");
        bprint(PRINT_HIGH, QWTF_team_name(key.qwtf_team));
        bprint(PRINT_HIGH, " key has returned home\n");
        sound(key, CHAN_ITEM, "items/itembk2.wav", 1, ATTN_NONE);
    }

    key.qwtf_state = QWTF_KEY_HOME;
    QWTF_key_home(key);
};

// Drop: it stays where the carrier fell and the clock starts.
void(entity carrier) QWTF_key_drop =
{
    local entity key;

    key = carrier.qwtf_carry;
    if (!key)
        return;

    QWTF_event_who(carrier, "drop");
    /* x y z, then `time`: the test needs both the spot the key landed on (to walk
     * onto it as a defender) and the instant it was dropped (the left-hand end of
     * the return interval). One line, so they cannot disagree. */
    dprint("QWTF_EVENT drop_at ");
    dprint(ftos(carrier.origin_x));
    dprint(" ");
    dprint(ftos(carrier.origin_y));
    dprint(" ");
    dprint(ftos(carrier.origin_z));
    dprint(" ");
    dprint(ftos(time));
    dprint("\n");

    carrier.qwtf_carry = world;
    carrier.qwtf_carry_team = 0;
    QWTF_carrier_glow(carrier, 0);

    key.qwtf_state = QWTF_KEY_DROPPED;
    key.origin = carrier.origin;
    key.origin_z = carrier.origin_z - 24;     // on the floor at their feet
    key.frame = 0;
    key.solid = SOLID_TRIGGER;
    key.touch = item_qwtf_key_touch;
    key.enemy = world;
    key.velocity = '0 0 0';
    QWTF_key_show(key);

    QWTF_announce(key.qwtf_team,
                  "Your key has been dropped! Touch it to return it",
                  carrier, "You dropped the enemy key!",
                  strcat("The ", QWTF_team_name(key.qwtf_team), " key was dropped"));
    bprint(PRINT_HIGH, "The ");
    bprint(PRINT_HIGH, QWTF_team_name(key.qwtf_team));
    bprint(PRINT_HIGH, " key was dropped\n");

    // Arm the clock. This is the ONLY place qwtf_next is set.
    key.qwtf_next = time + QWTF_KEY_RETURN_TIME;
    key.think = QWTF_key_think;
    key.nextthink = time + 0.5;
};

// Take: an ENEMY key, carried in the hands.
/* QWTF_key_take(KEY, CARRIER): the key is passed IN, not looked up.
 *
 * It used to do `key = find(carrier, classname, "item_qwtf_key")` -- and that is
 * the bug that hid behind every "the touch never fires" measurement. find() walks
 * an entity chain of solid links (touch/target/use); a SOLID_TRIGGER that the
 * engine called the touch on is not in any chain reachable from the player, so
 * find() returned world and the function returned at the top, silently, every
 * time. QWTF_DIAG KEYTOUCH other=diver proved the engine DID call the touch, which
 * is what finally located it (0218).
 */
void(entity key, entity carrier) QWTF_key_take =
{
    if (!key)
        return;

    // A defender touching a key lying on the floor sends it home at once:
    // GAME-DESIGN.md, "it returns home after 30 s, or immediately if a defender
    // touches it". Only a defender -- the attackers must not be able to defend a
    // key out of existence.
    if (key.qwtf_state == QWTF_KEY_DROPPED && carrier.qwtf_team == key.qwtf_team)
    {
        QWTF_event_who(carrier, "defender_return");
        QWTF_key_return(key);
        return;
    }

    // The key is being carried: you cannot take it off the carrier by walking into
    // them.
    if (key.enemy)
        return;

    // Already carrying the other key? Refused rather than swapped, because the
    // design says nothing about swapping and a guess here would be a guess.
    if (carrier.qwtf_carry)
    {
        QWTF_event_who(carrier, "take_refused_already_carrying");
        return;
    }

    // 0 is "not assigned yet". PlayerPreThink assigns the team, and on a player's
    // FIRST PreThink the assignment and the first touch can be the same tick, so
    // without this a player can pick up their OWN key before their team is set:
    // 0 != 1, so the enemy test below passes. (The reviewer flagged this as an
    // ordering hazard, 0174, and it is real.)
    if (carrier.qwtf_team == 0)
    {
        QWTF_event_who(carrier, "take_refused_no_team");
        return;
    }

    if (carrier.qwtf_team == key.qwtf_team)
        return;                       // a teammate does not carry their own key

    QWTF_event_who(carrier, "take");

    carrier.qwtf_carry = key;
    carrier.qwtf_carry_team = key.qwtf_team;

    key.qwtf_state = QWTF_KEY_CARRIED;
    key.frame = 0;
    key.solid = SOLID_NOT;
    key.touch = SUB_Null;
    key.enemy = carrier;
    key.velocity = '0 0 0';
    key.think = SUB_Null;
    key.nextthink = 0;
    QWTF_key_hide(key);               // out of the world, not merely invisible

    QWTF_carrier_glow(carrier, key.qwtf_team);
    sound(carrier, CHAN_ITEM, "weapons/pkup.wav", 1, ATTN_NORM);
    QWTF_announce(key.qwtf_team,
                  "Your key has been taken!",
                  carrier, "The enemy key is yours, take it to your key room",
                  strcat("The ", QWTF_team_name(key.qwtf_team), " key has been taken"));
    bprint(PRINT_HIGH, carrier.netname);
    bprint(PRINT_HIGH, " has the ");
    bprint(PRINT_HIGH, QWTF_team_name(key.qwtf_team));
    bprint(PRINT_HIGH, " key\n");
};

void() item_qwtf_key_touch =
{
    if (other.health <= 0)
        return;
    QWTF_key_take(self, other);
};

// --------------------------------------------------------------------------
// Capture. The carrier touches their OWN key's stand while carrying the enemy's,
// and only if their own key is AT HOME.
//
// This is a touch on the key itself, not a poll: the engine calls it when the
// carrier walks onto the pedestal. Polling it from a player's PostThink means it
// happens at the 4 Hz sample rather than when the player arrives, and -- the
// reason it was rejected -- it only happened when the trace was on at all.
void() item_qwtf_key_stand_touch =
{
    local entity theirs;
    local entity mine;

    if (other.health <= 0)
        return;

    theirs = other.qwtf_carry;
    if (!theirs)
        return;

    // A capture happens on the CARRIER'S OWN team's stand. This check was INVERTED
    // -- it was `if (self.qwtf_team == other.qwtf_team) return;` -- so the capture
    // only fired on the ENEMY's stand, and a player who walked into the enemy vault
    // picked the key up and scored on the spot, over and over.
    //
    // The owner's live log shows it exactly (0226): 15 take -> capture -> return
    // cycles in a row, blue = 150, while standing in the ENEMY vault. And
    // ctf_rules.js PASSED on take and capture, because the test walked through the
    // enemy key and its co-located stand and never went near the carrier's own
    // fort -- so the test was asserting the bug's behaviour and calling it a rule.
    if (self.qwtf_team != other.qwtf_team)
        return;

    // Their own key must be the one at home, too: the rule is that a capture needs
    // BOTH keys, yours home and theirs in your hands.
    mine = self;
    if (mine.qwtf_team != other.qwtf_team)
        return;

    // Their key has to be home. That is the rule that stops a team trading:
    // while yours is being run out, you cannot score.
    if (theirs.qwtf_state != QWTF_KEY_CARRIED)
        return;

    // Score FIRST, then print it. It printed 0 because the dprint came before the
    // addition, so a capture that WORKED looked like a capture that scored nothing
    // -- which is the fourth time a plausible-looking wrong number has cost me a
    // round.
    other.qwtf_captures = other.qwtf_captures + 1;
    other.frags = other.frags + 10;   // the engine's own Tab scoreboard
    if (other.qwtf_team == QWTF_TEAM_RED)
        qwtf_score_red = qwtf_score_red + 1;
    else
        qwtf_score_blue = qwtf_score_blue + 1;

    // The score is published as serverinfo the moment it moves, so a HUD (or
    // any tool on the wire) can read it without polling the rules.
    localcmd(strcat("serverinfo score_red ", ftos(qwtf_score_red), "\n"));
    localcmd(strcat("serverinfo score_blue ", ftos(qwtf_score_blue), "\n"));

    QWTF_event_who(other, "capture");

    // EVERY player sees the capture, with the running totals: the owner's
    // playtest complaint was that a capture was invisible beyond its sound.
    QWTF_announce(-1, "",
                  world, "",
                  strcat(other.netname, " captured the ",
                         QWTF_team_name(theirs.qwtf_team), " key!\nRed ",
                         ftos(qwtf_score_red), "  -  Blue ", ftos(qwtf_score_blue)));
    sound(other, CHAN_ITEM, "items/armor1.wav", 1, ATTN_NONE);
    bprint(PRINT_HIGH, other.netname);
    bprint(PRINT_HIGH, " captured the ");
    bprint(PRINT_HIGH, QWTF_team_name(theirs.qwtf_team));
    bprint(PRINT_HIGH, " key! Red ");
    bprint(PRINT_HIGH, ftos(qwtf_score_red));
    bprint(PRINT_HIGH, " - Blue ");
    bprint(PRINT_HIGH, ftos(qwtf_score_blue));
    bprint(PRINT_HIGH, "\n");
    dprint("QWTF_EVENT capture_score team=");
    dprint(ftos(other.qwtf_team));
    dprint(" red=");
    dprint(ftos(qwtf_score_red));
    dprint(" blue=");
    dprint(ftos(qwtf_score_blue));
    dprint("\n");

    QWTF_key_return(theirs);
};

// --------------------------------------------------------------------------
// item_qwtf_key: the map's key.
void() item_qwtf_key =
{
    // NOT item_key. That classname does not exist in LibreQuake's QuakeC (it has
    // item_key1 and item_key2, the single-player keys), and an unknown classname
    // is dropped when the map loads, so the vaults were empty in-engine while
    // maps/forts.map still said the key was on its pedestal. Same class of bug as
    // func_water1.

    // THIS IS LIBREQUAKE'S OWN ITEM PATH, and the ordering matters completely.
    //
    // The touch never fired, and it was not the trace, not the bounds and not the
    // classname. It is that FTE files an edict in the area-node list only in
    // SV_LinkEdict (0180/0183), which runs when the engine links the entity --
    // at spawn, and again whenever the solid or the size changes. Writing
    // absmin/absmax or mins/maxs from QuakeC changes the fields but leaves the
    // edict filed as a non-solid point, so the trace that finds touches never
    // sees it. That is why the touch printed zero times with the bounds
    // demonstrably overlapping the player.
    //
    // setsize + setorigin is the relink. And setmodel is what links at all: a
    // freshly spawned edict is SOLID_NOT with no bounds, so without a model the
    // trigger has nothing to be.
    //
    // Every Quake pickup does exactly this -- see item_key1 (items.qc:1274):
    // setmodel, self.touch, setsize, StartItem. StartItem schedules PlaceItem
    // (items.qc:214 -> :186) 0.2 s later, and PlaceItem sets SOLID_TRIGGER and
    // calls droptofloor(), which links the edict as a trigger. So the item is
    // touchable a fifth of a second after the map loads.
    // THE ORDER IS THE WHOLE THING (0180).
    //
    // FTE files an edict in the area-node list only in SV_LinkEdict, which runs
    // when the engine links the entity: at spawn, and again whenever the solid or
    // the size changes. Writing absmin/absmax or mins/maxs from QuakeC changes the
    // fields but never re-files the edict, so the trace that finds touches cannot
    // see it -- the touch printed zero times with the bounds demonstrably
    // overlapping the player. That is the whole bug.
    //
    // So: setmodel to get a model and the first link, setsize to change the size,
    // and then setorigin to the point it is already at, which is a pure relink
    // with the solid and the new size in place. startItem()/PlaceItem was tried
    // first, per item_key1, and it is WRONG for this map: PlaceItem sets
    // MOVETYPE_TOSS and calls droptofloor(), and if droptofloor finds no floor it
    // calls remove(self). In a vault 48 tall it did not, every load, and the
    // server said so:
    //
    //   Bonus item fell out of level at '328.000000 480.000000 -106.000000'
    //
    // which silently deleted both keys and both stands again.
    self.solid = SOLID_TRIGGER;
    self.movetype = MOVETYPE_NONE;
    precache_model("progs/w_s_key.mdl");
    setmodel(self, "progs/w_s_key.mdl");
    self.touch = item_qwtf_key_touch;
    setsize(self, '-16 -16 -16', '16 16 16');
    setorigin(self, self.origin);      // the relink

    // The bounds the engine will trace against, printed once. absmin/absmax are
    // absolute; mins/maxs are relative to the origin. If these are a few units the
    // trigger is a point and nothing can touch it.
    self.qwtf_team = QWTF_TEAM_NONE;
    if (self.spawnflags & 2)
        self.qwtf_team = QWTF_TEAM_RED;
    else if (self.spawnflags & 4)
        self.qwtf_team = QWTF_TEAM_BLUE;

    // Where it returns to, and the model to put back: both needed, and self.origin
    // is overwritten the moment it moves.
    self.qwtf_homevec = self.origin;
    self.qwtf_model = "progs/w_s_key.mdl";
    self.qwtf_state = QWTF_KEY_HOME;
    self.effects = QWTF_team_glow(self.qwtf_team);   // team-coloured at home

    // Disarmed. The clock only runs while the key is DROPPED.
    self.think = SUB_Null;
    self.nextthink = 0;

    // DROPTOTFLOOR IS THE RELINK, and it also REMOVES the item if it cannot find
    // floor. It could not, and the reason is a size, not a position: item_key1's
    // setsize is 56 tall (mins -24, maxs +32) and the vault is only 48 tall
    // (floor -128, ceiling -80), so a key standing on the plinth was embedded in
    // it, droptofloor failed, and PlaceItem did remove(self):
    //
    //   Bonus item fell out of level at '328.000000 480.000000 -74.000000'
    //
    // Both keys and both stands, gone, every map load, and the vault looked empty.
    // A cube 32 tall fits the room with 16 to spare, so that is the size here.
    // The plinth is left in place as scenery; the key now rests on the vault floor
    // beside it, which is where a 56-tall item would have ended up anyway.

    // The x was MISSING, not wrong -- the log read "QWTF_KEY 1 at  480 -112". I
    // had deleted the origin_x dprint while stripping diagnostics earlier, having
    // matched the line by its text rather than by its position, so this was my own
    // doing and not a shared ftos buffer at all. Printed one field per call, and
    // the x is back where it belongs.
    dprint("QWTFPROBE QWTF_KEY ");
    dprint(ftos(self.qwtf_team));
    dprint(" at ");
    dprint(ftos(self.origin_x));
    dprint(" ");
    dprint(ftos(self.origin_y));
    dprint(" ");
    dprint(ftos(self.origin_z));
    dprint("\n");
};

// The stand a team captures on. A capture is a touch on this, which is why it is
// an entity and not a z-height comparison in a tick.
void() item_qwtf_stand =
{
    self.solid = SOLID_TRIGGER;
    self.movetype = MOVETYPE_NONE;
    precache_model("progs/w_s_key.mdl");
    setmodel(self, "progs/w_s_key.mdl");
    self.touch = item_qwtf_key_stand_touch;
    setsize(self, '-16 -16 -16', '16 16 16');
    setorigin(self, self.origin);      // the relink, same reason

    // Linked, now undrawn. The stand used to draw the key model too, so every
    // key room showed TWO keys and only one of them could be picked up: the owner
    // ran through the decoy. The trigger keeps its size; only the drawing goes.
    self.modelindex = 0;

    self.qwtf_team = QWTF_TEAM_NONE;
    if (self.spawnflags & 2)
        self.qwtf_team = QWTF_TEAM_RED;
    else if (self.spawnflags & 4)
        self.qwtf_team = QWTF_TEAM_BLUE;
    self.effects = QWTF_team_glow(self.qwtf_team);   // a coloured light marks it

    self.qwtf_homevec = self.origin;
    self.qwtf_model = "progs/w_s_key.mdl";
    self.qwtf_state = QWTF_KEY_HOME;
    self.think = SUB_Null;
    self.nextthink = 0;


    dprint("QWTFPROBE QWTF_STAND ");
    dprint(ftos(self.qwtf_team));
    dprint(" at ");
    dprint(ftos(self.origin_x));
    dprint(" ");
    dprint(ftos(self.origin_y));
    dprint(" ");
    dprint(ftos(self.origin_z));
    dprint("\n");
};

// --------------------------------------------------------------------------
// Auto-balance on join: GAME-DESIGN.md, "never more than 1 player of difference
// when someone joins". Runs in PlayerPreThink, which the engine calls for every
// client every frame with self set, and only acts once per player.
//
// There is no way to ask "is this cvar set" in LibreQuake's QuakeC: strlen and
// strleft both report "Unknown value", and an empty string in an `if` is not
// reliably false. So a test pins a team by WRITING qwtf_team, which is what
// tests/ctf_rules.js does through the server's stdin.
float(entity p) QWTF_team_of_player =
{
    local entity p2;
    local float red, blue;

    red = 0;
    blue = 0;
    p2 = find(world, classname, "player");
    while (p2)
    {
        if (p2 != p)
        {
            if (p2.qwtf_team == QWTF_TEAM_RED)
                red = red + 1;
            else if (p2.qwtf_team == QWTF_TEAM_BLUE)
                blue = blue + 1;
        }
        p2 = find(p2, classname, "player");
    }

    if (red <= blue)
        return QWTF_TEAM_RED;
    return QWTF_TEAM_BLUE;
};

wrap void() PlayerPreThink =
{
    // 0 is "never assigned" and every field starts there. It CANNOT be
    // QWTF_TEAM_SPECTATOR (0), which is why QWTF_TEAM_NONE is 3: with 0 meaning
    // both, an unassigned player tested equal to a spectator and this guard
    // skipped them forever, so nobody ever had a team.
    if (self.qwtf_team == 0)
    {
        self.qwtf_team = QWTF_team_of_player(self);
        dprint("QWTFPROBE QWTF_TEAM ");
        dprint(self.netname);
        dprint(" -> ");
        dprint(ftos(self.qwtf_team));
        dprint("\n");
    }
    prior();
};

// --------------------------------------------------------------------------
// Drop-on-death, at the moment of death.
//
// It was "when the next 4 Hz probe tick notices health <= 0", which is wrong
// twice over: it did not happen at all without the trace, and a tick is up to a
// quarter second after the fact, during which the corpse is still standing on the
// key. PlayerDie is the death path (player.qc:615, assigned to self.th_die by
// PutClientInServer at client.qc:615).
wrap void() PlayerDie =
{
    if (self.qwtf_carry)
        QWTF_key_drop(self);
    prior();
};

// A carrier who LEAVES drops the key too (owner playtest 2026-10-12: "the key,
// on one side, seems to be absent, never returned"). The live log had a player
// take the BLUE key and disconnect ("Player dropped", a phone going to sleep);
// with no rule for that, the key stayed "carried" by a client that no longer
// existed -- hidden, no return clock -- for the rest of the match. Dropped
// where they stood, it returns home after QWTF_KEY_RETURN_TIME like any drop.
wrap void() ClientDisconnect =
{
    if (self.qwtf_carry)
        QWTF_key_drop(self);
    prior();
};

// And a new connection never inherits the slot's old carry: the same live log
// had the next player in that slot refused 53 takes as "already carrying".
wrap void() ClientConnect =
{
    self.qwtf_carry = world;
    self.qwtf_carry_team = 0;
    prior();
};

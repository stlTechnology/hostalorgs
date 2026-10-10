// qwtf/lobby.qc -- the join lobby (owner, 2026-10-09: "it loads me in, but
// should wait for me to select a team, a class and then spawn me in").
//
// A human who connects is an OBSERVER until they have picked both a team and
// a class: no body (solid NOT, movetype NOCLIP, invisible), no weapons, no
// damage, no key touches, and not counted on a team for the auto-balance.
// When the second pick arrives they spawn normally at their team's spawn.
// Bots are exempt: qwtf/bots.qc spawns and drives them, and they keep joining
// on their own.
//
// GAMEPLAY standing, the same as qwtf/classes.qc: every rule here sits on the
// hook that owns it, and nothing reads the test trace.
//
//   enter lobby     ClientConnect, which the engine calls when a client
//                   connects, before PutClientInServer
//   skip the class  QWTF_class_apply, so a waiter is never dressed as a class
//   leave lobby     PutClientInServer, which the engine calls on every spawn
//   stay observer   PlayerPreThink, per frame (ctf.qc's team auto-assign and
//                   the balance counts must not see a team on a waiter)
//   no firing       W_Attack and ImpulseCommands, the hooks the guns use
//   no key takes    item_qwtf_key_touch / item_qwtf_key_stand_touch, the key
//                   entity's own touch functions
//   who list        SV_ParseClientCommand, wrapped ahead of classes.qc's
//                   handler so `cmd qwtf_who` is answered before the pass-on
//
// The client-facing trail is the CONSOLE, not dprint: web/menu.js reads the
// page's console (the same output the engine prints) to open and close the
// overlay and to build the player list, so the server sprints the waiter:
//
//   QWTF_YOU team=<n> class=<n>      the caller's own lobby state, sent on
//                                    every lobby state change
//   QWTF_WHO <red|blue|choosing> <name>   one line per player, the answer to
//                                    `cmd qwtf_who`
//
// The server-log trail stays QWTF_EVENT, ALWAYS on, like every other rule:
//
//   QWTF_EVENT lobby_wait <name>
//   QWTF_EVENT lobby_spawn <name> team=<t> class=<c>
//
// Include position: immediately AFTER qwtf/classes.qc (this file wraps its
// QWTF_class_apply and its command handler, and reads QWTF_class_*), and
// BEFORE qwtf/sniper.qc, which wraps the same hooks on top of these wraps.

#ifdef __QW__

// The fields this file owns. Declared at file scope, the only place a field
// can be introduced in this dialect (same as ctf.qc and classes.qc); every
// file compiled after this one can read them.
.float qwtf_lobby;         // 1 while this client is waiting in the lobby
.float qwtf_team_picked;   // 1 once this client has sent a team pick
.float qwtf_lobby_seen;    // 1 once the lobby_wait event and QWTF_YOU went out

// A lobby waiter: a human who has not made BOTH picks yet. Bots are never
// waiters -- qwtf_isbot is set before ClientConnect, so the lobby flag is
// never set on them.
float(entity e) QWTF_lobby_waiting =
{
    if (!e.qwtf_lobby)
        return 0;
    // The team must be one the player PICKED: the spawn path auto-assigns a
    // team to place the body, and reading that as a pick let a class-only
    // waiter out of the lobby with no weapons -- whose mouse wheel then sent
    // CycleWeaponReverseCommand into a runaway loop and took the server down
    // (owner playtest 2026-10-10, build/playtest/server.log).
    if (e.qwtf_team == 0 || !e.qwtf_team_picked)
        return 1;
    if (!e.qwtf_class_chosen)
        return 1;
    return 0;
};

// The one-line lobby state the menu reads. team and class are the numbers the
// rest of the event trail uses (0 = not picked yet, 1 red / 2 blue; class 0 =
// none).
void(entity who) QWTF_lobby_you =
{
    sprint(who, PRINT_HIGH, "QWTF_YOU team=");
    sprint(who, PRINT_HIGH, ftos(who.qwtf_team));
    sprint(who, PRINT_HIGH, " class=");
    sprint(who, PRINT_HIGH, ftos(who.qwtf_class));
    sprint(who, PRINT_HIGH, "\n");
};

// The observer state, enforced rather than assumed: PutClientInServer writes
// it once per spawn, PlayerPreThink re-writes it every frame, so nothing the
// engine or another rule does to the body survives a frame.
void() QWTF_lobby_observe =
{
    // No body: nothing solid, nothing drawn, nothing to hit.
    self.solid = SOLID_NOT;
    self.movetype = MOVETYPE_NOCLIP;
    self.takedamage = DAMAGE_NO;
    self.modelindex = 0;
    self.model = "";
    self.effects = 0;
    self.weaponmodel = "";

    // No weapons, no grenades, no armour: the class has not been applied, so
    // the stats table must not leak through either.
    self.items = 0;
    self.weapon = 0;
    self.currentammo = 0;
    self.ammo_shells = 0;
    self.ammo_nails = 0;
    self.ammo_rockets = 0;
    self.ammo_cells = 0;
    self.armorvalue = 0;
    self.armortype = 0;
    self.items = self.items - (self.items & (IT_ARMOR1 | IT_ARMOR2 | IT_ARMOR3));
    self.qwtf_g1 = 0;
    self.qwtf_g2 = 0;

    // Free flight, like QW's own observer: the lobby camera is the player's
    // own camera, and noclip is what lets it leave the spawn room.
    self.maxspeed = 320;
    self.velocity = '0 0 0';
    self.impulse = 0;
};

// `cmd qwtf_who`: one QWTF_WHO line per player, the lobby list the menu
// renders. Sent to the requester's console only.
void(entity requester) QWTF_lobby_who =
{
    local entity e;
    local float t;

    e = find(world, classname, "player");
    while (e)
    {
        sprint(requester, PRINT_HIGH, "QWTF_WHO ");
        t = e.qwtf_team;
        if (t == QWTF_TEAM_RED)
            sprint(requester, PRINT_HIGH, "red");
        else if (t == QWTF_TEAM_BLUE)
            sprint(requester, PRINT_HIGH, "blue");
        else
            sprint(requester, PRINT_HIGH, "choosing");
        sprint(requester, PRINT_HIGH, " ");
        sprint(requester, PRINT_HIGH, e.netname);
        sprint(requester, PRINT_HIGH, "\n");
        e = find(e, classname, "player");
    }
};

// ---------------------------------------------------------------------------
// ENTER. The engine calls ClientConnect once per human join, with self set
// and netname already in place (the "joined" line right below is the base's
// own bprint of it). Bots come through here too -- QWTF_bot_spawn calls
// ClientConnect -- and they must never see the lobby.
wrap void() ClientConnect =
{
    prior();

    if (self.qwtf_isbot)
        return;

    self.qwtf_lobby = 1;
    self.qwtf_team_picked = 0;
    self.qwtf_lobby_seen = 0;
    QWTF_event_who(self, "lobby_wait");
};

// ---------------------------------------------------------------------------
// SPAWN. The engine calls PutClientInServer for every spawn, including the
// one nobody asked for -- a connecting client is placed in the server before
// it has said a word. That spawn is where the lobby does its work:
//
//   a waiter    the body is stripped to the observer state, and the team the
//               spawn path auto-assigned on the way in (classes.qc's
//               SelectSpawnPoint assigns one to pick a side) is taken back,
//               so the waiter counts on no team
//   both picks  this spawn IS the lobby spawn: the class was applied by the
//               wrap underneath (the skip only covers waiters), the spawn
//               point is the team's own, and the event says so
wrap void() PutClientInServer =
{
    prior();

    if (!self.qwtf_isbot && self.classname == "player")
    {
        if (QWTF_lobby_waiting(self))
        {
            if (!self.qwtf_lobby_seen)
            {
                self.qwtf_lobby_seen = 1;
                QWTF_lobby_you(self);
            }
            // SelectSpawnPoint auto-assigned a team to pick a side for the
            // body the engine insisted on placing. The waiter has picked
            // nothing, so take it back at once -- not a frame later -- or a
            // qwtf_setclass in this window would spawn them onto a team they
            // never chose.
            if (!self.qwtf_team_picked && self.qwtf_team != 0)
            {
                self.qwtf_team = 0;
                forceinfokey(self, "team", "lobby");
            }
            QWTF_lobby_observe();
            return;
        }

        if (self.qwtf_lobby)
        {
            self.qwtf_lobby = 0;
            self.qwtf_lobby_seen = 0;
            dprint("QWTF_EVENT lobby_spawn ");
            dprint(self.netname);
            dprint(" team=");
            dprint(ftos(self.qwtf_team));
            dprint(" class=");
            dprint(ftos(self.qwtf_class));
            dprint("\n");
        }
        // Every spawn, not only the lobby's: the page's class header (web/help.js)
        // follows class changes through this line.
        QWTF_lobby_you(self);
        // Team colours on the player model and the scoreboard (owner,
        // 2026-10-10: a red player still showed blue/yellow). The bots set
        // theirs in qwtf/bots.qc; humans had the engine default.
        if (self.qwtf_team == QWTF_TEAM_RED)
        {
            forceinfokey(self, "topcolor", "4");
            forceinfokey(self, "bottomcolor", "4");
        }
        else if (self.qwtf_team == QWTF_TEAM_BLUE)
        {
            forceinfokey(self, "topcolor", "13");
            forceinfokey(self, "bottomcolor", "13");
        }
    }
};

// The waiter is never dressed as a class: the stats table, the weapons and
// the ammo are for a body, and the waiter has none. This runs ahead of
// classes.qc's apply (this file is compiled after it), so a waiter's spawn
// prints no class_stats line at all.
wrap void(float id) QWTF_class_apply =
{
    if (!self.qwtf_isbot && self.qwtf_lobby && QWTF_lobby_waiting(self))
        return;
    prior(id);
};

// ---------------------------------------------------------------------------
// STAY. PlayerPreThink runs after classes.qc's and before ctf.qc's team
// auto-assign inside prior(); this post-code is therefore the last word on
// what a waiter is, every frame: no team the auto-assign tried to give them,
// and the observer state whatever else touched the body.
wrap void() PlayerPreThink =
{
    prior();

    if (self.classname != "player" || self.qwtf_isbot)
        return;
    if (!self.qwtf_lobby)
        return;

    if (QWTF_lobby_waiting(self))
    {
        if (!self.qwtf_team_picked && self.qwtf_team != 0)
        {
            self.qwtf_team = 0;
            forceinfokey(self, "team", "lobby");
        }
        QWTF_lobby_observe();
    }
    else
    {
        // Both picks are in but this is still the lobby's body: no model,
        // noclip, no weapons. A last pick that needed no respawn (a team pick
        // equal to the team the spawn path had already placed them on) left
        // the owner exactly here -- floating after a jump, no weapons, a
        // medkit that would not swing (playtest 2026-10-10). Spawn properly;
        // PutClientInServer's wrap above prints lobby_spawn and clears the flag.
        PutClientInServer();
    }
};

// NO FIRING. The waiter has no weapons and no grenades; these two are the
// hooks every shot and every impulse walks through, and the waiter's wrap
// runs ahead of every gun's.
wrap void() W_Attack =
{
    if (self.classname == "player" && !self.qwtf_isbot &&
        QWTF_lobby_waiting(self))
        return;
    prior();
};

wrap void() ImpulseCommands =
{
    if (self.classname == "player" && !self.qwtf_isbot &&
        QWTF_lobby_waiting(self))
    {
        self.impulse = 0;
        return;
    }
    prior();
};

// NO KEY TOUCHES. The key and the capture stand are ctf.qc's SOLID_TRIGGERs;
// a trigger's touch fires on the box overlap whether or not the mover is
// solid, so refusing in the touch -- not in some solidity trick -- is the
// rule. A waiter who flies straight through the vault takes nothing.
wrap void() item_qwtf_key_touch =
{
    if (other.classname == "player" && !other.qwtf_isbot &&
        QWTF_lobby_waiting(other))
        return;
    prior();
};

wrap void() item_qwtf_key_stand_touch =
{
    if (other.classname == "player" && !other.qwtf_isbot &&
        QWTF_lobby_waiting(other))
        return;
    prior();
};

// ---------------------------------------------------------------------------
// `cmd qwtf_who`, answered ahead of classes.qc's handler. Everything else is
// passed on untouched.
//
// A qwtf_setteam command also marks the team pick HERE, ahead of the handler,
// because the pick is the lobby's state and the field is this file's: the
// handler only writes .qwtf_team, and whether that number came from a pick or
// from the spawn path's auto-place is what stops PlayerPreThink from taking
// it back. A refused pick leaves .qwtf_team at 0, so the waiter keeps waiting
// whatever the flag says.
wrap void(string cmd) SV_ParseClientCommand =
{
    tokenize(cmd);
    if (argv(0) == "qwtf_who")
    {
        QWTF_lobby_who(self);
        return;
    }
    if (argv(0) == "qwtf_setteam")
        self.qwtf_team_picked = 1;
    // A class picked before any team joins a team automatically, the same as
    // "Auto" (owner, 2026-10-10: "i selected medic, it didn't return to the
    // game"). Done here, in one step with the class, so no second command can
    // be lost on the way.
    if (argv(0) == "qwtf_setclass" && !self.qwtf_isbot && !self.qwtf_team_picked)
    {
        self.qwtf_team_picked = 1;
        self.qwtf_team = QWTF_team_of_player(self);
        forceinfokey(self, "team", "red");
        if (self.qwtf_team == QWTF_TEAM_BLUE)
            forceinfokey(self, "team", "blue");
        dprint("QWTF_EVENT setteam_auto_with_class ");
        dprint(self.netname);
        dprint("\n");
    }
    prior(cmd);
};

#endif

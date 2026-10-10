// qwtf/bottarget_probe.qc -- TEST-ONLY (QWTF_EXTRA_QC). Put a lobby-like
// player (team 0, no damage) and a teammate next to Bot Red; then an enemy.
// Print what the bot targets each time.
#ifdef __QW__
void() QWTF_btp_think =
{
    local entity b, was;
    self.nextthink = time + 1;
    self.cnt = self.cnt + 1;
    b = find(world, netname, "Bot Red");
    if (!b) return;
    if (self.cnt == 4 || self.cnt == 6 || self.cnt == 8)
    {
        if (!self.enemy) { self.enemy = spawn(); self.enemy.classname = "player"; self.enemy.health = 100; }
        setorigin(self.enemy, b.origin + '64 0 0');
        if (self.cnt == 4) { self.enemy.qwtf_team = 0; self.enemy.takedamage = DAMAGE_NO; }
        if (self.cnt == 6) { self.enemy.qwtf_team = QWTF_TEAM_RED; self.enemy.takedamage = DAMAGE_AIM; }
        if (self.cnt == 8) { self.enemy.qwtf_team = QWTF_TEAM_BLUE; self.enemy.takedamage = DAMAGE_AIM; }
        b.qwtf_target = world; b.qwtf_scan = 0;
        was = self; self = b; QWTF_bot_fight(); self = was;
        dprint("QWTF_PROBE case="); dprint(ftos(self.cnt)); dprint(" targeted=");
        dprint(ftos(b.qwtf_target == self.enemy)); dprint("\n");
    }
    if (self.cnt == 9) remove(self);
};
wrap void() worldspawn = { local entity t; prior(); t = spawn(); t.think = QWTF_btp_think; t.nextthink = time + 1; };
#endif

// qwtf/botspawn_probe.qc -- TEST-ONLY (QWTF_EXTRA_QC). With the blue key taken
// (hidden at the world origin, as QWTF_key_take does), kill Bot Blue and print
// where it respawns: it must be on blue's half.
#ifdef __QW__
void() QWTF_bsp_think =
{
    local entity b, k;
    self.nextthink = time + 1;
    self.cnt = self.cnt + 1;
    b = find(world, netname, "Bot Blue");
    k = QWTF_key_of_team(QWTF_TEAM_BLUE);
    if (!b || !k) return;
    if (self.cnt == 5)
    {
        k.qwtf_state = QWTF_KEY_CARRIED;
        QWTF_key_hide(k);
        b.health = 1;
        T_Damage(b, world, world, 500);
        dprint("QWTF_PROBE killed Bot Blue with its key away\n");
    }
    if (self.cnt == 14)
    {
        dprint("QWTF_PROBE bot_blue_at x="); dprint(ftos(b.origin_x));
        dprint(" alive="); dprint(ftos(b.deadflag == DEAD_NO)); dprint("\n");
        remove(self);
    }
};
wrap void() worldspawn = { local entity t; prior(); t = spawn(); t.think = QWTF_bsp_think; t.nextthink = time + 1; };
#endif

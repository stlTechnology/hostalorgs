// qwtf/disconnect_probe.qc -- TEST-ONLY (QWTF_EXTRA_QC). Bot Red takes the BLUE
// key, then disconnects (ClientDisconnect, as the engine calls it when a client
// drops). Prints the key's state after, and 22 s later; then the slot reuse case.
#ifdef __QW__
void() QWTF_dcp_think =
{
    local entity r, k, was;
    self.nextthink = time + 1;
    self.cnt = self.cnt + 1;
    k = QWTF_key_of_team(QWTF_TEAM_BLUE);
    if (self.cnt == 4)
    {
        r = find(world, netname, "Bot Red");
        if (!r || !k) { self.cnt = 0; return; }
        QWTF_key_take(k, r);
        dprint("QWTF_PROBE taken state="); dprint(ftos(k.qwtf_state)); dprint(" carry="); dprint(ftos(r.qwtf_carry == k)); dprint("\n");
        self.enemy = r;
        was = self; self = r; ClientDisconnect(); self = was;
        dprint("QWTF_PROBE after disconnect state="); dprint(ftos(k.qwtf_state));
        dprint(" carry_cleared="); dprint(ftos(self.enemy.qwtf_carry == world)); dprint("\n");
        was = self; self = self.enemy; ClientConnect(); self = was;
        // a real departed client is gone; this bot is not, so move it off the key
        setorigin(self.enemy, '0 0 -10000'); self.enemy.takedamage = DAMAGE_NO;
        dprint("QWTF_PROBE reused slot carry="); dprint(ftos(self.enemy.qwtf_carry != world)); dprint("\n");
    }
    if (self.cnt == 27)
    {
        dprint("QWTF_PROBE 23s later state="); dprint(ftos(k.qwtf_state)); dprint(" home="); dprint(ftos(k.qwtf_state == QWTF_KEY_HOME)); dprint("\n");
        remove(self);
    }
};
wrap void() worldspawn = { local entity t; prior(); t = spawn(); t.think = QWTF_dcp_think; t.nextthink = time + 1; };
#endif

// qwtf/axe_probe.qc -- TEST-ONLY (QWTF_EXTRA_QC). Bot Red swings the axe once
// at Bot Blue (a fresh Soldier, 100 health / 200 armour) from 40 units, then
// at it again; prints Blue's health and armour after each.
#ifdef __QW__
void() QWTF_axp_think =
{
    local entity r, b, was;
    self.nextthink = time + 1;
    self.cnt = self.cnt + 1;
    r = find(world, netname, "Bot Red");
    b = find(world, netname, "Bot Blue");
    if (!r || !b) { self.cnt = 0; return; }
    if (self.cnt == 3 || self.cnt == 4)
    {
        if (self.cnt == 3) { b.health = 100; b.armorvalue = 200; }
        setorigin(b, r.origin + '40 0 0'); b.velocity = '0 0 0';
        r.v_angle = '0 0 0'; r.angles = '0 0 0';
        was = self; self = r; W_FireAxe(); self = was;
        dprint("QWTF_PROBE axe hit "); dprint(ftos(self.cnt - 2)); dprint(": blue hp="); dprint(ftos(b.health));
        dprint(" armour="); dprint(ftos(b.armorvalue)); dprint(" dead="); dprint(ftos(b.deadflag != DEAD_NO)); dprint("\n");
    }
    if (self.cnt == 5) remove(self);
};
wrap void() worldspawn = { local entity t; prior(); t = spawn(); t.think = QWTF_axp_think; t.nextthink = time + 1; };
#endif

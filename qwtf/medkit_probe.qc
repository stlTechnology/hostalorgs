// qwtf/medkit_probe.qc -- TEST-ONLY (QWTF_EXTRA_QC). The REAL medkit swing:
// Bot Red becomes a Medic, faces Bot Blue (a Soldier, 100 health / 200 armour)
// from 40 units and swings once. Prints Blue's health every second, then the
// cure by a heal at t=12.
#ifdef __QW__
void() QWTF_mkp_think =
{
    local entity r, b, was;
    self.nextthink = time + 1;
    self.cnt = self.cnt + 1;
    r = find(world, netname, "Bot Red");
    b = find(world, netname, "Bot Blue");
    if (!r || !b) { self.cnt = 0; return; }
    if (self.cnt == 3)
    {
        was = self;
        self = r; QWTF_class_apply(QWTF_CLASS_MEDIC);
        setorigin(b, r.origin + '40 0 0');
        b.velocity = '0 0 0';
        r.v_angle = '0 0 0'; r.angles = '0 0 0';
        r.attack_finished = 0;
        QWTF_medkit_attack();
        self = was;
        dprint("QWTF_PROBE swung; blue infected="); dprint(ftos(b.qwtf_poison_until > time)); dprint("\n");
    }
    if (self.cnt > 3 && self.cnt < 14)
    {
        dprint("QWTF_PROBE blue hp="); dprint(ftos(b.health)); dprint(" armour="); dprint(ftos(b.armorvalue)); dprint("\n");
    }
    if (self.cnt == 14)
    {
        QWTF_medkit_heal(b);
        dprint("QWTF_PROBE cured; infected="); dprint(ftos(b.qwtf_poison_until > time)); dprint("\n");
        remove(self);
    }
};
wrap void() worldspawn = { local entity t; prior(); t = spawn(); t.think = QWTF_mkp_think; t.nextthink = time + 1; };
#endif

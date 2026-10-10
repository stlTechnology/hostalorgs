// qwtf/backpack_probe.qc -- TEST-ONLY (QWTF_EXTRA_QC). Make Bot Red a Medic,
// touch it with a Soldier-style backpack, print what it holds afterwards.
#ifdef __QW__
void() QWTF_bpp_think =
{
    local entity b, pack, was;
    self.nextthink = time + 1;
    self.cnt = self.cnt + 1;
    if (self.cnt != 5) return;
    b = find(world, netname, "Bot Red");
    if (!b) { self.cnt = 4; return; }
    was = self;
    self = b; QWTF_class_apply(QWTF_CLASS_MEDIC);
    dprint("QWTF_PROBE before items="); dprint(ftos(b.items)); dprint(" rockets="); dprint(ftos(b.ammo_rockets));
    dprint(" nails="); dprint(ftos(b.ammo_nails)); dprint(" weapon="); dprint(ftos(b.weapon)); dprint("\n");
    pack = spawn();
    pack.classname = "item_backpack";
    pack.items = IT_ROCKET_LAUNCHER | IT_GRENADE_LAUNCHER;
    pack.ammo_rockets = 20; pack.ammo_nails = 50;
    setorigin(pack, b.origin);
    self = pack; other = b;
    BackpackTouch();
    self = was;
    dprint("QWTF_PROBE after items="); dprint(ftos(b.items)); dprint(" rockets="); dprint(ftos(b.ammo_rockets));
    dprint(" nails="); dprint(ftos(b.ammo_nails)); dprint(" weapon="); dprint(ftos(b.weapon));
    dprint(" class="); dprint(ftos(b.qwtf_class)); dprint("\n");
    remove(self);
};
wrap void() worldspawn = { local entity t; prior(); t = spawn(); t.think = QWTF_bpp_think; t.nextthink = time + 1; };
#endif
